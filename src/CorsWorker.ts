/*
Source: https://github.com/webpack/webpack/discussions/14648

Browsers do not support CORS for web workers (but they should?). This is a workaround to load a script from a different origin.
*/

type CorsWorkerOptions = {
    type?: "module" | "classic";
    name?: string;
};

export class CorsWorker {
    private _worker: Worker | undefined;

    constructor(readonly url: string, private options?: CorsWorkerOptions) {}

    private inited = false;

    async init() {
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
            this._worker = new Worker(objectURL, { type: this.options?.type, name: this.options?.name });
        } catch (err) {
            throw new Error("Failed to create worker");
        }

        return this;
    }

    get worker() {
        if (!this._worker) throw new Error("CorsWorker did not start properly");
        return this._worker;
    }
}
