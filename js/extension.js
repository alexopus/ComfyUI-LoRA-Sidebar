import { app } from "/scripts/app.js";
import { LoraStore } from "./stores/LoraStore.js";
import { LoraApi } from "./api/loraApi.js";
import { LoraDialog } from "./components/LoraDialog.js";

// Load CSS relative to this module, so it works regardless of the install folder name
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = new URL('./lora-sidebar.css', import.meta.url).href;
document.head.appendChild(link);

const CARD_SIZE_SETTING = 'Lora Sidebar.Card Size';
const MIN_CARD_SIZE = 80;
const MAX_CARD_SIZE = 320;
const CARD_SIZE_STEP = 20;
const WEIGHT_SETTING = 'Lora Sidebar.Default Weight';
const EDITING_SETTING = 'Lora Sidebar.Allow Editing';
const FILTER_DELAY_MS = 150;

class LoraSidebar {
    constructor() {
        this.store = new LoraStore();
        this.sidebarElement = null;
        this.breadcrumb = null;
        this.filterInput = null;
        this.authorTags = null;
        this.grid = null;
        this.filterTimer = null;
        this.isInitialized = false;
        this.cardSize = 140;

        // Listen to state changes
        this.store.addEventListener('stateChanged', (event) => {
            this.onStateChanged(event.detail);
        });
    }

    onStateChanged(changeDetails) {
        const { updates } = changeDetails;

        if (updates.currentFolder !== undefined) {
            this.renderBreadcrumb();
        }

        // Starting a load only changes the view when there's nothing to show yet ("Loading...");
        // a refresh otherwise keeps the current grid until the new list arrives
        const startedLoadingEmpty = updates.loading === true && this.loras.length === 0;
        if (updates.loras || updates.currentFolder !== undefined || updates.filter !== undefined
            || updates.selectedAuthors !== undefined || updates.error !== undefined || startedLoadingEmpty) {
            this.renderGrid();
        }
    }

    get loras() { return this.store.state.loras; }
    get currentFolder() { return this.store.state.currentFolder; }
    get filter() { return this.store.state.filter; }

    init() {
        this.cardSize = app.extensionManager.setting.get(CARD_SIZE_SETTING) || 140;
        // Not awaited: the tab shows "Loading..." instead of delaying startup on a slow LoRA drive
        this.loadLoras();
    }

    createSidebarContent(el) {
        // Ensure the parent element has proper height
        el.style.height = '100%';
        el.style.display = 'flex';
        el.style.flexDirection = 'column';

        // If already initialized, just re-attach the existing content
        if (this.isInitialized && this.sidebarElement) {
            el.innerHTML = '';
            el.appendChild(this.sidebarElement);
            return;
        }

        this.sidebarElement = document.createElement('div');
        this.sidebarElement.className = 'lora-sidebar';

        this.createToolbar(this.sidebarElement);
        this.createFilterContainer(this.sidebarElement);
        this.createAuthorTags(this.sidebarElement);
        this.createGrid(this.sidebarElement);

        el.appendChild(this.sidebarElement);
        this.isInitialized = true;

        this.updateCardSize();
        this.renderBreadcrumb();
        this.renderGrid();
    }

    createToolbar(parent) {
        const toolbar = document.createElement('div');
        toolbar.className = 'lora-toolbar';

        this.breadcrumb = document.createElement('div');
        this.breadcrumb.className = 'lora-breadcrumb';

        const rightControls = document.createElement('div');
        rightControls.className = 'lora-toolbar-controls';

        const zoomButtonGroup = document.createElement('div');
        zoomButtonGroup.className = 'lora-button-group';
        zoomButtonGroup.appendChild(this.createButton('pi pi-search-minus', 'Smaller cards', () => this.zoomOut()));
        zoomButtonGroup.appendChild(this.createButton('pi pi-search-plus', 'Larger cards', () => this.zoomIn()));

        const refreshButtonGroup = document.createElement('div');
        refreshButtonGroup.className = 'lora-button-group';
        refreshButtonGroup.appendChild(this.createButton('pi pi-refresh', 'Refresh', () => this.loadLoras()));

        rightControls.appendChild(zoomButtonGroup);
        rightControls.appendChild(refreshButtonGroup);

        toolbar.appendChild(this.breadcrumb);
        toolbar.appendChild(rightControls);
        parent.appendChild(toolbar);
    }

    createButton(iconClass, title, onClick) {
        const btn = document.createElement('button');
        btn.innerHTML = `<i class="${iconClass}"></i>`;
        btn.className = 'lora-btn';
        btn.title = title;
        btn.onclick = onClick;
        return btn;
    }

