"use client";

import { cn } from "@/lib/utils";
import {
  buildKBImageCssStyle,
  buildKBImageRenderAttributes,
  calculateKBImageResize,
  getKBImageResizeControlClassNames,
  getKBImageResizeHandleClassName,
  type KBImageResizeHandle,
  normalizeKBImageDimension,
} from "@/lib/kb/kb-image-dimensions";
import { mergeAttributes } from "@tiptap/core";
import ImageExtension from "@tiptap/extension-image";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

function readImageDimensionFromElement(
  element: HTMLElement,
  name: "width" | "height"
): string | null {
  return normalizeKBImageDimension(
    element.getAttribute(`data-${name}`) ??
      element.getAttribute(name) ??
      element.style[name]
  );
}

function KBImageNodeView({
  node,
  updateAttributes,
  selected,
  editor,
}: NodeViewProps) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const classes = getKBImageResizeControlClassNames();
  const width = (node.attrs.width as string | null) ?? "";
  const height = (node.attrs.height as string | null) ?? "";
  const imageRef = useRef<HTMLImageElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizeResultRef = useRef<{ width: string; height: string } | null>(
    null
  );

  const beginResize = (
    handle: KBImageResizeHandle,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const image = imageRef.current;
    if (!image || !editor.isEditable) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = image.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const updatePreview = () => {
      resizeFrameRef.current = null;
      const next = resizeResultRef.current;
      if (!next || !imageRef.current) return;

      imageRef.current.style.width = next.width;
      imageRef.current.style.height = next.height;
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      resizeResultRef.current = calculateKBImageResize({
        handle,
        startWidth,
        startHeight,
        deltaX: pointerEvent.clientX - startX,
        deltaY: pointerEvent.clientY - startY,
      });

      if (resizeFrameRef.current == null) {
        resizeFrameRef.current = window.requestAnimationFrame(updatePreview);
      }
    };

    const endResize = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", endResize);
      document.removeEventListener("pointercancel", endResize);

      if (resizeFrameRef.current != null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }

      const next = resizeResultRef.current;
      resizeResultRef.current = null;

      if (next) {
        updateAttributes(next);
      }
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", endResize);
    document.addEventListener("pointercancel", endResize);
  };

  return (
    <NodeViewWrapper
      as="figure"
      className={classes.node}
      contentEditable={false}
    >
      <img
        ref={imageRef}
        src={node.attrs.src}
        alt={node.attrs.alt ?? ""}
        title={node.attrs.title ?? undefined}
        className={cn(classes.image, selected && classes.selectedImage)}
        style={buildKBImageCssStyle({ width, height })}
        draggable={editor.isEditable}
        data-drag-handle={editor.isEditable ? "" : undefined}
      />
      {editor.isEditable ? (
        <div
          className={cn(classes.frame, selected && classes.visible)}
          aria-hidden="true"
        />
      ) : null}
      {editor.isEditable
        ? (
            ["top-left", "top-right", "bottom-left", "bottom-right"] as const
          ).map(handle => (
            <button
              key={handle}
              type="button"
              aria-label={t("resizeImage")}
              className={cn(
                getKBImageResizeHandleClassName(handle),
                selected && classes.visible
              )}
              draggable={false}
              onPointerDown={event => beginResize(handle, event)}
            />
          ))
        : null}
      {editor.isEditable ? (
        <button
          type="button"
          className={cn(classes.quickAction, selected && classes.visibleFlex)}
          title={t("resetImageSize")}
          aria-label={t("resetImageSize")}
          draggable={false}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            updateAttributes({ width: null, height: null });
          }}
          onMouseDown={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <RotateCcw className="size-4" />
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

export const KBImageExtension = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: element =>
          readImageDimensionFromElement(element as HTMLElement, "width"),
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: element =>
          readImageDimensionFromElement(element as HTMLElement, "height"),
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        buildKBImageRenderAttributes({
          ...HTMLAttributes,
          width: node.attrs.width,
          height: node.attrs.height,
        })
      ),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(KBImageNodeView);
  },
});
