import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { handleMcpRequest } from "./mcp";

type BridgeEvent =
  | { kind: "cell-edited"; notebookUri: string; cellIdx: number; code: string; etag: string; ts: number }
  | { kind: "cell-created"; notebookUri: string; cellIdx: number; code: string; ts: number }
  | { kind: "cell-deleted"; notebookUri: string; cellIdx: number; ts: number };

const bridgeEvents = new EventEmitter();
bridgeEvents.setMaxListeners(0); // many SSE clients allowed

// Subset of marimo-team.vscode-marimo's `experimental.kernels` API shape
// (matches marimo-lsp/extension/src/platform/Api.ts on tag 0.13.0+).
// Defined inline so the bridge has no dependency on the marimo package.
interface MarimoOutputItem { mime: string; data: Uint8Array }
interface MarimoOutput { items: MarimoOutputItem[] }
interface MarimoKernel {
  executeCode(
    code: string,
    token?: vscode.CancellationToken,
  ): AsyncIterable<MarimoOutput>;
}

/**
 * Pure-function handler return type. Lets both HTTP and MCP transports
 * reuse the same internal logic — HTTP writes `body` as JSON with the
 * given `status`; MCP wraps `body` as content + maps non-200 to MCP error.
 */
export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Agent Bridge — a localhost HTTP server inside VS Code that lets external
 * agents (Claude Code CLI, MCP servers, scripts) drive marimo notebooks open
 * in the VS Code marimo extension, with the same kernel state the user sees.
 *
 * Endpoints:
 *
 *   GET  /health
 *     -> { ok, port, vscodeVersion }
 *
 *   GET  /api/sessions
 *   POST /api/kernel/execute   (Marimo-Session-Id header, SSE response)
 *     -> marimo-pair compatible. Unmodified `marimo-pair/scripts/execute-code.sh`
 *        works against this bridge (runs scratchpad code in the open notebook
 *        kernel). The bridge also writes itself into the standard marimo
 *        server registry so `discover-servers.sh` finds it.
 *
 *   GET   /notebooks/cells?notebook=<uri>           list cells
 *   POST  /notebooks/cells          {notebookUri, code}    create cell
 *   PATCH /notebooks/cells/{N}?notebook=<uri> {code}       edit cell
 *   POST  /notebooks/cells/{N}/run?notebook=<uri>          queue cell run
 *     -> Cell mutation (marimo-pair's _code_mode is unavailable through
 *        marimo-lsp; these REST endpoints fill the gap).
 *
 *   POST /commands/{commandId}     {args: [...]}
 *     -> generic vscode.commands.executeCommand pass-through (escape hatch).
 *
 * Discovery: the bridge picks a port (configured or auto), then writes
 *   - $XDG_STATE_HOME/marimo/servers/agent-bridge-<port>.json (marimo-pair)
 *   - <globalStorage>/agent-bridge.json (per-user-data-dir, sandbox-safe)
 *   - $AGENT_BRIDGE_DISCOVERY_FILE if the env var is set
 *   - ~/.agent-bridge.json (back-compat for non-sandbox dev)
 */
