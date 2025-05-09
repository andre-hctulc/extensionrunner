/*
Source: https://github.com/webpack/webpack/discussions/14648

Browsers do not support CORS for web workers (but they should?). This is a workaround to load a script from a different origin.
*/

import { ERError } from "./error.js";

export class CorsWorker {
    private _worker: Worker | null = null;

    constructor(readonly url: string, private options?: WorkerOptions) {}

    private inited = false;

    async mount() {
        if (this.inited) return this;

        this.inited = true;

        try {
            const response = await fetch(this.url);
            if (!response.ok) throw new Error();
            const text = await response.text();
            const objectURL = URL.createObjectURL(
                new Blob([text], {
                    type: "application/javascript",
                })
            );
            this._worker = new Worker(objectURL, this.options);
            URL.revokeObjectURL(objectURL);
        } catch (err) {
            throw new ERError("Failed to create cors worker", [], { cause: err });
        }

        return this._worker;
    }

    getWorker() {
        return this._worker;
    }
}
