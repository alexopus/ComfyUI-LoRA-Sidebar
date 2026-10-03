export class LoraApi {
    static async getLoras() {
        try {
            const data = await LoraApi.readJson(await fetch('/lora_sidebar/list'), 'Failed to fetch LoRAs list');
            return data.loras || [];
        } catch (error) {
            console.error('Error fetching LoRAs:', error);
            throw error;
        }
    }

    // Renames the LoRA base name (and its sidecar files); resolves to the new LoRA name
    static async renameLora(name, title) {
        const data = await LoraApi.post('/lora_sidebar/rename', { name, title }, 'Failed to rename LoRA');
        return data.name;
    }

    static async saveDescription(name, description) {
        await LoraApi.post('/lora_sidebar/description', { name, description }, 'Failed to save description');
    }

    // Civitai info and sample images already fetched this session ({info, images}, each null if not);
    // never hashes or hits the network
    static async getCachedCivitai(name) {
        const response = await fetch(`/lora_sidebar/civitai/cached?name=${encodeURIComponent(name)}`);
        const data = await LoraApi.readJson(response, 'Failed to read cached civitai info');
        return { info: data.info || null, images: data.images || null };
    }

    // The civitai sample images with their prompt and settings; hashes the LoRA first if needed
    static async fetchCivitaiImages(name, refresh = false) {
        const data = await LoraApi.post('/lora_sidebar/civitai/images', { name, refresh }, 'Failed to fetch civitai images');
        return data.images || [];
    }

    // Looks the LoRA up on civitai, hashing it first (and saving <base>.sha256) if needed
    static async fetchCivitaiInfo(name, refresh = false) {
        const data = await LoraApi.post('/lora_sidebar/civitai', { name, refresh }, 'Failed to fetch civitai info');
        return data.info;
    }

    // Makes a sample image (its thumbnail url) the LoRA's preview; existing previews are kept as "<name>_old.*"
    static async setCivitaiPreview(name, url) {
        await LoraApi.post('/lora_sidebar/civitai/preview', { name, url }, 'Failed to set preview');
    }

    static async post(url, body, fallbackError) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return LoraApi.readJson(response, fallbackError);
    }

    // Parses the JSON body; an error response without a JSON body (e.g. a proxy error page) gets fallbackError
    static async readJson(response, fallbackError) {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
            throw new Error(data?.error || `${fallbackError} (HTTP ${response.status})`);
        }
        return data;
    }

    static getImageUrl(lora) {
        if (!lora.image) return null;
        // lora.image is the file mtime, used to bust the browser cache when the preview changes
        return `/lora_sidebar/image?name=${encodeURIComponent(lora.name)}&v=${lora.image}`;
    }
}
