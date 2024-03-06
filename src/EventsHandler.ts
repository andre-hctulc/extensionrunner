export class Event<T extends string, P = unknown> {
    constructor(readonly type: T, readonly payload: P) {}

    #defaultPrevented = false;

    preventDefault() {
        this.#defaultPrevented = true;
    }

    get defaultPrevented() {
        return this.#defaultPrevented;
    }
}

type EventType<M extends object> = Extract<keyof M, string>;
type EventListener<M extends object, T extends EventType<M>> = (event: Event<T, EventPayload<M, T>>) => void;
type EventPayload<M extends object, T extends EventType<M>> = M[T];

export class EventsHandler<M extends object> {
    #listeners = new Map<keyof M, Set<EventListener<M, EventType<M>>>>();
    #globalListeners = new Set<EventListener<M, EventType<M>>>();

    addEventListener(type: null, listener: EventListener<M, EventType<M>>): void;
    addEventListener<T extends EventType<M>>(type: T, listener: EventListener<M, T>): void;
    addEventListener(type: any, listener: any): void {
        if (!type) this.#globalListeners.add(listener as any);
        else {
            if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
            this.#listeners.get(type)?.add(listener as any);
        }
        return listener;
    }

    removeEventListener(type: EventType<M> | null, listener: EventListener<any, any>) {
        if (type === null) this.#globalListeners.delete(listener);
        else this.#listeners.get(type)?.delete(listener);
    }

    protected emitEvent<T extends EventType<M>>(type: T, payload: EventPayload<M, T>): Event<T, EventPayload<M, T>> {
        const ev = new Event<T, EventPayload<M, T>>(type, payload);
        this.#listeners.get(type)?.forEach(listener => listener(ev as any));
        this.#globalListeners.forEach(listener => listener(ev as any));
        return ev;
    }

    protected clearListeners() {
        this.#globalListeners.clear();
        this.#listeners.clear();
    }
}
