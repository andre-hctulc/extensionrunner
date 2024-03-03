import Module from "./Module.js";
import { relPath } from "./shared.js";
import type { Meta, MetaExtension, Operations } from "./types.js";
import * as worker from "./worker.js";

export type ExtensionInit = {
    type: "github" | "npm";
    /** npm package name or git repo (:username/:repo)*/
    name: string;
    /** npm version or git commit sha */
    version: string;
    onError?: (err: Error) => void;
    onEvent?: (type: string, payload: any, source: Module<any, any, any>) => void;
    onPushState?: (newState: any, source: Module<any, any, any>) => void;
    /**
     * Time in milliseconds to wait for a module operation to complete
     * @default 5000
     * */
    operationTimeout?: number;
    /**
     * Time in milliseconds to wait for a module connection establishment
     * @default 5000
     * */
    connectionTimeout?: number;
    meta?: MetaExtension;
};

/** module augmentation */
export interface PackageJSON {
    /** npm package name or github owner ans repository name (":owner/:repo") */
    name: string;
    version: string;
    description: string;
    main: string;
    scripts: {
        [key: string]: string;
    };
    keywords: string[];
}

export class Extension {
    readonly url: string = "";
    readonly staticParams: string = "";
    private _pkg: Partial<PackageJSON> = {};
    private started = false;
    /** `<module_id, { instances: <Module, data>, sharedState: any }>` */
    private cache = new Map<string, { instances: Map<Module<any, any, any>, { state?: { data: any } }>; sharedState: any }>();

    constructor(private init: ExtensionInit) {
        if (this.type === "github") {
            const [owner, repo] = this.init.name.split("/");
            this.url = `https://api.github.com/repos/${owner}/${repo}/contents/`;
            this.staticParams = `?ref=${init.version}`;
        } else if (this.type === "npm") {
            this.url = `https://unpkg.com/${this.init.name}@${this.init.version}/`;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");
    }

    async start() {
        if (this.started) return;
        this.started = true;
        // load meta (package.json)
        const file = await this.loadFile("package.json");
        const text = await file.text();
        this._pkg = JSON.parse(text);
    }

    /**
     * @param path Use _null_ or empty string for the packages entry file
     */
    async launchModule<I extends Operations, O extends Operations, S = any>(
        path: string | null,
        out: O,
        meta?: MetaExtension
    ): Promise<Module<I, O, S>> {
        path = relPath(path || "");
        const id = `module:${path}`;

        // start module worker

        /** The worker code is transformed to a string on build, so we can alwys import it here and start the worker */
        const workerCode = (worker as any).code;
        const blob = new Blob([workerCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        const worker_ = new Worker(url);
        URL.revokeObjectURL(url);
        const defaultMeta: Meta = {
            name: this.init.name,
            path,
            state: this.cache.get(id)?.sharedState,
            version: this.init.version,
            type: this.init.type,
        };

        // Post meta, so the worker knows which module to import

        const optsMeta = meta ? meta(defaultMeta) : defaultMeta;
        worker_.postMessage({ __type: "meta", meta: optsMeta });

        const mod: Module<any, any, any> = this.initModule(worker_, path, out, meta);

        return mod.start();
    }

    async launchIFrame<I extends Operations, O extends Operations, S = any>(
        parentElement: Element,
        path: string,
        out: O,
        meta?: MetaExtension
    ): Promise<Module<I, O, S>> {
        path = relPath(path);

        // create iframe and append to parentElement

        const iframe = document.createElement("iframe");

        iframe.src = this.url + path;

        // wait for load
        return new Promise<Module<I, O, S>>((resolve, reject) => {
            iframe.onload = async e => {
                if (!iframe.contentWindow) return reject("`contentWindow`ndow not defined");
                const mod: Module<any, any, any> = this.initModule(iframe.contentWindow, path, out, meta);
                resolve(mod.start());
            };

            iframe.addEventListener("error", e => {
                reject(new Error(e.message));
            });

            parentElement.appendChild(iframe);
        });
    }

    private initModule<I extends Operations, O extends Operations, S = any>(
        target: Worker | Window,
        path: string,
        out: O,
        meta?: MetaExtension
    ): Module<I, O, S> {
        const id = `iframe:${path}`;

        // extend meta

        const defaultMeta: Meta = {
            name: this.init.name,
            path,
            state: this.cache.get(id)?.sharedState,
            version: this.init.version,
            type: this.init.type,
        };

        let finalMeta = this.init.meta ? this.init.meta(defaultMeta) : defaultMeta;
        if (meta) finalMeta = meta(finalMeta);

        // create module

        const mod = new Module<I, O, S>(target, finalMeta, out, {
            onPushState: (newState, populate) => {
                if (populate) this.pushState(id, newState, undefined, [mod]);
                this.init.onPushState?.(newState, mod);
            },
            onEvent: (type, payload) => {
                this.init.onEvent?.(type, payload, mod);
            },
            operationTimeout: this.init.operationTimeout,
            connectionTimeout: this.init.connectionTimeout,
        });

        // cache

        let instances = this.cache.get(id)?.instances;
        if (!instances) {
            instances = new Map();
            this.cache.set(id, { instances, sharedState: undefined });
        }
        instances.set(mod, { state: undefined });

        return mod;
    }

    get id() {
        return this.init.type + "%" + this.init.name;
    }

    get pkg() {
        return this._pkg;
    }

    get type() {
        return this.init.type;
    }

    private getUrl(path: string, searchParams?: string) {
        if (searchParams) searchParams = this.staticParams + "&" + searchParams;
        else searchParams = this.staticParams;
        return this.url + path + searchParams;
    }

    async loadFile(path: string) {
        if (path.startsWith("/")) path = path.slice(1);
        else if (path.startsWith("./")) path = path.slice(2);
        const response = await fetch(this.getUrl(path), this.type === "github" ? { headers: { Accept: "application/vnd.github.raw+json" } } : {});
        return response;
    }

    pushState(moduleId: string, newState: any, instance?: Module<any, any, any>, exclude?: Module<any, any, any>[]) {
        const exclSet = new Set(exclude);
        const cache = this.cache.get(moduleId);
        if (cache) {
            if (instance) {
                if (!exclSet.has(instance)) instance.pushState(newState);
            } else {
                const modules = Array.from(cache.instances.keys());
                modules.forEach(instance => {
                    if (!exclSet.has(instance)) instance.pushState(newState);
                });
            }
        }
    }

    emitEvent(type: string, payload: any, filter?: (moduleId: string, instance: Module<any, any, any>) => boolean) {
        for (const moduleId of this.cache.keys()) {
            const modules = Array.from(this.cache.get(moduleId)?.instances.keys() || []);
            modules.forEach(instance => {
                if (filter && !filter(moduleId, instance)) return;
                instance.emitEvent(type as never, payload as never);
            });
        }
    }
}
