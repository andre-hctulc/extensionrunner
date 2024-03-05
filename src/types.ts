export type Operations<T> = Record<string, Operation<T>>;
export type Operation<T> = (this: T, ...args: any) => void;
export type EventType<I extends Operations<any>> = keyof I extends `event_${infer T}` ? T : never;
export type OperationName<I extends Operations<any>> = Exclude<keyof I, `event_${string}`>;
export type OperationResult<I extends Operations<any>, T extends keyof I> = ReturnType<I[T]>;
export type OperationArgs<I extends Operations<any>, T extends keyof I> = T extends `event_${string}` ? Parameters<I[T]>[0] : Parameters<I[T]>;
export type EventListener<I extends Operations<any>, T extends EventType<I> | null> = T extends null
    ? (type: EventType<I>, payload: OperationArgs<I, EventType<I>>) => void
    : (payload: T extends EventType<I> ? OperationArgs<I, `event_${T}`> : never) => void;

/** module augmentation */
export interface Meta<S = any> {
    authToken: string;
    name: string;
    path: string;
    state: S | undefined;
    version: string;
    type: "github" | "npm";
}

export type MetaExtension = (meta: Meta) => Meta;
