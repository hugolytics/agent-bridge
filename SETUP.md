# marimo + agent-bridge — setup from a fresh machine

Drive a marimo notebook open in VS Code from any external agent (Claude Code, Codex, plain `curl`) by talking to a localhost HTTP bridge that shares the editor's kernel state.

This doc replaces the install sections of `USAGE.md` and `agent-bridge/README.md`, both of which were written during early-iteration debugging and contain instructions we later discovered were wrong (do **not** disable `extensions.verifySignature`; do **not** patch `__metadata.targetPlatform`).

---

## What gets installed

Two VS Code extensions, both into your active VS Code profile:

| Extension | What it adds | Source |
|---|---|---|
| `hugolytics.vscode-marimo-agent` | Fork of `marimo-team.vscode-marimo`. Adds the `marimo.executeAgentCode` command **and** a 5-line Python patch so `marimo._code_mode.get_context()` resolves the open notebook's document. | `marimo-lsp/extension/` (this repo) |
| `hugolytics.agent-bridge` | Tiny VS Code extension (~50 KB). Hosts a localhost HTTP server exposing `/api/sessions`, `/api/kernel/execute` (marimo-pair compatible SSE), `/notebooks/cells` (cell CRUD), `/commands/<id>` (escape hatch). | `agent-bridge/` (this repo) |