    createFilterContainer(parent) {
        const filterContainer = document.createElement('div');
        filterContainer.className = 'lora-filter-container';

        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'lora-filter-input-wrapper';

        this.filterInput = document.createElement('input');
        this.filterInput.type = 'text';
        this.filterInput.className = 'lora-filter-input';
        this.filterInput.placeholder = 'Filter LoRAs in this folder...';
        this.filterInput.value = this.filter;
        // Filter once typing pauses, instead of rebuilding the grid on every keystroke
        this.filterInput.addEventListener('input', () => {
            clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => this.store.setFilter(this.filterInput.value.trim()), FILTER_DELAY_MS);
        });

        const clearButton = document.createElement('button');
        clearButton.className = 'lora-filter-clear';
        clearButton.innerHTML = '<i class="pi pi-times-circle"></i>';
        clearButton.title = 'Clear filter';
        clearButton.addEventListener('click', () => this.clearFilter());

        inputWrapper.appendChild(this.filterInput);
        inputWrapper.appendChild(clearButton);
        filterContainer.appendChild(inputWrapper);
        parent.appendChild(filterContainer);
    }

    createAuthorTags(parent) {
        this.authorTags = document.createElement('div');
        this.authorTags.className = 'lora-author-tags';
        parent.appendChild(this.authorTags);
    }

    createGrid(parent) {
        const scrollArea = document.createElement('div');
        scrollArea.className = 'lora-grid-scroll';

        this.grid = document.createElement('div');
        this.grid.className = 'lora-grid';

        scrollArea.appendChild(this.grid);
        parent.appendChild(scrollArea);
    }

    async loadLoras() {
        this.store.startLoading();
        try {
            this.store.setLoras(await LoraApi.getLoras());
        } catch (error) {
            this.store.setError(error.message);
        }
    }

    renderBreadcrumb() {
        if (!this.breadcrumb) return;
        this.breadcrumb.innerHTML = '';

        const parts = this.currentFolder ? this.currentFolder.split('/') : [];
        const crumbs = [{ label: 'loras', path: '' }];
        parts.forEach((part, i) => crumbs.push({ label: part, path: parts.slice(0, i + 1).join('/') }));

        crumbs.forEach((crumb, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'lora-breadcrumb-sep';
                sep.textContent = '/';
                this.breadcrumb.appendChild(sep);
            }
            const btn = document.createElement('button');
            btn.className = 'lora-breadcrumb-item' + (i === crumbs.length - 1 ? ' active' : '');
            btn.textContent = crumb.label;
            btn.onclick = () => this.openFolder(crumb.path);
            this.breadcrumb.appendChild(btn);
        });
    }

    renderGrid() {
        if (!this.grid) return;
        this.grid.innerHTML = '';

        const { loading, error } = this.store.state;
        if (error) {
            this.renderAuthorTags([]);
            this.renderMessage(`Error loading LoRAs: ${error}`);
            return;
        }
        if (loading && this.loras.length === 0) {
            this.renderAuthorTags([]);
            this.renderMessage('Loading...');
            return;
        }

        // Filtering searches recursively below the current folder, flattened
        const viewLoras = this.filter
            ? this.store.search(this.currentFolder, this.filter)
            : this.store.getLorasIn(this.currentFolder);
        this.renderAuthorTags(viewLoras);
        const loras = this.store.filterByAuthors(viewLoras);

        if (this.filter) {
            loras.forEach(lora => this.grid.appendChild(this.createLoraCard(lora, true)));
            if (loras.length === 0) this.renderMessage('No matching LoRAs');
            return;
        }

        const subfolders = this.store.getSubfolders(this.currentFolder);

        if (this.currentFolder) {
            this.grid.appendChild(this.createFolderCard({ name: '..', path: this.parentFolder(), count: null }));
        }
        subfolders.forEach(folder => this.grid.appendChild(this.createFolderCard(folder)));
        loras.forEach(lora => this.grid.appendChild(this.createLoraCard(lora, false)));

        if (subfolders.length === 0 && loras.length === 0) {
            this.renderMessage(viewLoras.length > 0 ? 'No matching LoRAs' : 'No LoRAs found');
        }
    }

    renderAuthorTags(viewLoras) {
        if (!this.authorTags) return;
        this.authorTags.innerHTML = '';

        const selected = this.store.state.selectedAuthors;
        const authors = this.store.getAuthors(viewLoras);
        // Keep selected authors visible (e.g. when the text filter hides them) so they can be toggled off
        selected
            .filter(name => !authors.some(a => a.name === name))
            .forEach(name => authors.push({ name, count: 0 }));

        this.authorTags.style.display = authors.length > 0 ? '' : 'none';

        authors.forEach(author => {
            const tag = document.createElement('button');
            tag.className = 'lora-author-tag' + (selected.includes(author.name) ? ' active' : '');
            tag.title = `Show only LoRAs by ${author.name}`;
            tag.onclick = () => this.store.toggleAuthor(author.name);

            const name = document.createElement('span');
            name.textContent = author.name;
            const count = document.createElement('span');
            count.className = 'lora-author-tag-count';
            count.textContent = author.count;

            tag.appendChild(name);
            tag.appendChild(count);
            this.authorTags.appendChild(tag);
        });
    }

    renderMessage(text) {
        const msg = document.createElement('div');
        msg.className = 'lora-grid-message';
        msg.textContent = text;
        this.grid.appendChild(msg);
    }

    createFolderCard(folder) {
        const card = document.createElement('div');
        card.className = 'lora-card lora-folder-card';
        card.title = folder.path || 'loras';
        card.onclick = () => this.openFolder(folder.path);

        const thumb = document.createElement('div');
        thumb.className = 'lora-card-image lora-card-placeholder';
        thumb.innerHTML = `<i class="pi ${folder.name === '..' ? 'pi-arrow-up' : 'pi-folder'}"></i>`;

        const name = document.createElement('div');
        name.className = 'lora-card-name';
        name.textContent = folder.name;

        card.appendChild(thumb);
        card.appendChild(name);

        if (folder.count !== null) {
            const count = document.createElement('div');
            count.className = 'lora-card-desc';
            count.textContent = `${folder.count} LoRA${folder.count === 1 ? '' : 's'}`;
            card.appendChild(count);
        }
        return card;
    }

    createLoraCard(lora, showPath) {
        const card = document.createElement('div');
        card.className = 'lora-card';
        // Just the file name: the dialog shows the full description
        card.title = lora.name;
        card.onclick = () => this.openLoraDialog(lora);

        const thumb = document.createElement('div');
        thumb.className = 'lora-card-image';

        // Quick actions, shown on hover
        const actions = document.createElement('div');
        actions.className = 'lora-card-actions';
        const copyButton = this.createButton('pi pi-copy', `Copy ${this.buildLoraPrompt(lora)}`, (event) => {
            event.stopPropagation();
            this.copyLoraPrompt(lora);
        });
        actions.appendChild(copyButton);

        const imageUrl = LoraApi.getImageUrl(lora);
        if (imageUrl) {
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.src = imageUrl;
            img.alt = lora.title;
            img.onerror = () => this.setPlaceholder(thumb);
            thumb.appendChild(img);
        } else {
            this.setPlaceholder(thumb);
        }

        const name = document.createElement('div');
        name.className = 'lora-card-name';
        name.textContent = showPath && lora.folder ? `${lora.folder}/${lora.title}` : lora.title;

        card.appendChild(thumb);
        card.appendChild(actions);
        card.appendChild(name);

        if (lora.author) {
            const author = document.createElement('div');
            author.className = 'lora-card-author';
            author.textContent = lora.author;
            card.appendChild(author);
        }

        // Only the first line fits on the card; the dialog shows the full text
        const firstLine = lora.description.split('\n').map(l => l.trim()).find(l => l);
        if (firstLine) {
            const desc = document.createElement('div');
            desc.className = 'lora-card-desc';
            desc.textContent = firstLine;
            card.appendChild(desc);
        }
        return card;
    }

    setPlaceholder(thumb) {
        thumb.classList.add('lora-card-placeholder');
        thumb.innerHTML = '<i class="pi pi-image"></i>';
    }

    parentFolder() {
        const parts = this.currentFolder.split('/');
        return parts.slice(0, -1).join('/');
    }

    openFolder(path) {
        this.store.setCurrentFolder(path);
    }

    clearFilter() {
        clearTimeout(this.filterTimer);
        this.filterInput.value = '';
        this.store.setFilter('');
        this.filterInput.focus();
    }

    getDefaultWeight() {
        return Number((app.extensionManager.setting.get(WEIGHT_SETTING) ?? 1).toFixed(2));
    }

    // Impact Pack wildcard syntax: "<lora:folder/name:weight>, keywords"
    buildLoraPrompt(lora) {
        const name = lora.folder ? `${lora.folder}/${lora.title}` : lora.title;
        const weight = lora.weight ?? this.getDefaultWeight();
        return `<lora:${name}:${weight}>` + (lora.keywords ? `, ${lora.keywords}` : '');
    }

    openLoraDialog(lora) {
        new LoraDialog(lora, {
            canEdit: app.extensionManager.setting.get(EDITING_SETTING) ?? true,
            defaultWeight: this.getDefaultWeight(),
            buildPrompt: (l) => this.buildLoraPrompt(l),
            onCopy: (l) => this.copyLoraPrompt(l),
            onCopyText: (text) => this.copyText(text),
            getCachedCivitai: (l) => LoraApi.getCachedCivitaiInfo(l.name),
            fetchCivitai: (l, refresh) => LoraApi.fetchCivitaiInfo(l.name, refresh),
            onRename: (l, title) => this.saveLoraEdit('Rename failed',
                () => LoraApi.renameLora(l.name, title)),
            onSaveDescription: (l, text) => this.saveLoraEdit('Saving description failed',
                () => LoraApi.saveDescription(l.name, text).then(() => l.name))
        }).show();
    }

    // Runs an edit that resolves to the (possibly new) LoRA name, reloads the list and returns the updated LoRA
    async saveLoraEdit(errorSummary, editFn) {
        let name;
        try {
            name = await editFn();
        } catch (error) {
            console.error(`${errorSummary}:`, error);
            app.extensionManager.toast?.add({ severity: 'error', summary: errorSummary, detail: error.message, life: 5000 });
            throw error;
        }
        await this.loadLoras();
        return this.loras.find(l => l.name === name);
    }

    copyLoraPrompt(lora) {
        return this.copyText(this.buildLoraPrompt(lora), 'LoRA copied');
    }

    async copyText(text, summary = 'Copied') {
        try {
            await this.writeClipboard(text);
            app.extensionManager.toast?.add({
                severity: 'info',
                summary,
                detail: text,
                life: 2000
            });
        } catch (error) {
            console.error('Error copying to clipboard:', error);
            app.extensionManager.toast?.add({
                severity: 'error',
                summary: 'Could not copy to clipboard',
                detail: text,
                life: 4000
            });
        }
    }

    async writeClipboard(text) {
        // Clipboard API is unavailable on non-secure origins (plain http on a LAN IP)
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        // An open modal dialog makes the rest of the page inert, so the textarea has to live inside it
        (document.querySelector('dialog[open]') ?? document.body).appendChild(textarea);
        textarea.select();
        try {
            if (!document.execCommand('copy')) {
                throw new Error('execCommand copy failed');
            }
        } finally {
            textarea.remove();
        }
    }

    zoomIn() {
        this.saveCardSize(Math.min(MAX_CARD_SIZE, this.cardSize + CARD_SIZE_STEP));
    }

    zoomOut() {
        this.saveCardSize(Math.max(MIN_CARD_SIZE, this.cardSize - CARD_SIZE_STEP));
    }

    saveCardSize(size) {
        if (size === this.cardSize) return;
        this.setCardSize(size);
        app.extensionManager.setting.set(CARD_SIZE_SETTING, size);
    }

    setCardSize(size) {
        this.cardSize = size;
        this.updateCardSize();
    }

    updateCardSize() {
        if (this.sidebarElement) {
            this.sidebarElement.style.setProperty('--lora-card-size', `${this.cardSize}px`);
        }
    }
}


