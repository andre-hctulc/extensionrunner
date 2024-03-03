export type Operations = Record<string, (...args: any[]) => void>;

export type EventType<I extends Operations> = keyof I extends `event_${infer T}` ? T : never;
export type Operation<I extends Operations> = Exclude<keyof I, `event_${string}`>;
export type OperationResult<I extends Operations, T extends keyof I> = ReturnType<I[T]>;
export type OperationArgs<I extends Operations, T extends keyof I> = T extends `event_${string}` ? Parameters<I[T]>[0] : Parameters<I[T]>;
export type EventListener<I extends Operations, T extends EventType<I> | null> = T extends null
    ? (type: EventType<I>, payload: OperationArgs<I, EventType<I>>) => void
    : (payload: T extends EventType<I> ? OperationArgs<I, `event_${T}`> : never) => void;

/** module augmentation */
export interface Meta<S = any> {
    name: string;
    path: string;
    state: S | undefined;
    version: string;
    type: "github" | "npm";
}

export type MetaExtension = (meta: Meta) => Meta;
