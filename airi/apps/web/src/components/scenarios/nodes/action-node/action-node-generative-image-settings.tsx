"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIntegrations } from "@/hooks/use-integrations";
import { cn } from "@/lib/utils";
import {
  GENERATIVE_AI_IMAGE_ASPECT_RATIOS,
  GENERATIVE_AI_IMAGE_MODELS,
  GENERATIVE_AI_IMAGE_PROVIDERS,
  GENERATIVE_AI_REFERENCE_IMAGE_LIMITS,
  isGenerativeAIImageModel,
  listGenerativeAIImageModels,
  MAX_GENERATIVE_AI_REFERENCE_IMAGES,
  type GenerativeAIImageConfig,
  type GenerativeAIImageProvider,
  type GoogleScenarioImageAspectRatio,
  type ScenarioActionAttachment,
} from "@icecore/scenario-contracts";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import {
  Check,
  CheckCircle2,
  ExternalLink,
  ImagePlus,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { resolveScenarioMediaDisplayUrl } from "../../builders/media-display-url";
import { ScenarioMediaPlaceholder } from "../../builders/scenario-media-placeholder";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import type { TranslateFn } from "../../types";
import type { ScenarioActionMedia } from "../../view/node-enrichment/types";
import {
  resolveGenerativePickedCardReason,
  useGenerativeReferenceUploads,
  type GenerativePickedCardReason,
} from "./use-generative-reference-uploads";

const REFERENCE_FILE_ACCEPT = [
  ...GENERATIVE_AI_REFERENCE_IMAGE_LIMITS.mimeTypes,
  ".jfif",
].join(",");

/** Shapes merchants pick most, named; the rest follow after a separator. */
const NAMED_SHAPES: ReadonlyArray<{
  ratio: GoogleScenarioImageAspectRatio;
  nameKey: string;
}> = [
  { ratio: "1:1", nameKey: "generativeAIShapeSquare" },
  { ratio: "4:5", nameKey: "generativeAIShapePortrait" },
  { ratio: "9:16", nameKey: "generativeAIShapeVertical" },
  { ratio: "16:9", nameKey: "generativeAIShapeWide" },
];
const OTHER_SHAPES = GENERATIVE_AI_IMAGE_ASPECT_RATIOS.filter(
  ratio => !NAMED_SHAPES.some(shape => shape.ratio === ratio)
);

const NOTICE_BUTTON_CLASS = "nodrag nopan nokey h-6 px-2 text-[11px]";
const TILE_CLASS =
  "nodrag nopan nokey flex aspect-square min-w-0 flex-col items-center justify-center gap-1 rounded-md border p-1 text-center text-[10px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function createDefaultGenerativeImageConfig(): GenerativeAIImageConfig {
  return {
    provider: "google",
    sourceId: "",
    modelId: GENERATIVE_AI_IMAGE_MODELS[0].id,
    aspectRatio: "16:9",
    referenceImages: [],
    includeInboundText: true,
  };
}

/** The integration each image provider's key is connected as. */
const IMAGE_SOURCE_TYPES: Record<GenerativeAIImageProvider, string> = {
  google: "google_ai",
  elevenlabs: "elevenlabs",
};
const PROVIDER_NAME_KEYS: Record<GenerativeAIImageProvider, string> = {
  google: "generativeAIProviderGoogle",
  elevenlabs: "generativeAIProviderElevenLabs",
};
const BILLING_HINT_KEYS: Record<GenerativeAIImageProvider, string> = {
  google: "generativeAIImageBillingHint",
  elevenlabs: "generativeAIImageBillingHintElevenLabs",
};

/**
 * Settings that run on another provider: its connection, and its default
 * model unless the chosen one also runs there.
 */
function switchGenerativeImageProvider(
  config: GenerativeAIImageConfig,
  provider: GenerativeAIImageProvider,
  sourceId: string
): GenerativeAIImageConfig {
  return {
    ...config,
    provider,
    sourceId,
    modelId: isGenerativeAIImageModel(provider, config.modelId)
      ? config.modelId
      : listGenerativeAIImageModels(provider)[0].id,
  };
}

type ConnectedImageSource = {
  provider: GenerativeAIImageProvider;
  id: string;
};

