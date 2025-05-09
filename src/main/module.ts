import { EventsHandler } from "../events-handler.js";
import { Extension } from "./extension.js";
import { logVerbose, logError, logInfo, LogLevel, receiveData } from "../shared.js";
import type {
    OperationArgs,
    OperationEventPayload,
    OperationName,
    OperationResult,
    Operations,
} from "../operations.js";
import { ERError } from "../error.js";
import { StateOptions } from "../state.js";
import { Meta } from "../meta.js";

/**
 * @template E Extension
 * @template I In interface
 * @template S State
 * */
export type ModuleInit<E extends Extension, I extends object, S extends object = {}> = {
    origin: string;
    target: Window | Worker;
    meta: Meta;
    stateOptions?: StateOptions<S>;
    operations: Partial<Operations<E, I>>;
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

export type AnyModule = Module<any, any, any, any>;

type ModuleEvents<O extends object, S extends object> = {
    /**
     * State push received
     */
    push_state: {
        /**
         * Raw new state received from a module.
         *
         * Possibly modified by `ModuleInit.allowPopulateState`.
         * */
        state: S;
    };
    load: undefined;
    destroy: undefined;
    error: { error: unknown };
    /**
     * Adapter called an operation
     */
    operation: OperationEventPayload<O, OperationName<any, O>>;
};

/**
 * Represents an iframe or a worker.
 *
 * @template E Extension
 * @template I Input interface (local)
 * @template O Output interface (remote)
 * @template S State
 * */
export class Module<
    E extends Extension<any>,
    O extends object,
    I extends object,
    S extends object = {}
> extends EventsHandler<ModuleEvents<O, S>> {
    readonly id = crypto.randomUUID();
    private _logLevel: LogLevel;
    private _init: ModuleInit<E, I, S>;

    constructor(readonly extension: E, init: ModuleInit<E, I, S>) {
        super();
        this._init = init;
        this._logLevel = this._init.logLevel || "error";
        if (init.stateOptions?.initialState) {
            this._state = init.stateOptions?.initialState;
        }
    }

    get ref() {
        return `${this.extension.name}/${this._init.meta.path}`;
    }

    private started = false;

    async start(): Promise<this> {
        if (this.started) return this;

        this.started = true;

        return new Promise<this>((resolve, reject) => {
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

                        const ev = this._emit("push_state", {
                            state,
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
                            const result = await this.execute(operation, ...args);

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

                            this._emit("operation", {
                                args,
                                result,
                                error: null,
                                operation,
                            });
                        } catch (error) {
                            logError(
                                "Module ",
                                this.ref,
                                " failed to execute remotely called operation '",
                                operation,
                                error
                            );

                            this._emit("operation", {
                                args,
                                result: undefined,
                                error,
                                operation,
                            });
                        }

                        break;
                    case "ready":
                        if (!resolved) resolve(this);
                        this._emit("load", undefined);
                        resolved = true;
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
        this._emit("error", { error });
    }

    private _postMessage(type: string, data: object, transfer?: Transferable[]) {
        this._init.target.postMessage(
            { ...data, __type: type },
            { transfer, targetOrigin: this._init.origin }
        );
    }

    private _state: S = {} as S;

    // #### API ####

    get state() {
        return this._state;
    }

    get meta() {
        return this._init.meta;
    }

    async execute<T extends OperationName<E, I>>(
        operation: T,
        ...args: OperationArgs<E, I, T>
    ): Promise<OperationResult<E, I, T>> {
        const op = this._init.operations?.[operation];

        if (typeof op !== "function") {
            throw new ERError(`Operation '${operation}' not found`, ["not_found"]);
        }

        return op.apply(this.extension, args) as any;
    }

    async remoteExecute<T extends OperationName<E, O>>(
        operation: T,
        ...args: OperationArgs<E, O, T>
    ): Promise<OperationArgs<E, O, T>> {
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
        this._clearListener();
        this._emit("destroy", undefined as any);
    }
}
