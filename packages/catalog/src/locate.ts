import { readFileSync } from "node:fs";
import { outputText, type MetaClient } from "@vitrina/meta";
import type { Box } from "./masks.ts";

const dataUrl = (path: string) => `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;

async function askJson<T>(meta: MetaClient, image: string, text: string, schema: object): Promise<T> {
  const response = await meta.createResponse({
    model: meta.config.models.spark,
    reasoning: { effort: "low" },
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl(image) }, { type: "input_text", text }] }],
    text: { format: { type: "json_schema", name: "answer", strict: true, schema } },
    max_output_tokens: 3000,
  });
  return JSON.parse(outputText(response)) as T;
}

/** Muse Spark chooses which numbered frame of a grid shows the product best. Returns a 0-based index. */
export async function pickFrame(meta: MetaClient, gridPath: string, count: number, product: string): Promise<number> {
  const answer = await askJson<{ best: number }>(
    meta,
    gridPath,
    `These are ${count} numbered frames from a video in which a shop owner shows a ${product}. Which frame shows the whole ${product} most clearly: in view and not cut off, sharp, and least covered by the hand?`,
    { type: "object", additionalProperties: false, required: ["best"], properties: { best: { type: "integer" } } },
  );
  return Math.min(count - 1, Math.max(0, Math.round(answer.best) - 1));
}

export interface NormalizedBox {
  readonly visible: boolean;
  readonly x_min: number;
  readonly y_min: number;
  readonly x_max: number;
  readonly y_max: number;
}

/** A 0-1000 box from the model in frame pixels, or null when it is missing or too small to track. */
export function boxInPixels(box: NormalizedBox, width: number, height: number): Box | null {
  if (!box.visible) return null;
  const px = (v: number, size: number) => Math.min(size, Math.max(0, Math.round((v / 1000) * size)));
  const result = { left: px(box.x_min, width), top: px(box.y_min, height), right: px(box.x_max, width), bottom: px(box.y_max, height) };
  return result.right - result.left >= 8 && result.bottom - result.top >= 8 ? result : null;
}

// Asked on one full-size frame: inside a grid, the model answers in the grid's coordinates.
export async function boxProduct(meta: MetaClient, framePath: string, product: string, width: number, height: number): Promise<Box | null> {
  const answer = await askJson<NormalizedBox>(
    meta,
    framePath,
    `Give the bounding box of the ${product} in this photo, normalized to 0-1000 (x across, y down), tight around the object itself, not the hand holding it. visible=false if it is not in the photo.`,
    {
      type: "object",
      additionalProperties: false,
      required: ["visible", "x_min", "y_min", "x_max", "y_max"],
      properties: {
        visible: { type: "boolean" },
        x_min: { type: "number" },
        y_min: { type: "number" },
        x_max: { type: "number" },
        y_max: { type: "number" },
      },
    },
  );
  return boxInPixels(answer, width, height);
}
