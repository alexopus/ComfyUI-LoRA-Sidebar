export class LoraStore extends EventTarget {
    constructor() {
        super();
        this.state = {
            loras: [],          // [{ name, folder, title, author, description, keywords, weight, size, image }]
            currentFolder: '',  // "" is the loras root, otherwise "sub/dir"
            filter: '',
            selectedAuthors: [], // author tags toggled on; empty means no author filtering
            sort: 'name',       // one of SORT_ORDERS
            loading: false,
            error: null
        };
    }

    setState(updates) {
        this.state = { ...this.state, ...updates };
        this.dispatchEvent(new CustomEvent('stateChanged', { detail: { updates } }));
    }

    startLoading() {
        this.setState({ loading: true });
    }

    // Ends loading in the same update, so a refresh re-renders once
    setLoras(loras) {
        const updates = { loras, error: null, loading: false };
        // Fall back to root if the current folder disappeared after a refresh
        const folder = this.state.currentFolder;
        if (folder && !loras.some(l => isInFolder(l.folder, folder))) {
            updates.currentFolder = '';
        }
        this.setState(updates);
    }

    setCurrentFolder(currentFolder) {
        // Clicking the current breadcrumb shouldn't drop the author selection
        if (currentFolder === this.state.currentFolder) return;
        // Author tags are per view, so navigating resets them
        this.setState({ currentFolder, selectedAuthors: [] });
    }

    setFilter(filter) {
        this.setState({ filter });
    }

    toggleAuthor(author) {
        const selected = this.state.selectedAuthors;
        this.setState({
            selectedAuthors: selected.includes(author)
                ? selected.filter(a => a !== author)
                : [...selected, author]
        });
    }

    setSort(sort) {
        if (!SORT_ORDERS.includes(sort) || sort === this.state.sort) return;
        this.setState({ sort });
    }

    setError(error) {
        this.setState({ error, loading: false });
    }

    // Derived data

    // Direct child folders of `folder`, with recursive LoRA counts
    getSubfolders(folder) {
        const counts = new Map();
        const prefix = folder ? folder + '/' : '';
        for (const lora of this.state.loras) {
            if (!lora.folder.startsWith(prefix) || lora.folder === folder) continue;
            const child = lora.folder.slice(prefix.length).split('/')[0];
            counts.set(child, (counts.get(child) || 0) + 1);
        }
        return [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            .map(([name, count]) => ({ name, path: prefix + name, count }));
    }

    // LoRAs directly inside `folder`
    getLorasIn(folder) {
        return this.state.loras.filter(l => l.folder === folder);
    }

    // LoRAs anywhere under `folder` matching `filter` by name or description
    search(folder, filter) {
        const needle = filter.toLowerCase();
        return this.state.loras.filter(l =>
            isInFolder(l.folder, folder) &&
            (l.name.toLowerCase().includes(needle) || l.description.toLowerCase().includes(needle))
        );
    }

    // Distinct authors among `loras` with their LoRA counts, sorted by name
    getAuthors(loras) {
        const counts = new Map();
        for (const lora of loras) {
            if (lora.author) counts.set(lora.author, (counts.get(lora.author) || 0) + 1);
        }
        return [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            .map(([name, count]) => ({ name, count }));
    }

    // `loras` by any of the selected authors, or all of them when none is selected
    filterByAuthors(loras) {
        const selected = this.state.selectedAuthors;
        if (selected.length === 0) return loras;
        return loras.filter(l => selected.includes(l.author));
    }

    // `loras` in the current sort order. The backend already sends them sorted by name,
    // so size ties (and unknown sizes, which go last) keep that order.
    sortLoras(loras) {
        const sort = this.state.sort;
        if (sort === 'name') return loras;
        const dir = sort === 'size-asc' ? 1 : -1;
        return [...loras].sort((a, b) => {
            if (a.size == null || b.size == null) return (a.size == null) - (b.size == null);
            return dir * (a.size - b.size);
        });
    }
}

export const SORT_ORDERS = ['name', 'size-desc', 'size-asc'];

function isInFolder(loraFolder, folder) {
    return !folder || loraFolder === folder || loraFolder.startsWith(folder + '/');
}
