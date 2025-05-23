import type { Meta } from "./types.js";

/*
Module Worker:
Imports entry point of modules
*/

let started = false;

const isNonEmptyStr = (s: any) => !!s && typeof s === "string";
const glob: Record<string, any> = globalThis || {};

// First message must be the meta!
onmessage = async e => {
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
        glob.$ER = { meta, state: meta.initialState || {} };

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
