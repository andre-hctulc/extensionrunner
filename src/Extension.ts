import { Operations } from "./types.js";
import { CorsWorker } from "./CorsWorker.js";
import { Module } from "./Module.js";
import type { Provider } from "./Provider.js";
import { jsdelivr, loadFile, randomId, relPath } from "./shared.js";
import type { Meta, MetaExtension, OperationEvents } from "./types.js";
import { EventsHandler } from "./EventsHandler.js";

export type ExtensionInit = {
    type: "github" | "npm";
    /** npm package name or git repo (:username/:repo)*/
    name: string;
    /** npm version */
    version: string;
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

interface ExtensionEvents extends OperationEvents<any> {
    state_populate: { module: Module<any, any, any>; state: any; options: any };
    module_load: Module<any, any, any>;
    module_destroy: Module<any, any, any>;
    destroy: undefined;
}

/** (id _or_ path _or_ check) _and_ !(notPath _or_ notId)  */
type ModuleFilter = {
    id?: string | string[];
    path?: string | string[];
    check?: (module: Module<any, any, any>) => boolean;
    notPath?: string | string[];
    notId?: string | string[];
};

interface ExtensionPushStateOptions {
    filter?: ModuleFilter;
    /** overwrite old states instead of merging */
    overwrite?: boolean;
}

type ModuleCache = { instances: Map<string, Module<any, any, any>>; sharedState: any };

interface LaunchModuleOptions<S extends object> {
    allowPopulateState?: ((state: Partial<S> | undefined, merge?: boolean) => boolean) | boolean;
    meta?: MetaExtension;
    initialState?: S;
}

export class Extension extends EventsHandler<ExtensionEvents> {
    readonly url: string = "";
    private _pkg: Partial<PackageJSON> = {};
    private started = false;
    /** `<path, { instances: <Module, data>, sharedState: any }>` */
    private cache = new Map<string, ModuleCache>();

    constructor(readonly provider: Provider, private init: ExtensionInit) {
        super();
    }

    async start() {
        if (this.started) return;
        this.started = true;
        // load meta (package.json)
        const file = await this.loadFile("package.json");
        const text = await file.text();
        this._pkg = JSON.parse(text);
    }

    /** When the filter is empty no modules are returned */
    filterModules(filter: ModuleFilter) {
        const all = this.getAllModules();
        const idsSet = new Set(Array.isArray(filter.id) ? filter.id : [filter.id]);
        const notIdsSet = new Set(Array.isArray(filter.notId) ? filter.notId : [filter.notId]);
        const pathsSet = new Set(Array.isArray(filter.path) ? filter.path : [filter.path]);
        const notPathsSet = new Set(Array.isArray(filter.notPath) ? filter.notPath : [filter.notPath]);
        return all.filter(module => {
            let include = idsSet.has(module.id) || pathsSet.has(module.meta.path) || !!filter.check?.(module);
            if (include && notIdsSet.size && notIdsSet.has(module.id)) include = false;
            if (include && notPathsSet.size && notPathsSet.has(module.meta.path)) include = false;
            return include;
        });
    }

    getAllModules() {
        return Array.from(this.cache.values()).flatMap(({ instances }) => Array.from(instances.values()));
    }

    /**
     * @param path Use _null_ or empty string for the packages entry file
     */
    async launchModule<O extends object, I extends object, S extends object = any>(
        path: string | null,
        out: Partial<Operations<Module<O, I, S>, O>>,
        options?: LaunchModuleOptions<S>
    ): Promise<Module<O, I, S>> {
        path = relPath(path || "");
        // IMP use correct npm version for the newest wroker build (extensionrunner@version)
        const corsWorker = new CorsWorker(jsdelivr + "/npm/extensionrunner@1.0.33/worker.js", {
            type: "module",
            name: `${this.init.name}:${path}`,
        });
        await corsWorker.init();
        const mod: Module<any, any, any> = this.initModule(
            corsWorker.worker,
            jsdelivr,
            path,
            out,
            options || {}
        );
        return mod.start();
    }

    async launchComponent<O extends object, I extends object, S extends object = any>(
        parentElement: Element,
        path: string,
        out: Partial<Operations<Module<O, I, S>, O>>,
        options?: LaunchModuleOptions<S>
    ): Promise<Module<O, I, S>> {
        path = relPath(path);

        // Most CDNs do not directly serve html files, they serve the html as a string in a response. So does jsdelivr and unpkg.
        // So we fetch the html and use ifrm.srcdoc to load the html
        const iframe = document.createElement("iframe");
        let url: string;
        let origin: string;

        if (this.type === "github") {
            const [owner, repo] = this.init.name.split("/");
            origin = "https://raw.githack.com";
            url = `${origin}/${owner}/${repo}/${this.init.version}/${path}`;
        } else if (this.type === "npm") {
            // TODO see Info.md CDNs
            origin = "https://unpkg.com";
            url = `${origin}/${this.init.name}@${this.init.version}/${path}`;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        iframe.src = url;
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
        // TODOD more attrs?

        // wait for load
        return new Promise<Module<O, I, S>>((resolve, reject) => {
            iframe.onload = async e => {
                if (!iframe.contentWindow) return reject("`contentWindow`ndow not defined");
                const mod: Module<O, I, S> = this.initModule(
                    iframe.contentWindow,
                    origin,
                    path,
                    out,
                    options || {}
                );
                resolve(mod.start());
            };

            iframe.addEventListener("error", e => {
                reject(new Error(e.message));
            });

            parentElement.appendChild(iframe);
        });
    }

    private initModule<O extends object, I extends object, S extends object = {}>(
        target: Window | Worker,
        origin: string,
        path: string,
        out: Partial<Operations<Module<O, I, S>, O>>,
        options: LaunchModuleOptions<S>
    ): Module<O, I, S> {
        // create meta

        let meta: Meta = {
            authToken: randomId(),
            name: this.init.name,
            path,
            initialState: this.cache.get(path)?.sharedState,
            version: this.init.version,
            type: this.init.type,
        };

        meta = this.init.meta ? this.init.meta(meta) : meta;
        if (options.meta) meta = options.meta(meta);

        if (options.initialState !== undefined) meta.initialState = options.initialState;

        // create module

        const mod = new Module<O, I, S>(this, {
            origin,
            target,
            meta: meta,
            out,
            operationTimeout: this.init.operationTimeout,
            connectionTimeout: this.init.connectionTimeout,
            allowPopulateState: options.allowPopulateState,
        });

        // propagate events

        mod.addEventListener(null, ev => {
            if (ev.type.startsWith("op:")) this.emitEvent(ev.type as any, ev.payload as any);
        });

        mod.addEventListener("state_populate", ev => {
            if (this.cache.has(path)) this.cache.get(path)!.sharedState = ev.payload;
            this.pushState(ev.payload.state, { filter: { notId: mod.id, path: mod.meta.path } });
            this.emitEvent("state_populate", {
                module: mod,
                state: ev.payload.state,
                options: ev.payload.options,
            });
        });

        mod.addEventListener("destroy", () => {
            this.cache.get(path)?.instances.delete(mod.id);
            this.emitEvent("module_destroy", mod);
        });

        // cache

        let instances = this.cache.get(path)?.instances;
        if (!instances) {
            instances = new Map();
            this.cache.set(path, { instances, sharedState: undefined });
        }
        instances.set(mod.id, mod);

        this.emitEvent("module_load", mod);

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

    /** If the response is not ok, the `Response` will be set on the thrown error (`Error.response`) */
    async loadFile(path: string) {
        return await loadFile(this.init.type, this.init.name, this.init.version, path);
    }

    pushState(newState: any, options?: ExtensionPushStateOptions) {
        const modules = options?.filter ? this.filterModules(options?.filter || {}) : this.getAllModules();
        for (const module of modules) {
            module.pushState(newState, { merge: !options?.overwrite });
        }
    }

    destroy() {
        const all = this.getAllModules();
        all.forEach(module => module.destroy());
        this.cache.clear();
        this.clearListeners();
        this.emitEvent("destroy", undefined);
    }
}
