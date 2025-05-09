// Meta

/**
 *  module augmentation
 * */
export interface Meta {
    authToken: string;
    name: string;
    path: string;
    version: string;
    type: "github" | "npm";
    windowType: "iframe" | "worker";
    initialState: any;
    data?: any;
}


// Operations

export type Operations<This, I extends object> = {
    [K in keyof I]: I[K] extends (...args: infer A) => infer R
        ? (this: This, ...args: A) => Awaited<R> | Promise<R>
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

export type OperationEventPayload<I extends object, O extends OperationName<any, I>> = {
    operation: O;
    args: OperationArgs<any, I, O>;
    result: OperationResult<any, I, O> | undefined;
    error: unknown;
};

/** module augmentation */
export interface PackageJSON {
    /** npm package name or github owner ans repository name (":owner/:repo") */
    name: string;
    version: string;
    description: string;
    main: string;
    scripts: {
        [key: string]: string;
    };
    keywords: string[];
}
