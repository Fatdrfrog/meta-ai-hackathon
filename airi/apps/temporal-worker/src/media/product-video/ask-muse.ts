import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import {
  createMetaResponse,
  getMetaModels,
  MetaModelApiError,
  metaResponseText,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import { whilePulsing } from "./pulse";

export type AskMuseDeps = {
  createMetaResponse?: typeof createMetaResponse;
  onCost?: (usd: number, what: string) => void;
  /** Called while a model call runs, so a Temporal activity can heartbeat. */
  pulse?: () => void;
};

/** One quick Muse Spark question about images, answered as JSON in `schema`. */
export async function askMuseAboutImages<T>(
  request: {
    /** JPEG images, in the order the question refers to them. */
    images: Buffer[];
    question: string;
    schema: object;
    /** Names the call in cost records. */
    purpose: string;
  },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<T> {
  const model = getMetaModels().museSpark;
  const response = await whilePulsing(deps.pulse, () =>
    (deps.createMetaResponse ?? createMetaResponse)(
      {
        model,
        reasoning: { effort: "low" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              ...request.images.map((image) => ({
                type: "input_image",
                image_url: `data:image/jpeg;base64,${image.toString("base64")}`,
              })),
              { type: "input_text", text: request.question },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "answer",
            strict: true,
            schema: request.schema,
          },
        },
        max_output_tokens: 3000,
      },
      options,
    ),
  );
  deps.onCost?.(
    estimateLlmCostUsd({
      model,
      promptTokens: response.usage?.input_tokens,
      completionTokens: response.usage?.output_tokens,
      cachedPromptTokens: response.usage?.input_tokens_details?.cached_tokens,
    }).totalCostUsd,
    request.purpose,
  );
  try {
    return JSON.parse(metaResponseText(response)) as T;
  } catch {
    throw new MetaModelApiError({
      kind: "server",
      transient: true,
      code: "invalid_json",
      message: `Muse Spark's answer (${request.purpose}) wasn't valid JSON`,
    });
  }
}
