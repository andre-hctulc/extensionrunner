# extensionrunner

**This package is currently under development**

_extensionrunner_ uses CDNs (jsdelivr, githack, unpkg),
to power external extensions safely in your App via Web Workers and IFrames directly from GitHub or npm.

## Features

-   Import modules from extensions
-   Display components from extensions
-   Fetch files from extensions
-   Shared state between modules and components

## Usage

**Provider**

`https://example.com`

_index.js_

```ts
import Provider from "extensionrunner";

const provider = new Provider();

const extension = await provider.loadExtension({
    type: "github", // or "npm"
    name: ":owner/:repo", // or npm package name
    version ":git_commit_sha", // or npm package version
})

const providerApi = {
    alert: (text: string) => alert("module/component:", text),
    sum: (a: number, b: number) => a+b
}


// -- Launch module

const module = await extension.launchModule("modules/module.js", providerApi, {
    // Deactivated by default
    allowPopulateState: (state, merge, module) => true, // or return new state
    initialState: {}
});

document.getElementById("echo_btn").onclick=()=>{
    const echo = module.execute("echo", "Hello from provider");
    console.log("Echo from module:", echo)
}

document.getElementById("print_btn").onclick=()=>{
    module.execute("print", "Hello", "from", "provider")
}

// -- Launch component

// `launchComponent` returns the same type as `launchModule`
const module = await extension.launchComponent("components/component.html", providerApi, {
    allowPopulateState: true,
});

setInterval(async ()=>{
    const newCounter = await module.execute("increment");
    console.log("Module confirmed new counter:", newCounter)
}, 1000)

document.getElementById("change_increment_by_btn").onclick= () => {
    // push state from provider
    module.pushState({ incrementBy: 2 })
}
```

**Extension**

_\<github_or_npm\>/modules/module.js_

```ts
import { Adapter } from "extensionrunner/adapter";

class MyAdapter extends Adapter {
    constructor(){
        super({
            provider: "https://example.com",
        })
    }

    onStart() {
        console.log("Started")
        this.execute("alert", "Module running...");
    }

    out: {
        echo: text => {
            return text;
        },
        print: (...text) => {
            console.log(...text);
        },
    }
}
```

_\<github_or_npm\>/components/component.html_

```html
<div>
    <!-- or external script -->
    <script type="module">
        import Adapter from "extensionrunner/adapter";

        let counter = 0;

        new Adapter({
            provider: "https://example.com",
            out: {
                increment: function () {
                    return (counter += this.state.incrementBy || 1);
                },
                reset: () => {
                    counter = 0;
                },
            },
        }).start(adapter => {
            // Listen to operations (This could also done directly in increment)
            adapter.addEventListener("op:increment", e => {
                document.getElementById("counter").innerHtml = e.payload.result + "";
            });

            // Listen to other events
            adapter.addEventListener("state_push", e => {
                document.getElementById("increment").innerHtml = "Incrementing by " + e.payload.incrementBy;
            });

            document.getElementById("change_increment").onclick = () => {
                // Push state from a component/module
                adapter.pushState(
                    { incrementBy: 5 },
                    {
                        // Share state with other components (components with the same path).
                        // Defaults to true
                        populate: true,
                    }
                );
            };
        });
    </script>
    <h1>Counter</h1>
    <p id="counter"></p>
    <p>Incrementing by <span id="increment">1</span></p>
    <button id="reset">Reset</button>
</div>
```

## TypeScript

```ts
interface ModuleInterface {
    print: (text: string) => string
    multiply: (a: number, b: number) => number
}

interface ProviderInterface {
    log: (...text: string[]) => void
    alert: () => void
    sum: (a: number, b: number) => number
}

interface ModuleState {
    user: string;
}

// Provider
provider.launchModule<ProviderInterface, ModuleInterface, ModleState>()

// Adapter
new Adapter<ProviderInterface, ModuleInterface, ModleState>(...).start(...)
```

## Fetch Files

```ts
const response = await provider.loadFile("path/to/file");
const response = await adapter.loadFile("path/to/file");
```

## pushState

```ts
// -- Provider

// Extension level
await extension.pushState(
    { activeTab: "files" },
    {
        // default: All modules/components
        filter: {
            check: module => module.meta.path.startsWith("toolbar/"),
        },
        merge: true, // default: true
    }
);
// Module Level
await module.pushState({
    activeTab: "account",
});

// -- Adapter

await adapter.pushState(
    {
        activeTab: "settings",
    },
    {
        populate: true, // default: true
    }
);
```
