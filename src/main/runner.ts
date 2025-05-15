import { EventsHandler } from "../events-handler.js";
import { LogLevel } from "../util.js";
import type { ExtensionInit } from "./extension.js";
import { Extension } from "./extension.js";
import { MainEvents } from "./main-events.js";

interface RunnerInit {
    /**
     * @default "error"
     */
    logLevel?: LogLevel;
    baseExtensionInit?: Partial<ExtensionInit>;
}

export interface RunnerEvents {}

export class Runner extends EventsHandler<MainEvents> {
    private _logLevel: LogLevel;
    private _init: RunnerInit;

    constructor(init: RunnerInit) {
        super();
        this._init = init;
        this._logLevel = init?.logLevel || "error";
    }

    private cache = new Map<string, Extension>();

    async mountExtension(extensionInit: ExtensionInit) {
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
        extensions.forEach((extension) => extension.destroy());
        this.cache.clear();
    }
}
