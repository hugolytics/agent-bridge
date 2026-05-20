/**
 * Hand-rolled JSON-RPC 2.0 dispatcher exposing the bridge as an MCP server
 * over Streamable HTTP (POST /mcp). No `@modelcontextprotocol/sdk` dep —
 * keeps the bridge zero-runtime-deps for vendoring. Spec:
 * https://modelcontextprotocol.io/specification/2025-06-18
 */

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
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return {
      jsonrpc: "2.0",
      id: req?.id ?? null,
      error: { code: -32600, message: "invalid request" },
    };
  }

  const id = req.id ?? null;

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

    case "tools/call":
      // Filled in Chunk 3.
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "tools/call not implemented yet" },
      };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown method: ${req.method}` },
      };
  }
}
