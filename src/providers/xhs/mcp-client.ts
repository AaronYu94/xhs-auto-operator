/**
 * Minimal MCP (Model Context Protocol) client for the streamable-HTTP transport.
 *
 * Scope: exactly what the Xiaohongshu provider needs — `initialize` (+ `notifications/initialized`),
 * `tools/list` and `tools/call` — over JSON-RPC 2.0 HTTP POST. Responses may be plain JSON or an
 * SSE stream (`text/event-stream`, `data:` lines). Stateless servers that do not require (or do
 * not implement) `initialize` are tolerated. Every failure surfaces as a typed `McpError`.
 *
 * xiaohongshu-mcp launches a headless browser per tool call, so the default timeout is generous.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_MCP_TIMEOUT_MS = 120_000;

export type McpErrorKind = 'network' | 'timeout' | 'http' | 'rpc' | 'tool';

export class McpError extends Error {
  readonly kind: McpErrorKind;
  /** HTTP status for kind 'http' */
  readonly status: number | null;
  /** JSON-RPC error code for kind 'rpc' */
  readonly code: number | null;
  readonly data: unknown;
  /**
   * JSON-RPC method of the HTTP exchange that failed ('initialize', 'tools/list', 'tools/call', …), or null.
   * Lets callers tell "the tool call never left this process" (safe to retry a write) from
   * "the tools/call request may have reached the server" (outcome unknown).
   */
  readonly method: string | null;

  constructor(
    kind: McpErrorKind,
    message: string,
    extra: { status?: number; code?: number; data?: unknown; cause?: unknown; method?: string } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'McpError';
    this.kind = kind;
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.data = extra.data;
    this.method = extra.method ?? null;
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}
export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}
export interface McpOtherContent {
  type: string;
  [key: string]: unknown;
}
export type McpContent = McpTextContent | McpImageContent | McpOtherContent;

export interface McpToolResult {
  content: McpContent[];
  isError: boolean;
  /** all text content blocks joined with '\n' */
  text: string;
  structuredContent?: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string | null;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, unknown>;
}

export interface McpHttpClientOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const truncateText = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Parse a `text/event-stream` body into the JSON payloads of its `data:` fields (one per event). */
export function parseSseMessages(body: string): unknown[] {
  const out: unknown[] = [];
  const events = body.replace(/\r\n?/g, '\n').split(/\n\n+/);
  for (const event of events) {
    const dataLines: string[] = [];
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Non-JSON SSE data (e.g. keep-alive text) is ignored.
    }
  }
  return out;
}

/** Decode an HTTP body (JSON, JSON batch or SSE) into JSON-RPC messages. */
export function decodeRpcBody(body: string, contentType: string | null): JsonRpcResponse[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const looksSse = (contentType ?? '').includes('text/event-stream') || /^(event|data|id|retry):/m.test(trimmed.slice(0, 200));
  let messages: unknown[];
  if (looksSse && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    messages = parseSseMessages(trimmed);
  } else {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      if (looksSse) messages = parseSseMessages(trimmed);
      else throw new McpError('rpc', `invalid JSON-RPC response body: ${truncateText(trimmed)}`, { cause: err });
    }
  }
  return messages.filter(isObject) as JsonRpcResponse[];
}

export class McpHttpClient {
  readonly url: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private nextId = 1;
  private session: string | null = null;
  private initialized = false;
  private initializing: Promise<McpInitializeResult | null> | null = null;
  private serverInfo: McpInitializeResult | null = null;

