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
     */
    constructor(lora, options) {
        this.lora = lora;
        this.options = options;
        this.editing = null; // null, 'title' or 'description'
        this.saving = false;
        this.civitai = { status: 'idle', info: null, error: null }; // status: idle, loading, loaded, error
        this.civitaiSection = null;

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
            const info = await this.options.getCachedCivitai(this.lora);
            if (info && this.civitai.status === 'idle') this.setCivitai({ status: 'loaded', info });
        } catch (error) {
            console.error('Error reading cached civitai info:', error);
        }
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
        this.container.innerHTML = '';
        this.container.appendChild(this.createHeader());
        this.container.appendChild(this.createBody());
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

        if (status === 'loaded') {
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

        const message = document.createElement('div');
        message.className = 'lora-dialog-civitai-message';

        if (status === 'loading') {
            message.innerHTML = '<i class="pi pi-spin pi-spinner"></i> ';
            message.append('Looking up on civitai (hashing the file first if there is no .sha256 yet)...');
            section.appendChild(message);
            return;
        }

        const fetchButton = document.createElement('button');
        fetchButton.className = 'lora-btn lora-dialog-btn lora-dialog-text-btn';
        fetchButton.innerHTML = `<i class="pi pi-cloud-download"></i> ${status === 'error' ? 'Try again' : 'Fetch from Civitai'}`;
        fetchButton.onclick = () => this.fetchCivitai(status === 'error');
        heading.appendChild(fetchButton);

        if (status === 'error') {
            message.classList.add('error');
            message.textContent = error;
            section.appendChild(message);
        }
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

    createIconButton(iconClass, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'lora-btn lora-dialog-btn';
        btn.title = title;
        btn.innerHTML = `<i class="${iconClass}"></i>`;
        btn.onclick = onClick;
        return btn;
    }
}
