# extensionrunner

**This package is currently in development**

_extensionrunner_ uses jsdelivr and unpkg CDNs to power external extensions safely

## Features

-   Fetch files assets from extensions
-   Import modules from extensions
-   Display components from extensions
-   Shared state between modules and components

## Usage

**Provider**

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
    allowPopulateCache: (state, oldState) => true, // or return new state
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
    allowPopulateCache: () => true,
});

setInterval(async ()=>{
    const newCounter = await module.execute("increment");
    console.log("module confirmed new counter", newCounter)
}, 1000)

document.getElementById("change_increment_by_btn").onclick= () => {
    module.pushState({ incrementBy: 2 })
}
```

**Extension**

_\<github_or_npm\>/modules/module.js_

```ts
import Adapter from "extensionrunner/adapter"

const adapterApi = {
    echo: text => {
        return text
    },
    print: (...text) => {
        console.log(...text)
    }
}

new Adapter({
    provider: "https://example.com",
    out: adapterApi
}).start(async adapter => {
    adapter.execute("alert", "module running...")
    console.log("The sum of 40 and 2 is", await adapter.execute("sum", 2, 40))
})
```

_\<github_or_npm\>/components/component.html_

```html
<!DOCTYPE html>

<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <!-- or external script -->
        <script type="module">
            import Adapter from "extensionrunner/adapter"

            let counter = 0

            new Adapter({
                provider: "https://example.com",
                out: {
                    increment: function () {
                        return (counter += this.state.incrementBy || 1)
                    },
                    reset: () => {
                        counter = 0
                    }
                }
            }).start(adapter => {
                // Listen to operations (This could also done directly in increment)
                adapter.addEventListener("op:increment", e => {
                    document.getElementById("counter").innerHtml = e.payload.result + ""
                })

                // Listen to other events
                adapter.addEventListener("state_push", e => {
                    document.getElementById("increment").innerHtml =
                        "Incrementing by " + e.payload.incrementBy
                })

                document.getElementById("change_increment").onclick = () => {
                    // Push state inside of a component/module
                    adapter.pushState(
                        { incrementBy: 5 },
                        {
                            // Share state with other components (components with the same path).
                            // Defaults to true
                            populate: true
                        }
                    )
                }
            })
        </script>
        <title>A Counter Component</title>
    </head>
    <body>
        <h1>Counter</h1>
        <p id="counter"></p>
        <p>Incrementing by <span id="increment">1</span></p>
        <button id="reset">Reset</button>
        <button id="change_increment_by_btn">Reset</button>
    </body>
</html>
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

interface ModuleState {}

// Provider
provider.launchModule<ProviderInterface, ModuleInterface, ModleState>()

// Adapter
new Adapter<ProviderInterface, ModuleInterface, ModleState>(...).start(...)
```
