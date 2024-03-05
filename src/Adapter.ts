import { Events, getMessageData, receiveData } from "./shared.js";
import { EventType, Meta, Operation, OperationArgs, Operations } from "./types.js";

/*
Runs in Worker/IFrame
*/

// Listen to meta init

// - For iframes meta initialization
// - For Modules the meta gets posted to the worker initialization which dynamically imports the module (and this file)
//   which means the meta should already be defined
const metaListener: (e: MessageEvent) => void = (e: MessageEvent) => {
    //TODO if ((globalThis as any).meta && typeof (globalThis as any).meta === "object") return removeEventListener("message", metaListener);

    const d = getMessageData(e, "meta");

    if (d) {
        console.log("Meta received", d.meta);
        (globalThis as any).meta = d.meta;
        removeEventListener("message", metaListener);
        // notify ready
        postMessage({ __type: "ready", __token: d.meta.authToken });
    }
};

addEventListener("message", metaListener);

export type AdapterInit<I extends Operations, O extends Operations, S = any> = {
    /** URL, origin of the provider app */
    provider: string;
    out: O;
    onError?: (err: Error) => void;
    onPushState?: (newState: S) => void;

    /**
     * Max time to wait for operation result
     */
    operationTimeout?: number;
    initialState?: S;
    // TODO mommentarily only provider is allowed
    allowOrigins?: string[];
};

/** Represents an iframe or a worker */
export default class Adapter<I extends Operations, O extends Operations, S = any> extends Events<
    EventType<I>,
    (payload: OperationArgs<I, `event_${EventType<I>}`>) => void
> {
    constructor(readonly init: AdapterInit<I, O, S>) {
        super();
        this.listen();
    }

    private listen() {
        // handle messages
        addEventListener("message", async e => {
            // TODO if(e.origin !== this.init.provider) return this.error("Unauthorized");

            if (typeof e?.data?.__type !== "string") return;

            const type = e.data.__type;

            switch (type) {
                case "state_push":
                    this.init.onPushState?.(e.data.state);
                    break;
                case "event":
                    this.notifyListeners?.(e.data.event, e.data.args);
                    break;
                case "operation":
                    const { args, operation, __port: port } = e.data;

                    if (!port) return this.err("Operation Channel Error", "Port not found");

                    const op = await this.init.out?.[operation];
                    if (typeof op !== "function") return this.err("Operation not found", null);

                    (port as MessagePort).onmessageerror = e => {
                        this.err("Operation Channel Error", e);
                    };

                    try {
                        const result = await op(...(args || []));
                        (port as MessagePort).postMessage({ __type: "operation:result", payload: result });
                    } catch (err) {
                        return this.err("Operation Execution Error", err);
                    }

                    break;
            }
        });
    }

    // API

    get meta(): Meta {
        const m = (globalThis as any).meta;
        if (!m || typeof m !== "object") throw new Error("Meta not defined");
        return m;
    }

    protected err(info: string, event: Event | unknown) {
        const msg =
            event instanceof Event ? ((event as any).message || (event as any).data || "").toString() : event instanceof Error ? event.message : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        this?.init?.onError?.(err);
        console.error(info, err);
        return err;
    }

    protected postMessage(type: string, data: object, transfer?: Transferable[]) {
        postMessage({ ...data, __type: type, __token: this.meta.authToken }, "*", transfer);
    }

    async execute<T extends Operation<O>>(operation: T, ...args: OperationArgs<O, T>): Promise<OperationArgs<O, T>> {
        return await receiveData(globalThis as any, "operation", { args, operation, __token: this.meta.authToken }, [], this.init.operationTimeout);
    }

    async emitEvent<T extends EventType<I>>(type: T, payload: OperationArgs<I, `event_${T}`>) {
        this.postMessage("event", { event: type, args: payload });
    }

    async pushState(newState: S | undefined, populate = true) {
        this.postMessage("state_push", { state: newState, populate });
    }
}
