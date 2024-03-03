import type { ExtensionInit } from "./Extension.js";
import { Extension } from "./Extension.js";
import type { Operations } from "./types.js";

interface ProviderOptions {}

export class Provider {
    constructor(readonly options?: ProviderOptions) {}

    private cache = new Map<string, Extension>();

    async loadExtension<I extends Operations, O extends Operations>(extensionInit: ExtensionInit) {
        const extension = new Extension(extensionInit);
        try {
            await extension.start();
        } catch (err) {
            throw new Error(`Failed to load extension: ${err}`);
        }
        this.cache.set(extension.id, extension);
        return extension;
    }

    allExtensions() {
        return Array.from(this.cache.values());
    }

    getExtension(id: string) {
        return this.cache.get(id) || null;
    }
}
