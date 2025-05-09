import { OperationEventPayload, Operations } from "../operations.js";
import { CorsWorker } from "../cors-worker.js";
import { AnyModule, Module, ModuleInit } from "./module.js";
import { getUrl, JS_DELIVR_URL, loadFile, logInfo, LogLevel, relPath } from "../shared.js";
import type { PackageJSON } from "../types.js";
import { EventsHandler } from "../events-handler.js";
import { Provider } from "./provider.js";
import { Meta } from "../meta.js";

export type ExtensionInit = {
    type: "github" | "npm";
    /** npm package name or git repo (:username/:repo)*/
    name: string;
    /** npm version */
    version: string;
    /**
     * Time in milliseconds to wait for a module connection establishment
     * @default 5000
     * */
    connectionTimeout?: number;
    /**
     * Defaults to provider's log level.
     */
    logLevel?: LogLevel;
    baseModuleInit?: Partial<ModuleInit<any, any, any>>;
};

interface ModuleEventPayload {
    module: AnyModule;
}

interface ModulesEventPayload {
    modules: AnyModule[];
}

interface ExtensionEvents<S extends object> {
    push_state: ModuleEventPayload & {
        state: S;
    };
    module_load: ModuleEventPayload;
    module_destroy: ModuleEventPayload;
    destroy: ModulesEventPayload;
    error: ModuleEventPayload & { error: unknown };
    operation: ModuleEventPayload & OperationEventPayload<any, any>;
}

/** (id _or_ path _or_ check) _and_ !(notPath _or_ notId)  */
export type ModulesFilter = {
    id?: string | string[];
    path?: string | string[];
    check?: (module: AnyModule) => boolean;
    notPath?: string | string[];
    notId?: string | string[];
};

type ModuleCache = {
    instances: Map<string, AnyModule>;
    /**
     * Shared state for modules with this path
     * modules can still have s different state (Module.state)
     * */
    state: any;
};

export interface LaunchModuleOptions<
    E extends Extension = Extension,
    O extends object = object,
    S extends object = object
> {
    /**
     * Modify the default module meta
     */
    modifyMeta?: (defaultMeta: Meta) => Meta;
    moduleInit?: Partial<ModuleInit<E, O, S>>;
}

export type ModulesSummary<T = void> = {
    result: Awaited<T>[];
    affected: AnyModule[];
    errors: unknown[];
    failed: AnyModule[];
};

/**
 * @template S Module State
 */
export class Extension<S extends object = any> extends EventsHandler<ExtensionEvents<S>> {
    readonly url: string = "";
    private _pkg: Partial<PackageJSON> = {};
    private started = false;
    /** `<path, { instances: <Module, data>, sharedState: any }>` */
    private _cache = new Map<string, ModuleCache>();
    private _logLevel: LogLevel;
    private _init: ExtensionInit;