/** The workspace's connected image sources, at most one per provider. */
function useConnectedImageSources(workspaceId: string) {
  const { sources, isLoading, isError, mutate } = useIntegrations(workspaceId);
  const connected = GENERATIVE_AI_IMAGE_PROVIDERS.flatMap(
    (provider): ConnectedImageSource[] => {
      const id = sources.find(
        source =>
          source.type === IMAGE_SOURCE_TYPES[provider] &&
          source.workspace_id === workspaceId &&
          asNullableRecord(source.credentials)?.has_api_key === true
      )?.id;
      return id ? [{ provider, id }] : [];
    }
  );
  return { connected, isLoading, isError: Boolean(isError), mutate };
}

/** A config without a source takes `fallback` once it is known. */
function usePinConnectedImageSource(
  config: GenerativeAIImageConfig,
  onChange: (config: GenerativeAIImageConfig) => void,
  fallback: ConnectedImageSource | null,
  blocked: boolean
) {
  const latest = useRef({ config, onChange });
  useEffect(() => {
    latest.current = { config, onChange };
  });
  const fallbackProvider = fallback?.provider;
  const fallbackId = fallback?.id;
  useEffect(() => {
    if (!config.sourceId && fallbackProvider && fallbackId && !blocked) {
      latest.current.onChange(
        switchGenerativeImageProvider(
          latest.current.config,
          fallbackProvider,
          fallbackId
        )
      );
    }
  }, [config.sourceId, fallbackProvider, fallbackId, blocked]);
}

