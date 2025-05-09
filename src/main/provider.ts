import { EventsHandler } from "../events-handler.js";
import { LogLevel } from "../shared.js";
import { OperationEventPayload, OperationName } from "../operations.js";
import type { ExtensionInit } from "./extension.js";
import { Extension } from "./extension.js";
import type { Module } from "./module.js";

interface ProviderInit {
    /**
     * @default "error"
     */
    logLevel?: LogLevel;
    baseExtensionInit?: Partial<ExtensionInit>;
}

interface ExtensionEventPayload {
    extension: Extension;
}

interface ProviderEvents {
    extension_load: ExtensionEventPayload;
    extension_destroy: ExtensionEventPayload;
    push_state: ExtensionEventPayload & { state: any; options: any; module: Module<any, any, any> };
    operation: ExtensionEventPayload & OperationEventPayload<any, OperationName<any, any>>;
    error: ExtensionEventPayload & { error: unknown };
}

export class Provider extends EventsHandler<ProviderEvents> {
    private _logLevel: LogLevel;
    private _init: ProviderInit;

    constructor(init: ProviderInit) {
        super();
        this._init = init;
        this._logLevel = init?.logLevel || "error";
    }

    private cache = new Map<string, Extension>();

    async loadExtension(extensionInit: ExtensionInit) {
        const extension = new Extension(this, {
            logLevel: this._logLevel,
            ...this._init.baseExtensionInit,
            ...extensionInit,
        });
        try {
            await extension.start();
        } catch (err) {
            throw new Error(`Failed to load extension: ${err?.toString()}`);
        }
        // propagate events
        extension.addEventListener("push_state", e => {
            this._emit("push_state", {
                extension,
                module: e.payload.module,
                state: e.payload.state,
                options: e.payload.module,
            });
        });
        extension.addEventListener("operation", ev => {
            this._emit("operation", {
                extension,
                ...ev.payload,
            });
        });
        extension.addEventListener("destroy", e => {
            this.cache.delete(extension.id);
            this._emit("extension_destroy", { extension });
        });
        extension.addEventListener("error", e => {
            this._emit("error", { extension, error: e.payload.error });
        });
        this._emit("extension_load", { extension });
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
