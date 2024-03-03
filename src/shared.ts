export function relPath(path: string) {
    if (path.startsWith("./")) path = path.slice(2);
    else if (path.startsWith("/")) path = path.slice(1);
    return path;
}

export function getMessageData(e: MessageEvent, type: string): Record<string, any> | null {
    if (e.data && typeof e.data === "object" && e.data.__type === type) return e.data;
    return null;
}

export async function receiveData(target: Worker | Window, messageType: string, data: object, transfer: Transferable[], errTimeout = 5000) {
    return new Promise<any>((resolve, reject) => {
        const channel = new MessageChannel();
        const out = channel.port1;
        const in_ = channel.port2;
        let resolved = false;

        setTimeout(() => {
            if (!resolved) reject(new Error("Operation timeout"));
        }, errTimeout);

        in_.onmessage = async e => {
            const data = getMessageData(e, messageType + ":result");
            if (data) {
                resolved = true;
                resolve(data.payload);
            }
        };
        in_.onmessageerror = e => {
            reject(new Error("Channel Error (in)"));
        };
        out.onmessageerror = e => {
            reject(new Error("Channel Error (out)"));
        };

        if (target instanceof Worker) target.postMessage({ __type: messageType, ...data }, { transfer: [in_, ...transfer] });
        else target.postMessage({ __type: messageType, ...data }, "*", [in_, ...transfer]);
    });
}

export class Events<T extends string, L extends (...args: any) => void> {
    #listeners = new Map<T, Set<L>>();
    addEventListener(type: T, listener: L) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
        this.#listeners.get(type)?.add(listener);
    }
    removeEventListener(type: T, listener: L) {
        this.#listeners.get(type)?.delete(listener);
    }
    protected notifyListeners(type: T, ...args: Parameters<L>) {
        this.#listeners.get(type)?.forEach(listener => listener(...(args as any)));
    }
}
