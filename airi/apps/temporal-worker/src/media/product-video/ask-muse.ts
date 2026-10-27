import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import {
  createMetaResponse,
  getMetaModels,
  metaResponseText,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";

export type AskMuseDeps = {
  createMetaResponse?: typeof createMetaResponse;
  onCost?: (usd: number, what: string) => void;
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
  const response = await (deps.createMetaResponse ?? createMetaResponse)(
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
  return JSON.parse(metaResponseText(response)) as T;
}
