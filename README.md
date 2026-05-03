# agent-bridge

A localhost HTTP server inside VS Code that lets external agents (Claude Code, MCP servers, scripts) drive marimo notebooks open in the [marimo VS Code extension](https://github.com/marimo-team/marimo-lsp), **with the same kernel state the user sees in the editor**.

## What problem does this solve?

The official `marimo edit` browser server has [`marimo-pair`](https://github.com/marimo-team/marimo-pair): a small skill that lets agents drive cells via HTTP. But marimo-pair targets the *standalone browser server*, which is a separate Python process with its own kernel.

If you author your marimo notebook in VS Code (via `marimo-team.vscode-marimo`), the browser server isn't running. The kernel that powers your editor is spawned by `marimo-lsp` over stdio — there's no HTTP surface, no `/api/sessions`, no `/api/kernel/execute`. Agents can't reach it.

`agent-bridge` is a tiny VS Code extension that fixes that by hosting `marimo-pair`'s HTTP API surface in-process inside VS Code, forwarding to whatever the active marimo notebook's kernel is doing.

**Net effect: the unmodified `marimo-pair` skill works against your VS Code marimo notebooks.** Same agent prompt, same scripts, two backends.

## Goals (and how they're met)

| Goal | Achieved by |
|---|---|
| Don't reinvent marimo-pair's agent UX | Bridge mimics marimo's standalone HTTP API (`/api/sessions`, `/api/kernel/execute` SSE) and registers in `$XDG_STATE_HOME/marimo/servers/` so `discover-servers.sh` finds it. The unmodified `marimo-pair/scripts/execute-code.sh --url …` works as-is. |
| Same kernel as the editor view | Bridge calls `marimo.executeAgentCode` (a tiny VS Code command added by the [marimo-lsp fork branch](https://github.com/hugolytics/marimo-lsp/tree/feature/external-cell-control-commands)) which wraps marimo-lsp's existing internal `KernelManager.executeCodeUnsafe` → LSP `marimo.api` `execute-scratchpad`. **No new Python code in marimo-lsp.** |
| Cell mutation surface (because `_code_mode` is unavailable through marimo-lsp) | REST endpoints on top of `vscode.workspace.applyEdit` + `NotebookEdit` (the API VS Code itself uses for Run/Edit). Provider-agnostic; no marimo coupling. |
| Minimal code | One file, ~430 LOC TS, no business logic — just HTTP + VS Code API forwarding. Single dispatch table for cell routes. |
| Testable in isolation | A `sandbox-test.sh` harness launches a fully isolated VS Code (`--user-data-dir` + `--extensions-dir`) and asserts 10 invariants in ~30 s wall-time. Never touches your real `~/.vscode/extensions/`. |

## Architecture

```text
┌────────────────────────────┐         ┌──────────────────┐         ┌────────────┐
│ Claude Code / marimo-pair  │  HTTP   │ agent-bridge ext │  CMD    │ marimo-lsp │
│   curl /api/kernel/execute │ ──SSE──▶│ in VS Code       │────────▶│ fork: ext  │
│   curl /notebooks/cells    │         │ (this repo)      │         │ executeAg… │
└────────────────────────────┘         └──────────────────┘         └─────┬──────┘
                                              │                          │
                                              │ vscode.workspace         │ LSP custom cmd
                                              │ .applyEdit               │ marimo.api
                                              ▼                          ▼
                                       ┌──────────────────┐         ┌─────────────┐
                                       │ open marimo nb   │         │ marimo-lsp  │
                                       │ (NotebookEdit)   │         │ Python srv  │
                                       └──────────────────┘         └─────┬───────┘
                                                                          │ stdio
                                                                          ▼
                                                                    ┌──────────┐
                                                                    │  marimo  │
                                                                    │  kernel  │
                                                                    └──────────┘
```

## HTTP surface

```text
GET  /health                              → {ok, port, vscodeVersion}

# marimo-pair compatible (so existing scripts work)
GET  /api/sessions                        → {<notebookUri>: {filename}, ...}
POST /api/kernel/execute                  → SSE: stdout/stderr/done events
     headers: Marimo-Session-Id: <uri>
     body:    {code: "..."}

# Cell mutation (REST; replaces _code_mode for marimo-lsp scratchpads)
GET    /notebooks/cells?notebook=<uri>    → {ok, result: {cells: [...]}}
POST   /notebooks/cells                   → create
       body: {notebookUri, code, languageId?, kind?, index?}
PATCH  /notebooks/cells/<N>?notebook=<uri> → replace cell N's code
       body: {code}
POST   /notebooks/cells/<N>/run?notebook=<uri> → queue cell run

# Generic escape hatch
POST /commands/<id>                       → vscode.commands.executeCommand
     body: {args: [...]}
```

## Discovery

The bridge writes its port to **four** places (each scoped to a different need):

1. `$XDG_STATE_HOME/marimo/servers/agent-bridge-<port>.json` — marimo-pair's `discover-servers.sh` reads this.
2. `<extension-globalStorage>/agent-bridge.json` — per-`--user-data-dir`, sandbox-safe.
3. `$AGENT_BRIDGE_DISCOVERY_FILE` if set — useful for harness scripts.
4. `~/.agent-bridge.json` — back-compat for non-sandboxed dev.

## Sandbox harness

`sandbox-test.sh` (in the parent repo) is the canonical TDD substrate:

```bash
./sandbox-test.sh              # ~30s, exits 0 on PASS
./sandbox-cleanup.sh           # quits zombie sandbox VS Codes via bridge
```

Asserts (from v22, all green):

```text
✓ scratchpad print(2 + 2) → "4" via /api/kernel/execute (SSE)
✓ list cells (mo-python lang, exec summary, outputs)
✓ create cell (defaults to mo-python for marimo notebooks)
✓ cell count grew
✓ edit cell
✓ run cell (queues; output appears asynchronously)
✓ cell output reflects edited code
✓ marimo-pair registry entry written
✓ /api/sessions returns the open notebook
✓ marimo-pair's REAL execute-code.sh works against the bridge
```

## Test status — what changed in marimo-lsp

The fork's diff against upstream `marimo-team/marimo-lsp` is:

- 1 new file: `extension/src/commands/executeAgentCode.ts` (~100 LOC)
- 1 small change: `extension/src/platform/VsCode.ts` — `registerCommand` accepts variadic args (3 LOC)
- 1 register line: `extension/src/features/RegisterCommands.ts` (4 LOC)
- 1 package.json contributes entry
- regenerated `extension/src/constants.ts`

**Existing test status:**

| Suite | Before | After my fork | Notes |
|---|---|---|---|
| `pnpm test` (vitest, 36 files, 396 tests) | 396 / 396 pass | **396 / 396 pass** | None broken. None obsolete. |
| `pnpm test:extension` (mocha + @vscode/test-cli) | n/a (env-bound; needs no other VS Code instance running) | n/a | Same env constraint as upstream. |
| Tests added | — | 0 (fork) / 10 (sandbox harness) | Sandbox lives in the parent repo, not in the fork PR — keeps PR diff tight. |

## Audit (independent agent replay, see `../AUDIT.md`)

A separate agent replicated two real marimo example notebooks (`examples/markdown/admonitions.py`, `marimo/_tutorials/intro.py` first 7 cells) using **only the bridge's REST endpoints** — cell-by-cell, real CRUD, no batching. Both replicated fully. The reactive DAG fires through the bridge: editing cell 5 caused cell 6 to auto-rerun without an explicit run call.

Two real bugs the audit found (fixed in this version):

- `PATCH /notebooks/cells/N` with no `body.code` silently wiped the cell. Now returns 400 with `"missing body.code (string) — refusing to wipe cell"`.
- `POST /notebooks/cells/99/run` returned `{ok:true}` even when 99 was out of bounds. Now returns 404 with `"cell index N out of bounds (cellCount=M)"`.

The audit's recommended refactor — collapse the four cell handlers into a single dispatch table with shared validation — was implemented as part of the fix. See `matchCellRoute` + the four small handler functions at the bottom of `src/extension.ts`.

## Known limitations (and where to push back upstream)

| Limitation | Root cause | Upstream fix |
|---|---|---|
| `marimo._code_mode.get_context()` raises `RuntimeError: NotebookDocument not available` through the bridge | `marimo-lsp`'s `execute-scratchpad` LSP method doesn't set the document contextvar that `_code_mode` requires | File issue at `marimo-team/marimo-lsp`: "set the doc contextvar in `execute-scratchpad` so `_code_mode` works in LSP scratchpads" |
| Scratchpad calls run in **isolated namespaces** (each call fresh) | Same root cause — marimo-lsp's scratchpad implementation differs from marimo standalone's `/api/execute` | Same upstream fix would also unblock cross-call state |
| Cell run is **fire-and-forget** (queues; no completion signal) | VS Code's `notebook.cell.execute` returns immediately on enqueue | Caller polls `GET /notebooks/cells` and watches `executionSummary`. Could add `?wait=true` SSE later if needed. |
| Bridge needs to be sideloaded; not on the marketplace | We haven't published it | Out of scope; could publish to OpenVSX after upstream PR lands. |

## Brainstorm: further leverage

Ideas for shrinking the stack further or pushing more value upstream:

1. **Land my marimo-lsp fork upstream** ([draft PR description](../FORK-PR.md)). 110 LOC of new code; closes [marimo-lsp#474](https://github.com/marimo-team/marimo-lsp/issues/474) and provides the foundation for [#488](https://github.com/marimo-team/marimo-lsp/issues/488). Once accepted, the fork dies and the marketplace ships my command natively. Bridge stays as the marimo-team-namespace-agnostic HTTP layer.

2. **Push the bridge into marimo-lsp itself.** If the marimo-lsp Python server hosts the same HTTP surface (it spawns `pygls` already; adding an `aiohttp` listener is small), the bridge extension can be deleted. Tradeoff: the marimo team has to take on Python HTTP server maintenance vs. the current isolation; security model gets harder. Current bridge is purely a localhost-no-auth dev tool — not safe for that path without rethinking auth.

3. **Patch `execute-scratchpad` to set the `_code_mode` contextvar.** Tiny Python change in marimo-lsp's `api.py` `run` function. Once landed, the bridge's REST cell endpoints become technically redundant — agents could use `_code_mode.create_cell()` etc. through `/api/kernel/execute`. The bridge code drops by ~150 LOC. Tradeoff: caller still needs SSE handling vs. straightforward REST. Worth doing for full marimo-pair parity.

4. **Make the bridge marimo-agnostic.** Cell mutation REST already is — works on Jupyter notebooks, dbcode notebooks, etc. Could rename to `vscode-notebook-bridge` and document the marimo wiring as one specific application.

5. **Plug into VS Code's MCP support.** Recent VS Code versions can host MCP servers as extension contributions. Wrapping the bridge's HTTP endpoints as MCP tools is ~50 LOC and lets Claude Code's MCP client discover the bridge automatically — no `--url` flag needed in marimo-pair calls.

6. **Open-source the sandbox harness as a generic pattern.** "Run a real VS Code with my extension installed and assert via curl in 30s, no editor restart" is broadly useful. Could be a separate npm package for any extension dev.

## Repo layout (parent dir)

```text
marimo-upstream/
├── marimo-lsp/         # fork of marimo-team/marimo-lsp (branch:
│                       #   feature/external-cell-control-commands)
├── agent-bridge/       # this extension
├── marimo/             # sibling clone of marimo-team/marimo (link target)
├── sandbox-test.sh     # the harness (10 assertions, ~30s)
├── sandbox-up.sh       # bring up a long-lived sandbox (for interactive work)
├── sandbox-down.sh     # quit a sandbox via its bridge
├── sandbox-cleanup.sh  # quit zombie sandbox VS Codes
├── USAGE.md            # end-user install & usage
└── AUDIT.md            # independent-agent replay audit (432 lines)
```

## Build & install

> **Use [`SETUP.md`](./SETUP.md) for the current install procedure.** The block below is from initial development and includes obsolete steps (signature-verify disable, `__metadata` patching) that we later confirmed break the install. Kept for archaeology.

```bash
# Build the bridge
( cd agent-bridge && \
  ./node_modules/.bin/esbuild --format=cjs --platform=node --bundle \
    --external:vscode --minify src/extension.ts --outfile=dist/extension.js && \
  ./node_modules/.bin/vsce package --no-dependencies --skip-license \
    --out /tmp/agent-bridge.vsix )

# Install (after disabling extensions.verifySignature in user settings.json)
code --install-extension /tmp/agent-bridge.vsix --force

# Patch the broken __metadata.targetPlatform sideload bug
node -e '
  const fs = require("fs"), p = process.argv[1];
  const o = JSON.parse(fs.readFileSync(p, "utf8"));
  o.__metadata = { installedTimestamp: Date.now(), size: 0, targetPlatform: "darwin-arm64" };
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
' ~/.vscode/extensions/hugolytics.agent-bridge-0.1.0/package.json

# Reload VS Code window. The bridge's port is in
#   ~/.vscode/extensions/.../globalStorage/hugolytics.agent-bridge/agent-bridge.json
# and (back-compat) ~/.agent-bridge.json
```

## License

TBD — same as marimo-lsp (Apache-2.0) once published.
