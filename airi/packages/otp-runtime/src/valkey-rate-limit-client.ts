import net from "node:net";
import tls from "node:tls";

import { parseEnvFlag as readEnvBoolean } from "@icecore/shared/lib/env";

type ValkeyResponse = string | number | null;

export type ValkeyRateLimitClientOptions = {
  host: string;
  port?: number;
  password?: string | null;
  tls?: boolean;
  timeoutMs?: number;
};

function encodeCommand(parts: string[]): string {
  return parts
    .reduce<string[]>(
      (lines, part) => {
        const byteLength = Buffer.byteLength(part);
        lines.push(`$${byteLength}`, part);
        return lines;
      },
      [`*${parts.length}`]
    )
    .join("\r\n")
    .concat("\r\n");
}

function parseResponse(buffer: Buffer): ValkeyResponse {
  const raw = buffer.toString("utf8");
  const prefix = raw[0];
  const body = raw.slice(1);
  const lineEnd = body.indexOf("\r\n");
  const line = lineEnd >= 0 ? body.slice(0, lineEnd) : body;

  if (prefix === "+") return line;
  if (prefix === ":") return Number.parseInt(line, 10);
  if (prefix === "-") throw new Error(line);
  if (prefix === "$") {
    const length = Number.parseInt(line, 10);
    if (length < 0) return null;
    const start = 1 + line.length + 2;
    return raw.slice(start, start + length);
  }

  throw new Error("Unsupported Valkey response");
}

export class ValkeyRateLimitClient {
  private host: string;
  private port: number;
  private password: string | null;
  private useTls: boolean;
  private timeoutMs: number;

  constructor(options: ValkeyRateLimitClientOptions) {
    this.host = options.host;
    this.port = options.port || 6379;
    this.password = options.password?.trim() || null;
    this.useTls = options.tls === true;
    this.timeoutMs = Math.max(100, options.timeoutMs || 750);
  }

  async setNxEx(key: string, value: string, seconds: number): Promise<boolean> {
    const result = await this.sendCommand([
      "SET",
      key,
      value,
      "NX",
      "EX",
      String(seconds),
    ]);
    return result === "OK";
  }

  async incr(key: string): Promise<number> {
    const result = await this.sendCommand(["INCR", key]);
    if (typeof result !== "number" || Number.isNaN(result)) {
      throw new Error("Valkey INCR returned a non-integer response");
    }
    return result;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.sendCommand(["EXPIRE", key, String(seconds)]);
  }

  private async sendCommand(command: string[]): Promise<ValkeyResponse> {
    const socket = await this.openSocket();
    try {
      if (this.password) {
        await this.sendRaw(socket, ["AUTH", this.password]);
      }
      return await this.sendRaw(socket, command);
    } finally {
      socket.destroy();
    }
  }

  private openSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = this.useTls
        ? tls.connect({ host: this.host, port: this.port })
        : net.connect({ host: this.host, port: this.port });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Valkey connection timed out"));
      }, this.timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setTimeout(this.timeoutMs);
        resolve(socket);
      });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private sendRaw(
    socket: net.Socket | tls.TLSSocket,
    command: string[]
  ): Promise<ValkeyResponse> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("utf8");
        if (!text.includes("\r\n")) return;
        cleanup();
        try {
          resolve(parseResponse(buffer));
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error("Valkey command timed out"));
      };
      const onClosed = () => {
        cleanup();
        reject(new Error("Valkey connection closed"));
      };
      const cleanup = () => {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
        socket.removeListener("close", onClosed);
        socket.removeListener("end", onClosed);
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.once("close", onClosed);
      socket.once("end", onClosed);
      socket.write(encodeCommand(command));
    });
  }
}

export function createValkeyRateLimitClientFromEnv(): ValkeyRateLimitClient | null {
  const host = String(
    process.env.MEMORYSTORE_VALKEY_HOST || process.env.VALKEY_HOST || ""
  ).trim();
  if (!host) return null;
  const port = Number.parseInt(
    String(
      process.env.MEMORYSTORE_VALKEY_PORT || process.env.VALKEY_PORT || ""
    ),
    10
  );
  const timeoutMs = Number.parseInt(
    String(process.env.MEMORYSTORE_VALKEY_TIMEOUT_MS || ""),
    10
  );
  return new ValkeyRateLimitClient({
    host,
    port: Number.isFinite(port) ? port : 6379,
    password:
      process.env.MEMORYSTORE_VALKEY_AUTH_TOKEN ||
      process.env.VALKEY_AUTH_TOKEN ||
      null,
    tls: readEnvBoolean(
      process.env.MEMORYSTORE_VALKEY_TLS || process.env.VALKEY_TLS
    ),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 750,
  });
}

export function encodeValkeyCommandForTests(parts: string[]): string {
  return encodeCommand(parts);
}

export function parseValkeyResponseForTests(buffer: Buffer): ValkeyResponse {
  return parseResponse(buffer);
}
