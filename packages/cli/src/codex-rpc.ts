// Minimal JSON-RPC client for Codex's experimental "app-server" daemon, which listens on a
// Unix domain socket and speaks JSON-RPC tunneled over the WebSocket wire protocol (RFC 6455).
//
// The exact method sequence and message shapes below (initialize/initialized, thread/resume,
// thread/read, thread/queue/add, thread/queue/start) mirror the reference implementation at
// github.com/LawrentChen/codex_callback (Python, MIT) — specifically its
// codex_callback/client.py and codex_callback/delivery.py — rather than inventing new ones,
// since a wrong method name or param shape fails silently against a real daemon.
//
// Uses the `ws` package rather than hand-rolling WebSocket framing. `ws` connects over a Unix
// domain socket via the `ws+unix:<socket path>:<url path>` address form (see its docs); the
// socket path and URL path are split on the first `:` after the `ws+unix:` scheme.
import WebSocket from "ws";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const { version: KINGPOST_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 20000;

/** `$CODEX_HOME/app-server-control/app-server-control.sock`, respecting the `CODEX_HOME` env
 * var override (defaults to `~/.codex`), matching the `join(homedir(), ".codex", ...)` pattern
 * already used elsewhere in this codebase (see doctor.ts). */
export function codexAppServerSocketPath(codexHome: string = process.env.CODEX_HOME || join(homedir(), ".codex")): string {
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** A single request/response JSON-RPC connection to the app-server daemon. Not reusable across
 * threads/sessions — create one per `kingpost watch` invocation. */
export class CodexRpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private socketPath: string) {}

  /** Connects, completes the WebSocket handshake over the Unix socket, then performs the
   * daemon's own handshake: an `initialize` request followed by an `initialized` notification
   * (exact sequence per codex_callback's `CodexClient.__enter__`). */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws+unix:${this.socketPath}:/`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("timed out connecting to codex app-server daemon"));
      }, CONNECT_TIMEOUT_MS);
      ws.once("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("message", (data) => this.handleMessage(data));
    });

    await this.request("initialize", {
      clientInfo: { name: "kingpost", version: KINGPOST_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return; // malformed frame — nothing to correlate it to, drop it
    }
    // Responses carry the request's id and no method; notifications (turn/completed,
    // thread/status/changed, etc.) carry a method and no id we're waiting on — this client
    // only needs request/response correlation, so notifications are otherwise ignored.
    if (message.id === undefined || message.method !== undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`codex rpc error: ${JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("codex rpc client not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex rpc request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  notify(method: string): void {
    this.ws?.send(JSON.stringify({ method }));
  }

  close(): void {
    this.ws?.close();
  }
}
