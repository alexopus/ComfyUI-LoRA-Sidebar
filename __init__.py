import asyncio
import json
import os
import random
import re
from aiohttp import web
from server import PromptServer
import folder_paths
from .civitai import CivitaiClient, CivitaiNotFound

WEB_DIRECTORY = "js"

# Required for ComfyUI to recognize this as a valid extension
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"]
# Checked in order: "<base>.png" first, then the "<base>.preview.png" convention used by model managers
IMAGE_SUFFIXES = IMAGE_EXTENSIONS + [f".preview{ext}" for ext in IMAGE_EXTENSIONS]
# Author tagged at the end of the base name, e.g. "Painterly_Style_[someone]"
AUTHOR_PATTERN = re.compile(r"_\[([^\]]+)\]$")
# Optional "keywords: ..." / "weight: ..." lines in the description; everything else is free-form notes
LABEL_PATTERN = re.compile(r"^\s*(keywords|weight)\s*:\s*(.*)$", re.IGNORECASE)
# An unlabelled first line holding only a weight hint such as "0.7", "0.5-0.7" or civitai's "1 (0.8 - 1.2)"
WEIGHT_ONLY_PATTERN = re.compile(r"^(?=.*\d)[\d.,\s\-–()]+$")
# A number with "," or "." as decimal separator. A "-" counts as a minus sign only when it isn't right after
# another number, so "0.5-0.7" is a range but "-0.5" (slider LoRAs) is negative
NUMBER_PATTERN = re.compile(r"(?<![\d.,])-?\d+(?:[.,]\d+)?")
# Larger numbers aren't weights, e.g. a resolution or a year on the first line
MAX_WEIGHT = 5
# Not allowed in a new LoRA name: path separators, characters Windows rejects, and ones that break "<lora:name:weight>"
INVALID_NAME_CHARS = set('/\\\0<>:"|?*')

def parse_weight(value: str) -> float | None:
    # The first plausible number: the lower bound of a range like "0.6-0.9",
    # the recommended value of civitai's "1 (0.8 - 1.2)", the "0.4" in "keep it low (0.4)"
    for number in NUMBER_PATTERN.findall(value):
        weight = float(number.replace(",", "."))
        if abs(weight) <= MAX_WEIGHT:
            return weight
    return None

def parse_description(text: str) -> tuple[str | None, float | None]:
    """Returns (keywords, weight) from a description text."""
    keywords = weight = None
    labelled = False
    for line in text.splitlines():
        match = LABEL_PATTERN.match(line)
        if not match:
            continue
        labelled = True
        label, value = match.group(1).lower(), match.group(2).strip()
        if label == "keywords" and keywords is None:
            keywords = value or None
        elif label == "weight" and weight is None:
            weight = parse_weight(value)

    if not labelled:
        # No labels: copy the whole text as keywords (easier to trim in the prompt than to assemble),
        # except a leading weight-only line such as "0.7", which becomes the weight
        lines = text.strip().splitlines()
        if lines and WEIGHT_ONLY_PATTERN.match(lines[0]):
            weight = parse_weight(lines[0])
            if weight is not None:
                lines = lines[1:]
        keywords = "\n".join(lines).strip() or None
    return keywords, weight

