// Meta

/** module augmentation */
export interface Meta<S = any> {
    authToken: string;
    name: string;
    path: string;
    initialState: S | undefined;
    version: string;
    type: "github" | "npm";
}

export type MetaExtension = (meta: Meta) => Meta;

// Operations

export type Operations<This, I extends object> = {
    [K in keyof I]: I[K] extends (...args: infer A) => infer R ? (this: This, ...args: A) => R : never;
};
export type OperationName<I extends object> = Extract<keyof Operations<any, I>, string>;
export type OperationResult<I extends object, O extends OperationName<I>> = I[O] extends (...args: any) => any ? ReturnType<I[O]> : never;
export type OperationArgs<I extends object, O extends OperationName<I>> = I[O] extends (...args: infer A) => any ? A : never;
export type OperationEvents<I extends object> = {
    [O in OperationName<I> as `op:${O}`]: {
        args: OperationArgs<I, O>;
        result: OperationResult<I, O> | undefined;
        error: Error | null;
    };
};

/* 
Test Types: 
*/

interface TestInterface {
    x: (arg1: Node, arg2: XMLHttpRequest) => void;
    event_load: (x: string, ds: number) => void;
}

let operations: Operations<any, TestInterface>;
let evs: OperationEvents<TestInterface>;
