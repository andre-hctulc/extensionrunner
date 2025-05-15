import { ERError } from "../error.js";
import { EREventListener, EREventType, EventsHandler } from "../events-handler.js";
import { getMessageData, isBrowser, loadFile, LogLevel, logVerbose, receiveData } from "../util.js";
import type {
    OperationName,
    OperationArgs,
    Operations,
    OperationResult,
    OperationEventPayload,
} from "../operations.js";
import { Meta } from "../meta.js";
import { AnyState } from "../state.js";
import { Adapter } from "../module.js";

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

export type WorkerAdapterInit<S extends object = {}> = {
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

type WorkerAdapterEvents = {
    "state:push": { state: AnyState };
    "operation:success": OperationEventPayload;
    "operation:error": OperationEventPayload;
    error: { error: unknown };
    load: undefined;
    destroy: undefined;
};

/**
 * Adapter for connecting to the the main thread.
 *
 * @template M Module API (remote)
 * @template W Worker API (local)
 * @template S State
 * */
export abstract class WorkerAdapter<
    M extends object = object,
    W extends object = object,
    S extends object = AnyState
> extends Adapter<S> {
    private _logLevel: LogLevel;
    private _init: WorkerAdapterInit<S>;
    private _events = new EventsHandler<WorkerAdapterEvents>();

    constructor(init: WorkerAdapterInit<S>) {
        super("");
        this._init = { ...init };
        this._listen();
        this._logLevel = init?.logLevel || "error";
    }

    private _listen() {
        // handle messages
        addEventListener("message", async (e) => {
            logVerbose(this._logLevel, "Adapter received message event:", e);

            // e.origin="" means origin self. For cors workers the origin will always be "" (see cors-worker.ts).
            if (e.origin !== "" && origin !== "*" && e.origin !== this._init.provider) {
                this._err("Unauthorized", undefined);
                return;
            }
            if (typeof e?.data?.__type !== "string") return;

            const type = e.data.__type;

            switch (type) {
                case "destroy":
                    this._events.emit("destroy", undefined);
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
                    this._events.emit("state:push", { state: e.data.state });
                    break;

                case "operation":
                    const { args, operation, __port: port } = e.data;

                    if (!port) return this._err("Operation Channel Error", new ERError("Port not found"));

                    (port as MessagePort).onmessageerror = (e) => {
                        this._err("Operation Channel Error", new ERError("Operation Channel Error"));
                    };

                    try {
                        const result = await this.executeLocal(operation, ...args);
                        (port as MessagePort).postMessage({
                            __type: "operation:result",
                            payload: result,
                        });
                        logVerbose(this._logLevel, "Executed remotely called operation '", operation, "'");
                        this._events.emit("operation:success", {
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
                        this._events.emit("operation:error", {
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

    override async start(): Promise<void> {
        if (this._started) return;

        this._started = true;

        // Already initialized? modules are initialized before the adapter can mount (module worker src/worker.ts)
        if (getMeta()) {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            let resolved = false;

            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                return reject(new Error("Provider start timeout"));
            }, this._init.startTimeout || 5000);

            // await meta init (the meta init listener is defined globally, so it is guaranteed to be called before)
            addEventListener("message", (e) => {
                const d = getMessageData(e, "meta");
                if (d && !resolved) {
                    resolved = true;
                    this.onStart?.();
                    this._events.emit("load", undefined);
                    logVerbose(this._logLevel, "Adapter started");
                    resolve();
                }
            });
        });
    }

    private _err(info: string, error: unknown) {
        console.error(info, error);
        this._events.emit("error", { error });
    }

    // ### Lifecycle ####

    onStart?(): void;
    onDestroy?(): void;

    // #### Meta ####

    get meta(): Meta {
        const m = getMeta();
        if (!m)
            throw new Error(
                "Meta not defined. " + (this._started ? "(unexpected)" : "The adapter has not been started")
            );
        return m;
    }

    // #### Operations ####

    abstract operations: Partial<Operations<this, W>>;

    async executeLocal<T extends OperationName<this, W>>(
        operation: T,
        ...args: OperationArgs<this, W, T>
    ): Promise<OperationResult<this, W, T>> {
        const op = await this.operations?.[operation];

        if (typeof op !== "function") {
            throw new ERError(`Operation '${operation}' not found`, ["not_found"]);
        }

        return op.apply(this, args) as any;
    }

    async execute<T extends OperationName<this, M>>(
        operation: T,
        ...args: OperationArgs<this, M, T>
    ): Promise<OperationResult<this, M, T>> {
        return await receiveData(
            isBrowser ? parent : self,
            "operation",
            { args, operation, __token: this.meta.authToken },
            this._init.provider,
            [],
            this._init.operationTimeout
        );
    }

    // #### State ####

    async pushState(newState: S) {
        /*
        The state gets set, when the provider sends a state_push message back, 
        so the states are in sync.
        See state_push
        */

        postToParent(
            "push_state",
            {
                state: newState,
                __token: this.meta.authToken,
            },
            this._init.provider
        );
    }
    // #### Files ####

    /** If the response is not ok, the `Response` will be set on the thrown error (`Error.response`) */
    async loadFile(path: string) {
        return await loadFile(this.meta.type, this.meta.name, this.meta.version, path);
    }

    // #### Events ####

    on<K extends EREventType<WorkerAdapterEvents> = EREventType<WorkerAdapterEvents>>(
        event: K | null,
        listener: EREventListener<WorkerAdapterEvents, K>
    ): this {
        this._events.on(event, listener);
        return this;
    }

    off<K extends EREventType<WorkerAdapterEvents> = EREventType<WorkerAdapterEvents>>(
        event: K | null,
        listener: EREventListener<WorkerAdapterEvents, K>
    ): this {
        this._events.off(event, listener);
        return this;
    }
}
