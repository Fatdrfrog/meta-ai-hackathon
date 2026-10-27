import type { CSSProperties } from "react";

import {
  getKBObjectResizeHandleClassName,
  getKBObjectSelectionClassNames,
} from "@/lib/kb/kb-object-controls";
import { cn } from "@/lib/utils";

const SAFE_IMAGE_DIMENSION =
  /^\d+(?:\.\d+)?(?:px|%|rem|em|vw|vh|vmin|vmax|ch)?$/i;

export type ImageDimensionInput = string | null | undefined;
export type KBImageResizeHandle =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const MIN_IMAGE_RESIZE_SIZE = 48;

export const KB_IMAGE_STACKING_CSS = `
  .kb-editor .node-image {
    display: inline-block;
    max-width: 100%;
    margin: 0.5rem 0.75rem 0.5rem 0;
    vertical-align: top;
  }

  .kb-editor .node-image .kb-editor-image-node {
    margin: 0;
  }

  .kb-editor img.kb-editor-image,
  .kb-editor .kb-editor-image-node__image {
    display: block;
    max-width: 100%;
    object-fit: contain;
  }

  .kb-editor img.kb-editor-image:not([style*="height"]),
  .kb-editor .kb-editor-image-node__image:not([style*="height"]) {
    height: auto;
  }

  .kb-editor > img.kb-editor-image,
  .kb-editor p > img.kb-editor-image {
    display: inline-block;
    margin: 0.5rem 0.75rem 0.5rem 0;
    vertical-align: top;
  }
`;

export function normalizeKBImageDimension(
  value: ImageDimensionInput
): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return null;
  }
  if (!SAFE_IMAGE_DIMENSION.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function toCssDimension(value: ImageDimensionInput): string | null {
  const normalized = normalizeKBImageDimension(value);
  if (!normalized) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/i.test(normalized)) {
    return `${normalized}px`;
  }
  return normalized;
}

export function buildKBImageStyleAttribute({
  width,
  height,
}: {
  width?: ImageDimensionInput;
  height?: ImageDimensionInput;
}): string | undefined {
  const styles: string[] = [];
  const cssWidth = toCssDimension(width);
  const cssHeight = toCssDimension(height);

  if (cssWidth) {
    styles.push(`width: ${cssWidth};`);
  }
  if (cssHeight) {
    styles.push(`height: ${cssHeight};`);
  }

  return styles.length > 0 ? styles.join(" ") : undefined;
}

export function buildKBImageCssStyle({
  width,
  height,
}: {
  width?: ImageDimensionInput;
  height?: ImageDimensionInput;
}): CSSProperties {
  const style: CSSProperties = {};
  const cssWidth = toCssDimension(width);
  const cssHeight = toCssDimension(height);

  if (cssWidth) {
    style.width = cssWidth;
  }
  if (cssHeight) {
    style.height = cssHeight;
  }

  return style;
}

export function buildKBImageRenderAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const { width, height, class: className, ...rest } = attributes;
  delete rest.style;
  const normalizedWidth = normalizeKBImageDimension(
    width as ImageDimensionInput
  );
  const normalizedHeight = normalizeKBImageDimension(
    height as ImageDimensionInput
  );
  const style = buildKBImageStyleAttribute({
    width: normalizedWidth,
    height: normalizedHeight,
  });

  return {
    ...rest,
    class: cn("kb-editor-image", className as string | undefined),
    ...(normalizedWidth ? { "data-width": normalizedWidth } : {}),
    ...(normalizedHeight ? { "data-height": normalizedHeight } : {}),
    ...(style ? { style } : {}),
  };
}

export function calculateKBImageResize({
  handle,
  startWidth,
  startHeight,
  deltaX,
  deltaY,
  minWidth = MIN_IMAGE_RESIZE_SIZE,
  minHeight = MIN_IMAGE_RESIZE_SIZE,
}: {
  handle: KBImageResizeHandle;
  startWidth: number;
  startHeight: number;
  deltaX: number;
  deltaY: number;
  minWidth?: number;
  minHeight?: number;
}): { width: string; height: string } {
  const growsRight = handle.endsWith("right");
  const growsDown = handle.startsWith("bottom");
  const nextWidth = Math.max(
    minWidth,
    Math.round(startWidth + (growsRight ? deltaX : -deltaX))
  );
  const nextHeight = Math.max(
    minHeight,
    Math.round(startHeight + (growsDown ? deltaY : -deltaY))
  );

  return {
    width: `${nextWidth}px`,
    height: `${nextHeight}px`,
  };
}

export function getKBImageResizeHandleClassName(
  handle: KBImageResizeHandle
): string {
  return getKBObjectResizeHandleClassName(
    handle,
    "kb-editor-image-resize-handle group-hover:block group-focus-within:block"
  );
}

export function getKBImageResizeControlClassNames() {
  const objectControls = getKBObjectSelectionClassNames();

  return {
    node: "kb-editor-image-node group relative m-0 w-fit max-w-full",
    image:
      "kb-editor-image-node__image block max-w-full cursor-grab rounded-md border border-transparent active:cursor-grabbing",
    selectedImage: "",
    frame: cn(
      objectControls.frame,
      "group-hover:block group-focus-within:block"
    ),
    quickAction: cn(
      objectControls.quickAction,
      "group-hover:flex group-focus-within:flex"
    ),
    visible: objectControls.visible,
    visibleFlex: objectControls.visibleFlex,
    resizeHandle:
      "kb-editor-image-resize-handle kb-editor-object-resize-handle pointer-events-auto absolute z-20 hidden size-4 rounded-full border-2 border-[#8b5cf6] bg-background shadow-sm ring-2 ring-background",
    reset: "inline-flex items-center justify-center",
  } as const;
}
