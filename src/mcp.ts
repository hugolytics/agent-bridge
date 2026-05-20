/**
 * Hand-rolled JSON-RPC 2.0 dispatcher exposing the bridge as an MCP server
 * over Streamable HTTP (POST /mcp). No `@modelcontextprotocol/sdk` dep —
 * keeps the bridge zero-runtime-deps for vendoring. Spec:
 * https://modelcontextprotocol.io/specification/2025-06-18
 */

import {
  HandlerResult,
  listCellsCore,
  createCellCore,
  editCellCore,
  deleteCellCore,
  runCellCore,
  cellOutputsCore,
  lookupNotebook,
  notebookNotOpenResult,
} from "./extension";
import * as vscode from "vscode";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Tagged-union result of resolving a notebook URI arg — lets TypeScript
 * narrow cleanly without `"uri" in r` gymnastics on the union of
 * `vscode.NotebookDocument | McpCallResult`.
 */
type NotebookLookup =
  | { ok: true; nb: vscode.NotebookDocument }
  | { ok: false; result: McpCallResult };

async function runScratchpadAsMcp(args: Record<string, unknown>): Promise<McpCallResult> {
  if (typeof args.notebookUri !== "string" || typeof args.code !== "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "missing notebookUri/code" }) }],
      isError: true,
    };
  }
  const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
  if (!ext) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "marimo-team.vscode-marimo not installed" }) }],
      isError: true,
    };
  }
  type MarimoKernel = {
    executeCode(code: string, token?: vscode.CancellationToken): AsyncIterable<{
      items: { mime: string; data: Uint8Array }[];
    }>;
  };
  const marimoApi = (ext.isActive ? ext.exports : await ext.activate()) as {
    experimental?: { kernels?: { getKernel(uri: vscode.Uri): Promise<MarimoKernel | undefined> } };
  } | undefined;
  const kernels = marimoApi?.experimental?.kernels;
  if (!kernels) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "experimental.kernels missing" }) }],
      isError: true,
    };
  }
  const kernel = await kernels.getKernel(vscode.Uri.parse(args.notebookUri));
  if (!kernel) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: `no active kernel: ${args.notebookUri}` }) }],
      isError: true,
    };
  }

  const items: McpContent[] = [];
  const dec = new TextDecoder();
  let firstError: string | undefined;
  try {
    for await (const output of kernel.executeCode(args.code)) {
      for (const it of output.items ?? []) {
        const text = dec.decode(it.data);
        const channel =
          it.mime === "application/vnd.code.notebook.stdout" ? "stdout" :
          it.mime === "application/vnd.code.notebook.stderr" ? "stderr" :
          it.mime === "application/vnd.code.notebook.error" ? "error" :
          "other";
        items.push({ type: "text", text: JSON.stringify({ channel, mime: it.mime, data: text }) });
        if (channel === "error" && !firstError) firstError = text;
      }
    }
  } catch (e) {
    firstError = String((e as Error)?.message ?? e);
  }
  items.push({
    type: "text",
    text: JSON.stringify({ channel: "done", success: !firstError, error: firstError }),
  });
  return { content: items, isError: !!firstError };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  // Helper: turn HandlerResult into McpCallResult.
  const wrap = (r: HandlerResult, extraContent?: McpContent[]): McpCallResult => {
    const items: McpContent[] = [{ type: "text", text: JSON.stringify(r.body) }];
    if (extraContent) items.push(...extraContent);
    return { content: items, isError: r.status >= 400 };
  };

  // Helper: resolve a notebook URI arg into a tagged union TS narrows cleanly.
  const resolveNb = (uri: unknown): NotebookLookup => {
    if (typeof uri !== "string") {
      return { ok: false, result: wrap({ status: 400, body: { ok: false, error: "missing notebookUri (string)" } }) };
    }
    const nb = lookupNotebook(uri);
    if (!nb) return { ok: false, result: wrap(notebookNotOpenResult(uri)) };
    return { ok: true, nb };
  };

  switch (name) {
    case "notebook_list_cells": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      return wrap(listCellsCore(r.nb));
    }

    case "notebook_cell_outputs": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      const idx = args.cellIdx;
      if (typeof idx !== "number" || idx < 0 || idx >= r.nb.cellCount) {
        return wrap({ status: 404, body: { ok: false, error: `cell index ${idx} out of bounds` } });
      }
      const result = await cellOutputsCore({ nb: r.nb, cellIdx: idx });
      // Lift image/* items into native MCP image content alongside the JSON text item.
      const extras: McpContent[] = [];
      type OutItem = { mime: string; data?: string; data_b64?: string };
      type OutGroup = { items: OutItem[] };
      const outputs = (result.body.result as { outputs: OutGroup[] } | undefined)?.outputs ?? [];
      for (const grp of outputs) {
        for (const it of grp.items) {
          if (it.mime.startsWith("image/") && typeof it.data_b64 === "string") {
            extras.push({ type: "image", data: it.data_b64, mimeType: it.mime });
          }
        }
      }
      return wrap(result, extras);
    }

    case "notebook_editor_state": {
      // No notebook arg required — uses active editor when omitted.
      const uri = typeof args.notebookUri === "string" ? args.notebookUri : undefined;
      const editor = vscode.window.activeNotebookEditor;
      const nb = uri ? lookupNotebook(uri) : editor?.notebook;
      if (!nb) {
        return wrap({ status: 404, body: { ok: false, error: "no active or matching notebook" } });
      }
      const matchingEditor =
        editor && editor.notebook.uri.toString() === nb.uri.toString() ? editor : undefined;
      const selected: number[] = [];
      if (matchingEditor) {
        for (const range of matchingEditor.selections) {
          for (let i = range.start; i < range.end; i++) selected.push(i);
        }
      }
      const activeCell =
        matchingEditor && matchingEditor.selection ? matchingEditor.selection.start : null;
      return wrap({
        status: 200,
        body: {
          ok: true,
          result: { notebookUri: nb.uri.toString(), selected, activeCell, cellTags: {} },
        },
      });
    }

    case "notebook_resolve_path": {
      const p = args.path;
      if (typeof p !== "string") {
        return wrap({ status: 400, body: { ok: false, error: "missing path (string)" } });
      }
      const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.fsPath === p);
      if (!nb) {
        return wrap({
          status: 404,
          body: {
            ok: false,
            error: `no open notebook with fsPath ${p}`,
            openNotebooks: vscode.workspace.notebookDocuments.map((n) => n.uri.toString()),
          },
        });
      }
      return wrap({
        status: 200,
        body: { ok: true, result: { uri: nb.uri.toString(), fsPath: nb.uri.fsPath } },
      });
    }

    case "notebook_list_sessions": {
      const marimoNbs = vscode.workspace.notebookDocuments.filter(
        (n) => n.notebookType === "marimo-notebook",
      );
      const sessions: Record<string, { filename: string }> = {};
      for (const n of marimoNbs) {
        sessions[n.uri.toString()] = { filename: n.uri.fsPath };
      }
      // Body shape deviates from {ok, result} on purpose: matches the HTTP
      // /api/sessions handler exactly (marimo-pair-compat surface — agents
      // expect a raw {uri: {filename}} map, not an envelope).
      return wrap({ status: 200, body: sessions });
    }

    case "notebook_open": {
      const uri = args.uri;
      if (typeof uri !== "string") {
        return wrap({ status: 400, body: { ok: false, error: "missing uri (string)" } });
      }
      const existing = lookupNotebook(uri);
      if (existing) {
        return wrap({
          status: 200,
          body: { ok: true, result: { uri: existing.uri.toString(), alreadyOpen: true } },
        });
      }
      await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.parse(uri), "marimo-notebook");
      return wrap({ status: 200, body: { ok: true, result: { uri, alreadyOpen: false } } });
    }

    case "notebook_create_cell": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      if (typeof args.code !== "string") {
        return wrap({ status: 400, body: { ok: false, error: "missing code (string)" } });
      }
      return wrap(await createCellCore({
        nb: r.nb,
        code: args.code,
        kind: args.kind as "code" | "markup" | undefined,
        languageId: args.languageId as string | undefined,
        index: typeof args.index === "number" ? args.index : undefined,
      }));
    }

    case "notebook_edit_cell": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      const idx = args.cellIdx;
      if (typeof idx !== "number" || idx < 0 || idx >= r.nb.cellCount) {
        return wrap({ status: 404, body: { ok: false, error: `cell index ${idx} out of bounds` } });
      }
      if (typeof args.code !== "string") {
        return wrap({ status: 400, body: { ok: false, error: "missing code (string)" } });
      }
      return wrap(await editCellCore({
        nb: r.nb,
        cellIdx: idx,
        code: args.code,
        ifMatch: typeof args.expectedEtag === "string" ? args.expectedEtag : undefined,
      }));
    }

    case "notebook_delete_cell": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      const idx = args.cellIdx;
      if (typeof idx !== "number" || idx < 0 || idx >= r.nb.cellCount) {
        return wrap({ status: 404, body: { ok: false, error: `cell index ${idx} out of bounds` } });
      }
      return wrap(await deleteCellCore({
        nb: r.nb,
        cellIdx: idx,
        ifMatch: typeof args.expectedEtag === "string" ? args.expectedEtag : undefined,
      }));
    }

    case "notebook_run_cell": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      const idx = args.cellIdx;
      if (typeof idx !== "number" || idx < 0 || idx >= r.nb.cellCount) {
        return wrap({ status: 404, body: { ok: false, error: `cell index ${idx} out of bounds` } });
      }
      return wrap(await runCellCore({ nb: r.nb, cellIdx: idx }));
    }

    case "notebook_kernel_interrupt": {
      const r = resolveNb(args.notebookUri);
      if (!r.ok) return r.result;
      await vscode.window.showNotebookDocument(r.nb);
      await vscode.commands.executeCommand("notebook.cancelExecution");
      return wrap({
        status: 200,
        body: { ok: true, result: { interrupted: true, notebookUri: r.nb.uri.toString() } },
      });
    }

    case "notebook_scratchpad_execute":
      // Streaming-equivalent: aggregate stdout/stderr/done into multiple
      // content items rather than a single text item. Uses the same
      // experimental.kernels.executeCode path as POST /api/kernel/execute
      // but collects events into an array instead of writing SSE.
      return runScratchpadAsMcp(args);

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }) }],
        isError: true,
      };
  }
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "agent-bridge";
const SERVER_VERSION = "0.2.0";

type EffectAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
};

const READ: EffectAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATE_IDEMPOTENT: EffectAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATE_NONIDEMPOTENT: EffectAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE_IDEMPOTENT: EffectAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const RUN: EffectAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  annotations: EffectAnnotations;
}

const NOTEBOOK_URI_PARAM = {
  notebookUri: {
    type: "string",
    format: "uri",
    description: "URI of an open marimo notebook, e.g. file:///path/to/notebook.py",
  },
} as const;

const CELL_IDX_PARAM = {
  cellIdx: { type: "integer", minimum: 0 },
} as const;

const TOOLS: ToolDef[] = [
  {
    name: "notebook_list_cells",
    description: "List all cells in a notebook with index, code, etag, executionSummary, timing, and outputs.",
    inputSchema: { type: "object", required: ["notebookUri"], properties: { ...NOTEBOOK_URI_PARAM } },
    annotations: READ,
  },
  {
    name: "notebook_cell_outputs",
    description: "Get a cell's outputs with binary fidelity. Each item has mime + (data | data_b64). Image mimes are also emitted as native MCP image content for inline rendering.",
    inputSchema: { type: "object", required: ["notebookUri", "cellIdx"], properties: { ...NOTEBOOK_URI_PARAM, ...CELL_IDX_PARAM } },
    annotations: READ,
  },
  {
    name: "notebook_editor_state",
    description: "Returns selected cell indices, active cell, and cell tags for the active notebook editor.",
    inputSchema: { type: "object", properties: { ...NOTEBOOK_URI_PARAM } },
    annotations: READ,
  },
  {
    name: "notebook_resolve_path",
    description: "Resolve a filesystem path to its open notebook URI.",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    annotations: READ,
  },
  {
    name: "notebook_list_sessions",
    description: "List active marimo notebook sessions (marimo-pair compatible). Returns a map of notebookUri to {filename}.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "notebook_open",
    description: "Open a marimo notebook. Idempotent: returns alreadyOpen=true if the notebook is already open.",
    inputSchema: { type: "object", required: ["uri"], properties: { uri: { type: "string", format: "uri" } } },
    annotations: MUTATE_IDEMPOTENT,
  },
  {
    name: "notebook_create_cell",
    description: "Create a new cell. Defaults to a code cell appended at the end of the notebook.",
    inputSchema: {
      type: "object",
      required: ["notebookUri", "code"],
      properties: {
        ...NOTEBOOK_URI_PARAM,
        code: { type: "string" },
        kind: { type: "string", enum: ["code", "markup"], default: "code" },
        languageId: { type: "string" },
        index: { type: "integer", minimum: 0 },
      },
    },
    annotations: MUTATE_NONIDEMPOTENT,
  },
  {
    name: "notebook_edit_cell",
    description: "Replace a cell's code. Pass `expectedEtag` for optimistic-concurrency protection — call fails with isError + currentEtag if the cell changed since you last read it. Idempotent when guarded by etag.",
    inputSchema: {
      type: "object",
      required: ["notebookUri", "cellIdx", "code"],
      properties: {
        ...NOTEBOOK_URI_PARAM,
        ...CELL_IDX_PARAM,
        code: { type: "string" },
        expectedEtag: { type: "string", pattern: "^[0-9a-f]{8}$" },
      },
    },
    annotations: MUTATE_IDEMPOTENT,
  },
  {
    name: "notebook_delete_cell",
    description: "Delete a cell. Pass `expectedEtag` for optimistic-concurrency protection.",
    inputSchema: {
      type: "object",
      required: ["notebookUri", "cellIdx"],
      properties: {
        ...NOTEBOOK_URI_PARAM,
        ...CELL_IDX_PARAM,
        expectedEtag: { type: "string", pattern: "^[0-9a-f]{8}$" },
      },
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
  },
  {
    name: "notebook_run_cell",
    description: "Queue a cell for execution. Returns once queued (not when the cell finishes). Subscribe to the HTTP /events SSE stream for completion.",
    inputSchema: {
      type: "object",
      required: ["notebookUri", "cellIdx"],
      properties: { ...NOTEBOOK_URI_PARAM, ...CELL_IDX_PARAM },
    },
    annotations: RUN,
  },
  {
    name: "notebook_scratchpad_execute",
    description: "Execute scratchpad code against the notebook's kernel. Returns stdout, stderr, and a final success/error summary as multiple MCP content items.",
    inputSchema: {
      type: "object",
      required: ["notebookUri", "code"],
      properties: { ...NOTEBOOK_URI_PARAM, code: { type: "string" } },
    },
    annotations: RUN,
  },
  {
    name: "notebook_kernel_interrupt",
    description: "Cancel any in-flight cell execution on the notebook's kernel.",
    inputSchema: {
      type: "object",
      required: ["notebookUri"],
      properties: { ...NOTEBOOK_URI_PARAM },
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
  },
];

export async function handleMcpRequest(body: unknown): Promise<JsonRpcResponse | null> {
  // Notifications (no `id`) get null back so the HTTP layer knows to 204.
  const req = body as JsonRpcRequest;
  const id = req?.id ?? null;
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "invalid request" },
    };
  }

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };

    case "notifications/initialized":
      return null;  // notifications get no response

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (typeof params?.name !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "missing params.name" },
        };
      }
      const callResult = await callTool(params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id, result: callResult };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown method: ${req.method}` },
      };
  }
}
