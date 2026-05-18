# Integration — for `marimo-team` (or anyone vendoring the bridge)

This repo is structured so the entire bridge — the localhost HTTP server, the marimo-pair-compatible SSE endpoint, the cell-CRUD REST surface, the discovery file — can be vendored into another VS Code extension with a single-file copy plus a small `package.json` merge.

The expected long-term home is `marimo-team.vscode-marimo`, behind an opt-in setting. This file is a how-to for that takeover. If you'd prefer a repo transfer instead of a vendor, that's offered in the [upstream design issue](#TBD) — we're happy either way.

## Shape

```
agent-bridge/
├── package.json            <- 50 lines incl. setting schema (mergeable)
├── src/extension.ts        <- 1 file, ~430 lines, no exotic deps
└── dist/extension.js       <- esbuild output
```

External deps at runtime: **`vscode` API only.** No `node_modules` shipped (esbuild bundles). The build doesn't reach into marimo's Python at all — it talks to marimo via `vscode.extensions.getExtension("marimo-team.vscode-marimo")?.activate()` and uses the public `experimental.kernels` API.

## How to vendor (4 steps)

### 1. Copy `src/extension.ts` into your extension

Drop the file at e.g. `extension/src/features/AgentBridge.ts`. Rename the exported `activate(ctx)` to e.g. `registerAgentBridge(ctx)` and call it from your existing `activate()`. The function returns nothing; cleanup is registered via `ctx.subscriptions`.

```ts
// your activate(ctx)
import { registerAgentBridge } from "./features/AgentBridge";

export function activate(ctx) {
  // ... your existing activation
  registerAgentBridge(ctx);
}
```

### 2. Merge `package.json` contributes

Add to your `contributes.configuration.properties`:

```json
"marimo.agentBridge.enabled": {
  "type": "boolean",
  "default": false,
  "description": "Start a localhost HTTP bridge so external agents (Claude Code, Codex, etc.) can drive this notebook's kernel via the experimental.kernels API. Listens on 127.0.0.1 only; off by default."
},
"marimo.agentBridge.port": {
  "type": "number",
  "default": 0,
  "description": "Port for the bridge HTTP server. 0 = auto-pick."
},
"marimo.agentBridge.token": {
  "type": "string",
  "default": "",
  "description": "Optional bearer token. If empty, no auth (localhost-only). Set for shared dev machines."
}
```

(Rename the setting prefix from `agentBridge.*` → `marimo.agentBridge.*` in the TS file's `getConfiguration("agentBridge")` call too.)

### 3. Remove the `extensionDependencies` + `activationEvents` from this repo

Your extension already activates on marimo notebooks. The bridge code only runs if the setting is true, so it costs nothing at activation time when disabled.

### 4. Add a one-shot onboarding nudge (optional but high-value)

When `vscode.extensions.getExtension("anthropic.claude-code")` (or `openai.codex`, or any other coding-agent extension) is present **and** the user has never seen the prompt, show:

> *"Detected Claude Code. Want to enable marimo's agent integration? It lets the agent drive the cells you have open with no setup. (You can flip `marimo.agentBridge.enabled` later.)"*
> [Enable] [Not now] [Don't ask again]

If they enable, flip the setting and prompt the user to install the marimo-pair skill (URL to its repo / Claude Code skill registry) so the agent actually has the protocol knowledge to use the bridge. Two opt-ins, both reversible, never auto-installed.

## What the bridge guarantees

- **Localhost only.** The server binds `127.0.0.1` explicitly; cannot be reached from another host.
- **Port 0 by default.** Avoids collisions with other processes.
- **Discovery file is opt-in.** Written at `<globalStorage>/agent-bridge.json` (per-VS-Code-window, no homedir collision) and to `$XDG_STATE_HOME/marimo/servers/agent-bridge-<port>.json` (marimo-pair registry, standard location). The legacy `~/.agent-bridge.json` write is for backward compat and can be dropped if you don't want it.
- **Cancellation.** The HTTP handler attaches `req.on("close")` to a `CancellationTokenSource` so the kernel work cancels when the SSE client disconnects.
- **No persistent state.** Cleanup happens via `ctx.subscriptions` — disposing the extension cleans the server, the discovery file, and the marimo-pair registry entry.

## What the bridge does NOT do

- No file I/O on user notebooks (cell mutation goes through `vscode.WorkspaceEdit` — same path the editor itself uses).
- No subprocess spawning.
- No telemetry.
- No network egress.

## Testing

The bridge has an out-of-tree sandbox harness in the parent repo (`sandbox-test-experimental.sh`). It launches a sandboxed VS Code (`--user-data-dir`, `--extensions-dir`), installs marketplace `marimo-team.vscode-marimo` plus the bridge, opens a real marimo notebook, runs 10 assertions covering cell list/create/edit/run + scratchpad SSE + marimo-pair compatibility, exits 0 on PASS. ~30s wall-time, fully reproducible.

For inline tests post-vendoring, the existing `experimental.kernels` test infrastructure (TestVsCode mock + Effect-based vitest layers) covers the kernel side. The HTTP server can be unit-tested by injecting a mock `vscode.ExtensionContext`.

## Questions / open issues for design discussion

- Should the discovery file write `$XDG_STATE_HOME/marimo/servers/` always, or only when `marimo-pair` is known to be installed? (Today: always — costs nothing if the dir doesn't exist or no agent looks.)
- Should the onboarding nudge live in `marimo-team.vscode-marimo` core, or as a separate "marimo agent companion" extension? (Today's view: in core, gated by setting. Discussion welcome.)
- Should MCP be the long-term transport? See pros/cons in the upstream design issue.

## License

This repo's code is licensed permissively; see `LICENSE` (or treat as ISC if absent). Adopt freely.