function ConnectProviderLink({
  provider,
  workspaceId,
  t,
}: {
  provider: GenerativeAIImageProvider;
  workspaceId: string;
  t: TranslateFn;
}) {
  return (
    <Button asChild size="sm" variant="outline" className={NOTICE_BUTTON_CLASS}>
      <a
        href={`/panel/w/${encodeURIComponent(workspaceId)}/settings/integrations?integration=${IMAGE_SOURCE_TYPES[provider]}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("generativeAIConnectProvider", {
          provider: t(PROVIDER_NAME_KEYS[provider]),
        })}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </Button>
  );
}

function SourceActionButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={cn(NOTICE_BUTTON_CLASS, "h-auto min-h-6 whitespace-normal")}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** Shown only when both services are connected. */
function ImageServicePicker({
  config,
  connected,
  onChange,
  t,
}: {
  config: GenerativeAIImageConfig;
  connected: ConnectedImageSource[];
  onChange: (config: GenerativeAIImageConfig) => void;
  t: TranslateFn;
}) {
  const selectId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={selectId} className="text-[11px] font-medium">
        {t("generativeAIImageSource")}
      </Label>
      <Select
        value={config.provider}
        onValueChange={value => {
          const entry = connected.find(source => source.provider === value);
          if (entry && entry.provider !== config.provider) {
            onChange(
              switchGenerativeImageProvider(config, entry.provider, entry.id)
            );
          }
        }}
      >
        <SelectTrigger
          id={selectId}
          className="nodrag nopan nokey w-full min-w-0 bg-background text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {connected.map(entry => (
            <SelectItem key={entry.provider} value={entry.provider}>
              {t(PROVIDER_NAME_KEYS[entry.provider])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Whether the step's service still pays: connected, replaced (the merchant
 * chooses the current connection) or gone (connect it or use the other).
 */
function ImageSourceStatus({
  config,
  connected,
  workspaceId,
  onChange,
  t,
}: {
  config: GenerativeAIImageConfig;
  connected: ConnectedImageSource[];
  workspaceId: string;
  onChange: (config: GenerativeAIImageConfig) => void;
  t: TranslateFn;
}) {
  const provider = t(PROVIDER_NAME_KEYS[config.provider]);
  const current = connected.find(entry => entry.provider === config.provider);
  if (current?.id === config.sourceId) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CheckCircle2
          className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
        {t("generativeAIProviderConnected", { provider })}
      </p>
    );
  }
  if (current) {
    return (
      <ScenarioInlineNotice
        action={
          <SourceActionButton
            label={t("generativeAIUseConnectedSource")}
            onClick={() => onChange({ ...config, sourceId: current.id })}
          />
        }
      >
        {t("generativeAISourceChanged", { provider })}
      </ScenarioInlineNotice>
    );
  }
  const other = connected.find(entry => entry.provider !== config.provider);
  return (
    <>
      <ScenarioInlineNotice>
        {t("generativeAIProviderRequired", { provider })}
      </ScenarioInlineNotice>
      <div className="flex flex-wrap gap-1">
        <ConnectProviderLink
          provider={config.provider}
          workspaceId={workspaceId}
          t={t}
        />
        {other ? (
          <SourceActionButton
            label={t("generativeAIUseProvider", {
              provider: t(PROVIDER_NAME_KEYS[other.provider]),
            })}
            onClick={() =>
              onChange(
                switchGenerativeImageProvider(config, other.provider, other.id)
              )
            }
          />
        ) : null}
      </div>
    </>
  );
}

function NoImageSourceNotice({
  workspaceId,
  t,
}: {
  workspaceId: string;
  t: TranslateFn;
}) {
  return (
    <>
      <ScenarioInlineNotice>
        {t("generativeAISourceRequired")}
      </ScenarioInlineNotice>
      <div className="flex flex-wrap gap-1">
        {GENERATIVE_AI_IMAGE_PROVIDERS.map(provider => (
          <ConnectProviderLink
            key={provider}
            provider={provider}
            workspaceId={workspaceId}
            t={t}
          />
        ))}
      </div>
    </>
  );
}

function ImageSourceUnavailableNotice({
  isLoading,
  onRetry,
  t,
}: {
  isLoading: boolean;
  onRetry: () => void;
  t: TranslateFn;
}) {
  return isLoading ? (
    <p
      role="status"
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      {t("generativeAISourceLoading")}
    </p>
  ) : (
    <ScenarioInlineNotice
      tone="error"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={NOTICE_BUTTON_CLASS}
          onClick={onRetry}
        >
          {t("generativeAISourceRetry")}
        </Button>
      }
    >
      {t("generativeAISourceUnavailable")}
    </ScenarioInlineNotice>
  );
}

/**
 * The workspace connection that pays for the images: Google AI or
 * ElevenLabs. A config without a source takes a connected one, its own
 * provider's first; a replaced source waits for the merchant to choose.
 */
export function ActionNodeGenerativeImageSource({
  config,
  workspaceId,
  onChange,
  t,
}: {
  config: GenerativeAIImageConfig;
  workspaceId: string;
  onChange: (config: GenerativeAIImageConfig) => void;
  t: TranslateFn;
}) {
  const { connected, isLoading, isError, mutate } =
    useConnectedImageSources(workspaceId);
  usePinConnectedImageSource(
    config,
    onChange,
    connected.find(entry => entry.provider === config.provider) ??
      connected[0] ??
      null,
    isError
  );
  const ready = !isLoading && !isError;

  return (
    <div className="space-y-1" data-testid="generative-ai-image-source">
      {!ready ? (
        <ImageSourceUnavailableNotice
          isLoading={isLoading}
          onRetry={() => void mutate()}
          t={t}
        />
      ) : connected.length === 0 ? (
        <NoImageSourceNotice workspaceId={workspaceId} t={t} />
      ) : (
        <>
          {connected.length > 1 ? (
            <ImageServicePicker
              config={config}
              connected={connected}
              onChange={onChange}
              t={t}
            />
          ) : null}
          <ImageSourceStatus
            config={config}
            connected={connected}
            workspaceId={workspaceId}
            onChange={onChange}
            t={t}
          />
        </>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t(BILLING_HINT_KEYS[config.provider])}
      </p>
    </div>
  );
}

/** The picked carousel card's image as a reference, toggled from its tile. */
export type GenerativePickedCardImage = {
  included: boolean;
  /** False when some cards have no image the reference rules accept. */
  cardImagesUsable: boolean;
  onToggle: (included: boolean) => void;
};

/**
 * Reference images as a grid: thumbnails, the picked card image tile and an
 * add tile that takes clicks and drops until the limit is reached.
 */
export function ActionNodeGenerativeReferenceImages({
  config,
  upload,
  onChange,
  pickedCardImage,
  t,
}: {
  config: GenerativeAIImageConfig;
  upload?: ScenarioActionMedia["upload"];
  onChange: (config: GenerativeAIImageConfig) => void;
  pickedCardImage?: GenerativePickedCardImage;
  t: TranslateFn;
}) {
  const reservesCardImage = pickedCardImage?.included === true;
  const ownCount = config.referenceImages.length;
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const cardReasonId = `${baseId}-card-reason`;
  const inputRef = useRef<HTMLInputElement>(null);
  const uploads = useGenerativeReferenceUploads({
    config,
    upload,
    onChange,
    reservesCardImage,
    t,
  });
  const cardReason = resolveGenerativePickedCardReason(
    pickedCardImage,
    ownCount,
    t
  );

  return (
    <div className="space-y-1.5" data-testid="generative-ai-reference-images">
      <ActionNodeGenerativeReferenceHeader
        labelId={labelId}
        count={ownCount + (reservesCardImage ? 1 : 0)}
        t={t}
      />
      <input
        ref={inputRef}
        type="file"
        accept={REFERENCE_FILE_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        disabled={!uploads.canUpload}
        onChange={uploads.onInputChange}
      />
      <div
        role="group"
        aria-labelledby={labelId}
        data-testid="generative-ai-reference-dropzone"
        className={cn(
          "nodrag nopan grid grid-cols-3 gap-2 rounded-md",
          uploads.dragging && uploads.canUpload && "ring-2 ring-primary/40"
        )}
        onDragOver={uploads.onDragOver}
        onDragLeave={uploads.onDragLeave}
        onDrop={uploads.onDrop}
      >
        {config.referenceImages.map((image, index) => (
          <ActionNodeGenerativeReferenceTile
            key={`${image.bucket}/${image.path}`}
            image={image}
            index={index}
            uploading={uploads.uploading}
            onRemove={uploads.removeReference}
            t={t}
          />
        ))}
        {pickedCardImage ? (
          <ActionNodeGenerativePickedCardTile
            pickedCardImage={pickedCardImage}
            reason={cardReason.text}
            reasonId={cardReasonId}
            t={t}
          />
        ) : null}
        {uploads.full ? null : (
          <ActionNodeGenerativeReferenceAddTile
            disabled={!uploads.canUpload}
            uploading={uploads.uploading}
            onClick={() => inputRef.current?.click()}
            t={t}
          />
        )}
      </div>
      <ActionNodeGenerativeReferenceNotes
        cardReason={cardReason}
        cardReasonId={cardReasonId}
        error={uploads.error}
        t={t}
      />
    </div>
  );
}

function ActionNodeGenerativeReferenceHeader({
  labelId,
  count,
  t,
}: {
  labelId: string;
  /** Own references plus the included card image. */
  count: number;
  t: TranslateFn;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span id={labelId} className="text-[11px] font-medium">
        {t("generativeAIReferenceImages")}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {count}/{MAX_GENERATIVE_AI_REFERENCE_IMAGES}
      </span>
    </div>
  );
}

function ActionNodeGenerativeReferenceTile({
  image,
  index,
  uploading,
  onRemove,
  t,
}: {
  image: ScenarioActionAttachment;
  index: number;
  uploading: boolean;
  onRemove: (index: number) => void;
  t: TranslateFn;
}) {
  const src = resolveScenarioMediaDisplayUrl(image);
  const alt = t("generativeAIReferencePreview", { index: index + 1 });
  return (
    <div className="relative aspect-square min-w-0 overflow-hidden rounded-md border bg-background">
      {src ? (
        // Signed workspace previews already use the media service.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="size-full object-contain" />
      ) : (
        <ScenarioMediaPlaceholder label={alt} className="size-full" />
      )}
      <Button
        type="button"
        variant="secondary"
        size="icon"
        disabled={uploading}
        className="nodrag nopan nokey absolute right-0.5 top-0.5 size-6"
        aria-label={t("generativeAIRemoveReference", {
          index: index + 1,
        })}
        onClick={() => onRemove(index)}
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function ActionNodeGenerativePickedCardTile({
  pickedCardImage,
  reason,
  reasonId,
  t,
}: {
  pickedCardImage: GenerativePickedCardImage;
  reason: string | null;
  reasonId: string;
  t: TranslateFn;
}) {
  return (
    <button
      type="button"
      aria-pressed={pickedCardImage.included}
      aria-describedby={reason ? reasonId : undefined}
      disabled={!pickedCardImage.included && reason !== null}
      data-testid="generative-ai-picked-card-slot"
      className={cn(
        TILE_CLASS,
        pickedCardImage.included
          ? "border-primary bg-primary/5 text-foreground"
          : "border-dashed bg-background text-muted-foreground hover:bg-muted/50"
      )}
      onClick={() => pickedCardImage.onToggle(!pickedCardImage.included)}
    >
      {pickedCardImage.included ? (
        <Check className="size-4 text-primary" aria-hidden />
      ) : (
        <ImagePlus className="size-4" aria-hidden />
      )}
      <span>{t("generativeAIPickedCardImage")}</span>
    </button>
  );
}

function ActionNodeGenerativeReferenceAddTile({
  disabled,
  uploading,
  onClick,
  t,
}: {
  disabled: boolean;
  uploading: boolean;
  onClick: () => void;
  t: TranslateFn;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid="generative-ai-reference-add"
      className={cn(
        TILE_CLASS,
        "border-dashed bg-background text-muted-foreground hover:bg-muted/50"
      )}
      onClick={onClick}
    >
      {uploading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <ImagePlus className="size-4" aria-hidden />
      )}
      <span>
        {t(
          uploading
            ? "generativeAIReferenceUploading"
            : "generativeAIReferenceUpload"
        )}
      </span>
    </button>
  );
}

/** Why the card image tile is off, the hint and the last upload error. */
function ActionNodeGenerativeReferenceNotes({
  cardReason,
  cardReasonId,
  error,
  t,
}: {
  cardReason: GenerativePickedCardReason;
  cardReasonId: string;
  error: string | null;
  t: TranslateFn;
}) {
  return (
    <>
      {cardReason.text ? (
        <p
          id={cardReasonId}
          className={cn(
            "text-[11px] leading-snug",
            cardReason.blocks ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {cardReason.text}
        </p>
      ) : null}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("generativeAIReferenceHint")}
      </p>
      {error ? (
        <p role="alert" className="text-[11px] leading-snug text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The image's shape, and the model behind More settings. */
export function ActionNodeGenerativeImageFormat({
  config,
  onChange,
  t,
}: {
  config: GenerativeAIImageConfig;
  onChange: (config: GenerativeAIImageConfig) => void;
  t: TranslateFn;
}) {
  const shapeId = useId();
  const modelId = useId();
  const models = listGenerativeAIImageModels(config.provider);
  const modelInvalid = !isGenerativeAIImageModel(
    config.provider,
    config.modelId
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={shapeId} className="text-[11px] font-medium">
          {t("generativeAIImageAspectRatio")}
        </Label>
        <Select
          value={config.aspectRatio}
          onValueChange={value => {
            const aspectRatio = GENERATIVE_AI_IMAGE_ASPECT_RATIOS.find(
              ratio => ratio === value
            );
            if (aspectRatio) onChange({ ...config, aspectRatio });
          }}
        >
          <SelectTrigger
            id={shapeId}
            className="nodrag nopan nokey w-full min-w-0 bg-background text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NAMED_SHAPES.map(({ ratio, nameKey }) => {
              const name = t(nameKey);
              return (
                <SelectItem
                  key={ratio}
                  value={ratio}
                  textValue={`${ratio} ${name}`}
                >
                  <span className="tabular-nums">{ratio}</span>{" "}
                  <span className="text-muted-foreground">{name}</span>
                </SelectItem>
              );
            })}
            <SelectSeparator />
            {OTHER_SHAPES.map(ratio => (
              <SelectItem key={ratio} value={ratio}>
                <span className="tabular-nums">{ratio}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ScenarioCollapsibleSection
        variant="inline"
        title={t("generativeAIMoreSettings")}
        keepMounted
        errorCount={modelInvalid ? 1 : 0}
        data-testid="generative-ai-more-settings"
      >
        <div className="space-y-1 pt-1">
          <Label htmlFor={modelId} className="text-[11px] font-medium">
            {t("generativeAIImageModel")}
          </Label>
          <Select
            value={config.modelId}
            onValueChange={next => {
              if (models.some(model => model.id === next))
                onChange({ ...config, modelId: next });
            }}
          >
            <SelectTrigger
              id={modelId}
              aria-invalid={modelInvalid}
              className="nodrag nopan nokey w-full min-w-0 bg-background text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map(model => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ScenarioCollapsibleSection>
    </div>
  );
}