export function activate(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("agentBridge");
  const enabled = cfg.get<boolean>("enabled", true);
  const eagerStart = cfg.get<boolean>("eagerStart", false);
  const requestedPort = cfg.get<number>("port", 0);
  const token = cfg.get<string>("token", "") || "";

  const out = vscode.window.createOutputChannel("Agent Bridge");
  ctx.subscriptions.push(out);

  if (!enabled) {
    out.appendLine(
      "agentBridge.enabled is false — skipping HTTP server. Flip the setting and reload to re-enable.",
    );
    return;
  }

  // Watch for notebook document changes and emit structured events onto the
  // module-level bridgeEvents bus. SSE clients connected to GET /events pick
  // these up in real time. Runs regardless of HTTP server start mode so the
  // event bus is always hot once the extension is enabled.
  const changeSub = vscode.workspace.onDidChangeNotebookDocument((e) => {
    const nbUri = e.notebook.uri.toString();
    const ts = Date.now();
    for (const change of e.contentChanges) {
      // VS Code 1.86+ NotebookDocumentContentChange shape:
      // { range, addedCells: NotebookCell[], removedCells: NotebookCell[] }
      const removedLen = change.removedCells?.length ?? 0;
      for (let i = 0; i < removedLen; i++) {
        bridgeEvents.emit("event", {
          kind: "cell-deleted",
          notebookUri: nbUri,
          cellIdx: change.range.start + i,
          ts,
        } satisfies BridgeEvent);
      }
      for (const addedCell of change.addedCells ?? []) {
        bridgeEvents.emit("event", {
          kind: "cell-created",
          notebookUri: nbUri,
          cellIdx: addedCell.index,
          code: addedCell.document.getText(),
          ts,
        } satisfies BridgeEvent);
      }
    }
    for (const cellChange of e.cellChanges ?? []) {
      if (cellChange.document) {
        const code = cellChange.cell.document.getText();
        bridgeEvents.emit("event", {
          kind: "cell-edited",
          notebookUri: nbUri,
          cellIdx: cellChange.cell.index,
          code,
          etag: cellEtag(code),
          ts,
        } satisfies BridgeEvent);
      }
    }
  });
  ctx.subscriptions.push(changeSub);

  // The bridge activates eagerly (onStartupFinished) but defers starting the
  // HTTP server until a marimo notebook is actually open — that way production
  // users get lazy-server behavior without the chicken-and-egg the sandbox
  // and other test harnesses hit (where the bridge needs to be up *before*
  // marimo.openAsMarimoNotebook is called). Set agentBridge.eagerStart=true
  // (or open a marimo notebook before VS Code starts) to start immediately.
  let started = false;
  const startServer = () => {
    if (started) return;
    started = true;
    listenAndAnnounce(ctx, requestedPort, token, out);
  };

  const hasMarimoOpen = vscode.workspace.notebookDocuments.some(
    (n) => n.notebookType === "marimo-notebook",
  );
  if (eagerStart || hasMarimoOpen) {
    out.appendLine(
      eagerStart
        ? "eagerStart=true — starting HTTP server now"
        : "marimo notebook already open — starting HTTP server now",
    );
    startServer();
  } else {
    out.appendLine(
      "deferred — HTTP server will start when a marimo notebook opens (set agentBridge.eagerStart=true to skip the wait)",
    );
    const sub = vscode.workspace.onDidOpenNotebookDocument((nb) => {
      if (nb.notebookType === "marimo-notebook") startServer();
    });
    ctx.subscriptions.push(sub);
  }
}

