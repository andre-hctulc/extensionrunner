import { Module } from "./Module.js";
import type { Provider } from "./Provider.js";
import { Events, randomId, relPath } from "./shared.js";
import type { Meta, MetaExtension, Operations } from "./types.js";

export type ExtensionInit = {
    type: "github" | "npm";
    /** npm package name or git repo (:username/:repo)*/
    name: string;
    /** npm version */
    version: string;
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

const jsdelivr = "https://cdn.jsdelivr.net";

export class Extension extends Events<string, (payload: any, module: Module<any, any, any>) => void> {
    readonly url: string = "";
    private _pkg: Partial<PackageJSON> = {};
    private started = false;
    /** `<module_id, { instances: <Module, data>, sharedState: any }>` */
    private cache = new Map<string, { instances: Map<Module<any, any, any>, { state?: { data: any } }>; sharedState: any }>();

    constructor(readonly provider: Provider, private init: ExtensionInit) {
        super();
        if (this.type === "github") {
            const [owner, repo] = this.init.name.split("/");
            this.url = `${jsdelivr}/gh/${owner}/${repo}@${init.version}/`;
        } else if (this.type === "npm") {
            this.url = `${jsdelivr}/npm/${init.name}@${init.version}/`;
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
        // TODO npm/extensiontunner@version/...  version not specified -> latest version is used
        const worker_ = new Worker(jsdelivr + "/npm/extensionrunner/worker.js", { type: "module" });
        const mod: Module<any, any, any> = this.initModule(worker_ as any, jsdelivr, path, out, meta);

        return mod.start();
    }

    async launchIFrame<I extends Operations, O extends Operations, S = any>(
        parentElement: Element,
        path: string,
        out: O,
        meta?: MetaExtension
    ): Promise<Module<I, O, S>> {
        path = relPath(path);

        // Most CDNs do not directly serve html files, they serve the html as a string in a response. So does jsdelivr and unpkg.
        // So we fetch the html and use ifrm.srcdoc to load the html
        const iframe = document.createElement("iframe");
        let url: string;
        let origin: string;

        if (this.type === "github") {
            const [owner, repo] = this.init.name.split("/");
            origin = "https://raw.githack.com";
            url = `https://raw.githack.com/${owner}/${repo}/${this.init.version}/${path}`;
        } else if (this.type === "npm") {
            // TODO see Info.md CDNs
            origin = "https://unpkg.com";
            url = `${origin}/${this.init.name}@${this.init.version}/${path}`;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        iframe.src = url;
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
        // TODOD more attrs?

        // wait for load
        return new Promise<Module<I, O, S>>((resolve, reject) => {
            iframe.onload = async e => {
                if (!iframe.contentWindow) return reject("`contentWindow`ndow not defined");
                const mod: Module<any, any, any> = this.initModule(iframe.contentWindow, origin, path, out, meta);
                resolve(mod.start());
            };

            iframe.addEventListener("error", e => {
                reject(new Error(e.message));
            });

            parentElement.appendChild(iframe);
        });
    }

    private initModule<I extends Operations, O extends Operations, S = any>(
        target: Window | Worker,
        origin: string,
        path: string,
        out: O,
        meta?: MetaExtension
    ): Module<I, O, S> {
        // genrate random id

        let _meta: Meta = {
            authToken: randomId(),
            name: this.init.name,
            path,
            state: this.cache.get(path)?.sharedState,
            version: this.init.version,
            type: this.init.type,
        };

        _meta = this.init.meta ? this.init.meta(_meta) : _meta;
        if (meta) _meta = meta(_meta);

        // create module

        const mod = new Module<I, O, S>(this, origin, target, _meta, out, {
            onPushState: (newState, populate) => {
                if (populate) this.pushState(path, newState, undefined, [mod]);
                this.init.onPushState?.(newState, mod);
            },
            onEvent: (type, payload) => {
                this.notifyListeners?.(type, payload, mod);
            },
            operationTimeout: this.init.operationTimeout,
            connectionTimeout: this.init.connectionTimeout,
        });

        // cache

        let instances = this.cache.get(path)?.instances;
        if (!instances) {
            instances = new Map();
            this.cache.set(path, { instances, sharedState: undefined });
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
        if (searchParams && !searchParams.startsWith("?")) searchParams = "?" + searchParams;
        return this.url + path + (searchParams || "");
    }

    /** If the response is not ok, the `Response` will be set on the thrown error (`Error.response`) */
    async loadFile(path: string) {
        if (path.startsWith("/")) path = path.slice(1);
        else if (path.startsWith("./")) path = path.slice(2);
        const response = await fetch(this.getUrl(path), this.type === "github" ? {} : {});
        if (!response.ok) {
            const error = new Error(`Failed to load file: ${response.statusText}`);
            (error as any).response = response;
            throw new Error(`Failed to load file: ${response.statusText}`);
        }
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
