import asyncio
import hashlib
import html
import json
import os
import re
import aiohttp

API_URL = "https://civitai.com/api/v1"
# Model pages are opened on civitai.red
SITE_URL = "https://civitai.red"
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=20)
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
NEXT_DATA_PATTERN = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

class CivitaiNotFound(Exception):
    pass

class CivitaiClient:
    """Looks up LoRAs on civitai by sha256. Results live in memory for this session only:
    the .txt stays the source of truth, only the (expensive, stable) hash is written next to the LoRA."""

    def __init__(self):
        self.cache = {}  # sha256 -> info dict

    async def get_sha256(self, lora_full_path: str) -> str:
        """Reads <base>.sha256 (bare hex, as other tools write it) or computes and saves it.
        A .sha256 older than the LoRA is recomputed and overwritten: the file was probably replaced
        by another version, and the old hash would silently show the wrong civitai model."""
        sha_path = os.path.splitext(lora_full_path)[0] + ".sha256"
        if os.path.isfile(sha_path):
            with open(sha_path, 'r', encoding='utf-8', errors='replace') as f:
                existing = f.read().strip()
            if not SHA256_PATTERN.match(existing):
                print(f"[Lora Sidebar] Ignoring invalid hash file {sha_path}")
                # Don't overwrite a file we can't make sense of
                return await asyncio.to_thread(compute_sha256, lora_full_path)
            if os.path.getmtime(lora_full_path) <= os.path.getmtime(sha_path):
                return existing.lower()
            print(f"[Lora Sidebar] {sha_path} is older than the LoRA, hashing again")

        # Hashing a large file takes seconds; keep it off the server's event loop
        file_hash = await asyncio.to_thread(compute_sha256, lora_full_path)
        try:
            with open(sha_path, 'w', encoding='utf-8') as f:
                f.write(file_hash)
        except OSError as e:
            # Saving is only a shortcut for next time, e.g. a read-only LoRA drive shouldn't block the lookup
            print(f"[Lora Sidebar] Could not save hash file {sha_path}: {e}")
        return file_hash

    async def get_info(self, lora_full_path: str, refresh: bool = False) -> dict:
        file_hash = await self.get_sha256(lora_full_path)
        if not refresh and file_hash in self.cache:
            return self.cache[file_hash]

        async with aiohttp.ClientSession(timeout=REQUEST_TIMEOUT) as session:
            version = await fetch_json(session, f"{API_URL}/model-versions/by-hash/{file_hash}")
            if version is None:
                raise CivitaiNotFound(f"No model on civitai with sha256 {file_hash}")
            model_id = version.get("modelId")
            model, settings = (None, None)
            if model_id:
                # The version lookup lacks the creator and the model description;
                # the recommended strength isn't in the public API at all, only in the model page
                model, settings = await asyncio.gather(
                    fetch_model(session, model_id),
                    fetch_version_settings(session, model_id, version.get("id")),
                )

        info = build_info(file_hash, version, model or {}, settings or {})
        self.cache[file_hash] = info
        return info

def compute_sha256(path: str) -> str:
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(block)
    return sha256.hexdigest()

async def fetch_json(session: aiohttp.ClientSession, url: str) -> dict | None:
    """GETs a civitai API url; None when civitai reports it doesn't exist."""
    async with session.get(url, headers={"User-Agent": "ComfyUI-Lora-Sidebar"}) as response:
        if response.status == 404:
            return None
        response.raise_for_status()
        return await response.json()

async def fetch_model(session: aiohttp.ClientSession, model_id) -> dict | None:
    """Best effort: without the model (e.g. rate limited) the version info is still worth showing."""
    url = f"{API_URL}/models/{model_id}"
    try:
        return await fetch_json(session, url)
    except Exception as e:
        print(f"[Lora Sidebar] Could not read model info from {url}: {e}")
        return None

async def fetch_version_settings(session: aiohttp.ClientSession, model_id, version_id) -> dict | None:
    """Best effort: the version's "Usage Tips" (strength, minStrength, maxStrength) from the page's embedded
    Next.js data, found as the object with our version id that has a "settings" dict. None if anything fails,
    e.g. after civitai changes its page layout."""
    # civitai.red answers 403 to aiohttp (while serving curl), civitai.com serves the same page data
    url = f"https://civitai.com/models/{model_id}?modelVersionId={version_id}"
    try:
        async with session.get(url, headers={"User-Agent": "Mozilla/5.0 (ComfyUI-Lora-Sidebar)"}) as response:
            response.raise_for_status()
            page = await response.text()
        match = NEXT_DATA_PATTERN.search(page)
        return find_version_settings(json.loads(match.group(1)), version_id) if match else None
    except Exception as e:
        print(f"[Lora Sidebar] Could not read usage tips from {url}: {e}")
        return None

def find_version_settings(data, version_id) -> dict | None:
    if isinstance(data, dict):
        if str(data.get("id")) == str(version_id) and isinstance(data.get("settings"), dict):
            return data["settings"]
        children = data.values()
    elif isinstance(data, list):
        children = data
    else:
        return None
    for child in children:
        found = find_version_settings(child, version_id)
        if found is not None:
            return found
    return None

def build_info(file_hash: str, version: dict, model: dict, settings: dict) -> dict:
    model_id = version.get("modelId")
    version_id = version.get("id")
    url = f"{SITE_URL}/models/{model_id}?modelVersionId={version_id}" if model_id else None
    return {
        "sha256": file_hash,
        "url": url,
        "name": (version.get("model") or {}).get("name") or model.get("name"),
        "version": version.get("name"),
        "author": (model.get("creator") or {}).get("username"),
        "baseModel": version.get("baseModel"),
        "type": (version.get("model") or {}).get("type") or model.get("type"),
        "strength": settings.get("strength"),
        "minStrength": settings.get("minStrength"),
        "maxStrength": settings.get("maxStrength"),
        # An entry may hold several comma-separated words; keep each entry as written, minus stray commas
        "trainedWords": [w for w in (w.strip(" ,\n") for w in version.get("trainedWords") or []) if w],
        "tags": model.get("tags") or [],
        "description": html_to_text(model.get("description")),
        "versionDescription": html_to_text(version.get("description")),
    }

def html_to_text(value: str | None) -> str:
    """Civitai descriptions are HTML; reduce them to plain text with line breaks kept."""
    if not value:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|h[1-6]|li|ul|ol|blockquote)>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>", "- ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()