  constructor(opts: McpHttpClientOptions) {
    if (!opts.url || !/^https?:\/\//i.test(opts.url)) throw new McpError('network', `invalid MCP endpoint url: ${opts.url}`);
    this.url = opts.url;
    this.token = opts.token || undefined;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    this.clientName = opts.clientName ?? 'xhs-auto-operator';
    this.clientVersion = opts.clientVersion ?? '1.0.0';
  }

  /** Session id echoed back to the server (null for stateless servers). */
  get sessionId(): string | null {
    return this.session;
  }

  /** Result of the last successful initialize (null when the server is stateless / skipped it). */
  get server(): McpInitializeResult | null {
    return this.serverInfo;
  }

  /**
   * Perform the MCP handshake once. Servers that reject `initialize` as unknown/unsupported
   * (JSON-RPC -32601, HTTP 404/405) are treated as stateless and used without a session.
   * Network/timeout failures propagate so callers can report the endpoint as unreachable.
   */
  async initialize(): Promise<McpInitializeResult | null> {
    if (this.initialized) return this.serverInfo;
    if (!this.initializing) {
      this.initializing = this.doInitialize().finally(() => {
        this.initializing = null;
      });
    }
    return this.initializing;
  }

  private async doInitialize(): Promise<McpInitializeResult | null> {
    try {
      const result = await this.rawRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      });
      const r = isObject(result) ? result : {};
      this.serverInfo = {
        protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion : null,
        serverInfo: isObject(r.serverInfo) ? (r.serverInfo as { name?: string; version?: string }) : null,
        capabilities: isObject(r.capabilities) ? r.capabilities : {},
      };
      this.initialized = true;
      try {
        await this.rawNotify('notifications/initialized', {});
      } catch (err) {
        // Some stateless servers answer notifications with 4xx; the session is still usable.
        if (err instanceof McpError && (err.kind === 'network' || err.kind === 'timeout')) throw err;
      }
      return this.serverInfo;
    } catch (err) {
      if (err instanceof McpError && this.isUnsupportedInitialize(err)) {
        this.initialized = true;
        this.serverInfo = null;
        this.session = null;
        return null;
      }
      throw err;
    }
  }

  private isUnsupportedInitialize(err: McpError): boolean {
    if (err.kind === 'rpc') return err.code === -32601 || err.code === -32600;
    if (err.kind === 'http') return err.status === 404 || err.status === 405 || err.status === 400;
    return false;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!isObject(result) || !Array.isArray(result.tools)) {
        throw new McpError('rpc', 'tools/list returned no tools array', { method: 'tools/list' });
      }
      for (const t of result.tools) {
        if (isObject(t) && typeof t.name === 'string') {
          tools.push({
            name: t.name,
            description: typeof t.description === 'string' ? t.description : undefined,
            inputSchema: isObject(t.inputSchema) ? t.inputSchema : undefined,
          });
        }
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** Call a tool. A result with `isError: true` throws McpError(kind 'tool') carrying the tool's text. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    if (!isObject(result)) throw new McpError('rpc', `tools/call ${name} returned no result object`, { method: 'tools/call' });
    const content: McpContent[] = Array.isArray(result.content)
      ? (result.content.filter((c) => isObject(c) && typeof c.type === 'string') as McpContent[])
      : [];
    const text = content
      .filter((c): c is McpTextContent => c.type === 'text' && typeof (c as McpTextContent).text === 'string')
      .map((c) => c.text)
      .join('\n');
    const out: McpToolResult = { content, isError: result.isError === true, text };
    if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent;
    if (out.isError) throw new McpError('tool', text || `tool ${name} reported an error`, { data: out, method: 'tools/call' });
    return out;
  }

  /** JSON-RPC request with lazy handshake and one re-initialize when the server expired our session. */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    try {
      return await this.rawRequest(method, params);
    } catch (err) {
      if (err instanceof McpError && err.kind === 'http' && err.status === 404 && this.session) {
        this.session = null;
        this.initialized = false;
        this.serverInfo = null;
        await this.initialize();
        return this.rawRequest(method, params);
      }
      throw err;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.session) h['mcp-session-id'] = this.session;
    if (this.initialized && this.serverInfo?.protocolVersion) h['mcp-protocol-version'] = this.serverInfo.protocolVersion;
    return h;
  }

  private async post(payload: Record<string, unknown>): Promise<{ status: number; body: string; contentType: string | null }> {
    const method = typeof payload.method === 'string' ? payload.method : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new McpError('timeout', `MCP request timed out after ${this.timeoutMs} ms (${this.url})`, { cause: err, method });
        }
        throw new McpError('network', `MCP endpoint unreachable (${this.url}): ${(err as Error)?.message ?? String(err)}`, {
          cause: err,
          method,
        });
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.session = sid;
      let body: string;
      try {
        body = await res.text();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new McpError('timeout', `MCP response timed out after ${this.timeoutMs} ms (${this.url})`, { cause: err, method });
        }
        throw new McpError('network', `failed reading MCP response: ${(err as Error)?.message ?? String(err)}`, { cause: err, method });
      }
      return { status: res.status, body, contentType: res.headers.get('content-type') };
    } finally {
      clearTimeout(timer);
    }
  }

  private async rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const { status, body, contentType } = await this.post({ jsonrpc: '2.0', id, method, params });
    let messages: JsonRpcResponse[] = [];
    let decodeError: unknown = null;
    try {
      messages = decodeRpcBody(body, contentType);
    } catch (err) {
      decodeError = err;
    }
    const response = messages.find((m) => m.id === id) ?? messages.find((m) => 'result' in m || 'error' in m);
    if (response?.error) {
      throw new McpError('rpc', `${method}: ${response.error.message ?? 'JSON-RPC error'}`, {
        code: typeof response.error.code === 'number' ? response.error.code : undefined,
        data: response.error.data,
        status,
        method,
      });
    }
    if (status < 200 || status >= 300) {
      throw new McpError('http', `${method}: HTTP ${status} ${truncateText(body.trim())}`.trim(), { status, method });
    }
    if (decodeError) {
      const e = decodeError as McpError;
      throw new McpError('rpc', `${method}: ${e.message}`, { cause: e, method });
    }
    if (!response || !('result' in response)) {
      throw new McpError('rpc', `${method}: response contained no JSON-RPC result`, { method });
    }
    return response.result;
  }

  private async rawNotify(method: string, params: Record<string, unknown>): Promise<void> {
    const { status, body } = await this.post({ jsonrpc: '2.0', method, params });
    if (status < 200 || status >= 300) {
      throw new McpError('http', `${method}: HTTP ${status} ${truncateText(body.trim())}`.trim(), { status, method });
    }
  }
}
