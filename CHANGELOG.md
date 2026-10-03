# Changelog

## 0.6.0 - 2026-10-03

### Changed
- LoRA Mixer: the `count` input is replaced by `min_count` and `max_count`; each run picks a random number of LoRAs in that range. Saved workflows using the node need its inputs re-checked, since the widget values shift by one.

## 0.5.1 - 2026-10-03

### Fixed
- The copy buttons in a sample image's settings overlay are smaller, so they fit within one-line rows.

## 0.5.0 - 2026-10-03

### Added
- `Use as preview` button on each Civitai sample image (still images only, shown when editing is allowed): downloads the image and makes it the LoRA's preview. The current preview is renamed to `<name>_old.<ext>` (`_old2`, ... if that exists), so it isn't lost.

## 0.4.1 - 2026-10-02

### Changed
- The details dialog is wider (up to 1600px instead of 1100px), giving the sample images strip more room.

## 0.4.0 - 2026-10-02

### Added
- `Sample images` button in the details dialog's Civitai section: opens a bar at the bottom of the dialog (which then takes the full height) with a horizontally scrolling strip of the LoRA version's sample images from Civitai. Hovering or focusing an image shows its prompt, negative prompt and generation settings as selectable text, with a copy button per row and one that copies everything in A1111's parameters format. Images without a prompt or settings show no overlay; clicking an image opens its Civitai page.

### Changed
- The Civitai info and sample images share one lookup per session, and a LoRA is hashed only once when both are fetched at the same time.

## 0.3.0 - 2026-09-29

### Added
- `LoRA Mixer` node: picks a number of distinct random LoRAs from a folder (optionally with its sub-folders) and outputs one `<lora:name:weight>, keywords` line each, with a random weight in a given range.

## 0.2.1 - 2026-09-27

### Changed
- The sort button now opens a dropdown listing each order with its icon and name, instead of cycling through the orders on each click. The button shows the current order's icon.

## 0.2.0 - 2026-09-27

### Added
- Sort LoRAs by name (default) or by file size, largest or smallest first. A toolbar button cycles through the orders, and the choice is saved in the `Lora Sidebar.Sort Order` setting. Folders always stay alphabetical and on top.
- The card tooltip shows the LoRA's file size under its file name.

## 0.1.0 - 2026-09-27

- Initial release.
