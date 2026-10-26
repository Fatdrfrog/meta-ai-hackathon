import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requirePrice, tokenCostUsd, type SpendLedger, type TokenUsage } from "./budget.ts";
import type { MetaConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { readSseData } from "./sse.ts";

export interface ResponseRequest {
  readonly model: string;
  readonly input: unknown;
  readonly [field: string]: unknown;
}

export interface ResponseJson {
  readonly id: string;
  readonly status: string;
  readonly output: readonly {
    readonly type: string;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
  }[];
  readonly usage?: TokenUsage;
}

export interface StreamEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface MetaClient {
  readonly config: MetaConfig;
  readonly ledger: SpendLedger;
  uploadFile(path: string, mimeType: string): Promise<{ id: string }>;
  /** Token-billed call; usage is charged to the ledger from the response. */
  createResponse(body: ResponseRequest): Promise<ResponseJson>;
  /** Fixed-price streaming call (SAM bills per frame); `costUsd` is checked first and charged once the request is accepted. */
  streamResponse(body: ResponseRequest, costUsd: number): AsyncGenerator<StreamEvent>;
}

// The API occasionally answers with a 5xx HTML page; a short retry gets through.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 2000];

export function createMetaClient(config: MetaConfig, ledger: SpendLedger): MetaClient {
  async function post(path: string, init: { headers?: Record<string, string>; body: BodyInit }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, ...init.headers },
        body: init.body,
      });
      if (res.ok) return res;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RETRY_STATUSES.has(res.status)) {
        throw new ApiError("Meta Model API", path, res.status, await res.text());
      }
      await res.body?.cancel();
      await sleep(delay);
    }
  }

  return {
    config,
    ledger,

    async uploadFile(path, mimeType) {
      const form = new FormData();
      form.set("purpose", "user_data");
      form.set("file", await openAsBlob(path, { type: mimeType }), basename(path));
      const res = await post("/files", { body: form });
      return (await res.json()) as { id: string };
    },

    async createResponse(body) {
      requirePrice(body.model);
      ledger.assertCanSpend(0, body.model);
      const res = await post("/responses", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ResponseJson;
      if (json.usage) {
        ledger.record({ model: body.model, usd: tokenCostUsd(body.model, json.usage), note: "response" });
      }
      return json;
    },

    async *streamResponse(body, costUsd) {
      ledger.assertCanSpend(costUsd, body.model);
      const res = await post("/responses", {
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
      });
      // The request is billed once accepted, even if the reader stops early.
      ledger.record({ model: body.model, usd: costUsd, note: "stream" });
      if (!res.body) return;
      for await (const data of readSseData(res.body)) {
        if (data === "[DONE]") return;
        yield JSON.parse(data) as StreamEvent;
      }
    },
  };
}

export function outputText(response: ResponseJson): string {
  return response.output
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}
