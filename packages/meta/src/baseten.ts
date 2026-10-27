import { requirePrice, tokenCostUsd, type SpendLedger } from "./budget.ts";
import { ApiError } from "./errors.ts";

// Muse Spark Open, Meta's open-weight model, served by Baseten through an OpenAI-compatible API.
export interface BasetenConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export function loadBasetenConfig(env: NodeJS.ProcessEnv = process.env): BasetenConfig {
  const apiKey = env.BASETEN_API_KEY;
  if (!apiKey) throw new Error("BASETEN_API_KEY is not set. Add your Baseten API key to .env.");
  return {
    apiKey,
    baseUrl: env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
    // The hackathon ID; Baseten's own docs show meta-models/muse-spark-open, which is wrong here.
    model: env.BASETEN_MODEL ?? "meta-models/muse-spark-open-1026",
  };
}

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatCompletionJson {
  readonly choices: readonly {
    readonly message: { readonly content: string | null; readonly tool_calls?: readonly ToolCall[] | null };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
  };
}

export interface BasetenClient {
  readonly config: BasetenConfig;
  chatCompletion(body: { readonly messages: readonly unknown[]; readonly [field: string]: unknown }): Promise<ChatCompletionJson>;
}

export function createBasetenClient(config: BasetenConfig, ledger: SpendLedger): BasetenClient {
  return {
    config,
    async chatCompletion(body) {
      requirePrice(config.model);
      ledger.assertCanSpend(0, config.model);
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, ...body }),
      });
      if (!res.ok) throw new ApiError("Baseten", "/chat/completions", res.status, await res.text());
      const json = (await res.json()) as ChatCompletionJson;
      if (json.usage) {
        const usd = tokenCostUsd(config.model, {
          input_tokens: json.usage.prompt_tokens,
          output_tokens: json.usage.completion_tokens,
          input_tokens_details: { cached_tokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0 },
        });
        ledger.record({ model: config.model, usd, note: "chat completion" });
      }
      return json;
    },
  };
}

export function messageText(json: ChatCompletionJson): string {
  return json.choices[0]?.message.content ?? "";
}
