import type { Meta } from "./types";

let started = false;

const isNonEmptyStr = (s: any) => !!s && typeof s === "string";

// First message must be the meta!
self.onmessage = async e => {
    if (started) return;
    started = true;

    // If init message
    if (e.data?.__type == "meta" && typeof e.data.meta === "object") {
        const meta: Meta = e.data.meta;

        // Check meta
        if (!isNonEmptyStr(meta.path)) throw new Error("Invalid path");
        if (!isNonEmptyStr(meta.version)) throw new Error("Invalid name");
        if (!isNonEmptyStr(meta.path)) throw new Error("Invalid version");

        // init meta
        (self as any).meta = meta;

        // import module (for side effects - imported modules should use `Adapter`)
        let importUrl: string;

        // do not use template strings here, post build script wraps this code in ``
        if (meta.type === "npm") {
            // unpkg
            importUrl = `https://cdn.jsdelivr.net/npm/${meta.name}@${meta.version}/${meta.path}`;
        } else if (meta.type === "github") {
            // Use jsdelivr for github, as github does not support Commit shas or CORS
            const [owner, repo] = meta.name.split("/");
            importUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${meta.version}/${meta.path}`;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        try {
            const mod = await import(importUrl);
            postMessage({ __type: "ready", __token: meta.authToken });
        } catch (err) {
            console.error("Failed to import module", err);
            postMessage({ __type: "import_error", __token: meta.authToken });
        }
    }
};

export {};
