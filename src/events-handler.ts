export class EREvent<T extends string, P = any> {
    constructor(readonly type: T, readonly payload: P) {}

    #defaultPrevented = false;

    preventDefault() {
        this.#defaultPrevented = true;
    }

    get defaultPrevented() {
        return this.#defaultPrevented;
    }
}

export type EREventType<M extends object> = Extract<keyof M, string>;
export type EREventListener<M extends object, T extends EREventType<M>> = (
    event: EREvent<T, EventPayload<M, T>>
) => void;
export type EventPayload<M extends object, T extends EREventType<M>> = M[T];

export class EventsHandler<M extends object> {
    #listeners = new Map<keyof M, Set<EREventListener<M, EREventType<M>>>>();
    #globalListeners = new Set<EREventListener<M, EREventType<M>>>();

    on<T extends EREventType<M> = EREventType<M>>(
        type: T | null,
        listener: EREventListener<M, T>
    ): EREventListener<M, T> {
        if (!type) this.#globalListeners.add(listener as any);
        else {
            if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
            this.#listeners.get(type)?.add(listener as any);
        }
        return listener;
    }

    off(type: EREventType<M> | null, listener: EREventListener<any, any>) {
        if (type === null) this.#globalListeners.delete(listener);
        else this.#listeners.get(type)?.delete(listener);
    }

    emit<T extends EREventType<M>>(type: T, payload: EventPayload<M, T>): EREvent<T, EventPayload<M, T>> {
        const ev = new EREvent<T, EventPayload<M, T>>(type, payload);
        this.#listeners.get(type)?.forEach((listener) => listener(ev as any));
        this.#globalListeners.forEach((listener) => listener(ev as any));
        return ev;
    }

    protected _clearListener() {
        this.#globalListeners.clear();
        this.#listeners.clear();
    }
}
