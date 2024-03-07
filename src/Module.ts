import { EventsHandler } from "./EventsHandler.js";
import { Extension } from "./Extension.js";
import { randomId, receiveData } from "./shared.js";
import type { Meta, OperationArgs, OperationEvents, OperationName, Operations } from "./types.js";

type ModuleInit<O extends object, I extends object, S extends object = {}> = {
    origin: string;
    target: Window | Worker;
    meta: Meta;
    out: Partial<Operations<Module<O, I, S>, O>>;
    /**
     * Max time to wait for ready
     * @default 5000
     * */
    connectionTimeout?: number;
    /**
     * Max time to wait for operation result
     */
    operationTimeout?: number;
    initialState?: S;
    /**
     * Allows adapters to push states to the provider. The provider then populates the state.
     *
     * If a given callback modifies the state and _merge_ is true it should return a partial state, otherwise the whole modified state.
     * For merge pushes, the allowed state, modified or not, is merged with `ModuleInit.mergeStates` or the dafault merge,
     * to create the new state.
     *
     * @default false
     */
    allowPopulateState?: ((state: Partial<S> | undefined, merge: boolean) => boolean | Partial<S>) | boolean;
    /**
     * Customize how states are merged
     * @default { ...oldState, ...newState }
     */
    mergeStates?: (oldState: Partial<S> | undefined, newState: Partial<S> | undefined) => Partial<S>;
};

type ModuleEvents<I extends object> = {
    state_populate: {
        /**
         * Raw new state received from a module.
         *
         * Possibly modified by `ModuleInit.allowPopulateState`.
         * */
        state: object;
        options: any;
    };
    load: undefined;
    destroy: undefined;
    error: Error;
} & OperationEvents<I>;

export type PushStateOptions = {
    /** @default true */
    merge?: boolean;
};

/** Represents an iframe or a worker */
export class Module<O extends object, I extends object, S extends object = {}> extends EventsHandler<
    ModuleEvents<I>
> {
    private logs: boolean;
    readonly id = randomId();

    constructor(readonly extension: Extension, private init: ModuleInit<O, I, S>) {
        super();
        this.logs = !!this.extension.provider.options?.logs;
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

            const messagesListener: (e: MessageEvent) => void = async e => {
                // origin = "" -> same origin
                if (e.origin !== "" && e.origin !== this.init.origin) return;
                if (e.data?.__token !== this.meta.authToken) return;

                if (typeof e?.data?.__type !== "string") return;

                const type = e.data.__type;

                switch (type) {
                    case "state_populate":
                        let receivedState = e.data.state;

                        if (!receivedState || typeof receivedState !== "object")
                            return this.err("Invalid state received", e);

                        const options = e.data.options || {};
                        let newState: any;

                        if (this.init.allowPopulateState) {
                            const merge = !!options.merge;

                            const allowed =
                                this.init.allowPopulateState === true ||
                                this.init.allowPopulateState?.(receivedState, merge);

                            if (!allowed) return;

                            // state allowed but modified
                            if (typeof allowed === "object") receivedState = allowed;
                            else newState = receivedState;
                        } else {
                            return;
                        }

                        this.emitEvent("state_populate", {
                            state: newState,
                            options,
                        } as any);
                        break;
                    case "operation":
                        const { args, operation, __port: port } = e.data;

                        if (!port) return this.err("Operation Channel Error", "Port not found");

                        let op: any = await (this.init.out as any)?.[operation];
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
                                const e = this.err("Operation Execution Error", err);
                                this.emitEvent(`op:${operation}`, {
                                    args,
                                    result: undefined,
                                    error: e,
                                } as any);
                                return;
                            }
                        } else {
                            this.emitEvent(`op:${operation}`, {
                                args,
                                result: undefined,
                                error: null,
                            } as any);
                        }

                        break;
                    case "ready":
                        if (!resolved) resolve(this);
                        this.emitEvent("load", undefined as any);
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
            if (this.init.target instanceof Worker) {
                if (this.logs) console.log("Listening on worker for messages");
                this.init.target.addEventListener("message", messagesListener);
            }
            // IFrame
            else {
                if (this.logs) console.log("Listening on window for messages");
                (window as Window).addEventListener("message", messagesListener);
            }

            // Post meta:
            // - Workers need this to import the module in the worker initialization, whoich dynamically imports the module
            // - Iframes need this to init their meta
            this.init.target.postMessage(
                { __type: "meta", meta: this.init.meta },
                { targetOrigin: this.init.origin }
            );

            setTimeout(() => {
                if (!resolved) reject(this.err("Connection timeout", null));
            }, this.init.connectionTimeout || 5000);
        });
    }

    private _state: Partial<S> | undefined;

    get state() {
        return this._state;
    }

    get meta() {
        return this.init.meta;
    }

    private err(info: string, event: Event | unknown) {
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

    private postMessage(type: string, data: object, transfer?: Transferable[]) {
        this.init.target.postMessage({ ...data, __type: type }, { transfer, targetOrigin: this.init.origin });
    }

    async execute<T extends OperationName<I>>(
        operation: T,
        ...args: OperationArgs<I, T>
    ): Promise<OperationArgs<I, T>> {
        return await receiveData(
            this.init.target,
            "operation",
            { args, operation },
            this.init.origin,
            [],
            this.init.operationTimeout
        );
    }

    async pushState(newState: Partial<S>, options?: PushStateOptions) {
        let s: Partial<S>;

        if (options?.merge !== false) {
            if (this.init.mergeStates) {
                s = this.init.mergeStates(this.state, newState);
            } else {
                s = { ...this.state, ...newState };
            }
        } else s = newState;

        await this.postMessage("state_push", {
            state: s,
        });

        // Set state for this module (push state success)
        // Set state only here, so the state in the module is the same as here (the provider)
        this._state = s;

        // return a complete state here
        //  as the state in modules is overwritten in the adapter with the pushed state
        return s;
    }

    destroy() {
        if (this.init.target instanceof Worker) {
            try {
                this.init.target.terminate();
            } catch (err) {}
        }
        this.clearListeners();
        this.emitEvent("destroy", undefined as any);
    }
}
