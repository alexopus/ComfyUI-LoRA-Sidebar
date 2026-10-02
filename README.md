# ComfyUI LoRA Sidebar

A ComfyUI sidebar for browsing your LoRAs as a grid of preview images, keeping your existing sub-folder structure. Plain files next to each LoRA hold the preview and description, no database or JSON.

## Features

- Grid view of every LoRA ComfyUI knows about (all configured `loras` paths)
- Folder navigation with breadcrumbs, mirroring the folders on disk
- Preview images and descriptions picked up from files next to each LoRA; cards show the first line of the description
- Placeholder tile when a LoRA has no preview image
- Filter by name or description (searches the current folder and everything below it)
- Author shown under the name and toggleable author tags to filter the current view, when the file name ends with `_[author]` (e.g. `Painterly_Style_[someone].safetensors`)
- Adjustable card size (saved in ComfyUI settings)
- Hover a card and use its copy button to copy the LoRA in Impact Pack wildcard syntax, e.g. `<lora:styles/my_lora:0.6>, my keyword`
- Click a card to open a details dialog with the full preview image, keywords, weight and the complete description
- Rename a LoRA (its preview, description and other `<name>.*` files are renamed with it) and edit its description from the dialog
- Fetch a LoRA's info from Civitai by its sha256 (name, author, base model, type, recommended strength, trained words, tags, description) with copy buttons and a link to the model page. The hash is read from `<name>.sha256`, or computed and saved there on the first fetch. Fetched info is kept only until ComfyUI restarts; copy what you want to keep into the description
- Show the Civitai sample images of a LoRA in a scrollable bar at the bottom of the details dialog. Hovering an image shows its prompt, negative prompt and generation settings (model, sampler, steps, CFG, seed, size, ...), selectable and with copy buttons, including one that copies everything in A1111's parameters format

## LoRA Mixer node

The `LoRA Mixer` node (category `loaders`) picks `count` different LoRAs at random from `path` (a folder within the LoRA directory, empty for its root, optionally including its sub-folders) and outputs one line per LoRA, each with a random weight between `min_weight` and `max_weight` and the LoRA's keywords:

```
<lora:styles/my_lora:0.73>, my_style, retro
<lora:styles/other_lora:0.51>
```

Change the `seed` to get a different pick; it's randomized after every run by default. Multi-line keywords are joined with `, ` to keep one line per LoRA. Feed the output into a wildcard or prompt node that understands `<lora:...>` (e.g. Impact Pack's).

## Preview images and descriptions

Put the files next to the LoRA, using the same base name:

```
loras/
  styles/
    my_lora.safetensors
    my_lora.png           <- preview image
    my_lora.txt           <- description
```

Image extensions checked, in order: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, then the same list as `.preview.<ext>` (e.g. `my_lora.preview.png`).

The description is plain text. Two optional lines are picked up for copying:

```
keywords: my_style, retro
weight: 0.6
Anything else is free-form notes.
```

The weight is the first number on its line, so a range such as `weight: 0.6-0.9` uses 0.6 and Civitai's `weight: 1 (0.8 - 1.2)` uses 1. Negative weights (`-0.5`) and a comma as decimal separator (`0,7`) work too. Without these lines, the whole text is copied as the keywords, except a first line that is only a weight such as `0.7`, which is used as the weight. When no weight is given, the `LoRA weight used when copying` setting is used.

## Settings

- `LoRA Card Size`: card width in the grid (also changed with the zoom buttons)
- `LoRA weight used when copying`: weight for LoRAs whose description has none
- `Allow renaming LoRAs and editing descriptions in the LoRA dialog`: on by default. Turning it off hides the edit controls, but the extension's rename and save endpoints stay reachable for anyone who can access your ComfyUI server

## Installation

Clone into ComfyUI's `custom_nodes/` directory and restart ComfyUI:

```
cd ComfyUI/custom_nodes
git clone https://github.com/alexopus/ComfyUI-LoRA-Sidebar
```
