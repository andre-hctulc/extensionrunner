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
    state_populate: {
        module: Module<any, any, any>;
        state: any;
        options: any;
        result: ModuleActions;
    };
    module_load: Module<any, any, any>;
    module_destroy: Module<any, any, any>;
    destroy: undefined;
    error: { error: Error; origin?: Module<any, any, any> };
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
    /**
     * @default true
     */
    merge?: boolean;
}

type ModuleCache = { instances: Map<string, Module<any, any, any>>; state: any };

interface LaunchModuleOptions<S extends object> {
    allowPopulateState?:
        | ((state: Partial<S> | undefined, merge: boolean, module: Module<any, any, any>) => boolean)
        | boolean;
    meta?: MetaExtension;
    /** @default populated state */
    initialState?: S;
}

type ModuleActions<T = void> = {
    result: Awaited<T>[];
    affected: Module<any, any, any>[];
    errors: unknown[];
    failed: Module<any, any, any>[];
};

export class Extension extends EventsHandler<ExtensionEvents> {
    readonly url: string = "";
    private _pkg: Partial<PackageJSON> = {};
    private started = false;
    /** `<path, { instances: <Module, data>, sharedState: any }>` */
    private cache = new Map<string, ModuleCache>();
    private logs: boolean;

    constructor(readonly provider: Provider, private init: ExtensionInit) {
        super();
        this.logs = !!provider.options?.logs;
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
        // IMP use correct npm version for the newest worker build (extensionrunner@version)
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
            initialState: this.cache.get(path)?.state,
            version: this.init.version,
            type: this.init.type,
        };

        meta = this.init.meta ? this.init.meta(meta) : meta;
        if (options.meta) meta = options.meta(meta);

        if (options.initialState !== undefined) meta.initialState = options.initialState;

        // create module

        const populateState = options.allowPopulateState ?? false;

        const mod: Module<O, I, S> = new Module<O, I, S>(this, {
            origin,
            target,
            meta: meta,
            out,
            operationTimeout: this.init.operationTimeout,
            connectionTimeout: this.init.connectionTimeout,
            allowPopulateState:
                typeof populateState === "boolean"
                    ? populateState
                    : (newState, merge) => populateState(newState, merge, mod),
        });

        // propagate events

        mod.addEventListener(null, ev => {
            if (ev.type.startsWith("op:")) this.emitEvent(ev.type as any, ev.payload as any);
        });

        mod.addEventListener("state_populate", async ev => {
            if (ev.payload.options?.populate === false) return;

            if (this.cache.has(path)) this.cache.get(path)!.state = ev.payload;
            const pushResults = await this.pushState(ev.payload.state, {
                filter: { notId: mod.id, path: mod.meta.path },
            });
            this.emitEvent("state_populate", {
                module: mod,
                state: ev.payload.state,
                options: ev.payload.options,
                result: pushResults,
            });
        });

        mod.addEventListener("destroy", () => {
            this.cache.get(path)?.instances.delete(mod.id);
            this.emitEvent("module_destroy", mod);
        });

        mod.addEventListener("error", ev => {
            this.emitEvent("error", { error: ev.payload, origin: mod });
        });

        // cache

        let instances = this.cache.get(path)?.instances;
        if (!instances) {
            instances = new Map();
            this.cache.set(path, { instances, state: undefined });
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

    async pushState(newState: any, options?: ExtensionPushStateOptions): Promise<ModuleActions> {
        return await this.forEachModule(
            module => {
                module.pushState(newState, { merge: options?.merge ?? true });
            },
            {
                parallel: true,
            }
        );
    }

    async forEachModule<T>(
        callback: (module: Module<any, any, any>) => T,
        options?: { filter?: ModuleFilter; parallel?: boolean }
    ): Promise<ModuleActions<T>> {
        const result: ModuleActions<T> = { failed: [], affected: [], result: [], errors: [] };
        const modules = options?.filter ? this.filterModules(options.filter) : this.getAllModules();

        if (options?.parallel) {
            const par: { error: unknown | null; result: any; module: Module<any, any, any> }[] =
                await Promise.all(
                    modules.map(async module => {
                        try {
                            return { error: null, result: await callback(module), module };
                        } catch (err) {
                            return { error: err, result: undefined, module };
                        }
                    })
                );
            par.forEach(p => {
                if (p.error) {
                    result.failed.push(p.module);
                    result.errors.push(p.error);
                } else {
                    result.affected.push(p.module);
                    result.result.push(p.result);
                }
            });
        } else {
            for (const module of modules) {
                try {
                    result.result.push(await callback(module));
                    result.affected.push(module);
                } catch (err) {
                    result.failed.push(module);
                    result.errors.push(err);
                }
            }
        }
        return result;
    }

    async destroy() {
        const actions = await this.forEachModule(module => module.destroy());
        this.cache.clear();
        this.clearListeners();
        this.emitEvent("destroy", undefined);
        return actions;
    }

    private err(info: string, event: any) {
        const msg =
            event instanceof Event
                ? ((event as any).message || (event as any).data || "").toString()
                : event instanceof Error
                ? event.message
                : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        if (this.logs) console.error(info, err);
        this.emitEvent("error", err as any);
        return err;
    }
}
