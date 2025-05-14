export function relPath(path: string) {
    if (path.startsWith("./")) path = path.slice(2);
    else if (path.startsWith("/")) path = path.slice(1);
    return path;
}

export function getMessageData(e: MessageEvent, type: string): Record<string, any> | null {
    if (e.data && typeof e.data === "object" && e.data.__type === type) return e.data;
    return null;
}

export const isBrowser = typeof window !== "undefined" && window === window.self;

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

        out.onmessage = async (e) => {
            const data = getMessageData(e, type + ":result");
            if (data) {
                resolved = true;
                resolve(data.payload);
            }
        };
        _in.onmessageerror = (e) => {
            reject(new Error("Channel Error (in)"));
        };
        out.onmessageerror = (e) => {
            reject(new Error("Channel Error (out)"));
        };

        target.postMessage(
            { ...data, __type: type, __port: _in },
            { targetOrigin: origin, transfer: [_in, ...(transfer || [])] }
        );
    });
}

export const JS_DELIVR_URL = "https://cdn.jsdelivr.net";

/**
 * Creates a `jsdelivr` URL for a given package (+ path).
 */
export function getUrl(type: "github" | "npm", name: string, version: string, path?: string) {
    let baseUrl: string;

    if (type === "github") {
        const [owner, repo] = name.split("/");
        baseUrl = `${JS_DELIVR_URL}/gh/${owner}/${repo}@${version}`;
    } else if (type === "npm") {
        baseUrl = `${JS_DELIVR_URL}/npm/${name}@${version}`;
    } else throw new Error("Invalid type ('npm' or 'github' expected)");

    if (path) {
        return `${baseUrl}/${relPath(path)}`;
    }

    return baseUrl;
}

export async function loadFile(type: "github" | "npm", name: string, version: string, path: string) {
    if (path.startsWith("/")) path = path.slice(1);
    else if (path.startsWith("./")) path = path.slice(2);
    const response = await fetch(getUrl(type, name, version, path), type === "github" ? {} : {});
    if (!response.ok) {
        const error = new Error(`Failed to load file: ${response.statusText}`);
        (error as any).response = response;
        throw new Error(`Failed to load file: ${response.statusText}`);
    }
    return response;
}

export type LogLevel = "all" | "info" | "error";

export function logVerbose(logLevel: LogLevel, ...message: any[]) {
    if (logLevel === "all") {
        console.log(":extension-runner:", message);
    }
}

export function logInfo(logLevel: LogLevel, ...message: any[]) {
    if (logLevel === "error") return;
    console.info(":extension-runner:", ...message);
}

export function logError(...message: any[]) {
    console.error(":extension-runner:", ...message);
}

export function checkOrigin(
    origin: string,
    allowedOrigins: string | string[] | ((origin: string) => boolean)
) {
    if (allowedOrigins === "*") return true;
    if (typeof allowedOrigins === "string") {
        return origin === allowedOrigins;
    }
    if (Array.isArray(allowedOrigins)) {
        return allowedOrigins.includes(origin);
    }
    if (typeof allowedOrigins === "function") {
        return allowedOrigins(origin);
    }
    return false;
}
