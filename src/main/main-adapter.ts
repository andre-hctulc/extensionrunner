import { Extension } from "./extension.js";
import { logVerbose, logError, logInfo, LogLevel, receiveData } from "../util.js";
import type {
    OperationArgs,
    OperationEventPayload,
    OperationName,
    OperationResult,
    Operations,
} from "../operations.js";
import { ERError } from "../error.js";
import { AnyState, StateOptions } from "../state.js";
import { Meta } from "../meta.js";
import { Adapter } from "../module.js";

/**
 * @template M Main API interface
 * @template S State
 * */
export type MainAdapterInit<M extends object = object, S extends object = AnyState> = {
    origin: string;
    target: Window | Worker;
    meta: Meta;
    stateOptions?: StateOptions<S>;
    operations: Partial<Operations<Extension, M>>;
    /**
     * @default crypto.randomUUID()
     */
    id?: string;
    /**
     * Max time to wait for module to connect
     * @default 5000
     * */
    connectionTimeout?: number;
    /**
     * Max time to wait for operation result
     * @default 5000
     */
    operationTimeout?: number;
    /**
     * Defaults to extension's log level.
     */
    logLevel?: LogLevel;
};

export type AnyMainAdapter = MainAdapter<any, any, any>;

export interface MainAdapterEventPayloadBase {
    adapter: AnyMainAdapter;
}

export interface MainAdapterEvents {
    /**
     * State push received
     */
    "state:push": MainAdapterEventPayloadBase & {
        /**
         * Raw new state received from a module.
         *
         * Possibly modified by `ModuleInit.allowPopulateState`.
         * */
        state: Record<string, any>;
    };
    "adapter:load": MainAdapterEventPayloadBase;
    "adapter:destroy": MainAdapterEventPayloadBase;
    /**
     * Adapter called an operation
     */
    "operation:success": MainAdapterEventPayloadBase & OperationEventPayload;
    /**
     * Adapter called an operation
     */
    "operation:error": MainAdapterEventPayloadBase & OperationEventPayload;
}

/**
 * Represents an iframe or a worker.
 *
 * @template M Main API interface
 * @template W Worker API interface
 * @template S State
 * */
export class MainAdapter<
    M extends object = object,
    W extends object = object,
    S extends object = AnyState
