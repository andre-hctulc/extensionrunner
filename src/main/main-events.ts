import { Extension, ExtensionEvents } from "./extension.js";
import { AnyMainAdapter, MainAdapterEvents } from "./main-adapter.js";
import { RunnerEvents } from "./runner.js";

export interface MainEvents extends MainAdapterEvents, ExtensionEvents, RunnerEvents {
    error: { error: unknown; adapter?: AnyMainAdapter; extension?: Extension };
}
