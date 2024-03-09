import { EventsHandler } from "./EventsHandler.js";
import { getMessageData, isBrowser, loadFile, randomId, receiveData } from "./shared.js";
import type {
    Meta,
    OperationName,
    OperationArgs,
    Operations,
    OperationEvents,
    OperationResult,
} from "./types.js";

/*
Runs in Worker/IFrame
*/

// Listen to meta init

// - For iframes meta initialization
// - For Modules the meta gets posted to the worker initialization which dynamically imports the module (and this file)
//   which means the meta should already be defined
const metaListener: (e: MessageEvent) => void = (e: MessageEvent) => {
    const meta = getMeta();
    if (meta) return removeEventListener("message", metaListener);
    const d = getMessageData(e, "meta");
    if (d) {
        // DEBUG console.log("Meta received", d.meta);
        setMeta(d.meta);
        setState(d.meta.initialState);
        // notify ready (Use parent.postmessage)
        postToParent("ready", { __token: d.meta.authToken }, "*");
        removeEventListener("message", metaListener);
    }
};

addEventListener("message", metaListener);

function getMeta() {
    return globalThis.$ER?.meta;
}

function getState() {
    return globalThis.$ER?.state || {};
}

function setMeta(newMeta: any) {
    if (!globalThis.$ER) globalThis.$ER = {};
    globalThis.$ER.meta = newMeta;
}

function setState(newState: any) {
    if (!globalThis.$ER) globalThis.$ER = {};
    globalThis.$ER.state = newState || {};
}

export function postToParent(type: string, data: object, origin: string, transfer?: Transferable[]) {
    if (isBrowser) (window as Window).parent.postMessage({ ...data, __type: type }, origin, transfer || []);
    else self.postMessage({ ...data, __type: type }, origin, transfer || []);
}

export type AdapterInit<I extends object, O extends object, S extends object = {}> = {
    /** URL, origin of the provider app */
    provider: string;
    out: Partial<Operations<Adapter<I, O, S>, O>>;
    /**
     * Max time to wait for operation result
     */
    operationTimeout?: number;
    initialState?: S;
    /**
     * Max time to wait for the provider to start
     * @default 5000
     * */
    startTimeout?: number;
    errorOnUnauthorized?: boolean;
};

export interface AdapterPushStateOptions {
    /** @default true */
    populate?: boolean;
    /**
     * Merge states instead of overwriting them
     * @default true
     * */
    merge?: boolean;
}

type AdapterEvents<I extends object> = OperationEvents<I> & {
    state_update: any;
    load: undefined;
    error: Error;
};

/** Extension adapter */
export default class Adapter<
    I extends object,
    O extends object = {},
    S extends object = {}
> extends EventsHandler<AdapterEvents<O>> {
    readonly id = "adapter_id:" + randomId();

    constructor(readonly init: AdapterInit<I, O, S>) {
        super();
        this.listen();
    }

    private listen() {
        // handle messages
        addEventListener("message", async e => {
            // e.rotin="" -> origin self
            if (e.origin !== "" && e.origin !== this.init.provider) {
                if (this.init.errorOnUnauthorized)
                    this.err("Unauthorized - Event origin and provider origin mismatch", undefined);
                return;
            }
            if (typeof e?.data?.__type !== "string") return;

            const type = e.data.__type;

            switch (type) {
                case "state_push":
                    const newState = e.data.state;
                    if (!newState || typeof newState !== "object")
                        return this.err("Invalid state received", e);
                    // Set state only here, so module and provider state are the in sync
                    setState(newState);
                    // DEBUG console.log("Received state_push", this.id, "New state:", this.state);
                    this.emitEvent("state_update", e.data.state);
                    break;
                case "operation":
                    const { args, operation, __port: port } = e.data;

                    if (!port) return this.err("Operation Channel Error", "Port not found");

                    let op = await (this.init.out as any)?.[operation];
                    if (typeof op !== "function") op = null;
                    (port as MessagePort).onmessageerror = e => {
                        this.err("Operation Channel Error", e);
                    };

                    if (op) {
                        try {
                            const result = await op.apply(this, args);
                            (port as MessagePort).postMessage({
                                __type: "operation:result",
                                payload: result,
                            });
                            this.emitEvent(`op:${operation}`, {
                                args,
                                result,
                                error: null,
                            } as any);
                        } catch (err) {
                            const error = this.err("Operation Execution Error", err);
                            this.emitEvent(`op:${operation}`, {
                                args,
                                result: undefined,
                                error,
                            } as any);
                            return;
                        }
                    } else
                        this.emitEvent(`op:${operation}`, {
                            args,
                            result: undefined,
                            error: null,
                        } as any);

                    break;
            }
        });
    }

    private _started = false;

    async start(onStart?: (this: Adapter<I, O, S>, adapter: this) => void): Promise<this> {
        if (this._started) return this;

        this._started = true;

        // Already initialzed? modules are initialized before the adapter can mount (module worker src/worker.ts)
        if (getMeta()) {
            if (onStart) onStart.apply(this, [this]);
            return this;
        }

        return new Promise((resolve, reject) => {
            let resolved = false;

            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                return reject(new Error("Provider start timeout"));
            }, this.init.startTimeout || 5000);

            // await meta init (the meta init listener is defined globally, so it is guaranteed to be called before)
            addEventListener("message", e => {
                const d = getMessageData(e, "meta");
                if (d && !resolved) {
                    resolved = true;
                    if (onStart) onStart.apply(this, [this]);
                    resolve(this);
                }
            });
        });
    }

    // API

    get meta(): Meta {
        const m = getMeta();
        if (!m)
            throw new Error(
                "Meta not defined. " + (this._started ? "(unexpected)" : "The adapter has not been started")
            );
        return m;
    }

    get state(): Partial<S> {
        return getState();
    }

    protected err(info: string, event: Event | unknown) {
        const msg =
            event instanceof Event
                ? ((event as any).message || (event as any).data || "").toString()
                : event instanceof Error
                ? event.message
                : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        console.error(info, err);
        this.emitEvent("error", err as any);
        return err;
    }

    async execute<T extends OperationName<I>>(
        operation: T,
        ...args: OperationArgs<I, T>
    ): Promise<OperationResult<I, T>> {
        return await receiveData(
            isBrowser ? parent : self,
            "operation",
            { args, operation, __token: this.meta.authToken },
            this.init.provider,
            [],
            this.init.operationTimeout
        );
    }

    async pushState(newState: S | undefined, options?: AdapterPushStateOptions) {
        /*
        The state gets set, when the provider sends a state_push message back, 
        so the states are in sync.
        See state_push
        */

        // DEBUG console.log("pushState", this.id, newState);

        postToParent(
            "state_populate",
            {
                state: newState,
                /* Set props explicitly to prevent unwanted data from being trandsfered */
                options: { merge: !options?.merge, populate: options?.populate !== false },
                __token: this.meta.authToken,
            },
            this.init.provider
        );
    }

    /** If the response is not ok, the `Response` will be set on the thrown error (`Error.response`) */
    async loadFile(path: string) {
        return await loadFile(this.meta.type, this.meta.name, this.meta.version, path);
    }
}
