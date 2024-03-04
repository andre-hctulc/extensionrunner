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
    constructor(readonly target: Window | Worker, readonly meta: Meta, private out: O, protected options: ModuleOptions<I, O, S>) {}

    async start(): Promise<this> {
        return new Promise<this>((resolve, reject) => {
            let resolved = false;
            // handle messages
            this.target.onmessage = async e => {
                console.log("MESG");

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
                        const op = await this.out[operation];

                        (port as MessagePort).onmessageerror = e => {
                            this.err("Operation Channel Error", e);
                        };

                        if (typeof op !== "function") return this.err("Operation not found", null);

                        try {
                            const result = await op(...args);
                            (port as MessagePort).postMessage({ __type: "operation:result", payload: result });
                        } catch (err) {
                            return this.err("Operation Execution Error", err);
                        }

                        break;
                    case "ready":
                        resolved = true;
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
                        break;
                }
            };
            // errors
            this.target.onmessageerror = (e: any) => {
                this.err("Message Error", e);
            };
            this.target.onerror = (e: any) => {
                if (!resolved) {
                    resolved = true;
                    reject(this.err("Initialization Error", e));
                } else this.err("Uncaught Error", e);
            };

            // Post meta, so the worker knows which module to import (for workers)
            // iframes do not neccessarily need this
            this.target.postMessage({ __type: "meta", meta: this.meta });

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
        return err;
    }

    protected postMessage(type: string, data: object, transfer?: Transferable[]) {
        if (this.target instanceof Worker) this.target.postMessage({ __type: type, ...data }, { transfer });
        else if (this.target) this.target.postMessage({ __type: type, ...data }, "*", transfer);
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