function listenAndAnnounce(
  ctx: vscode.ExtensionContext,
  requestedPort: number,
  token: string,
  out: vscode.OutputChannel,
): void {
  const server = http.createServer((req, res) => {
    handle(req, res, token, out).catch((err) => {
      out.appendLine(`unhandled: ${err?.stack ?? String(err)}`);
      writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    out.appendLine(`listen error: ${err.code} ${err.message}`);
    if (err.code === "EADDRINUSE") {
      out.appendLine(
        `port ${requestedPort} already in use; set agentBridge.port to 0 for auto-pick`,
      );
    }
  });
  server.listen(requestedPort, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : requestedPort;
    // Per-extension globalStorageUri is per-user-data-dir, so it's already
    // sandbox-scoped — no race between concurrent sandbox runs sharing the
    // user's home dir. We ALSO write a copy at $AGENT_BRIDGE_DISCOVERY_FILE
    // (if set, useful for harness scripts to point at a known location) and
    // ~/.agent-bridge.json (back-compat for non-sandboxed dev workflows).
    fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    const discoveryPaths = [
      path.join(ctx.globalStorageUri.fsPath, "agent-bridge.json"),
    ];
    if (process.env.AGENT_BRIDGE_DISCOVERY_FILE) {
      discoveryPaths.push(process.env.AGENT_BRIDGE_DISCOVERY_FILE);
    } else {
      discoveryPaths.push(path.join(os.homedir(), ".agent-bridge.json"));
    }
    const payload = JSON.stringify(
      { port, token: token || null, pid: process.pid, started: Date.now() },
      null,
      2,
    );
    for (const p of discoveryPaths) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, payload);
        out.appendLine(`discovery: ${p}`);
      } catch (err) {
        out.appendLine(`discovery write failed at ${p}: ${err}`);
      }
    }
    out.appendLine(`listening on http://127.0.0.1:${port}`);

    // Per-workspace .mcp.json for Claude Code's project-scoped MCP
    // auto-discovery. Claude Code reads <workspace>/.mcp.json (not
    // <workspace>/.claude/.mcp.json — the .claude/ subdir holds settings.json
    // and skills, not MCP config), and expects the shape
    // {"mcpServers": {"<name>": {...}}} (not a flat name→config map).
    // Verified end-to-end: with the correct path+shape Claude Code reports
    // "agent-bridge: http://...:N/mcp (HTTP) - ✓ Connected" via `claude mcp list`.
    //
    // When VS Code opens a single file (no workspace folder yet), we defer
    // the write until a workspace folder or marimo notebook appears.
    // Cleanup on dispose regardless.
    let mcpDiscoveryPath: string | undefined;
    const mcpEntry: Record<string, unknown> = {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
    };
    if (token) {
      mcpEntry.headers = { Authorization: `Bearer ${token}` };
    }
    const mcpPayload = JSON.stringify(
      { mcpServers: { "agent-bridge": mcpEntry } },
      null,
      2,
    );

    const writeMcpDiscovery = (dir: string) => {
      if (mcpDiscoveryPath) return; // already written
      const p = path.join(dir, ".mcp.json");
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, mcpPayload);
        mcpDiscoveryPath = p;
        out.appendLine(`mcp discovery: ${p}`);
      } catch (err) {
        out.appendLine(`mcp discovery write failed: ${err}`);
      }
    };

    // Try workspace folder immediately.
    const wsNow = vscode.workspace.workspaceFolders?.[0];
    if (wsNow) {
      writeMcpDiscovery(wsNow.uri.fsPath);
    }

    // If no workspace folder yet, watch for one (file-only launch) or fall
    // back to the first marimo notebook's parent dir when it opens.
    if (!mcpDiscoveryPath) {
      const wsSub = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        const added = e.added[0];
        if (added) writeMcpDiscovery(added.uri.fsPath);
      });
      ctx.subscriptions.push(wsSub);

      const nbSub = vscode.workspace.onDidOpenNotebookDocument((nb) => {
        writeMcpDiscovery(path.dirname(nb.uri.fsPath));
      });
      ctx.subscriptions.push(nbSub);

      // Also check notebooks already open (e.g. eagerStart with notebook open).
      const nbNow = vscode.workspace.notebookDocuments[0];
      if (nbNow) writeMcpDiscovery(path.dirname(nbNow.uri.fsPath));
    }

    ctx.subscriptions.push({
      dispose() {
        if (mcpDiscoveryPath) {
          try { fs.unlinkSync(mcpDiscoveryPath); } catch { /* ignore */ }
        }
      },
    });

    // marimo-pair compatibility: register this bridge in the same local
    // server registry that marimo-pair's discover-servers.sh reads. The
    // registry file format mirrors what `marimo edit` writes — fields:
    // server_id, pid, host, port, base_url, started_at, version. With this,
    // marimo-pair's `execute-code.sh` finds the bridge (by --port or auto-
    // discovery) and POSTs to /api/sessions + /api/kernel/execute, which
    // the bridge serves marimo-standalone-compatibly below.
    const xdgState =
      process.env.XDG_STATE_HOME ||
      path.join(os.homedir(), ".local", "state");
    const marimoServersDir = path.join(xdgState, "marimo", "servers");
    const registryPath = path.join(
      marimoServersDir,
      `agent-bridge-${port}.json`,
    );
    try {
      fs.mkdirSync(marimoServersDir, { recursive: true });
      fs.writeFileSync(
        registryPath,
        JSON.stringify(
          {
            server_id: `127.0.0.1:${port}`,
            pid: process.pid,
            host: "127.0.0.1",
            port,
            base_url: "",
            started_at: new Date().toISOString(),
            version: "0.1.0",
            // Non-standard tag so a smart consumer can tell this is the
            // VS Code bridge vs a real `marimo edit` server.
            agent_bridge: true,
          },
          null,
          2,
        ),
      );
      out.appendLine(`marimo-pair registry: ${registryPath}`);
    } catch (err) {
      out.appendLine(`marimo-pair registry write failed: ${err}`);
    }

    ctx.subscriptions.push({
      dispose() {
        try {
          fs.unlinkSync(registryPath);
        } catch {
          /* ignore */
        }
      },
    });
  });

  ctx.subscriptions.push({
    dispose() {
      server.close();
      try {
        fs.unlinkSync(path.join(os.homedir(), ".agent-bridge.json"));
      } catch {
        /* ignore */
      }
    },
  });
}

