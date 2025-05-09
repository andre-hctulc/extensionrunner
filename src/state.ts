export interface StateOptions<S extends object> {
    /**
     * Check the state pushed by adapters. This **does not** check states pushed directly with `pushState`.
     *
     * Either return a new state or true/false to accept/reject the state.
     */
    checkState?: (oldState: S, newState: Partial<S>) => S | boolean;
    /**
     * Initial state
     */
    initialState?: S;
}
