/** JSON-RPC-style requests in both directions over a WebSocket */
import type WebSocket from "ws";

export const TOOL_CALL_TIMEOUT_MS = 5 * 60_000;

type RpcMessage =
  | { id: number; method: string; params?: unknown }
  | { id: number; result: unknown }
  | { id: number; error: { message: string } };

export type RpcHandlers<M> = {
  [K in keyof M]: M[K] extends { params: infer P; result: infer R } ? (params: P) => Promise<R> : never;
};

export class RpcPeer<Outgoing, Incoming> {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly handlers: Partial<RpcHandlers<Incoming>>,
    private readonly onClose?: () => void,
  ) {
    socket.on("message", (data) => void this.onMessage(data.toString()));
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());
  }

  get open(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  request<K extends keyof Outgoing & string>(
    method: K,
    params: Outgoing[K] extends { params: infer P } ? P : never,
    options: { timeoutMs?: number } = {},
  ): Promise<Outgoing[K] extends { result: infer R } ? R : never> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(new Error("Connection closed"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Connection closed"));
    }
    this.pending.clear();
    if (this.socket.readyState === this.socket.OPEN) this.socket.close();
    this.onClose?.();
  }

  private async onMessage(text: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(text) as RpcMessage;
    } catch {
      return;
    }
    if ("method" in message) {
      const handler = (this.handlers as Record<string, ((params: unknown) => Promise<unknown>) | undefined>)[message.method];
      try {
        if (!handler) throw new Error(`Unknown method ${message.method}`);
        this.reply({ id: message.id, result: await handler(message.params) });
      } catch (error) {
        this.reply({ id: message.id, error: { message: errorMessage(error) } });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private reply(message: RpcMessage) {
    if (this.open) this.socket.send(JSON.stringify(message));
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