class LoraCatalog:
    def __init__(self):
        # Preview paths found by the last get_loras, keyed by LoRA name. Image requests are served from it,
        # so they don't hit the (possibly slow) drive on the server's event loop, and only listed names resolve
        self.image_paths: dict[str, str] = {}

    def get_lora_names(self) -> list[str]:
        return folder_paths.get_filename_list("loras")

    def list_dir(self, dir_path: str, dir_cache: dict) -> set[str]:
        # One scandir per folder instead of an isfile() per candidate sibling file
        if dir_path not in dir_cache:
            try:
                with os.scandir(dir_path) as entries:
                    dir_cache[dir_path] = {os.path.normcase(e.name) for e in entries if e.is_file()}
            except OSError:
                dir_cache[dir_path] = set()
        return dir_cache[dir_path]

    def file_exists(self, path: str, dir_cache: dict) -> bool:
        dir_path, filename = os.path.split(path)
        return os.path.normcase(filename) in self.list_dir(dir_path, dir_cache)

    def find_image(self, lora_full_path: str, dir_cache: dict) -> str | None:
        base_path = os.path.splitext(lora_full_path)[0]
        for suffix in IMAGE_SUFFIXES:
            image_path = base_path + suffix
            if self.file_exists(image_path, dir_cache):
                return image_path
        return None

    def read_description(self, lora_full_path: str, dir_cache: dict) -> str:
        txt_path = os.path.splitext(lora_full_path)[0] + ".txt"
        if not self.file_exists(txt_path, dir_cache):
            return ""
        try:
            with open(txt_path, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except Exception as e:
            print(f"[Lora Sidebar] Error reading description {txt_path}: {e}")
            return ""

    def get_loras(self) -> list[dict]:
        loras = []
        image_paths = {}
        # Directory listings shared across all LoRAs of this call, so each folder is read once
        dir_cache = {}
        for name in self.get_lora_names():
            full_path = folder_paths.get_full_path("loras", name)
            if not full_path:
                continue

            # Normalize separators so the frontend can split folders on "/"
            rel_name = name.replace(os.sep, "/")
            folder, filename = rel_name.rsplit("/", 1) if "/" in rel_name else ("", rel_name)
            image_path = self.find_image(full_path, dir_cache)
            title = os.path.splitext(filename)[0]
            author_match = AUTHOR_PATTERN.search(title)
            description = self.read_description(full_path, dir_cache)
            keywords, weight = parse_description(description)
            try:
                image_mtime = int(os.path.getmtime(image_path)) if image_path else None
            except OSError:
                image_mtime = None  # removed since the folder was listed
            if image_mtime is not None:
                image_paths[rel_name] = image_path
            try:
                size = os.path.getsize(full_path)
            except OSError:
                size = None

            loras.append({
                "name": rel_name,
                "folder": folder,
                "title": title,
                "author": author_match.group(1) if author_match else None,
                "description": description,
                "keywords": keywords,
                "weight": weight,
                "size": size,  # bytes
                # mtime doubles as a cache-buster for the image URL; None means "use placeholder"
                "image": image_mtime,
            })
        # Replaced as a whole, so a request during a refresh sees either the old or the new map
        self.image_paths = image_paths
        return sorted(loras, key=lambda l: l["name"].lower())

    def resolve_known(self, lora_name: str) -> str | None:
        # Only resolve names ComfyUI itself lists, so arbitrary paths can't be requested
        if not isinstance(lora_name, str):
            return None
        known = {n.replace(os.sep, "/") for n in self.get_lora_names()}
        if lora_name not in known:
            return None
        return folder_paths.get_full_path("loras", lora_name)

    def get_image_path(self, lora_name: str) -> str | None:
        return self.image_paths.get(lora_name)

    def find_sibling_files(self, dir_path: str, base: str) -> list[str]:
        """File names in dir_path belonging to the LoRA with this base name: the model itself and every
        "<base>.*" sidecar (previews, .txt, .sha256, .safetensors.rgthree-info.json, ...)."""
        with os.scandir(dir_path) as entries:
            names = [e.name for e in entries if e.is_file()]
        # Another LoRA extending this base (e.g. "style.v2" next to "style") owns its own "style.v2.*" files
        other_bases = [
            os.path.splitext(n)[0] for n in names
            if os.path.splitext(n)[1] in folder_paths.supported_pt_extensions
            and n.startswith(base + ".") and os.path.splitext(n)[0] != base
        ]
        return [
            n for n in names
            if n.startswith(base + ".") and not any(n.startswith(ob + ".") for ob in other_bases)
        ]

    def rename_lora(self, lora_name: str, new_title: str) -> str:
        """Renames the LoRA and its sidecar files within its folder. Returns the new LoRA name."""
        full_path = self.resolve_known(lora_name)
        if not full_path:
            raise LookupError(f"Unknown LoRA: {lora_name}")

        if not isinstance(new_title, str):
            raise ValueError("Invalid name")
        new_title = new_title.strip()
        if not new_title or new_title in (".", "..") or any(c in INVALID_NAME_CHARS for c in new_title):
            raise ValueError('Invalid name: it must not be empty or contain any of / \\ < > : " | ? *')

        dir_path, filename = os.path.split(full_path)
        base, ext = os.path.splitext(filename)
        folder = lora_name.rsplit("/", 1)[0] + "/" if "/" in lora_name else ""
        new_lora_name = folder + new_title + ext
        if new_title == base:
            return lora_name

        renames = [
            (os.path.join(dir_path, n), os.path.join(dir_path, new_title + n[len(base):]))
            for n in self.find_sibling_files(dir_path, base)
        ]
        # Check every target before touching anything; samefile allows case-only renames on case-insensitive filesystems
        conflicts = [
            os.path.basename(dst) for src, dst in renames
            if os.path.exists(dst) and not os.path.samefile(src, dst)
        ]
        if conflicts:
            raise FileExistsError(f"Already exists: {', '.join(conflicts)}")

        done = []
        try:
            for src, dst in renames:
                os.rename(src, dst)
                done.append((src, dst))
        except OSError:
            # Put back what was already renamed, so the LoRA isn't left half-renamed
            for src, dst in reversed(done):
                try:
                    os.rename(dst, src)
                except OSError as e:
                    print(f"[Lora Sidebar] Could not roll back rename {dst} -> {src}: {e}")
            raise

        # ComfyUI notices the changed folder mtime, but drop its cached list to be certain
        folder_paths.filename_list_cache.pop("loras", None)
        return new_lora_name

    def set_preview(self, lora_full_path: str, data: bytes, ext: str):
        """Saves data as the LoRA's preview "<base><ext>". Every existing preview moves to "<base>_old<suffix>"
        (numbered if that exists), so none of them takes precedence over the new one and nothing is lost."""
        base_path = os.path.splitext(lora_full_path)[0]
        moves = []
        for suffix in IMAGE_SUFFIXES:
            src = base_path + suffix
            if not os.path.isfile(src):
                continue
            dst, n = f"{base_path}_old{suffix}", 2
            while os.path.exists(dst) or any(dst == d for _, d in moves):
                dst, n = f"{base_path}_old{n}{suffix}", n + 1
            moves.append((src, dst))

        done = []
        try:
            for src, dst in moves:
                os.rename(src, dst)
                done.append((src, dst))
            with open(base_path + ext, 'wb') as f:
                f.write(data)
        except OSError:
            # Put the old previews back, so a failure doesn't leave the LoRA without one
            for src, dst in reversed(done):
                try:
                    os.rename(dst, src)
                except OSError as e:
                    print(f"[Lora Sidebar] Could not roll back preview move {dst} -> {src}: {e}")
            raise

    def write_description(self, lora_name: str, description: str):
        """Writes <base>.txt; an empty description removes the file."""
        full_path = self.resolve_known(lora_name)
        if not full_path:
            raise LookupError(f"Unknown LoRA: {lora_name}")
        if not isinstance(description, str):
            raise ValueError("Invalid description")
        txt_path = os.path.splitext(full_path)[0] + ".txt"
        description = description.strip()
        if description:
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write(description + "\n")
        elif os.path.isfile(txt_path):
            os.remove(txt_path)

lora_catalog = LoraCatalog()
civitai_client = CivitaiClient()

class LoraMixer:
    """Picks random LoRAs from a folder and outputs one "<lora:name:weight>, keywords" line per LoRA."""

    @classmethod
    def INPUT_TYPES(cls):
        weight = {"min": -MAX_WEIGHT, "max": MAX_WEIGHT, "step": 0.05}
        return {
            "required": {
                "path": ("STRING", {"default": "", "tooltip": "Folder within the LoRA directory, empty for its root"}),
                "include_subfolders": ("BOOLEAN", {"default": True}),
                "min_count": ("INT", {"default": 1, "min": 1, "max": 100, "tooltip": "Fewest distinct LoRAs to pick"}),
                "max_count": ("INT", {"default": 3, "min": 1, "max": 100, "tooltip": "Most distinct LoRAs to pick"}),
                "min_weight": ("FLOAT", {"default": 0.5, **weight}),
                "max_weight": ("FLOAT", {"default": 1.0, **weight}),
                # Without a changing input ComfyUI would cache the output and never pick again
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "mix"
    CATEGORY = "loaders"

    def mix(self, path, include_subfolders, min_count, max_count, min_weight, max_weight, seed):
        path = path.replace("\\", "/").strip().strip("/")
        candidates = []
        for name in lora_catalog.get_lora_names():
            rel_name = name.replace(os.sep, "/")
            folder = rel_name.rsplit("/", 1)[0] if "/" in rel_name else ""
            if folder == path or (include_subfolders and (not path or folder.startswith(path + "/"))):
                candidates.append(name)
        if not candidates:
            raise ValueError(f"LoRA Mixer: no LoRAs found in '{path}'")

        rng = random.Random(seed)
        count = rng.randint(*sorted((min_count, max_count)))
        low, high = sorted((min_weight, max_weight))
        dir_cache = {}
        lines = []
        for name in rng.sample(sorted(candidates), min(count, len(candidates))):
            full_path = folder_paths.get_full_path("loras", name)
            keywords, _ = parse_description(lora_catalog.read_description(full_path, dir_cache)) if full_path else (None, None)
            lora = os.path.splitext(name.replace(os.sep, "/"))[0]
            weight = round(rng.uniform(low, high), 2)
            line = f"<lora:{lora}:{weight}>"
            if keywords:
                # One line per LoRA, so multi-line keywords are joined
                line += ", " + ", ".join(l.strip() for l in keywords.splitlines() if l.strip())
            lines.append(line)
        return ("\n".join(lines),)

NODE_CLASS_MAPPINGS["LoraMixer"] = LoraMixer
NODE_DISPLAY_NAME_MAPPINGS["LoraMixer"] = "LoRA Mixer"

def error_response(e: Exception):
    status = {LookupError: 404, ValueError: 400, FileExistsError: 409, CivitaiNotFound: 404}.get(type(e), 500)
    return web.json_response({"error": str(e)}, status=status)

async def read_body(request) -> dict:
    # A malformed body is the client's fault: 400, not 500
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise ValueError("Invalid JSON body")
    if not isinstance(data, dict):
        raise ValueError("Invalid JSON body")
    return data

# The catalog's file operations run in a thread: on a slow (e.g. network mounted) LoRA drive they'd
# otherwise block the whole server, including the websocket and the queue

@PromptServer.instance.routes.get("/lora_sidebar/list")
async def get_loras_list(request):
    try:
        loras = await asyncio.to_thread(lora_catalog.get_loras)
        return web.json_response({"loras": loras})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.get("/lora_sidebar/image")
async def get_lora_image(request):
    try:
        lora_name = request.query.get("name", "")
        image_path = lora_catalog.get_image_path(lora_name)
        if not image_path:
            return web.json_response({"error": "Image not found"}, status=404)
        return web.FileResponse(image_path, headers={"Cache-Control": "max-age=86400"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/lora_sidebar/rename")
async def rename_lora(request):
    try:
        data = await read_body(request)
        new_name = await asyncio.to_thread(lora_catalog.rename_lora, data.get("name", ""), data.get("title", ""))
        return web.json_response({"name": new_name})
    except Exception as e:
        return error_response(e)

@PromptServer.instance.routes.post("/lora_sidebar/description")
async def save_description(request):
    try:
        data = await read_body(request)
        await asyncio.to_thread(lora_catalog.write_description, data.get("name", ""), data.get("description", ""))
        return web.json_response({"success": True})
    except Exception as e:
        return error_response(e)

@PromptServer.instance.routes.get("/lora_sidebar/civitai/cached")
async def get_cached_civitai_info(request):
    # Only answers from the session cache, so opening the dialog never hashes or hits the network
    full_path = lora_catalog.resolve_known(request.query.get("name", ""))
    sha_path = os.path.splitext(full_path)[0] + ".sha256" if full_path else None
    if not sha_path or not os.path.isfile(sha_path):
        return web.json_response({"info": None, "images": None})
    try:
        with open(sha_path, 'r', encoding='utf-8') as f:
            file_hash = f.read().strip().lower()
    except (OSError, UnicodeDecodeError) as e:
        # Not a hash we could have cached anyway; the fetch will report the details
        print(f"[Lora Sidebar] Could not read {sha_path}: {e}")
        return web.json_response({"info": None, "images": None})
    return web.json_response({
        "info": civitai_client.cache.get(file_hash),
        "images": civitai_client.image_cache.get(file_hash),
    })

@PromptServer.instance.routes.post("/lora_sidebar/civitai")
async def fetch_civitai_info(request):
    try:
        data = await read_body(request)
        full_path = lora_catalog.resolve_known(data.get("name", ""))
        if not full_path:
            raise LookupError(f"Unknown LoRA: {data.get('name', '')}")
        info = await civitai_client.get_info(full_path, refresh=bool(data.get("refresh")))
        return web.json_response({"info": info})
    except Exception as e:
        return error_response(e)

@PromptServer.instance.routes.post("/lora_sidebar/civitai/images")
async def fetch_civitai_images(request):
    try:
        data = await read_body(request)
        full_path = lora_catalog.resolve_known(data.get("name", ""))
        if not full_path:
            raise LookupError(f"Unknown LoRA: {data.get('name', '')}")
        images = await civitai_client.get_images(full_path, refresh=bool(data.get("refresh")))
        return web.json_response({"images": images})
    except Exception as e:
        return error_response(e)

@PromptServer.instance.routes.post("/lora_sidebar/civitai/preview")
async def set_civitai_preview(request):
    try:
        data = await read_body(request)
        full_path = lora_catalog.resolve_known(data.get("name", ""))
        if not full_path:
            raise LookupError(f"Unknown LoRA: {data.get('name', '')}")
        image, ext = await civitai_client.download_sample(full_path, data.get("url"))
        await asyncio.to_thread(lora_catalog.set_preview, full_path, image, ext)
        return web.json_response({"success": True})
    except Exception as e:
        return error_response(e)

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
