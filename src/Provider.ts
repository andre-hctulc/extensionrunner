import { EventsHandler } from "./EventsHandler.js";
import type { ExtensionInit } from "./Extension.js";
import { Extension } from "./Extension.js";
import type { Module } from "./Module.js";
import type { OperationEvents } from "./types.js";

interface ProviderOptions {
    logs?: boolean;
}

interface ProviderEvents extends OperationEvents<any> {
    extension_load: Extension;
    extension_destroy: Extension;
    state_populate: { extension: Extension; state: any; options: any; module: Module<any, any, any> };
}

export class Provider extends EventsHandler<ProviderEvents> {
    constructor(readonly options?: ProviderOptions) {
        super();
    }

    private cache = new Map<string, Extension>();

    async loadExtension(extensionInit: ExtensionInit) {
        const extension = new Extension(this, extensionInit);
        try {
            await extension.start();
        } catch (err) {
            throw new Error(`Failed to load extension: ${err?.toString()}`);
        }
        // propagate events
        extension.addEventListener("state_populate", e => {
            this.emitEvent("state_populate", { extension, module: e.payload.module, state: e.payload.state, options: e.payload.module });
        });
        extension.addEventListener(null, ev => {
            if (ev.type.startsWith("op:")) this.emitEvent(ev.type as any, ev.payload as any);
        });
        extension.addEventListener("destroy", e => {
            this.cache.delete(extension.id);
            this.emitEvent("extension_destroy", extension);
        });
        this.emitEvent("extension_load", extension);
        // cache
        this.cache.set(extension.id, extension);
        return extension;
    }

    allExtensions() {
        return Array.from(this.cache.values());
    }

    getExtension(id: string) {
        return this.cache.get(id) || null;
    }

    destroy() {
        const extensions = Array.from(this.cache.values());
        extensions.forEach(extension => extension.destroy());
        this.cache.clear();
    }
}
