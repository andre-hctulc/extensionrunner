import type { Extension } from "./Extension.js";
import { receiveData } from "./shared.js";
import { EventType, Meta, Operation, OperationArgs, Operations } from "./types.js";

export interface ModuleOptions<I extends Operations, O extends Operations, S = any> {
    onError?: (err: Error) => void;
    onPushState?: (newState: S, populate: boolean) => void;
    onEvent?: (type: EventType<I>, payload: OperationArgs<I, `event_${EventType<I>}`>) => void;
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
}

/** Represents an iframe or a worker */
export class Module<I extends Operations, O extends Operations, S = any> {
    private logs: boolean;

    constructor(
        readonly extension: Extension,
        readonly origin: string,
        readonly target: MessageEventSource,
        readonly meta: Meta,
        private out: O,
        protected options: ModuleOptions<I, O, S>
    ) {
        this.logs = !!this.extension.provider.options?.logs;
    }

    private inited = false;
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
                // authenticate
                // TODO if (e.origin !== this.origin) return;
                // TODO if (e.data?.__token !== this.meta.authToken) return;

                if (typeof e?.data?.__type !== "string") return;

                const type = e.data.__type;

                switch (type) {
                    case "state_push":
                        this._state = e.data.state;
                        this.options.onPushState?.(e.data.state, !!e.data.populate);
                        break;
                    case "event":
                        this.options.onEvent?.(e.data.event, e.data.args);
                        break;
                    case "operation":
                        const { args, operation, __port: port } = e.data;

                        if (!port) return this.err("Operation Channel Error", "Port not found");

                        const op = await this.out[operation];
                        if (typeof op !== "function") return this.err("Operation not found", null);

                        (port as MessagePort).onmessageerror = e => {
                            this.err("Operation Channel Error", e);
                        };

                        try {
                            const result = await op(...args);
                            (port as MessagePort).postMessage({ __type: "operation:result", payload: result });
                        } catch (err) {
                            return this.err("Operation Execution Error", err);
                        }

                        break;
                    case "ready":
                        resolved = true;

                        // init events once
                        if (!this.inited) {
                            this.inited = true;

                            // init postMessage (received by worker.ts or iframe)
                            const events = new MessageChannel();
                            const eventsIn = events.port1;
                            const eventsOut = events.port2;

                            eventsIn.onmessageerror = e => {
                                this.err("Events Channel (in) Error", e);
                            };

                            eventsOut.onmessageerror = e => {
                                this.err("Events Channel (out) Error", e);
                            };
                            resolve(this);
                        }

                        break;
                }
            };

            /*
             worker messages are only received via Worker.onmessage, 
             whereas iframe messages are received via window.onmessage or iframe.contentWindow.onmessage.
             So we need to handle workers and iframes differently
            */

            // Worker
            if (this.target instanceof Worker) {
                if (this.logs) console.log("Listening on worker for messages");
                this.target.onmessage = messagesListener;
            }
            // IFrame
            else {
                if (this.logs) console.log("Listening to window for messages");
                (window as Window).addEventListener("message", messagesListener);
            }

            // Post meta:
            // - Workers need this to import the module in the worker initialization, whoich dynamicaally imports the module
            // - Iframes need this to init their meta
            this.target.postMessage({ __type: "meta", meta: this.meta }, { targetOrigin: "*" });

            setTimeout(() => {
                if (!resolved) reject(this.err("Connection timeout", null));
            }, this.options.connectionTimeout || 5000);
        });
    }

    private _state: S | undefined;

    get state() {
        return this._state;
    }

    protected err(info: string, event: Event | unknown) {
        const msg =
            event instanceof Event ? ((event as any).message || (event as any).data || "").toString() : event instanceof Error ? event.message : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        this.options?.onError?.(err);
        console.error(info, err);
        return err;
    }

    protected postMessage(type: string, data: object, transfer?: Transferable[]) {
        this.target.postMessage({ ...data, __type: type }, { transfer });
    }

    async execute<T extends Operation<O>>(operation: T, ...args: OperationArgs<O, T>): Promise<OperationArgs<O, T>> {
        return await receiveData(this.target, "operation", { args, operation }, [], this.options.operationTimeout);
    }

    async emitEvent<T extends EventType<I>>(type: T, payload: OperationArgs<I, `event_${T}`>) {
        this.postMessage("event", { event: type, args: payload });
    }

    async pushState(newState: S | undefined) {
        this.postMessage("state_push", { state: newState });
    }
}
