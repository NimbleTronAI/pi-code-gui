# SDK Resolution & Initialization

> **Status:** stable

Pi Code Gui does not bundle the Pi SDK. It loads the copy the user installed globally
(`npm install -g @earendil-works/pi-coding-agent`) into the extension host, in-process, with a
dynamic `import()`. This page covers how that copy is found and loaded; what the extension then does
with it is in [PiService](../architecture/pi-service.md).

## Finding and loading the package

- `resolvePiPackagePath()` (`src/pi-service.ts`) builds an ordered candidate list with the pure
  `buildPiPackageCandidates` (`src/pi-package-path.ts`): project-local `.pi/npm`, global prefixes
  derived from `$PATH`, Windows AppData, home fallbacks, then NVM node versions newest-first. The
  first candidate whose `package.json` exists wins; none found throws "Pi coding agent SDK not
  found".
- `importWithRetry` (`src/sdk-service.ts`) imports the SDK modules, retrying while npm is still
  populating `node_modules`. It hands `import()` a `file://` URL for every absolute path
  (`importSpecifierFor`), which Windows drive letters require (gh #71).
- If nothing resolves, `extension.ts` shows "Pi coding agent SDK is not installed" with an
  **Install Pi** action that runs the npm command above.
- `src/pi-sdk-version.json` pins nothing at runtime. It records the release the extension was last
  tested against, so the currency check has something to compare npm's latest with.

## Candidate paths: the PATH entry itself (#81)

Every candidate used to be derived from a `$PATH` entry's **parent** —
`<dirname>/lib/node_modules/…`, and on Windows `<dirname>/node_modules/…`. That
assumes the npm prefix sits one level above the binaries, which holds for
`<prefix>/bin` on POSIX and `<prefix>/npm` on Windows, and fails whenever the prefix
directory is on `PATH` itself with `node_modules` beside its binaries.

Node installed to `D:\nodejs` (npm prefix `D:\nodejs`, packages in
`D:\nodejs\node_modules`) therefore had **no candidate at all**: `dirname` gives
`D:\`, so the probe looked in `D:\lib\node_modules` and `D:\node_modules` and gave
up. The user sees "Pi coding agent SDK is not installed" while `pi --version` answers
fine in a shell — a failure that sends people to inspect their npm install rather than
the extension. nvm-windows lays the active version out the same way.

`buildPiPackageCandidates` now also probes the PATH entry itself, on **every**
platform (the layout is not Windows-specific, and a candidate that does not exist
costs one `stat`), added last within the loop so it cannot outrank a working
resolution.

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8); absorbed the SDK-loading facts from the retired runtime-selection page.
> **Earlier:** 2026-08-31 — added the PATH-entry candidate (#81, shipped 0.1.12).