export function deactivate() {
  // disposables handle cleanup
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  out: vscode.OutputChannel,
): Promise<void> {
  if (token) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, {
      ok: true,
      port: (req.socket.address() as { port: number }).port,
      vscodeVersion: vscode.version,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    const body = await readJson(req).catch(() => null);
    const resp = await handleMcpRequest(body);
    if (resp === null) {
      res.statusCode = 204;
      res.end();
    } else {
      writeJson(res, 200, resp);
    }
    return;
  }

  // ---- marimo-pair compatibility surface ---------------------------------
  // marimo-pair's execute-code.sh discovers the server via the registry,
  // calls GET /api/sessions to pick a session id, then POSTs to
  // /api/kernel/execute with `Marimo-Session-Id: <id>` header and `{code}`
  // body. The response is SSE: `event: stdout/stderr/done` with JSON `data:`.
  // We use the open marimo notebook URI as the session id (1:1 mapping).

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const marimoNbs = vscode.workspace.notebookDocuments.filter(
      (n) => n.notebookType === "marimo-notebook",
    );
    const sessions: Record<string, { filename: string }> = {};
    for (const n of marimoNbs) {
      sessions[n.uri.toString()] = { filename: n.uri.fsPath };
    }
    writeJson(res, 200, sessions);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kernel/execute") {
    const sessionId = req.headers["marimo-session-id"] as string | undefined;
    if (!sessionId) {
      writeJson(res, 400, { ok: false, error: "missing Marimo-Session-Id header" });
      return;
    }
    const body = await readJson(req);
    if (typeof body?.code !== "string") {
      writeJson(res, 400, { ok: false, error: "missing 'code' in body" });
      return;
    }

    // Talk to marimo via the public experimental.kernels API exposed by
    // marimo-team.vscode-marimo. This is what manzt pointed us at in
    // marimo-team/marimo-lsp#545 — no fork required.
    const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
    if (!ext) {
      writeJson(res, 503, {
        ok: false,
        error: "marimo-team.vscode-marimo not installed",
      });
      return;
    }
    const marimoApi = (ext.isActive
      ? ext.exports
      : await ext.activate()) as
      | {
          experimental?: {
            kernels?: {
              getKernel(uri: vscode.Uri): Promise<MarimoKernel | undefined>;
            };
          };
        }
      | undefined;
    const kernels = marimoApi?.experimental?.kernels;
    if (!kernels) {
      writeJson(res, 503, {
        ok: false,
        error: "marimo-team.vscode-marimo doesn't expose experimental.kernels (need >=0.13.0)",
      });
      return;
    }
    const kernel = await kernels.getKernel(vscode.Uri.parse(sessionId));
    if (!kernel) {
      writeJson(res, 404, {
        ok: false,
        error: `no active kernel for notebook (open it and bind the marimo kernel first): ${sessionId}`,
      });
      return;
    }

    // Stream kernel outputs straight into the marimo-pair SSE protocol.
    // Cancel kernel work if the SSE client disconnects.
    const cts = new vscode.CancellationTokenSource();
    req.on("close", () => cts.cancel());

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");

    const decoder = new TextDecoder();
    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Capture the first .error item we see, but keep iterating so traceback
    // stderr/stdout that arrives alongside still streams to the client.
    // Emit the final done event from the catch/finally path so we always
    // produce exactly one done event with the right success flag.
    let firstError:
      | { name?: string; message?: string; stack?: string; raw: string }
      | undefined;
    try {
      for await (const output of kernel.executeCode(body.code, cts.token)) {
        for (const item of output.items ?? []) {
          const text = decoder.decode(item.data);
          if (item.mime === "application/vnd.code.notebook.stdout") {
            writeEvent("stdout", { data: text });
          } else if (item.mime === "application/vnd.code.notebook.stderr") {
            writeEvent("stderr", { data: text });
          } else if (item.mime === "application/vnd.code.notebook.error") {
            // JSON-encoded error per vscode.NotebookCellOutput.error().
            // Don't terminate the stream — kernels may send traceback as
            // follow-up stderr/stdout items in the same iteration.
            if (!firstError) {
              let parsed: { name?: string; message?: string; stack?: string } =
                {};
              try { parsed = JSON.parse(text); } catch { /* leave empty */ }
              firstError = { ...parsed, raw: text };
            }
          } else {
            // Rich output (text/plain, text/html, image/*, application/json).
            // marimo-pair doesn't model these as a distinct channel; emit on
            // stdout with the mime preserved so callers that want it can read.
            writeEvent("stdout", { data: text, mime: item.mime });
          }
        }
      }
      if (firstError) {
        writeEvent("done", {
          success: false,
          error: {
            msg:
              firstError.message ?? firstError.name ?? firstError.raw,
          },
        });
      } else {
        writeEvent("done", { success: true, output: { data: "" } });
      }
    } catch (e) {
      writeEvent("done", {
        success: false,
        error: { msg: String((e as Error)?.message ?? e) },
      });
    } finally {
      cts.dispose();
      res.end();
    }
    return;
  }

  // ---- Editor & notebook lifecycle (URI resolution, open, state) --------
  // These activate before the cell-CRUD routes so they take priority over the
  // generic /notebooks/* path. None of them touch the kernel.

  if (req.method === "GET" && url.pathname === "/notebooks") {
    const fsPath = url.searchParams.get("path");
    if (!fsPath) {
      writeJson(res, 400, { ok: false, error: "missing ?path=<fs-path>" });
      return;
    }
    const nb = vscode.workspace.notebookDocuments.find(
      (n) => n.uri.fsPath === fsPath,
    );
    if (!nb) {
      writeJson(res, 404, {
        ok: false,
        error: `no open notebook with fsPath ${fsPath}`,
        openNotebooks: vscode.workspace.notebookDocuments.map((n) => n.uri.toString()),
      });
      return;
    }
    writeJson(res, 200, { ok: true, result: { uri: nb.uri.toString(), fsPath: nb.uri.fsPath } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/notebooks/open") {
    const body = await readJson(req).catch(() => ({}));
    if (typeof body?.uri !== "string") {
      writeJson(res, 400, { ok: false, error: "missing body.uri (string)" });
      return;
    }
    const existing = vscode.workspace.notebookDocuments.find(
      (n) => n.uri.toString() === body.uri,
    );
    if (existing) {
      writeJson(res, 200, { ok: true, result: { uri: existing.uri.toString(), alreadyOpen: true } });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.parse(body.uri),
      "marimo-notebook",
    );
    writeJson(res, 200, { ok: true, result: { uri: body.uri, alreadyOpen: false } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/editor/state") {
    const nbUriParam = url.searchParams.get("notebook");
    const editor = vscode.window.activeNotebookEditor;
    const nb = nbUriParam
      ? vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === nbUriParam)
      : editor?.notebook;
    if (!nb) {
      writeJson(res, 404, { ok: false, error: "no active or matching notebook" });
      return;
    }
    const matchingEditor =
      editor && editor.notebook.uri.toString() === nb.uri.toString() ? editor : undefined;
    // Selections are NotebookRange[]; collect every selected cell index.
    const selected: number[] = [];
    if (matchingEditor) {
      for (const range of matchingEditor.selections) {
        for (let i = range.start; i < range.end; i++) selected.push(i);
      }
    }
    const activeCell =
      matchingEditor && matchingEditor.selection
        ? matchingEditor.selection.start
        : null;
    // Cell tags don't exist in marimo's notebook model today. Expose an empty
    // object so consumers can write code against a stable shape; will fill in
    // when marimo or VS Code adds a tag mechanism.
    writeJson(res, 200, {
      ok: true,
      result: {
        notebookUri: nb.uri.toString(),
        selected,
        activeCell,
        cellTags: {},
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kernel/interrupt") {
    const body = await readJson(req).catch(() => ({}));
    const nbUri = body?.notebookUri ?? url.searchParams.get("notebook");
    if (!nbUri) {
      writeJson(res, 400, { ok: false, error: "missing body.notebookUri or ?notebook=<uri>" });
      return;
    }
    const nb = vscode.workspace.notebookDocuments.find(
      (n) => n.uri.toString() === nbUri,
    );
    if (!nb) {
      writeJson(res, 404, { ok: false, error: `notebook not open: ${nbUri}` });
      return;
    }
    // Cancel any in-flight cell execution for this notebook. VS Code's
    // notebook.cancelExecution operates on the active editor; we ensure the
    // target notebook is active first via vscode.window.showNotebookDocument.
    await vscode.window.showNotebookDocument(nb);
    await vscode.commands.executeCommand("notebook.cancelExecution");
    writeJson(res, 200, { ok: true, result: { interrupted: true, notebookUri: nbUri } });
    return;
  }

  // ---- SSE event stream ---------------------------------------------------
  // GET /events?notebook=<encoded-uri> — streams BridgeEvent objects as SSE.
  // Without ?notebook=, all notebooks' events stream (wildcard mode).
  // A 15-second heartbeat comment keeps intermediaries from dropping the conn.
  if (req.method === "GET" && url.pathname === "/events") {
    const nbFilter = url.searchParams.get("notebook");
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    // Any res.write can throw if the client disconnected between listener
    // registration and the write — tear down listeners on the first failure
    // so we don't accumulate dead callbacks.
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      bridgeEvents.off("event", onEvent);
      try { res.end(); } catch { /* socket already gone */ }
    };
    const safeWrite = (chunk: string) => {
      if (closed) return;
      try { res.write(chunk); } catch { teardown(); }
    };
    // Heartbeat so intermediaries don't drop the connection on idle.
    const hb = setInterval(() => safeWrite(":hb\n\n"), 15_000);
    const onEvent = (e: BridgeEvent) => {
      if (nbFilter && e.notebookUri !== nbFilter) return;
      safeWrite(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    bridgeEvents.on("event", onEvent);
    req.on("close", teardown);
    // Send an immediate hello so a synchronous test can confirm connection.
    safeWrite(`event: hello\ndata: {"ts":${Date.now()}}\n\n`);
    return;
  }

  // ---- Notebook cell mutation -------------------------------------------
  // All endpoints share the same pattern: locate the notebook (by ?notebook=
  // or body.notebookUri), validate the cell index if the URL has one, then run
  // a small handler. Single dispatch table keeps validation in one place
  // (audit found PATCH-with-no-code wiped cells + run-out-of-bounds was
  // silently OK; both fixed by the shared validator).
  const cellRoute = matchCellRoute(req.method ?? "", url.pathname);
  if (cellRoute) {
    const body = await readJson(req).catch(() => ({}));
    const nbUri = url.searchParams.get("notebook") ?? body?.notebookUri;
    if (!nbUri) {
      writeJson(res, 400, { ok: false, error: "missing ?notebook=<uri> or body.notebookUri" });
      return;
    }
    const nb = vscode.workspace.notebookDocuments.find(
      (n) => n.uri.toString() === nbUri,
    );
    if (!nb) {
      writeJson(res, 404, {
        ok: false,
        error: `notebook not open: ${nbUri}`,
        openNotebooks: vscode.workspace.notebookDocuments.map((n) => n.uri.toString()),
      });
      return;
    }
    if (
      cellRoute.cellIdx !== undefined &&
      (cellRoute.cellIdx < 0 || cellRoute.cellIdx >= nb.cellCount)
    ) {
      writeJson(res, 404, {
        ok: false,
        error: `cell index ${cellRoute.cellIdx} out of bounds (cellCount=${nb.cellCount})`,
      });
      return;
    }
    const ifMatch =
      (req.headers["if-match"] as string | undefined) ??
      body?.expectedEtag ??
      undefined;
    await cellRoute.handler({ nb, body, cellIdx: cellRoute.cellIdx, res, ifMatch });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/commands/")) {
    const commandId = decodeURIComponent(url.pathname.slice("/commands/".length));
    const body = await readJson(req).catch(() => ({}));
    const args = Array.isArray(body?.args) ? body.args : [];
    out.appendLine(`exec: ${commandId} args=${JSON.stringify(args).slice(0, 200)}`);
    const result = await vscode.commands.executeCommand(commandId, ...args);
    writeJson(res, 200, { ok: true, result });
    return;
  }

  writeJson(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function writeHandlerResult(res: http.ServerResponse, r: HandlerResult): void {
  writeJson(res, r.status, r.body);
}

interface CellRouteCtx {
  nb: vscode.NotebookDocument;
  body: any;
  cellIdx: number | undefined;
  res: http.ServerResponse;
  ifMatch?: string;
}

interface CellRoute {
  cellIdx?: number;
  handler: (ctx: CellRouteCtx) => Promise<void>;
}

function matchCellRoute(method: string, pathname: string): CellRoute | null {
  if (method === "GET" && pathname === "/notebooks/cells") return { handler: listCells };
  if (method === "POST" && pathname === "/notebooks/cells") return { handler: createCell };
  const m = pathname.match(/^\/notebooks\/cells\/(\d+)(\/run|\/outputs)?$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  if (method === "PATCH" && !m[2]) return { cellIdx: idx, handler: editCell };
  if (method === "DELETE" && !m[2]) return { cellIdx: idx, handler: deleteCell };
  if (method === "POST" && m[2] === "/run") return { cellIdx: idx, handler: runCell };
  if (method === "GET" && m[2] === "/outputs") return { cellIdx: idx, handler: cellOutputs };
  return null;
}

export function listCellsCore(nb: vscode.NotebookDocument): HandlerResult {
  const cells = nb.getCells().map((c, i) => {
    const code = c.document.getText();
    const summary = c.executionSummary;
    const timing = summary?.timing
      ? { startTime: summary.timing.startTime, endTime: summary.timing.endTime,
          duration_ms: summary.timing.endTime - summary.timing.startTime }
      : null;
    return {
      index: i,
      kind: c.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      languageId: c.document.languageId,
      code,
      etag: cellEtag(code),
      executionSummary: summary
        ? { success: summary.success, executionOrder: summary.executionOrder }
        : null,
      timing,
      outputs: c.outputs.map((o) => ({
        items: o.items.map((it) => ({ mime: it.mime, text: textDecodeSafe(it.data) })),
      })),
    };
  });
  return { status: 200, body: { ok: true, result: { cells } } };
}

async function listCells({ nb, res }: CellRouteCtx): Promise<void> {
  writeHandlerResult(res, listCellsCore(nb));
}

export async function createCellCore(args: {
  nb: vscode.NotebookDocument;
  code: string;
  kind?: "code" | "markup";
  languageId?: string;
  index?: number;
}): Promise<HandlerResult> {
  const kind =
    args.kind === "markup" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
  const isMarimo = args.nb.notebookType === "marimo-notebook";
  const lang =
    args.languageId ??
    (kind === vscode.NotebookCellKind.Code ? (isMarimo ? "mo-python" : "python") : "markdown");
  const idx = typeof args.index === "number" ? args.index : args.nb.cellCount;
  const edit = new vscode.WorkspaceEdit();
  edit.set(args.nb.uri, [
    vscode.NotebookEdit.insertCells(idx, [
      new vscode.NotebookCellData(kind, args.code, lang),
    ]),
  ]);
  const ok = await vscode.workspace.applyEdit(edit);
  return { status: 200, body: { ok, result: { index: idx, cellCount: args.nb.cellCount } } };
}

async function createCell({ nb, body, res }: CellRouteCtx): Promise<void> {
  if (typeof body?.code !== "string") {
    writeJson(res, 400, { ok: false, error: "missing body.code (string)" });
    return;
  }
  writeHandlerResult(res, await createCellCore({
    nb,
    code: body.code,
    kind: body.kind,
    languageId: body.languageId,
    index: typeof body.index === "number" ? body.index : undefined,
  }));
}

export async function editCellCore(args: {
  nb: vscode.NotebookDocument;
  cellIdx: number;
  code: string;
  ifMatch?: string;
}): Promise<HandlerResult> {
  const cell = args.nb.cellAt(args.cellIdx);
  const currentEtag = cellEtag(cell.document.getText());
  // `!== undefined` (not truthiness) so an etag like "00000000" still triggers
  // the check — matches the live editCell handler's semantics exactly.
  if (args.ifMatch !== undefined && args.ifMatch !== currentEtag) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "etag mismatch — cell changed since you read it",
        currentEtag,
        providedEtag: args.ifMatch,
      },
    };
  }
  const range = new vscode.Range(
    cell.document.positionAt(0),
    cell.document.positionAt(cell.document.getText().length),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(cell.document.uri, range, args.code);
  const ok = await vscode.workspace.applyEdit(edit);
  return {
    status: 200,
    body: { ok, result: { index: args.cellIdx, etag: cellEtag(args.code) } },
  };
}

async function editCell({ nb, body, cellIdx, res, ifMatch }: CellRouteCtx): Promise<void> {
  if (typeof body?.code !== "string") {
    writeJson(res, 400, { ok: false, error: "missing body.code (string) — refusing to wipe cell" });
    return;
  }
  writeHandlerResult(res, await editCellCore({
    nb,
    cellIdx: cellIdx!,
    code: body.code,
    ifMatch,
  }));
}

export async function deleteCellCore(args: {
  nb: vscode.NotebookDocument;
  cellIdx: number;
  ifMatch?: string;
}): Promise<HandlerResult> {
  const cell = args.nb.cellAt(args.cellIdx);
  const currentEtag = cellEtag(cell.document.getText());
  // `!== undefined` matches the live deleteCell handler.
  if (args.ifMatch !== undefined && args.ifMatch !== currentEtag) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "etag mismatch — cell changed since you read it",
        currentEtag,
        providedEtag: args.ifMatch,
      },
    };
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(args.nb.uri, [
    vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(args.cellIdx, args.cellIdx + 1)),
  ]);
  const ok = await vscode.workspace.applyEdit(edit);
  return {
    status: 200,
    body: { ok, result: { deletedIndex: args.cellIdx, cellCount: args.nb.cellCount } },
  };
}

async function deleteCell({ nb, cellIdx, res, ifMatch }: CellRouteCtx): Promise<void> {
  writeHandlerResult(res, await deleteCellCore({
    nb,
    cellIdx: cellIdx!,
    ifMatch,
  }));
}

export async function runCellCore(args: {
  nb: vscode.NotebookDocument;
  cellIdx: number;
}): Promise<HandlerResult> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: args.cellIdx, end: args.cellIdx + 1 }],
    document: args.nb.uri,
  });
  return { status: 200, body: { ok: true, result: { queued: args.cellIdx } } };
}

