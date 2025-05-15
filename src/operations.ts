export type Operations<This, I extends object> = {
    [K in keyof I]: I[K] extends (...args: infer A) => infer R
        ? (this: This, ...args: A) => Awaited<R> | Promise<Awaited<R>>
        : never;
};

export type OperationName<This, I extends object> = string & keyof Operations<This, I>;

export type OperationResult<This, I extends object, O extends OperationName<This, I>> = I[O] extends (
    ...args: any
) => any
    ? Awaited<ReturnType<I[O]>>
    : never;

export type OperationArgs<This, I extends object, O extends OperationName<This, I>> = I[O] extends (
    ...args: infer A
) => any
    ? A
    : never;

export interface OperationEventPayload {
    operation: string;
    args: any[];
    result: any;
    error: unknown;
}