> extends Adapter<S> {
    private _logLevel: LogLevel;
    private _init: MainAdapterInit<M, S>;

    constructor(readonly extension: Extension, init: MainAdapterInit<M, S>) {
        super(init.id ?? crypto.randomUUID(), init.stateOptions?.initialState);
        this._init = init;
        this._logLevel = this._init.logLevel || "error";
    }

    get ref() {
        return `${this.extension.name}/${this._init.meta.path}`;
    }

    get runner() {
        return this.extension.runner;
    }

    private _started = false;

    override async start() {
        if (this._started) return;

        this._started = true;

        return new Promise<void>((resolve, reject) => {
            // In CORS context target is Window (iframe.contentWindow)
            // We cant define target.onmessage or target.onerror on a cross origin Window
            // Thats why we listen to the message event on the global object and check the source

            let resolved = false;

            const messagesListener: (e: MessageEvent) => void = async (e) => {
                // origin = "" -> same origin
                if (e.origin !== "" && e.origin !== this._init.origin) return;
                if (e.data?.__token !== this.meta.authToken) return;

                if (typeof e?.data?.__type !== "string") return;

                const type = e.data.__type;

                switch (type) {
                    case "push_state":
                        let state = e.data.state;

                        if (!state || typeof state !== "object")
                            return this._err("Invalid state received", e);

                        const ev = this.runner.emit("state:push", {
                            state,
                            adapter: this,
                        });

                        if (ev.defaultPrevented) {
                            return;
                        }

                        logVerbose(this._logLevel, "State push received from module", this.ref, "\n", state);

                        try {
                            // confirm state
                            await this.pushState(state);
                        } catch (err) {}

                        break;
                    case "operation":
                        const { args, operation, __port: port } = e.data;

                        if (!port) {
                            return this._err("Operation Channel Error", "Port not found");
                        }

                        (port as MessagePort).onmessageerror = (e) => {
                            this._err("Operation Channel Error", e);
                        };

                        try {
                            const result = await this.executeLocal(operation, ...args);

                            (port as MessagePort).postMessage({
                                __type: "operation:result",
                                payload: result,
                            });

                            logVerbose(
                                this._logLevel,
                                "Module ",
                                this.ref,
                                " executed remotely called operation '",
                                operation,
                                "'"
                            );

                            this.runner.emit("operation:success", {
                                args,
                                result,
                                error: null,
                                operation,
                                adapter: this,
                            });
                        } catch (error) {
                            logError(
                                "Module ",
                                this.ref,
                                " failed to execute remotely called operation '",
                                operation,
                                error
                            );

                            this.runner.emit("operation:error", {
                                args,
                                result: undefined,
                                error,
                                operation,
                                adapter: this,
                            });
                        }

                        break;
                    case "ready":
                        if (!resolved) {
                            this.runner.emit("adapter:load", { adapter: this });
                        }
                        resolved = true;
                        resolve();
                        break;
                }
            };

            /*
             worker messages are only received via Worker.onmessage, 
             whereas iframe messages are received via window.onmessage or iframe.contentWindow.onmessage.
             So we need to handle workers and iframes differently
            */

            // Worker
            if (this._init.target instanceof Worker) {
                logInfo(this._logLevel, "Listening on worker for messages");
                this._init.target.addEventListener("message", messagesListener);
            }
            // IFrame
            else {
                logInfo(this._logLevel, "Listening on window for messages");
                (window as Window).addEventListener("message", messagesListener);
            }

            // Post meta:
            // - Workers need this to import the module in the worker initialization, which dynamically imports the module
            // - Iframes need this to init their meta
            this._init.target.postMessage(
                { __type: "meta", meta: this._init.meta },
                { targetOrigin: this._init.origin }
            );

            setTimeout(() => {
                if (!resolved) reject(this._err("Connection timeout", null));
            }, this._init.connectionTimeout || 5000);
        });
    }

    private _err(message: string, error: unknown) {
        logError(message, error);
        this.runner.emit("error", { error, adapter: this });
    }

    private _postMessage(type: string, data: object, transfer?: Transferable[]) {
        this._init.target.postMessage(
            { ...data, __type: type },
            { transfer, targetOrigin: this._init.origin }
        );
    }

    // #### API ####

    get meta() {
        return this._init.meta;
    }

    async executeLocal<T extends OperationName<Extension, M>>(
        operation: T,
        ...args: OperationArgs<Extension, M, T>
    ): Promise<OperationResult<Extension, M, T>> {
        const op = this._init.operations?.[operation];

        if (typeof op !== "function") {
            throw new ERError(`Operation '${operation}' not found`, ["not_found"]);
        }

        return op.apply(this.extension, args) as any;
    }

    async execute<T extends OperationName<Extension, W>>(
        operation: T,
        ...args: OperationArgs<Extension, W, T>
    ): Promise<OperationResult<Extension, W, T>> {
        return await receiveData(
            this._init.target,
            "operation",
            { args, operation },
            this._init.origin,
            [],
            this._init.operationTimeout
        );
    }

    async pushState(newState: S) {
        await this._postMessage("state_push", {
            state: newState,
        });

        logVerbose(this._logLevel, "State pushed to ", this.ref);

        // Set state for this module (push state success)
        // Set state only here, so the state in the module is the same as here (the provider)
        this._state = newState;
    }

    async destroy() {
        await this._postMessage("destroy", {});
        if (this._init.target instanceof Worker) {
            try {
                this._init.target.terminate();
            } catch (err) {}
        }
        this.runner.emit("adapter:destroy", { adapter: this });
    }
}