async function runCell({ nb, cellIdx, res }: CellRouteCtx): Promise<void> {
  writeHandlerResult(res, await runCellCore({ nb, cellIdx: cellIdx! }));
}

/**
 * Mime types whose content is valid UTF-8 text and should be returned as a
 * `data` string. Anything not in this set is binary and gets only `data_b64`.
 * Stdout/stderr channel mimes are explicitly listed here because VS Code uses
 * its own `application/vnd.code.notebook.*` namespace for them — not text/*.
 */
function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr" ||
    mime === "application/vnd.code.notebook.error"
  );
}

export async function cellOutputsCore(args: {
  nb: vscode.NotebookDocument;
  cellIdx: number;
}): Promise<HandlerResult> {
  const cell = args.nb.cellAt(args.cellIdx);
  const outputs = cell.outputs.map((o) => ({
    items: o.items.map((it) => {
      const b64 = Buffer.from(it.data).toString("base64");
      if (isTextMime(it.mime)) {
        return { mime: it.mime, data: textDecodeSafe(it.data), data_b64: b64 };
      }
      return { mime: it.mime, data_b64: b64 };
    }),
  }));
  return {
    status: 200,
    body: { ok: true, result: { cellIdx: args.cellIdx, outputs } },
  };
}

async function cellOutputs({ nb, cellIdx, res }: CellRouteCtx): Promise<void> {
  writeHandlerResult(res, await cellOutputsCore({ nb, cellIdx: cellIdx! }));
}

