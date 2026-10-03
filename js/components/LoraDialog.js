import { LoraApi } from "../api/loraApi.js";

// Civitai model types that are expected in the loras folder; anything else is flagged
const LORA_TYPES = ['LORA', 'LoCon', 'DoRA'];

// e.g. "218 MB", "1.6 GB"
export function formatSize(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// Civitai "Usage Tips", e.g. "1 (0.8 - 1.2)"; empty when the author set none
function formatStrength({ strength, minStrength, maxStrength }) {
    const range = minStrength != null && maxStrength != null ? `${minStrength} - ${maxStrength}` : '';
    if (strength == null) return range;
    return range ? `${strength} (${range})` : String(strength);
}

// A sample's prompt and settings as A1111 writes them, which most prompt tools can paste
function formatParameters({ prompt, negativePrompt, settings }) {
    const lines = [];
    if (prompt) lines.push(prompt);
    if (negativePrompt) lines.push(`Negative prompt: ${negativePrompt}`);
    if (settings.length) lines.push(settings.map(([label, value]) => `${label}: ${value}`).join(', '));
    return lines.join('\n');
}

/**
 * Modal with the full preview image, parsed info and the complete description of one LoRA,
 * optionally with renaming and description editing.
 * Closes on Escape, the close button, or a click outside the content; removes itself when closed.
 */
export class LoraDialog {
    /**
     * @param lora LoRA object from the store
     * @param options.canEdit show rename / edit controls
     * @param options.defaultWeight weight shown when the LoRA has none
     * @param options.buildPrompt (lora) => text copied to the clipboard
     * @param options.onCopy (lora) => void
     * @param options.onRename (lora, title) => Promise<updated lora>; rejects to stay in edit mode
     * @param options.onSaveDescription (lora, text) => Promise<updated lora>; rejects to stay in edit mode
     * @param options.onCopyText (text) => void
     * @param options.getCachedCivitai (lora) => Promise<info | null>, from this session's cache only
     * @param options.fetchCivitai (lora, refresh) => Promise<info>; may hash the file first
     * @param options.fetchCivitaiImages (lora, refresh) => Promise<images>; may hash the file first
     * @param options.onSetPreview (lora, image) => Promise<updated lora>; makes a sample image the preview
     */
    constructor(lora, options) {
        this.lora = lora;
        this.options = options;
        this.editing = null; // null, 'title' or 'description'
        this.saving = false;
        this.civitai = { status: 'idle', info: null, error: null }; // status: idle, loading, loaded, error
        this.civitaiSection = null;
        this.samples = { status: 'idle', images: null, error: null }; // same statuses as civitai
        this.samplesVisible = false;
        // Created once and kept across render(), so editing doesn't reload the images or reset the scroll position
        this.samplesBar = document.createElement('div');
        this.samplesBar.className = 'lora-samples';

        this.element = document.createElement('dialog');
        this.element.className = 'lora-dialog';

        this.container = document.createElement('div');
        this.container.className = 'lora-dialog-container';
        this.element.appendChild(this.container);

        // The container fills the <dialog>, so only backdrop clicks target the dialog element itself.
        // (Checking container.contains(target) fails for buttons that re-render, as they're detached by then.)
        this.element.addEventListener('click', (event) => {
            if (event.target === this.element) this.close();
        });
        // Escape while editing cancels the edit instead of closing the dialog
        this.element.addEventListener('cancel', (event) => {
            if (this.editing) {
                event.preventDefault();
                this.setEditing(null);
            }
        });
        this.element.addEventListener('close', () => this.element.remove());

        this.render();
        this.loadCachedCivitai();
    }

    async loadCachedCivitai() {
        try {
            const { info, images } = await this.options.getCachedCivitai(this.lora);
            if (info && this.civitai.status === 'idle') this.setCivitai({ status: 'loaded', info });
            if (images && this.samples.status === 'idle') {
                this.samples = { status: 'loaded', images, error: null };
                this.setSamplesVisible(true);
            }
        } catch (error) {
            console.error('Error reading cached civitai info:', error);
        }
    }

    async fetchSamples(refresh = false) {
        this.setSamples({ status: 'loading' });
        try {
            const images = await this.options.fetchCivitaiImages(this.lora, refresh);
            this.setSamples({ status: 'loaded', images });
        } catch (error) {
            this.setSamples({ status: 'error', error: error.message });
        }
    }

    setSamples(state) {
        this.samples = { images: null, error: null, ...state };
        this.renderSamples();
    }

    // Shows the bar, fetching the images unless they're already here (or on their way)
    openSamples() {
        // Start the fetch first, so the bar's first render already shows it loading
        if (this.samples.status === 'idle' || this.samples.status === 'error') this.fetchSamples(this.samples.status === 'error');
        this.setSamplesVisible(true);
    }

    // The dialog takes the full height while the bar is shown, to give the images room
    setSamplesVisible(visible) {
        this.samplesVisible = visible;
        this.element.classList.toggle('lora-dialog-tall', visible);
        if (visible) {
            this.container.appendChild(this.samplesBar);
        } else {
            this.samplesBar.remove();
        }
        this.renderCivitai(); // its heading has the button that opens the bar
        this.renderSamples();
    }

    async fetchCivitai(refresh = false) {
        this.setCivitai({ status: 'loading' });
        try {
            const info = await this.options.fetchCivitai(this.lora, refresh);
            this.setCivitai({ status: 'loaded', info });
        } catch (error) {
            this.setCivitai({ status: 'error', error: error.message });
        }
    }

    setCivitai(state) {
        this.civitai = { info: null, error: null, ...state };
        this.renderCivitai();
    }

    show() {
        document.body.appendChild(this.element);
        this.element.showModal();
        return this;
    }

    close() {
        this.element.close();
    }

    setEditing(editing) {
        this.editing = editing;
        this.render();
    }

    render() {
        // The samples bar stays attached: detaching it would reset its scroll position
        for (const child of [...this.container.children]) {
            if (child !== this.samplesBar) child.remove();
        }
        this.container.prepend(this.createHeader(), this.createBody());
        this.container.querySelector('[data-autofocus]')?.focus();
    }

    createHeader() {
        const header = document.createElement('div');
        header.className = 'lora-dialog-header';

        if (this.editing === 'title') {
            header.appendChild(this.createTitleEditor());
        } else {
            const title = document.createElement('h2');
            title.className = 'lora-dialog-title';
            title.textContent = this.lora.title;
            title.title = this.lora.title;
            header.appendChild(title);

            if (this.options.canEdit) {
                header.appendChild(this.createIconButton('pi pi-pencil', 'Rename', () => this.setEditing('title')));
            }
        }

        header.appendChild(this.createIconButton('pi pi-times', 'Close', () => this.close()));
        return header;
    }

    createTitleEditor() {
        const editor = document.createElement('div');
        editor.className = 'lora-dialog-title-editor';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'lora-dialog-input';
        input.value = this.lora.title;
        input.dataset.autofocus = '';

        const save = () => this.runEdit(() => this.options.onRename(this.lora, input.value));
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) save();
        });

        const row = document.createElement('div');
        row.className = 'lora-dialog-edit-row';
        row.appendChild(input);
        row.appendChild(this.createIconButton('pi pi-check', 'Save (Enter)', save));
        row.appendChild(this.createIconButton('pi pi-undo', 'Cancel (Esc)', () => this.setEditing(null)));

        const hint = document.createElement('div');
        hint.className = 'lora-dialog-hint';
        hint.textContent = 'Renames the LoRA and all its "<name>.*" files (preview, .txt, .sha256, ...). '
            + 'Workflows and prompts using the old name have to be updated.';

        editor.appendChild(row);
        editor.appendChild(hint);
        return editor;
    }

    createBody() {
        const body = document.createElement('div');
        body.className = 'lora-dialog-body';
        body.appendChild(this.createImage());
        body.appendChild(this.createInfo());
        return body;
    }

    createImage() {
        const imageArea = document.createElement('div');
        imageArea.className = 'lora-dialog-image';

        const imageUrl = LoraApi.getImageUrl(this.lora);
        const setPlaceholder = () => {
            imageArea.classList.add('lora-card-placeholder');
            imageArea.innerHTML = '<i class="pi pi-image"></i>';
        };

        if (imageUrl) {
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = this.lora.title;
            img.onerror = setPlaceholder;
            imageArea.appendChild(img);
        } else {
            setPlaceholder();
        }
        return imageArea;
    }

    createInfo() {
        const info = document.createElement('div');
        info.className = 'lora-dialog-info';

        const table = document.createElement('table');
        table.className = 'lora-dialog-table';
        this.addRow(table, 'File', this.lora.name);
        if (this.lora.size != null) {
            this.addRow(table, 'Size', formatSize(this.lora.size));
        }
        if (this.lora.author) {
            this.addRow(table, 'Author', this.lora.author, 'lora-dialog-author');
        }
        this.addRow(table, 'Keywords', this.lora.keywords || '—');
        this.addRow(table, 'Weight', this.lora.weight ?? `${this.options.defaultWeight} (default)`);
        info.appendChild(table);

        info.appendChild(this.createCopyArea());
        this.addDescription(info);

        this.civitaiSection = document.createElement('div');
        this.civitaiSection.className = 'lora-dialog-civitai';
        info.appendChild(this.civitaiSection);
        this.renderCivitai();
        return info;
    }

    // Re-renders only the civitai part, so a finished fetch doesn't reset an edit in progress
    renderCivitai() {
        const section = this.civitaiSection;
        if (!section) return;
        section.innerHTML = '';
        const { status, info, error } = this.civitai;

        const heading = document.createElement('div');
        heading.className = 'lora-dialog-section';
        const label = document.createElement('span');
        label.textContent = 'Civitai';
        heading.appendChild(label);
        section.appendChild(heading);

        // Independent of the info lookup; hidden while the bar is open (the bar has its own hide button)
        const samplesButton = this.samplesVisible ? null : this.createTextButton('pi pi-images', 'Sample images', () => this.openSamples());

        if (status === 'loaded') {
            if (samplesButton) heading.appendChild(samplesButton);
            if (info.url) {
                const link = document.createElement('a');
                link.className = 'lora-dialog-link';
                link.href = info.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.innerHTML = '<i class="pi pi-external-link"></i> View on Civitai';
                heading.appendChild(link);
            }
            heading.appendChild(this.createIconButton('pi pi-refresh', 'Fetch again', () => this.fetchCivitai(true)));
            section.appendChild(this.createCivitaiTable(info));
            return;
        }

        if (status === 'loading') {
            if (samplesButton) heading.appendChild(samplesButton);
            section.appendChild(this.createLoadingMessage());
            return;
        }

        heading.appendChild(this.createTextButton('pi pi-cloud-download', status === 'error' ? 'Try again' : 'Fetch from Civitai',
            () => this.fetchCivitai(status === 'error')));
        if (samplesButton) heading.appendChild(samplesButton);

        if (status === 'error') {
            const message = document.createElement('div');
            message.className = 'lora-dialog-civitai-message error';
            message.textContent = error;
            section.appendChild(message);
        }
    }

    createLoadingMessage() {
        const message = document.createElement('div');
        message.className = 'lora-dialog-civitai-message';
        message.innerHTML = '<i class="pi pi-spin pi-spinner"></i> ';
        message.append('Looking up on civitai (hashing the file first if there is no .sha256 yet)...');
        return message;
    }

    // Bottom bar with a horizontally scrolling strip of the civitai sample images
    renderSamples() {
        const bar = this.samplesBar;
        if (!this.samplesVisible) return;
        bar.innerHTML = '';
        const { status, images, error } = this.samples;

        const heading = document.createElement('div');
        heading.className = 'lora-dialog-section';
        const label = document.createElement('span');
        label.textContent = status === 'loaded' ? `Sample images (${images.length})` : 'Sample images';
        heading.appendChild(label);
        if (status === 'loaded') {
            heading.appendChild(this.createIconButton('pi pi-refresh', 'Fetch again', () => this.fetchSamples(true)));
        }
        const hideButton = this.createIconButton('pi pi-chevron-down', 'Hide sample images', () => this.setSamplesVisible(false));
        hideButton.classList.add('lora-samples-hide');
        heading.appendChild(hideButton);
        bar.appendChild(heading);

        if (status === 'loading' || status === 'idle') {
            bar.appendChild(this.createLoadingMessage());
            return;
        }
        if (status === 'error') {
            heading.insertBefore(this.createTextButton('pi pi-cloud-download', 'Try again', () => this.fetchSamples(true)), hideButton);
            const message = document.createElement('div');
            message.className = 'lora-dialog-civitai-message error';
            message.textContent = error;
            bar.appendChild(message);
            return;
        }
        if (!images.length) {
            const message = document.createElement('div');
            message.className = 'lora-dialog-civitai-message';
            message.textContent = 'Civitai has no sample images for this version.';
            bar.appendChild(message);
            return;
        }

        const strip = document.createElement('div');
        strip.className = 'lora-samples-strip';
        // A vertical wheel scrolls the strip sideways, except over the (scrollable) settings
        strip.addEventListener('wheel', (event) => {
            if (event.deltaX || !event.deltaY || event.target.closest('.lora-sample-overlay')) return;
            strip.scrollLeft += event.deltaY;
            event.preventDefault();
        }, { passive: false });
        for (const image of images) strip.appendChild(this.createSample(image));
        bar.appendChild(strip);
    }

    createSample(image) {
        const item = document.createElement('div');
        item.className = 'lora-sample';
        if (image.width && image.height) item.style.aspectRatio = `${image.width} / ${image.height}`;

        // The image opens its civitai page; the settings overlay is a sibling, so selecting text doesn't navigate
        const link = document.createElement('a');
        link.href = image.page || image.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = 'Open on Civitai';

        if (image.type === 'video') {
            const video = document.createElement('video');
            video.src = image.thumbnail;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = 'metadata';
            item.addEventListener('mouseenter', () => video.play().catch(() => {}));
            item.addEventListener('mouseleave', () => video.pause());
            link.appendChild(video);
        } else {
            const img = document.createElement('img');
            img.src = image.thumbnail;
            img.loading = 'lazy';
            img.alt = '';
            link.appendChild(img);
        }
        item.appendChild(link);

        if (image.prompt || image.negativePrompt || image.settings.length) {
            item.appendChild(this.createSampleOverlay(image));
        }
        // A preview has to be a still image
        if (this.options.canEdit && image.type === 'image') {
            const coverButton = this.createIconButton('pi pi-image', 'Use as preview (the current one is kept as "<name>_old.*")',
                () => this.setPreview(image, coverButton));
            coverButton.classList.add('lora-sample-cover-btn');
            item.appendChild(coverButton);
        }
        return item;
    }

    // Prompt and settings shown on hover (or keyboard focus); plain text, so it can be selected and copied
    createSampleOverlay(image) {
        const overlay = document.createElement('div');
        overlay.className = 'lora-sample-overlay';

        const toolbar = document.createElement('div');
        toolbar.className = 'lora-sample-toolbar';
        toolbar.appendChild(this.createIconButton('pi pi-copy', 'Copy all (A1111 parameters format)',
            () => this.options.onCopyText(formatParameters(image))));
        overlay.appendChild(toolbar);

        const table = document.createElement('table');
        table.className = 'lora-dialog-table';
        this.addCopyRow(table, 'Prompt', image.prompt, 'lora-dialog-long');
        this.addCopyRow(table, 'Negative', image.negativePrompt, 'lora-dialog-long');
        for (const [label, value] of image.settings) this.addCopyRow(table, label, value);
        overlay.appendChild(table);
        return overlay;
    }

    createCivitaiTable(info) {
        const table = document.createElement('table');
        table.className = 'lora-dialog-table';

        const name = [info.name, info.version].filter(Boolean).join(' - ');
        const isLoraType = !info.type || LORA_TYPES.includes(info.type);

        this.addCopyRow(table, 'Name', name);
        this.addCopyRow(table, 'Author', info.author, 'lora-dialog-author');
        this.addCopyRow(table, 'Base model', info.baseModel);
        this.addCopyRow(table, 'Type', isLoraType ? info.type : `${info.type} (not a LoRA)`,
            isLoraType ? '' : 'lora-dialog-warning');
        // Copied as a "weight:" line, ready to paste into the description
        const strength = formatStrength(info);
        this.addCopyRow(table, 'Strength', strength, '', strength && `weight: ${strength}`);
        this.addCopyRow(table, 'Trained words', info.trainedWords.join(', '));
        this.addCopyRow(table, 'Tags', info.tags.join(', '));
        this.addCopyRow(table, 'Description', info.description, 'lora-dialog-long');
        this.addCopyRow(table, 'Version notes', info.versionDescription, 'lora-dialog-long');
        this.addCopyRow(table, 'SHA256', info.sha256, 'lora-dialog-hash');
        return table;
    }

    // A row whose value can be copied; skipped when there is no value
    addCopyRow(table, label, value, valueClass = '', copyValue = value) {
        if (!value) return;
        const row = table.insertRow();
        row.className = 'lora-dialog-copy-row';

        const labelCell = row.insertCell();
        labelCell.className = 'lora-dialog-label';
        labelCell.textContent = label;

        const valueCell = row.insertCell();
        const valueText = document.createElement('div');
        valueText.className = valueClass;
        valueText.textContent = value;
        valueCell.appendChild(valueText);

        const copyButton = this.createIconButton('pi pi-copy', `Copy ${label.toLowerCase()}`, () => this.options.onCopyText(copyValue));
        copyButton.classList.add('lora-dialog-copy-btn');
        valueCell.appendChild(copyButton);
    }

    addRow(table, label, value, valueClass = '') {
        const row = table.insertRow();
        const labelCell = row.insertCell();
        labelCell.className = 'lora-dialog-label';
        labelCell.textContent = label;
        const valueCell = row.insertCell();
        valueCell.className = valueClass;
        valueCell.textContent = value;
    }

    createCopyArea() {
        const copyArea = document.createElement('div');
        copyArea.className = 'lora-dialog-copy';

        const preview = document.createElement('code');
        preview.textContent = this.options.buildPrompt(this.lora);

        copyArea.appendChild(preview);
        copyArea.appendChild(this.createIconButton('pi pi-copy', 'Copy to clipboard', () => this.options.onCopy(this.lora)));
        return copyArea;
    }

    addDescription(parent) {
        const { canEdit } = this.options;
        if (!this.lora.description && !canEdit) return;

        const heading = document.createElement('div');
        heading.className = 'lora-dialog-section';
        const label = document.createElement('span');
        label.textContent = 'Description';
        heading.appendChild(label);
        parent.appendChild(heading);

        if (this.editing === 'description') {
            const textarea = document.createElement('textarea');
            textarea.className = 'lora-dialog-input lora-dialog-textarea';
            textarea.value = this.lora.description;
            textarea.placeholder = 'keywords: ...\nweight: ...\nNotes';
            textarea.dataset.autofocus = '';

            const save = () => this.runEdit(() => this.options.onSaveDescription(this.lora, textarea.value));
            textarea.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save();
            });

            heading.appendChild(this.createIconButton('pi pi-check', 'Save (Ctrl+Enter)', save));
            heading.appendChild(this.createIconButton('pi pi-undo', 'Cancel (Esc)', () => this.setEditing(null)));
            parent.appendChild(textarea);
            return;
        }

        if (canEdit) {
            heading.appendChild(this.createIconButton('pi pi-pencil', 'Edit description', () => this.setEditing('description')));
        }

        const description = document.createElement('pre');
        description.className = 'lora-dialog-description' + (this.lora.description ? '' : ' empty');
        description.textContent = this.lora.description || 'No description yet';
        parent.appendChild(description);
    }

    // Swaps only the preview image afterwards, so an edit in progress isn't reset
    async setPreview(image, button) {
        if (this.saving) return;
        this.saving = true;
        const icon = button.querySelector('i');
        icon.className = 'pi pi-spin pi-spinner';
        let updated;
        try {
            updated = await this.options.onSetPreview(this.lora, image);
        } catch {
            return; // the callback reports the error
        } finally {
            this.saving = false;
            icon.className = 'pi pi-image';
        }
        if (!updated) {
            this.close(); // the LoRA is gone from the refreshed list
            return;
        }
        this.lora = updated;
        this.container.querySelector('.lora-dialog-image')?.replaceWith(this.createImage());
    }

    // Runs a save callback; on success shows the updated LoRA, on failure stays in edit mode
    async runEdit(saveFn) {
        if (this.saving) return;
        this.saving = true;
        let updated;
        try {
            updated = await saveFn();
        } catch {
            return; // the callback reports the error
        } finally {
            this.saving = false;
        }
        if (!updated) {
            this.close(); // the LoRA is gone from the refreshed list
            return;
        }
        this.lora = updated;
        this.setEditing(null);
    }

    createTextButton(iconClass, text, onClick) {
        const btn = document.createElement('button');
        btn.className = 'lora-btn lora-dialog-btn lora-dialog-text-btn';
        btn.innerHTML = `<i class="${iconClass}"></i> `;
        btn.append(text);
        btn.onclick = onClick;
        return btn;
    }

    createIconButton(iconClass, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'lora-btn lora-dialog-btn';
        btn.title = title;
        btn.innerHTML = `<i class="${iconClass}"></i>`;
        btn.onclick = onClick;
        return btn;
    }
}