No marimo-pair *fork* is needed — the unmodified [marimo-pair](https://github.com/marimo-team/marimo-pair) skill works as-is, just pointed at the bridge URL.

---

## Prerequisites

- macOS or Linux (Windows untested; the bridge code is platform-agnostic but install paths differ)
- VS Code ≥ 1.96 (`code --version`)
- `node` ≥ 22 (for the build step) — `brew install node` if you don't have it
- A Python project with `marimo` installed in its venv (any version that ships `marimo._code_mode`, i.e. recent)
- Optional: `gh` CLI logged in if you want to install pre-built VSIXes from GitHub releases (once published)

---

## Install — three commands

```bash
cd ~/VScode-projects   # or wherever you cloned this
git clone https://github.com/hugolytics/marimo-lsp.git
git clone https://github.com/hugolytics/agent-bridge.git

# 1. Build both VSIXes from source (~30s combined)
( cd marimo-lsp/extension      && pnpm install --frozen-lockfile && \
    PATH="$(pnpm bin):$PATH" vsce package --no-dependencies )
( cd agent-bridge              && pnpm install --frozen-lockfile && \
    PATH="$(pnpm bin):$PATH" vsce package --no-dependencies )

# 2. Find which VS Code profile you want to install into.
#    If you've never created a custom profile, this is "Default".
#    Otherwise look at User/profiles/ and pick the one your project is
#    associated with (see "Profiles" troubleshooting section below).
PROFILE="Default"   # or "hugo", "work", etc.

# 3. Install both into that profile
CODE='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
"$CODE" --profile "$PROFILE" --install-extension marimo-lsp/extension/vscode-marimo-agent-0.13.0.vsix
"$CODE" --profile "$PROFILE" --install-extension agent-bridge/agent-bridge-0.1.0.vsix
```

That's it. **Do not** patch `__metadata.targetPlatform`, **do not** disable `extensions.verifySignature` — we tried both, both made things worse. The default install path is correct as long as the `.vsixmanifest` doesn't claim a `TargetPlatform` (the build above runs `vsce package` without `--target`, which is what produces a working sideload).

---

## First run

1. Open VS Code in a workspace that's associated with the profile you installed into.
2. Open any `.py` file that's a marimo notebook.
3. Click the marimo notebook icon in the editor toolbar — the notebook view appears.
4. **Restart the kernel once** via `Cmd+Shift+P → marimo: Restart Notebook Kernel`. (The first kernel start binds the LSP session; without it, `cm.get_context()` and `/api/kernel/execute` will return "no session found".)
5. Verify the bridge is up:

   ```bash
   cat ~/.agent-bridge.json
   # → {"port": 60146, "token": null, "pid": 36738, "started": ...}

   PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
   curl -sf "http://127.0.0.1:$PORT/health"
   # → {"ok":true,"port":60146,"vscodeVersion":"1.118.1"}
   ```

---

## Use it from an agent

### Claude Code with the marimo-pair skill (no skill changes)

```bash
# The marimo-pair skill comes bundled with the superpowers marketplace.
# If you don't have it: install via /plugin install superpowers
PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
NB="file:///absolute/path/to/your/notebook.py"

bash ~/.claude/skills/marimo-pair/scripts/execute-code.sh \
  --url "http://127.0.0.1:$PORT" \
  --session "$NB" \
  -c 'print("hello from agent")'
```

The skill's `discover-servers.sh` can also find the bridge automatically because it writes a marimo-server registry file at `$XDG_STATE_HOME/marimo/servers/agent-bridge-<port>.json`.

### Codex / any agent that can run shell

Same pattern — read the port, hit `--url http://127.0.0.1:<port>`. The bridge speaks marimo-pair's protocol (SSE on `POST /api/kernel/execute`), so any agent that already targets marimo standalone works against the bridge by changing the URL.

### Direct REST (no skill)

```bash
PORT=$(node -e "console.log(require(process.env.HOME+'/.agent-bridge.json').port)")
NB="file:///absolute/path/to/your/notebook.py"

# Run code in the kernel (marimo-pair protocol; SSE)
curl -sf -X POST "http://127.0.0.1:$PORT/api/kernel/execute" \
  -H "Marimo-Session-Id: $NB" \
  -H 'content-type: application/json' \
  -d '{"code":"print(2 + 2)"}'

# List cells (full code, outputs, execution summary)
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

## Troubleshooting (the gotchas we actually hit)

### "Install extension for marimo-notebook" prompt after install

Your VS Code profile's extension registry doesn't know about the fork. Almost always: you have a custom profile (e.g. `hugo`) and installed into `Default`. Fix:

```bash
# Find which profile your workspace is associated with:
python3 -c "
import json, pathlib
d = json.load(open(pathlib.Path.home() / 'Library/Application Support/Code/User/globalStorage/storage.json'))
ws = d.get('profileAssociations', {}).get('workspaces', {})
for k, v in ws.items():
    if v != '__default__profile__':
        print(f'{v} <- {k}')
"
# Then reinstall both VSIXes with --profile <that-profile-name>.
# The PROFILE NAME (not the dir hash) is in storage.json under userDataProfiles[].name.
```

### `cm.get_context()` raises `NotebookDocument not available`

The LSP session for that notebook hasn't been bound yet. Restart the kernel: `Cmd+Shift+P → marimo: Restart Notebook Kernel`. (Happens after every `marimo: Restart Language Server` call, or after fresh install + window reload.)

### Bridge port not in `~/.agent-bridge.json`

Bridge didn't activate. Check the VS Code output panel → "Agent Bridge" channel. Most common cause: another VS Code session already holds `~/.agent-bridge.json` — close it or look in `User/globalStorage/hugolytics.agent-bridge/agent-bridge.json` for this session's port.

### "No session found" from `/api/kernel/execute`

The marimo notebook isn't open in the editor for that URI. The bridge can only reach kernels that VS Code is actively managing. Open the notebook tab and rerun.

---

## Updating

```bash
cd marimo-lsp     && git pull && ( cd extension && pnpm install && PATH="$(pnpm bin):$PATH" vsce package --no-dependencies )
cd ../agent-bridge && git pull && pnpm install && PATH="$(pnpm bin):$PATH" vsce package --no-dependencies

CODE='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
"$CODE" --profile "$PROFILE" --install-extension ./marimo-lsp/extension/vscode-marimo-agent-*.vsix
"$CODE" --profile "$PROFILE" --install-extension ./agent-bridge/agent-bridge-*.vsix

# Reload window OR run marimo: Restart Language Server + Restart Notebook Kernel.
```

---

## What lives where

```
marimo-upstream/
├── SETUP.md             ← you are here (the only install doc that's current)
├── USAGE.md             ← background and design notes; install section is obsolete (use this file)
├── FORK-PR.md           ← draft of the upstream PR to marimo-team/marimo-lsp
├── PUSH.sh              ← maintainer dispatch script (push fork branch, create bridge repo, open PR)
├── marimo-lsp/          ← the fork (branch: feature/external-cell-control-commands)
└── agent-bridge/        ← the bridge extension
```
