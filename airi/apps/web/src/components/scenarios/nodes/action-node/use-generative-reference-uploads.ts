"use client";

import {
  findGenerativeAIReferenceImageIssue,
  MAX_GENERATIVE_AI_REFERENCE_IMAGES,
  normalizeGenerativeAIImageConfig,
  type GenerativeAIImageConfig,
  type GenerativeAIReferenceImageIssue,
  type ScenarioActionAttachment,
} from "@icecore/scenario-contracts";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import type { TranslateFn } from "../../types";
import type { ScenarioActionMedia } from "../../view/node-enrichment/types";
import type { GenerativePickedCardImage } from "./action-node-generative-image-settings";

const REFERENCE_ISSUE_MESSAGE_KEYS: Record<
  GenerativeAIReferenceImageIssue,
  string
> = {
  count: "generativeAIReferenceLimit",
  mime_type: "generativeAIReferenceInvalid",
  file_size: "generativeAIReferenceTooLarge",
  total_size: "generativeAIReferenceTotalTooLarge",
};

const REFERENCE_LIMIT_VALUES = { max: MAX_GENERATIVE_AI_REFERENCE_IMAGES };

export type GenerativePickedCardReason = {
  /** Why the card image tile cannot be turned on, or null. */
  text: string | null;
  /** A saved card image the cards cannot provide blocks activation. */
  blocks: boolean;
};

export function resolveGenerativePickedCardReason(
  pickedCardImage:
    | Pick<GenerativePickedCardImage, "included" | "cardImagesUsable">
    | undefined,
  ownCount: number,
  t: TranslateFn
): GenerativePickedCardReason {
  if (!pickedCardImage) return { text: null, blocks: false };
  if (!pickedCardImage.cardImagesUsable) {
    return {
      text: t("generativeAIPickedCardImageUnavailable"),
      blocks: pickedCardImage.included,
    };
  }
  const noSlot =
    !pickedCardImage.included && ownCount >= MAX_GENERATIVE_AI_REFERENCE_IMAGES;
  return {
    text: noSlot
      ? t("generativeAIPickedCardImageNoSlot", REFERENCE_LIMIT_VALUES)
      : null,
    blocks: false,
  };
}

/**
 * Reference uploads, one batch at a time, plus the grid's drop and remove
 * handlers. Each finished upload joins the latest config, and unmounting
 * leaves a running batch stale.
 */
export function useGenerativeReferenceUploads({
  config,
  upload,
  onChange,
  reservesCardImage,
  t,
}: {
  config: GenerativeAIImageConfig;
  upload?: ScenarioActionMedia["upload"];
  onChange: (config: GenerativeAIImageConfig) => void;
  /** The included card image takes one of the reference slots. */
  reservesCardImage: boolean;
  t: TranslateFn;
}) {
  const maxOwnReferences =
    MAX_GENERATIVE_AI_REFERENCE_IMAGES - (reservesCardImage ? 1 : 0);
  const full = config.referenceImages.length >= maxOwnReferences;
  const operation = useRef(0);
  const busy = useRef(false);
  const current = useRef({ config, onChange });
  useEffect(() => {
    current.current = { config, onChange };
  });
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      operation.current += 1;
    },
    []
  );

  const canUpload = Boolean(upload) && !uploading && !full;

  /**
   * Claims the queue for the files that fit the free slots, or shows the
   * limit they break. Null when nothing uploads.
   */
  const startBatch = (files: File[]) => {
    const references = current.current.config.referenceImages;
    const slots = maxOwnReferences - references.length;
    if (slots <= 0) return null;
    const candidates = files.slice(0, slots);
    const issue = findGenerativeAIReferenceImageIssue(
      candidates.map(file => ({ mimeType: file.type, fileSize: file.size })),
      {
        existingBytes: references.reduce(
          (sum, image) => sum + (image.fileSize || 0),
          0
        ),
      }
    );
    if (issue) {
      setError(t(REFERENCE_ISSUE_MESSAGE_KEYS[issue], REFERENCE_LIMIT_VALUES));
      return null;
    }
    const request = ++operation.current;
    busy.current = true;
    setUploading(true);
    setError(
      files.length > slots
        ? t("generativeAIReferenceLimit", REFERENCE_LIMIT_VALUES)
        : null
    );
    return { request, candidates };
  };

  /** Adds a finished upload to the latest config; false stops the batch. */
  const addUploaded = (
    request: number,
    attachment: ScenarioActionAttachment | undefined
  ) => {
    if (request !== operation.current) return false;
    const latest = current.current.config;
    const next = {
      ...latest,
      referenceImages: [...latest.referenceImages, attachment],
    };
    const normalized = normalizeGenerativeAIImageConfig(next, {
      draft: true,
    });
    if (!attachment || !normalized) {
      setError(t("generativeAIReferenceUploadFailed"));
      return false;
    }
    current.current = { ...current.current, config: normalized };
    current.current.onChange(normalized);
    return true;
  };

  const uploadFiles = async (files: File[]) => {
    if (!upload || busy.current || !files.length) return;
    const batch = startBatch(files);
    if (!batch) return;
    try {
      for (const file of batch.candidates) {
        const attachment = await upload(file, { persist: false });
        if (!addUploaded(batch.request, attachment)) return;
      }
    } catch {
      if (batch.request === operation.current)
        setError(t("generativeAIReferenceUploadFailed"));
    } finally {
      if (batch.request === operation.current) {
        busy.current = false;
        setUploading(false);
      }
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void uploadFiles(files);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
    setDragging(canUpload);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (canUpload) void uploadFiles(Array.from(event.dataTransfer.files || []));
  };

  const removeReference = (index: number) => {
    setError(null);
    onChange({
      ...config,
      referenceImages: config.referenceImages.filter(
        (_, candidate) => candidate !== index
      ),
    });
  };

  return {
    full,
    canUpload,
    uploading,
    dragging,
    error,
    onInputChange,
    onDragOver,
    onDragLeave,
    onDrop,
    removeReference,
  };
}
