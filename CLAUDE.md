# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A ComfyUI extension that adds a sidebar for browsing LoRAs: a grid of preview images with short descriptions, navigated by the LoRA sub-folder structure on disk. The details dialog can also rename a LoRA and edit its `.txt` description (can be turned off in settings). Sibling project of ComfyUI-Notes-Sidebar and follows the same structure.

## Architecture

### Backend (Python) — `__init__.py`
- **LoraCatalog**: discovers LoRAs via `folder_paths.get_filename_list("loras")` / `get_full_path`, finds sibling preview images and `.txt` descriptions. `get_loras` reads each folder once (`dir_cache` + set lookups) instead of an `isfile` per candidate file, which matters on the user's mounted LoRA drive.
- Sibling file convention: `<base>.<img ext>` then `<base>.preview.<img ext>` (see `IMAGE_SUFFIXES`), `<base>.txt`, and `<base>.sha256`.
- LoRA names are normalized to `/` separators before being sent to the frontend.
- Every endpoint resolves LoRAs through `resolve_known`, which only accepts names ComfyUI's LoRA list contains (the image endpoint through the equivalent `image_paths` map).
- List, rename and description handlers run the catalog in `asyncio.to_thread`, so a slow drive doesn't block the server.
- Renaming (`rename_lora`) changes only the base name, within the same folder, and takes every `<base>.*` sidecar along (previews, `.txt`, `.sha256`, rgthree's `.safetensors.rgthree-info.json`, ...), except files of another LoRA extending the base (`style.v2.*` next to `style`). All targets are checked for conflicts first; a failure midway rolls back. Clears `folder_paths.filename_list_cache["loras"]` afterwards.

- **LoraMixer** node ("LoRA Mixer", category `loaders`): `rng.sample` of distinct LoRAs from `path` (optionally with sub-folders), one `<lora:name:weight>, keywords` line each, weight uniform in [min, max] rounded to 2 decimals. The `seed` input is what makes ComfyUI re-run it instead of returning the cached output. Multi-line keywords are joined with `, `; an empty folder raises instead of silently outputting nothing.

### Civitai lookup — `civitai.py`
- **CivitaiClient**: sha256 from `<base>.sha256` (bare 64-char hex, the format other tools write), else computed in a thread and saved in that format (best effort, a read-only drive just skips saving); an invalid existing file is left untouched. A `.sha256` older than its LoRA is recomputed and overwritten (the LoRA was likely replaced by another version). The `/models/<modelId>` lookup is best effort too. Then `GET civitai.com/api/v1/model-versions/by-hash/<sha>` plus `/models/<modelId>` (creator, description, tags). Links point to `civitai.red`.
- Sample images (`get_images` / `build_images`) come from the same by-hash response, whose `images[].meta` holds prompt, negative prompt and generation settings (the same source rgthree-comfy uses). The raw response is cached per sha256 (`versions`), so the info and images buttons share one lookup, and concurrent hashing of the same file is deduplicated (`hashing`). Thumbnails swap the url's `/original=true/` for `/width=450/`; videos use the original url.
- `download_sample` fetches a thumbnail to become the preview, only accepting urls from that LoRA's sample list (no arbitrary url fetching); the extension comes from the response's content type. `LoraCatalog.set_preview` then moves every existing preview candidate (all `IMAGE_SUFFIXES`) to `<base>_old<suffix>` (`_old2`, ... if taken; outside `<base>.*`, so neither shown nor renamed with the LoRA) and writes `<base><ext>`, rolling the moves back on failure.
- Results are cached in memory per sha256 for the session only, by design: the `.txt` is the source of truth, and the user copies what they need from the civitai table into it. Only the `.sha256` is persisted.
- Recommended strength ("Usage Tips": `strength`, `minStrength`, `maxStrength`) is not in any public API endpoint, and the tRPC API refuses external calls. `fetch_version_settings` reads it best-effort from the model page's `__NEXT_DATA__` (object with our version id and a `settings` dict); failures just log and leave it empty. The page is fetched from civitai.com because civitai.red returns 403 to aiohttp. Empty `settings` means the author set none.

### Frontend (JavaScript) — `js/`
- `extension.js` — `LoraSidebar` class: UI creation, rendering, sidebar tab + settings registration, author tag bar, `<lora:...>` prompt building, clipboard (falls back to a hidden textarea + `execCommand('copy')` on non-secure origins like plain http on a LAN IP). Cards show only the first description line and the file name + size as tooltip; the dialog shows the rest. The filter input is debounced (`FILTER_DELAY_MS`). A toolbar dropdown (current order's icon + chevron, items as icon + text) picks the sort order: name, size desc or size asc; folder cards always stay alphabetical and first.
- `stores/LoraStore.js` — EventTarget state store (`loras`, `currentFolder`, `filter`, `selectedAuthors`, `sort`, `loading`, `error`) plus derived queries (`getSubfolders`, `getLorasIn`, `search`, `getAuthors`, `filterByAuthors`, `sortLoras`); name order is the backend's (sorted by full name), and size sorts are stable on top of it; navigating resets `selectedAuthors`. `setLoras`/`setError` also end loading, so a refresh is one state update and one grid render.
- `api/loraApi.js` — centralized fetch calls
- `components/LoraDialog.js` — native `<dialog>` opened by clicking a card: full image, info table, copy button, full description, rename/edit, and a civitai section (fetch button, then a table with per-row copy buttons and a "View on Civitai" link); the civitai part re-renders on its own so it can't reset an edit in progress. A "Sample images" button opens a bottom bar (the dialog becomes full height) with a horizontally scrolling strip of the civitai samples; hovering or focusing one shows its prompt/settings as selectable text with per-row copy buttons and a copy-all in A1111 parameters format. The bar element is created once and stays attached across `render()`, so edits don't reload images or reset its scroll. With editing allowed, each still sample has a "Use as preview" button; afterwards only the dialog's image is swapped (not a full `render()`), so an edit in progress survives
- `lora-sidebar.css` — dark theme styles; card size driven by the `--lora-card-size` CSS variable. The grid uses fixed-width columns (not `1fr`) so every zoom step visibly resizes cards, and `scrollbar-gutter: stable` so the column count doesn't change when the scrollbar appears; both were deliberate choices by the user.

## API Endpoints
- `GET /lora_sidebar/list` — `{loras: [{name, folder, title, author, description, keywords, weight, size, image}]}`; `size` is the LoRA file size in bytes (`null` if unreadable); `image` is the preview's mtime (cache-buster) or `null` for placeholder; `author` is parsed from a trailing `_[author]` in the base name (see `AUTHOR_PATTERN`), else `null`; `description` is the raw `.txt`, `keywords`/`weight` are parsed from it by `parse_description` (see Description convention)
- `GET /lora_sidebar/image?name=<lora name>` — serves the preview image from `LoraCatalog.image_paths`, the name → path map the last list call built. No drive lookups on the event loop, and only listed names resolve; a preview added since the last refresh shows after the next one.
- `POST /lora_sidebar/rename` `{name, title}` — renames to the new base name `title`; returns `{name: <new lora name>}`; 400 invalid name, 404 unknown LoRA, 409 target exists
- `POST /lora_sidebar/description` `{name, description}` — writes `<base>.txt`; empty removes it
- `GET /lora_sidebar/civitai/cached?name=<lora name>` — `{info, images}` from the session cache, each `null` if not fetched; never hashes or hits the network (used when the dialog opens)
- `POST /lora_sidebar/civitai/images` `{name, refresh}` — `{images: [{url, thumbnail, page, type, width, height, prompt, negativePrompt, settings: [[label, value], ...]}]}`; 404 when civitai doesn't know the hash
- `POST /lora_sidebar/civitai/preview` `{name, url}` — downloads a sample thumbnail (`url` must be one of the LoRA's sample `thumbnail`s, else 400) and makes it the preview, keeping the old ones as `<base>_old.*`
- `POST /lora_sidebar/civitai` `{name, refresh}` — `{info: {sha256, url, name, version, author, baseModel, type, strength, minStrength, maxStrength, trainedWords, tags, description, versionDescription}}`; 404 when civitai doesn't know the hash
- The write endpoints are always available; the `Allow Editing` setting only hides the UI.

## Development
- No build step. Python changes need a ComfyUI restart; JS/CSS changes need a browser refresh.
- CSS is loaded via `import.meta.url`, so the install folder name doesn't matter.
- Settings: `Lora Sidebar.Card Size` (80–320px, step 20), `Lora Sidebar.Default Weight` (0–2, step 0.05), `Lora Sidebar.Allow Editing` (boolean, default on), `Lora Sidebar.Sort Order` (`name` / `size-desc` / `size-asc`, also set by the toolbar dropdown).
- Card click opens the details dialog; the hover copy button copies `<lora:folder/title:weight>, keywords` (Impact Pack wildcard syntax). Weight is the parsed one, else the `Default Weight` setting.
- No automated tests. Manual check: sidebar tab "LoRAs" appears, folders navigate, previews/placeholders render, filter and author tags work, card opens the dialog, hover button copies the `<lora:...>` text, rename and description edit work in the dialog, civitai fetch fills the table, sample images open the bottom bar with hover settings, "Use as preview" replaces the preview and keeps the old one as `<name>_old.*`. Test renames and hashing on a scratch copy, never on the real LoRA folders.
- The backend can be exercised outside ComfyUI by stubbing the `folder_paths` and `server` modules in `sys.modules` and loading `__init__.py` with importlib as a package (`submodule_search_locations`), since it imports `.civitai` relatively.

## Description convention
Plain text, no structured format. Optional lines `keywords: ...` and `weight: ...` (any position, case-insensitive; first of each wins). Weight is the first number on the line with an absolute value ≤ `MAX_WEIGHT` (5): the lower bound of `0.6-0.9`, the recommended value of civitai's `1 (0.8 - 1.2)` (which the dialog's Strength row copies as a `weight:` line). `,` works as a decimal separator (`0,7`), and a `-` directly before a number that doesn't follow another number is a minus sign (`-0.5` for sliders; `0.5-0.7` stays a range). Without any label line, the whole text is the keywords (the user prefers trimming the pasted text over assembling it), except a leading numbers-only line (`0.7`, `0.5-0.7`, `1 (0.8 - 1.2)`) that yields a weight; a first line like `512` or `2024` stays in the keywords.
