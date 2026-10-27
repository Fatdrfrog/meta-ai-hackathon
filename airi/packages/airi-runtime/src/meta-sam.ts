import {
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  ResponsesStreamError,
  ResponsesStreamRefusalError,
  type ImageSegmentationResult,
  type ResponseStreamOutcome,
  type SegmentationMaskRecord,
  type SegmentationRecord,
  type VideoSegmentationResult,
} from "@meta-sam/parser";
import {
  getMetaModels,
  META_SAM_IMAGE_COST_USD,
  MetaModelApiError,
  metaSamVideoCostUsd,
  streamMetaResponse,
  type MetaRequestOptions,
} from "./meta-model-api";

// SAM 3.1 through the Responses API. A prompt is either one short noun phrase
// ("pink toy phone"; SAM handles lists and negation poorly) or an object
// prompt from `buildObjectPrompt` that marks one object with a box.

export {
  buildObjectPrompt,
  decodeMaskToRaster,
  frameIndexOf,
  recordsOfKind,
  type ImageSegmentationResult,
  type SegmentationMaskRecord,
  type SegmentationRecord,
  type VideoSegmentationResult,
} from "@meta-sam/parser";

function samRequest(prompt: string, media: Record<string, string>) {
  return {
    model: getMetaModels().sam,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }, media],
      },
    ],
    metadata: { include_confidence: "true" },
  };
}

/**
 * Drains a parsed SAM stream into its final result. The parser wraps whatever
 * the stream throws, so the client's own error is unwrapped to keep its
 * `transient` flag, and a stream that stopped early is an error a retry may
 * fix rather than an empty result that looks like "nothing found".
 */
async function finish<Result extends { outcome: ResponseStreamOutcome }>(
  parsed: AsyncIterable<unknown> & { finalResult: Promise<Result> },
): Promise<Result> {
  let result: Result;
  try {
    for await (const _snapshot of parsed) {
      // Drain the stream; the final result holds every record.
    }
    result = await parsed.finalResult;
  } catch (error) {
    if (error instanceof ResponsesStreamError) {
      if (error.cause instanceof MetaModelApiError) throw error.cause;
      throw new MetaModelApiError(
        error instanceof ResponsesStreamRefusalError
          ? {
              kind: "invalid_request",
              transient: false,
              code: "refusal",
              message: error.message,
            }
          : {
              kind: "server",
              transient: true,
              code: error.code,
              message: `SAM's answer couldn't be read: ${error.message}`,
            },
      );
    }
    throw error;
  }
  if (result.outcome.status !== "completed") {
    throw new MetaModelApiError({
      kind: "server",
      transient: true,
      code: `incomplete_${result.outcome.reason}`,
      message: `SAM's answer stopped early${result.outcome.detail ? `: ${result.outcome.detail}` : ""}`,
    });
  }
  return result;
}

export async function segmentMetaImage(
  request: {
    /** A public URL or a data URL such as `data:image/jpeg;base64,...`. */
    imageUrl: string;
    prompt: string;
  },
  options?: MetaRequestOptions,
): Promise<{ result: ImageSegmentationResult; costUsd: number }> {
  const result = await finish(
    parseImageStream(
      streamMetaResponse(
        samRequest(request.prompt, {
          type: "input_image",
          image_url: request.imageUrl,
        }),
        options,
      ),
    ),
  );
  return { result, costUsd: META_SAM_IMAGE_COST_USD };
}

/** Tracks through a video uploaded with `uploadMetaFile`; billed per frame. */
export async function segmentMetaVideo(
  request: { fileId: string; prompt: string; frameCount: number },
  options?: MetaRequestOptions,
): Promise<{ result: VideoSegmentationResult; costUsd: number }> {
  const result = await finish(
    parseVideoStream(
      streamMetaResponse(
        samRequest(request.prompt, {
          type: "input_video",
          file_id: request.fileId,
        }),
        options,
      ),
    ),
  );
  return { result, costUsd: metaSamVideoCostUsd(request.frameCount) };
}

/** The mask SAM is most confident about; on a tie, the larger one. */
export function bestMetaSamMask(
  records: readonly SegmentationRecord[],
): SegmentationMaskRecord | undefined {
  const area = (mask: SegmentationMaskRecord) =>
    (mask.bounds.right - mask.bounds.left) *
    (mask.bounds.bottom - mask.bounds.top);
  let best: SegmentationMaskRecord | undefined;
  for (const mask of recordsOfKind(records, "mask")) {
    if (!best) {
      best = mask;
      continue;
    }
    const diff = (mask.confidence ?? 0) - (best.confidence ?? 0);
    if (diff > 0 || (diff === 0 && area(mask) > area(best))) best = mask;
  }
  return best;
}
