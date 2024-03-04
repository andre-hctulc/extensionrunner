# extensionrunner

**This package is currently in development**

_extensionrunner_ uses jsdelivr and unpkg CDNs to power external extensions safely

## Features

-   Fetch files from a extension
-   Import modules from a extension
-   Display iframes targeting Extension components

## Usage

**Provider**

_index.js_

```ts
import Provider from "extensionrunner";

const provider = new Provider();

const extension = await provider.loadExtension();
```

**Extension**

_\<github_or_npm\>/module.js_

```ts
import adapter from "extensionrunner";
```

_\<github_or_npm\>/component.html_

```ts

```
