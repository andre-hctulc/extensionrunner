import { receiveData } from "./shared.js";
import { EventType, Operation, OperationArgs, Operations } from "./types.js";

/*
Worker env
*/

/** Represents an iframe or a worker */
class Adapter<I extends Operations, O extends Operations, S = any> {
    // OPTIONS

    onError?: (err: Error) => void;
    onPushState?: (newState: S) => void;
    onEvent?: (type: EventType<I>, payload: OperationArgs<I, `event_${EventType<I>}`>) => void;
    /**
     * Max time to wait for operation result
     */
    operationTimeout?: number;
    initialState?: S;
    out = {} as O;

    // MESSGAES

    constructor() {
        // handle messages
        self.onmessage = async e => {
            if (typeof e?.data?.__type !== "string") return;
            const type = e.data.__type;
            switch (type) {
                case "state_push":
                    this.onPushState?.(e.data.state);
                    break;
                case "event":
                    this.onEvent?.(e.data.event, e.data.args);
                    break;
                case "operation":
                    const { args, operation, port } = e.data;
                    const op = await this.out?.[operation];

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
            }
        };

        // errors
        self.onmessageerror = e => {
            this.err("Message Error", e);
        };
        self.onerror = e => {
            this.err("Uncaught Error", e);
        };
    }

    // API

    protected err(info: string, event: Event | unknown) {
        const msg =
            event instanceof Event ? ((event as any).message || (event as any).data || "").toString() : event instanceof Error ? event.message : "";
        const err = new Error(`${info}${msg ? ": " + msg : ""}`);
        this?.onError?.(err);
        return err;
    }

    protected postMessage(type: string, data: object, transfer?: Transferable[]) {
        postMessage({ __type: type, ...data }, "*", transfer);
    }

    async execute<T extends Operation<O>>(operation: T, ...args: OperationArgs<O, T>): Promise<OperationArgs<O, T>> {
        return await receiveData(self, "operation", { args, operation }, [], this.operationTimeout);
    }

    async emitEvent<T extends EventType<I>>(type: T, payload: OperationArgs<I, `event_${T}`>) {
        this.postMessage("event", { event: type, args: payload });
    }

    async pushState(newState: S | undefined, populate = true) {
        this.postMessage("state_push", { state: newState, populate });
    }
}

const adapter = new Adapter();

export default adapter;

export type { Adapter };