    constructor(readonly provider: Provider, init: ExtensionInit) {
        super();
        this._init = init;
        this._logLevel = init.logLevel || "error";
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
    filterModules(filter: ModulesFilter) {
        const all = this.getAllModules();
        const idsSet = new Set(Array.isArray(filter.id) ? filter.id : [filter.id]);
        const notIdsSet = new Set(Array.isArray(filter.notId) ? filter.notId : [filter.notId]);
        const pathsSet = new Set(Array.isArray(filter.path) ? filter.path : [filter.path]);
        const notPathsSet = new Set(Array.isArray(filter.notPath) ? filter.notPath : [filter.notPath]);
        return all.filter((module) => {
            let include = idsSet.has(module.id) || pathsSet.has(module.meta.path) || !!filter.check?.(module);
            if (include && notIdsSet.size && notIdsSet.has(module.id)) include = false;
            if (include && notPathsSet.size && notPathsSet.has(module.meta.path)) include = false;
            return include;
        });
    }

    getAllModules() {
        return Array.from(this._cache.values()).flatMap(({ instances }) => Array.from(instances.values()));
    }

    /**
     * @param path Use _null_ or empty string for the packages entry file
     */
    async launchModule<O extends object, I extends object, MS extends object = S>(
        path: string | null,
        out: Partial<Operations<this, O>>,
        options?: LaunchModuleOptions<this, O, MS>
    ): Promise<Module<this, O, I, MS>> {
        path = relPath(path || "");
        /* ???? // important: use correct npm version for the newest worker build (extensionrunner@version) */
        const corsWorker = new CorsWorker(
            getUrl(this.type, this.name, this._init.version, path || undefined),
            {
                type: "module",
                name: `${this._init.name}:${path}`,
            }
        );
        await corsWorker.mount();
        const mod: AnyModule = this._initModule(
            corsWorker.getWorker()!,
            JS_DELIVR_URL,
            path,
            "worker",
            out,
            (options as any) || {}
        );
        return mod.start();
    }

    async launchComponent<O extends object, I extends object, MS extends object = S>(
        parentElement: Element,
        path: string,
        out: Partial<Operations<this, O>>,
        options?: LaunchModuleOptions<this, O, MS>
    ): Promise<Module<this, O, I, MS>> {
        path = relPath(path);

        // Most CDNs do not directly serve html files, they serve the html as a string in a response. So does jsdelivr and unpkg.
        // So we fetch the html and use iframe.srcdoc to load the html
        const iframe = document.createElement("iframe");
        let url: string;
        let origin: string;

        if (this.type === "github") {
            const [owner, repo] = this._init.name.split("/");
            origin = "https://raw.githack.com";
            url = `${origin}/${owner}/${repo}/${this._init.version}/${path}`;
        } else if (this.type === "npm") {
            // TODO see Info.md CDNs
            origin = "https://unpkg.com";
            url = `${origin}/${this._init.name}@${this._init.version}/${path}`;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        iframe.src = url;
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
        // TODO more attrs?

        // wait for load
        return new Promise<AnyModule>((resolve, reject) => {
            iframe.onload = async (e) => {
                if (!iframe.contentWindow) return reject("`contentWindow` not defined");
                const mod: Module<this, O, I, MS> = this._initModule(
                    iframe.contentWindow,
                    origin,
                    path,
                    "iframe",
                    out,
                    (options as any) || {}
                );
                logInfo(this._logLevel, "Component launched", mod.ref);
                resolve(mod.start());
            };

            iframe.addEventListener("error", (e) => {
                reject(new Error(e.message));
            });

            parentElement.appendChild(iframe);
        });
    }

    private _initModule(
        target: Window | Worker,
        origin: string,
        path: string,
        windowType: "iframe" | "worker",
        out: Partial<Operations<this, any>>,
        options: LaunchModuleOptions
    ): AnyModule {
        // create meta

        const initialState =
            options.moduleInit?.stateOptions?.initialState ||
            this._init.baseModuleInit?.stateOptions?.initialState ||
            {};

        let meta: Meta = {
            authToken: crypto.randomUUID(),
            name: this._init.name,
            path,
            initialState,
            version: this._init.version,
            type: this._init.type,
            windowType,
        };

        if (options.modifyMeta) {
            meta = options.modifyMeta(meta);
        }

        // create module

        const mod: AnyModule = new Module(this, {
            ...this._init.baseModuleInit,
            ...options.moduleInit,
            origin,
            target,
            meta: meta,
            operations: out,
        });

        // propagate events

        mod.addEventListener("operation", (ev) => {
            this._emit("operation", { module: mod, ...ev.payload });
        });

        mod.addEventListener("push_state", async (ev) => {
            this._emit("push_state", {
                module: mod,
                state: ev.payload.state as any,
            });
        });

        mod.addEventListener("destroy", () => {
            this._emit("module_destroy", { module: mod });
        });

        mod.addEventListener("error", (ev) => {
            this._emit("error", { error: ev.payload.error, module: mod });
        });

        // cache

        let instances = this._cache.get(path)?.instances;
        if (!instances) {
            instances = new Map();
            this._cache.set(path, { instances, state: undefined });
        }
        instances.set(mod.id, mod);

        this._emit("module_load", { module: mod });

        logInfo(this._logLevel, "Module launched", mod.ref);

        return mod;
    }

    get id() {
        return this._init.type + "/" + this._init.name;
    }

    get pkg() {
        return this._pkg;
    }

    get type() {
        return this._init.type;
    }

    get name() {
        return this._init.name;
    }

    /** If the response is not ok, the `Response` will be set on the thrown error (`Error.response`) */
    async loadFile(path: string) {
        return await loadFile(this._init.type, this._init.name, this._init.version, path);
    }

    async pushState(newState: S): Promise<ModulesSummary> {
        return await this.forEachModule(
            (module) => {
                module.pushState(newState);
            },
            {
                parallel: true,
            }
        );
    }

    async forEachModule<T>(
        callback: (module: AnyModule) => T,
        options?: { filter?: ModulesFilter; parallel?: boolean }
    ): Promise<ModulesSummary<T>> {
        const result: ModulesSummary<T> = { failed: [], affected: [], result: [], errors: [] };
        const modules = options?.filter ? this.filterModules(options.filter) : this.getAllModules();

        if (options?.parallel) {
            const par: { error: unknown | null; result: any; module: AnyModule }[] = await Promise.all(
                modules.map(async (module) => {
                    try {
                        return { error: null, result: await callback(module), module };
                    } catch (err) {
                        return { error: err, result: undefined, module };
                    }
                })
            );
            par.forEach((p) => {
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
        const allModules = this.getAllModules();
        const actions = await this.forEachModule((module) => module.destroy(), { parallel: true });
        this._cache.clear();
        this._clearListener();
        this._emit("destroy", { modules: allModules });
        return actions;
    }
}
