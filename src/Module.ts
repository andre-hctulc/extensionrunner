import { EventsHandler } from "./EventsHandler.js";
import { Extension } from "./Extension.js";
import { randomId, receiveData } from "./shared.js";
import type { Meta, OperationArgs, OperationEvents, OperationName, Operations } from "./types.js";

export interface ModuleOptions<O extends object, I extends object, S extends object = {}> {
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

type ModuleInit<O extends object, I extends object, S extends object = {}> = {
    origin: string;
    target: Window | Worker;
    meta: Meta;
    out: Operations<Module<O, I, S>, O>;
};

type ModuleEvents<I extends object> = {
    state_populate: { state: any; options: any };
    load: undefined;
    destroy: undefined;
} & OperationEvents<I>;

export type ModulePushStateOptions = {
    /** @default false */
    merge?: boolean;
};

/** Represents an iframe or a worker */
export class Module<O extends object, I extends object, S extends object = {}> extends EventsHandler<ModuleEvents<I>> {
    private logs: boolean;
    readonly id = randomId();

    constructor(readonly extension: Extension, private init: ModuleInit<O, I, S>, protected options: ModuleOptions<O, I, S>) {
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
                // authenticate
                // TODO if (e.origin !== this.origin) return;
                // TODO if (e.data?.__token !== this.meta.authToken) return;

                if (typeof e?.data?.__type !== "string") return;

                const type = e.data.__type;

                switch (type) {
                    case "state_populate":
                        this._state = e.data.state;
                        this.emitEvent("state_populate", { state: e.data.state, options: e.data.options } as any);
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
                                (port as MessagePort).postMessage({ __type: "operation:result", payload: result });
                                this.emitEvent(`op:${operation}`, { args, result, error: null } as any);
                            } catch (err) {
                                const e = this.err("Operation Execution Error", err);
                                this.emitEvent(`op:${operation}`, { args, result: undefined, error: e } as any);
                                return;
                            }
                        } else {
                            this.emitEvent(`op:${operation}`, { args, result: undefined, error: null } as any);
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
            this.init.target.postMessage({ __type: "meta", meta: this.init.meta }, { targetOrigin: "*" }); // TODO targetOrigin

            setTimeout(() => {
                if (!resolved) reject(this.err("Connection timeout", null));
            }, this.options.connectionTimeout || 5000);
        });
    }

    private _state: S | undefined;

    get state() {
        return this._state;
    }

    get meta() {
        return this.init.meta;
    }

    protected err(info: string, event: Event | unknown) {
        const msg =
            event instanceof Event ? ((event as any).message || (event as any).data || "").toString() : event instanceof Error ? event.message : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        console.error(info, err);
        return err;
    }

    protected postMessage(type: string, data: object, transfer?: Transferable[]) {
        this.init.target.postMessage({ ...data, __type: type }, { transfer });
    }

    async execute<T extends OperationName<I>>(operation: T, ...args: OperationArgs<I, T>): Promise<OperationArgs<I, T>> {
        // TODO "*" origin
        return await receiveData(this.init.target, "operation", { args, operation }, "*", [], this.options.operationTimeout);
    }

    async pushState(newState: S | undefined, options?: ModulePushStateOptions) {
        this.postMessage("state_push", {
            state: newState,
            /* Set explicitly to prevent unwanted data from being trandsfered */
            options: { merge: !!options?.merge },
        });
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
