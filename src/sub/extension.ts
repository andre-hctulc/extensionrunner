import { ERError } from "../error.js";
import { EventsHandler } from "../events-handler.js";
import { getMessageData, isBrowser, loadFile, LogLevel, logVerbose, receiveData } from "../shared.js";
import type {
    OperationName,
    OperationArgs,
    Operations,
    OperationResult,
    OperationEventPayload,
} from "../operations.js";
import { Meta } from "../meta.js";

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

const glob: Record<string, any> = globalThis || {};

function getMeta() {
    return glob.$ER?.meta;
}

function getState() {
    return glob.$ER?.state || {};
}

function setMeta(newMeta: any) {
    if (!glob.$ER) glob.$ER = {};
    glob.$ER.meta = newMeta;
}

function setState(newState: any) {
    if (!glob.$ER) glob.$ER = {};
    glob.$ER.state = newState || {};
}

export function postToParent(type: string, data: object, origin: string, transfer?: Transferable[]) {
    if (isBrowser) (window as Window).parent.postMessage({ ...data, __type: type }, origin, transfer || []);
    else self.postMessage({ ...data, __type: type }, origin, transfer || []);
}

export type ExtensionInit<S extends object = {}> = {
    /** URL, origin of the provider app */
    provider: string;
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
    logLevel?: LogLevel;
};

export interface ExtensionPushStateOptions {
    /** @default true */
    populate?: boolean;
    /**
     * Merge states instead of overwriting them
     * @default true
     * */
    merge?: boolean;
}

type ExtensionEvents<O extends object, S extends object> = {
    state_update: { state: S };
    /**
     * Provider called an operation
     */
    operation: OperationEventPayload<O, OperationName<any, O>>;
    error: { error: unknown };
    start: undefined;
    destroy: undefined;
};

/**
 * Extension Adapter.
 *
 * @template I Input interface (local)
 * @template O Output interface (remote)
 * @template S State
 * */
export abstract class Extension<
    I extends object = object,
    O extends object = object,
    S extends object = object
> extends EventsHandler<ExtensionEvents<O, S>> {
    readonly id = crypto.randomUUID();
    private _logLevel: LogLevel;

    constructor(readonly init: ExtensionInit<S>) {
        super();
        this._listen();
        this._logLevel = init?.logLevel || "error";
    }

    private _listen() {
        // handle messages
        addEventListener("message", async (e) => {
            logVerbose(this._logLevel, "Adapter received message event:", e);

            // origin will be "" for modules, as the import worker is dynamically created (See ./CorsWorker.ts)
            // e.origin="" -> origin self
            if (e.origin !== "" && e.origin !== this.init.provider) {
                this._err("Unauthorized - Event origin and provider origin mismatch", undefined);
                return;
            }
            if (typeof e?.data?.__type !== "string") return;

            const type = e.data.__type;

            switch (type) {
                case "destroy":
                    this._emit("destroy", undefined);
                    logVerbose(this._logLevel, "Adapter destroyed");
                    this.onDestroy?.();
                    break;

                case "state_push":
                    const newState = e.data.state;
                    if (!newState || typeof newState !== "object") {
                        return this._err("Invalid state received", new ERError("State not found"));
                    }
                    logVerbose(this._logLevel, "State push received: ", newState);
                    // Set state only here, so module and provider state are the in sync
                    setState(newState);
                    this._emit("state_update", { state: e.data.state });
                    break;

                case "operation":
                    const { args, operation, __port: port } = e.data;

                    if (!port) return this._err("Operation Channel Error", new ERError("Port not found"));

                    (port as MessagePort).onmessageerror = (e) => {
                        this._err("Operation Channel Error", new ERError("Operation Channel Error"));
                    };

                    try {
                        const result = await this.execute(operation, ...args);
                        (port as MessagePort).postMessage({
                            __type: "operation:result",
                            payload: result,
                        });
                        logVerbose(this._logLevel, "Executed remotely called operation '", operation, "'");
                        this._emit("operation", {
                            args,
                            result,
                            error: null,
                            operation,
                        });
                    } catch (err) {
                        logVerbose(
                            this._logLevel,
                            "Remote execution error at operation '",
                            operation,
                            "': ",
                            err
                        );
                        this._err("Operation Execution Error", err);
                        this._emit("operation", {
                            args,
                            result: undefined,
                            error: err,
                            operation,
                        });
                        return;
                    }

                    break;
            }
        });
    }

    private _started = false;

    async start(): Promise<this> {
        if (this._started) return this;

        this._started = true;

        // Already initialized? modules are initialized before the adapter can mount (module worker src/worker.ts)
        if (getMeta()) {
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
            addEventListener("message", (e) => {
                const d = getMessageData(e, "meta");
                if (d && !resolved) {
                    resolved = true;
                    this.onStart?.();
                    this._emit("start", undefined);
                    logVerbose(this._logLevel, "Adapter started");
                    resolve(this);
                }
            });
        });
    }

    private _err(info: string, error: unknown) {
        console.error(info, error);
        this._emit("error", { error });
    }

    // #### Abstract ####

    abstract operations: Partial<Operations<this, I>>;

    // Lifecycle
    onStart?(): void;
    onDestroy?(): void;

    // #### API ####

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

    async execute<T extends OperationName<this, I>>(
        operation: T,
        ...args: OperationArgs<this, I, T>
    ): Promise<OperationResult<this, I, T>> {
        const op = await this.operations?.[operation];

        if (typeof op !== "function") {
            throw new ERError(`Operation '${operation}' not found`, ["not_found"]);
        }

        return op.apply(this, args) as any;
    }

    async remoteExecute<T extends OperationName<this, O>>(
        operation: T,
        ...args: OperationArgs<this, O, T>
    ): Promise<OperationResult<this, O, T>> {
        return await receiveData(
            isBrowser ? parent : self,
            "operation",
            { args, operation, __token: this.meta.authToken },
            this.init.provider,
            [],
            this.init.operationTimeout
        );
    }

    async pushState(newState: S | undefined, options?: ExtensionPushStateOptions) {
        /*
        The state gets set, when the provider sends a state_push message back, 
        so the states are in sync.
        See state_push
        */

        // DEBUG console.log("pushState", this.id, newState);

        postToParent(
            "push_state",
            {
                state: newState,
                /* Set props explicitly to prevent unwanted data from being transferred */
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
