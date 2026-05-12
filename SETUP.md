# marimo + agent-bridge — setup from a fresh machine

Drive a marimo notebook open in VS Code from any external agent (Claude Code, Codex, plain `curl`) by talking to a localhost HTTP bridge that shares the editor's kernel state.

This doc replaces the install sections of `USAGE.md` and `agent-bridge/README.md`, both of which date from early-iteration debugging.

> **History note (2026-05-05):** earlier versions of this stack required a fork of `marimo-team.vscode-marimo` plus a Python patch to `marimo-lsp/api.py`. Per maintainer feedback on [marimo-team/marimo-lsp#545](https://github.com/marimo-team/marimo-lsp/pull/545) we rewrote the bridge to use marimo-team's public `experimental.kernels` API (modeled on the vscode-jupyter integration pattern). **No fork is needed anymore** — only the marketplace extension + the bridge.

---

## What gets installed

| Extension | What it adds | Source |
|---|---|---|
| `marimo-team.vscode-marimo` (≥ 0.13.0) | The marimo notebook editor for VS Code. Exposes a public `experimental.kernels` API to sibling extensions. | VS Code marketplace |
| `hugolytics.agent-bridge` | Tiny VS Code extension (~50 KB). Hosts a localhost HTTP server exposing `/api/sessions`, `/api/kernel/execute` (marimo-pair compatible SSE), `/notebooks/cells` (cell CRUD + run), `/commands/<id>` (escape hatch). Calls into `marimo-team.vscode-marimo` via `experimental.kernels.getKernel(uri).executeCode(...)`. | `agent-bridge/` (this repo) |

The unmodified [marimo-pair](https://github.com/marimo-team/marimo-pair) skill from the superpowers marketplace works against this bridge — just point it at the bridge URL.

---

## Prerequisites

- macOS or Linux (Windows untested; the bridge code is platform-agnostic but install paths differ)
- VS Code ≥ 1.96 (`code --version`)
- `node` ≥ 22 (only needed if building the bridge from source) — `brew install node` if you don't have it
- A Python project with `marimo` installed in its venv

---

## Install — two extensions, one profile

```bash
CODE='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'

# Pick the VS Code profile your project uses. If you've never created a
# custom profile, this is "Default". Otherwise check
# ~/Library/Application Support/Code/User/profiles/ and storage.json's
# profileAssociations.workspaces map.
PROFILE="Default"

# 1. marimo-team's editor extension from the marketplace.
"$CODE" --profile "$PROFILE" --install-extension marimo-team.vscode-marimo

# 2. agent-bridge. Build from source (until we publish releases):
git clone https://github.com/hugolytics/agent-bridge.git
( cd agent-bridge && pnpm install --frozen-lockfile && \
    PATH="$(pnpm bin):$PATH" vsce package --no-dependencies )
"$CODE" --profile "$PROFILE" --install-extension agent-bridge/agent-bridge-0.1.0.vsix
```

**Don't** patch `__metadata.targetPlatform`, **don't** disable `extensions.verifySignature` — those were dead-end fixes from when we were sideloading a fork; they actively break things now.

---

## First run

1. Open VS Code in a workspace that's associated with the profile you installed into.
2. Open any `.py` file that's a marimo notebook.
3. Click the marimo notebook icon in the editor toolbar — the notebook view appears.
4. Bind the kernel (`Cmd+Shift+P → marimo: Restart Notebook Kernel`, or pick the marimo controller from the kernel picker). The bridge can only reach kernels VS Code is actively managing.
5. Verify the bridge is up:

   ```bash
   cat ~/.agent-bridge.json
   # → {"port": 60146, "token": null, "pid": ..., "started": ...}

   PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
   curl -sf "http://127.0.0.1:$PORT/health"
   # → {"ok":true,"port":60146,"vscodeVersion":"1.118.1"}
   ```

---

## Use it from an agent

### Claude Code with the marimo-pair skill (no skill changes)

```bash
PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
NB="file:///absolute/path/to/your/notebook.py"

bash ~/.claude/skills/marimo-pair/scripts/execute-code.sh \
  --url "http://127.0.0.1:$PORT" \
  --session "$NB" \
  -c 'print("hello from agent")'
```

`discover-servers.sh` from the same skill also finds the bridge automatically — it writes itself into the marimo server registry at `$XDG_STATE_HOME/marimo/servers/agent-bridge-<port>.json`.

### Codex / any agent that can shell out

Same pattern: read the port from `~/.agent-bridge.json`, hit `--url http://127.0.0.1:<port>`. The bridge speaks marimo-pair's SSE protocol (`POST /api/kernel/execute` with `Marimo-Session-Id: <uri>` header).

### Direct REST (no skill)

```bash
PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
NB="file:///absolute/path/to/your/notebook.py"

# Stream code in the kernel (marimo-pair SSE)
curl -sN -X POST "http://127.0.0.1:$PORT/api/kernel/execute" \
  -H "Marimo-Session-Id: $NB" -H 'content-type: application/json' \
  -d '{"code":"print(2 + 2)"}'

# List cells (code + outputs + executionSummary)
curl -sf "http://127.0.0.1:$PORT/notebooks/cells?notebook=$NB" | jq .

# Create a cell
curl -sf -X POST "http://127.0.0.1:$PORT/notebooks/cells" \
  -H 'content-type: application/json' \
  -d "{\"notebookUri\":\"$NB\",\"kind\":\"code\",\"code\":\"df.head()\"}"

# Edit cell N
curl -sf -X PATCH "http://127.0.0.1:$PORT/notebooks/cells/3?notebook=$NB" \
  -H 'content-type: application/json' \
  -d '{"code":"df.tail()"}'

# Run cell N
curl -sf -X POST "http://127.0.0.1:$PORT/notebooks/cells/3/run?notebook=$NB"
```

---

## Troubleshooting

### "Install extension for marimo-notebook" prompt

Your VS Code profile's extension registry doesn't see `marimo-team.vscode-marimo`. Usually: you have a custom profile and installed into a different one. Find which profile your workspace uses:

```bash
python3 -c "
import json, pathlib
d = json.load(open(pathlib.Path.home() / 'Library/Application Support/Code/User/globalStorage/storage.json'))
ws = d.get('profileAssociations', {}).get('workspaces', {})
for k, v in ws.items():
    if v != '__default__profile__':
        print(f'{v} <- {k}')
"
# Then reinstall both extensions with --profile <profile-name>.
```

### `503 marimo-team.vscode-marimo not installed`

The bridge couldn't find the marimo extension in your current profile. Install it (`code --profile <name> --install-extension marimo-team.vscode-marimo`) and reload the window.

### `404 no active kernel for notebook`

The notebook is open as text but the marimo kernel hasn't been bound. Open it as a marimo notebook (click the marimo icon in the editor toolbar) and run any cell to provision the kernel.

### Bridge port not in `~/.agent-bridge.json`

Bridge didn't activate. Open the VS Code output panel → "Agent Bridge" channel. Most common cause: another VS Code session already holds `~/.agent-bridge.json` — close it or look in `User/globalStorage/hugolytics.agent-bridge/agent-bridge.json` for this session's port.

---

## Updating

```bash
cd agent-bridge && git pull && pnpm install && \
  PATH="$(pnpm bin):$PATH" vsce package --no-dependencies

CODE='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
"$CODE" --profile "$PROFILE" --install-extension ./agent-bridge/agent-bridge-*.vsix --force

# Reload the window. marimo-team.vscode-marimo updates itself from the marketplace.
```

---

## What lives where

```
marimo-upstream/
├── SETUP.md             ← you are here
├── USAGE.md             ← architecture + REST reference (install section is obsolete)
├── agent-bridge/        ← the bridge extension (https://github.com/hugolytics/agent-bridge)
└── marimo-lsp/          ← archived fork (used by the closed PR #545; kept only for the
                           Python `_code_mode` patch which is a candidate for a separate
                           small upstream issue/PR)
```