const loraSidebar = new LoraSidebar();

app.registerExtension({
    name: "comfyui.lora.sidebar",
    settings: [
        {
            id: CARD_SIZE_SETTING,
            name: "LoRA Card Size",
            type: "slider",
            attrs: {
                min: MIN_CARD_SIZE,
                max: MAX_CARD_SIZE,
                step: CARD_SIZE_STEP
            },
            defaultValue: 140,
            // Fires for the zoom buttons and for edits in the Settings dialog
            onChange: (newValue) => loraSidebar.setCardSize(newValue)
        },
        {
            id: WEIGHT_SETTING,
            name: "LoRA weight used when copying",
            type: "slider",
            attrs: {
                min: 0,
                max: 2,
                step: 0.05
            },
            defaultValue: 1
        },
        {
            id: EDITING_SETTING,
            name: "Allow renaming LoRAs and editing descriptions in the LoRA dialog",
            type: "boolean",
            defaultValue: true
        }
    ],
    setup() {
        loraSidebar.init();

        app.extensionManager.registerSidebarTab({
            id: "lora-browser",
            icon: "pi pi-images",
            title: "LoRAs",
            tooltip: "LoRA Browser",
            type: "custom",
            render: (el) => {
                loraSidebar.createSidebarContent(el);
            },
        });
    }
});
