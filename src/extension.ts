import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

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
  const requestedPort = cfg.get<number>("port", 0);
  const token = cfg.get<string>("token", "") || "";

  const out = vscode.window.createOutputChannel("Agent Bridge");
  ctx.subscriptions.push(out);

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

    let errored = false;
    try {
      for await (const output of kernel.executeCode(body.code, cts.token)) {
        for (const item of output.items ?? []) {
          const text = decoder.decode(item.data);
          if (item.mime === "application/vnd.code.notebook.stdout") {
            writeEvent("stdout", { data: text });
          } else if (item.mime === "application/vnd.code.notebook.stderr") {
            writeEvent("stderr", { data: text });
          } else if (item.mime === "application/vnd.code.notebook.error") {
            // JSON-encoded error per vscode.NotebookCellOutput.
            let parsed: { name?: string; message?: string; stack?: string } = {};
            try { parsed = JSON.parse(text); } catch { /* leave empty */ }
            writeEvent("done", {
              success: false,
              error: { msg: parsed.message ?? parsed.name ?? text },
            });
            errored = true;
            return;
          } else {
            // Rich output (text/plain, text/html, image/*, application/json).
            // marimo-pair doesn't model these as a distinct channel; emit on
            // stdout with the mime preserved so callers that want it can read.
            writeEvent("stdout", { data: text, mime: item.mime });
          }
        }
      }
      writeEvent("done", { success: true, output: { data: "" } });
    } catch (e) {
      writeEvent("done", {
        success: false,
        error: { msg: String((e as Error)?.message ?? e) },
      });
      errored = true;
    } finally {
      // ESLint placeholder: errored is consulted by future test scaffolding.
      void errored;
      cts.dispose();
      res.end();
    }
    return;
  }

  // ---- Notebook cell mutation -------------------------------------------
  // All four endpoints share the same pattern: locate the notebook (by ?notebook=
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
    await cellRoute.handler({ nb, body, cellIdx: cellRoute.cellIdx, res });
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

interface CellRouteCtx {
  nb: vscode.NotebookDocument;
  body: any;
  cellIdx: number | undefined;
  res: http.ServerResponse;
}

interface CellRoute {
  cellIdx?: number;
  handler: (ctx: CellRouteCtx) => Promise<void>;
}

function matchCellRoute(method: string, pathname: string): CellRoute | null {
  if (method === "GET" && pathname === "/notebooks/cells") return { handler: listCells };
  if (method === "POST" && pathname === "/notebooks/cells") return { handler: createCell };
  const m = pathname.match(/^\/notebooks\/cells\/(\d+)(\/run)?$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  if (method === "PATCH" && !m[2]) return { cellIdx: idx, handler: editCell };
  if (method === "POST" && m[2] === "/run") return { cellIdx: idx, handler: runCell };
  return null;
}

async function listCells({ nb, res }: CellRouteCtx): Promise<void> {
  const cells = nb.getCells().map((c, i) => ({
    index: i,
    kind: c.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
    languageId: c.document.languageId,
    code: c.document.getText(),
    executionSummary: c.executionSummary
      ? {
          success: c.executionSummary.success,
          executionOrder: c.executionSummary.executionOrder,
        }
      : null,
    outputs: c.outputs.map((o) => ({
      items: o.items.map((it) => ({ mime: it.mime, text: textDecodeSafe(it.data) })),
    })),
  }));
  writeJson(res, 200, { ok: true, result: { cells } });
}

async function createCell({ nb, body, res }: CellRouteCtx): Promise<void> {
  if (typeof body?.code !== "string") {
    writeJson(res, 400, { ok: false, error: "missing body.code (string)" });
    return;
  }
  const kind =
    body.kind === "markup" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
  // Default code cell language to "mo-python" (marimo's custom Python id)
  // for marimo notebooks. Without this, marimo's NotebookController doesn't
  // own the cell and run-cell silently no-ops.
  const isMarimo = nb.notebookType === "marimo-notebook";
  const lang =
    body.languageId ??
    (kind === vscode.NotebookCellKind.Code ? (isMarimo ? "mo-python" : "python") : "markdown");
  const idx = typeof body.index === "number" ? body.index : nb.cellCount;
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [
    vscode.NotebookEdit.insertCells(idx, [
      new vscode.NotebookCellData(kind, body.code, lang),
    ]),
  ]);
  const ok = await vscode.workspace.applyEdit(edit);
  writeJson(res, 200, { ok, result: { index: idx, cellCount: nb.cellCount } });
}

async function editCell({ nb, body, cellIdx, res }: CellRouteCtx): Promise<void> {
  if (typeof body?.code !== "string") {
    writeJson(res, 400, { ok: false, error: "missing body.code (string) — refusing to wipe cell" });
    return;
  }
  const cell = nb.cellAt(cellIdx!);
  const range = new vscode.Range(
    cell.document.positionAt(0),
    cell.document.positionAt(cell.document.getText().length),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(cell.document.uri, range, body.code);
  const ok = await vscode.workspace.applyEdit(edit);
  writeJson(res, 200, { ok, result: { index: cellIdx } });
}

async function runCell({ nb, cellIdx, res }: CellRouteCtx): Promise<void> {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: cellIdx!, end: cellIdx! + 1 }],
    document: nb.uri,
  });
  writeJson(res, 200, { ok: true, result: { queued: cellIdx } });
}

function textDecodeSafe(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return "";
  }
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
