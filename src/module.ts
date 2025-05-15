/**
 * @template S State
 */
export abstract class Adapter<S> {
    constructor(readonly id: string, initialState: S = {} as S) {
        this._state = initialState;
    }

    // #### Lifecycle ####

    abstract start(): void;

    // #### State ####

    protected _state: S;

    get state() {
        return this._state;
    }

    abstract pushState(newState: S): void;
}
