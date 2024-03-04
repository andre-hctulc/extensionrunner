import type { Meta } from "./types.js";

/*
Import the extension module from github or unpkg
*/

let started = false;

const isNonEmptyStr = (s: any) => !!s && typeof s === "string";

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

        // set meta globally
        (self as any).__meta = meta;

        // import module (for side effects - imported modules should use `Adapter`)
        let importUrl: string;

        // do not use template strings here, post build script wraps this code in ``
        if (meta.type === "npm") {
            importUrl = "https://unpkg.com/" + meta.name + "@" + meta.version + "/" + meta.path;
        } else if (meta.type === "github") {
            const [owner, repo] = meta.name.split("/");
            importUrl = "github:" + owner + "/" + repo + "@" + meta.version;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        const mod = await import(importUrl);
        
        postMessage({ __type: "ready" });
    }
};
