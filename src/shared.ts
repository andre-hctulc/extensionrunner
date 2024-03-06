export function relPath(path: string) {
    if (path.startsWith("./")) path = path.slice(2);
    else if (path.startsWith("/")) path = path.slice(1);
    return path;
}

export function getMessageData(e: MessageEvent, type: string): Record<string, any> | null {
    if (e.data && typeof e.data === "object" && e.data.__type === type) return e.data;
    return null;
}

/** 25 char long pseudo cryptic id */
export function randomId() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let uniqueId = "";
    for (let i = 0; i < 25; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        uniqueId += chars[randomIndex];
    }
    return uniqueId;
}

export const isBrowser = typeof window !== "undefined" && window === window.self;

// TODO origin
export function postToParent(type: string, data: object, origin = "*", transfer?: Transferable[]) {
    if (isBrowser) window.parent.postMessage({ ...data, __type: type }, origin, transfer || []);
    else self.postMessage({ ...data, __type: type }, origin, transfer || []);
}

export async function receiveData(
    target: typeof globalThis | Window | Worker,
    type: string,
    data: object,
    origin = "*",
    transfer?: Transferable[],
    errTimeout = 5000
) {
    return new Promise<any>((resolve, reject) => {
        const channel = new MessageChannel();
        const out = channel.port1;
        const _in = channel.port2;
        let resolved = false;

        setTimeout(() => {
            if (!resolved) reject(new Error("Operation timeout"));
        }, errTimeout || 5000);

        out.onmessage = async e => {
            const data = getMessageData(e, type + ":result");
            if (data) {
                resolved = true;
                resolve(data.payload);
            }
        };
        _in.onmessageerror = e => {
            reject(new Error("Channel Error (in)"));
        };
        out.onmessageerror = e => {
            reject(new Error("Channel Error (out)"));
        };

        if (target instanceof Worker) {
            target.postMessage({ ...data, __type: type, __port: _in }, { transfer: [_in, ...(transfer || [])] });
        } else target.postMessage({ ...data, __type: type, __port: _in }, origin, [_in, ...(transfer || [])]);
    });
}