/**
 * Derived cell state from VS Code's executionSummary. NOT marimo's full
 * reactivity state — "stale" (a cell whose inputs changed) requires marimo's
 * dependency graph and is intentionally out of scope here.
 *
 * Mapping:
 *   - no executionSummary at all                                   → "idle"
 *   - success === true (with or without executionOrder)            → "success"
 *   - success === false (with or without executionOrder)           → "error"
 *   - executionOrder set, success === undefined (running window)   → "running"
 *   - executionOrder undefined, success undefined                  → "idle"
 *
 * Note: marimo notebooks do not populate executionOrder in VS Code's
 * executionSummary (marimo manages its own execution model). We therefore
 * check success first and fall back to executionOrder for the running window.
 */
export async function cellStatusCore(args: {
  nb: vscode.NotebookDocument;
  cellIdx: number;
}): Promise<HandlerResult> {
  const cell = args.nb.cellAt(args.cellIdx);
  const summary = cell.executionSummary;
  let status: "idle" | "running" | "success" | "error";
  if (!summary) {
    status = "idle";
  } else if (summary.success === true) {
    status = "success";
  } else if (summary.success === false) {
    status = "error";
  } else if (summary.executionOrder !== undefined) {
    // executionOrder is set but success is still undefined → cell is running
    status = "running";
  } else {
    status = "idle";
  }
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        cellIdx: args.cellIdx,
        status,
        executionOrder: summary?.executionOrder ?? null,
        success: summary?.success ?? null,
      },
    },
  };
}

function textDecodeSafe(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return "";
  }
}

/**
 * Short stable hash of a cell's code — optimistic-concurrency token so an
 * agent that GETs then PATCHes can detect a user edit in between. NOT
 * cryptographic; collisions are fine because we only use this for "did the
 * cell change since you read it?" comparisons within a session.
 *
 * Hashes UTF-16 code units (not UTF-8 bytes), so two cells that differ only
 * in unpaired surrogates could theoretically collide. Tolerated — agents
 * resync via the change-event stream, not the etag space.
 */
function cellEtag(code: string): string {
  // FNV-1a 32-bit; 8 hex chars is plenty for in-session diffing.
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function lookupNotebook(uri: string): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === uri);
}

export function notebookNotOpenResult(uri: string): HandlerResult {
  return {
    status: 404,
    body: {
      ok: false,
      error: `notebook not open: ${uri}`,
      openNotebooks: vscode.workspace.notebookDocuments.map((n) => n.uri.toString()),
    },
  };
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const txt = Buffer.concat(chunks).toString("utf8");
      if (!txt) return resolve({});
      try {
        resolve(JSON.parse(txt));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
