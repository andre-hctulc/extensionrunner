export class ERError extends Error {
    readonly tags: string[] = [];

    constructor(message: string, tags?: string[], options?: ErrorOptions) {
        super(message, options);
        if (tags) {
            this.tags = tags;
        }
    }
}
