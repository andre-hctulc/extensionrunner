/*
Import the extension module from github or unpkg
Do not use imports here, they ccannot be resolved (See script postbuild)
*/

const devMode = process.env.NODE_ENV !== "production";

let started = false;

const isNonEmptyStr = (s: any) => !!s && typeof s === "string";

// First message must be the meta!
self.onmessage = async e => {
    if (started) return;
    started = true;

    // If init message
    if (e.data?.__type == "meta" && typeof e.data.meta === "object") {
        const meta: any = e.data.meta;

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
            importUrl = "https://unpkg.com/" + meta.name + "@" + meta.version + "/" + meta.path;
        } else if (meta.type === "github") {
            // Use jsdelivr for github, as github does not support Commit shas or CORS
            const [owner, repo] = meta.name.split("/");
            importUrl = "https://cdn.jsdelivr.net/gh/" + owner + "/" + repo + "@" + meta.version + "/" + meta.path;
        } else throw new Error("Invalid type ('npm' or 'github' expected)");

        try {
            if (devMode) console.log("Importing module", importUrl);
            const mod = await import(importUrl);
            postMessage({ __type: "ready", __token: meta.authToken });
            if (devMode) console.log("Imported module", importUrl);
        } catch (err) {
            console.error("Failed to import module", err);
        }
    }
};

export {};
