# Info

## CDNs

We use CDNs to import modules, load files and power iframes.
iframes must receive mime type text/html which not all CDNs serve

### GitHub

<ins>IFrames:</ins>

_githubusercontent_ only serves text/plain ❌

_jsdelivr_ only serves text/plain (Utilizes GitHub CDNs) ❌

_githack_ serves correct mime types ✅

<ins>Modules:</ins>

_jsdelivr_ ✅

### npm

<ins>IFrames:</ins>

// TODO

<ins>Modules:</ins>

_jsdelivr_ ✅
