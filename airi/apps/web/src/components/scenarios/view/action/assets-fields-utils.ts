import type { ScenarioReplyCtaType } from "../../types";

export type ScenarioCtaFlowOption = {
  id: string;
  name: string;
  status?: string;
};

export const FIELD_LABEL_CLASS = "text-xs font-medium text-muted-foreground";

export type ScenarioActionAssetsLayout = {
  /** The WhatsApp reply CTA (type, button text, link or form) is editable. */
  supportsReplyCta: boolean;
  /** The CTA type the fields show: "link" whenever the reply CTA is hidden. */
  effectiveCtaType: ScenarioReplyCtaType;
  /** A link CTA edits its one URL inline instead of in the link list. */
  showInlineCtaLinkInput: boolean;
  showLinkControls: boolean;
  showTelegramUrlLabel: boolean;
};

/** Which asset controls an action shows for its channel and CTA type. */
export function resolveScenarioActionAssetsLayout({
  ctaType,
  hideLinkControls,
  hideReplyCtaChrome,
  linkCount,
  onCtaTypeChange,
  onCtaButtonLabelChange,
  onCtaFlowIdChange,
  onTelegramUrlButtonLabelChange,
}: {
  ctaType?: ScenarioReplyCtaType;
  hideLinkControls: boolean;
  hideReplyCtaChrome: boolean;
  linkCount: number;
  onCtaTypeChange?: (ctaType: ScenarioReplyCtaType) => void;
  onCtaButtonLabelChange?: (value: string) => void;
  onCtaFlowIdChange?: (flowId: string) => void;
  onTelegramUrlButtonLabelChange?: (value: string) => void;
}): ScenarioActionAssetsLayout {
  const supportsReplyCta = Boolean(
    !hideReplyCtaChrome &&
      ctaType &&
      onCtaTypeChange &&
      onCtaButtonLabelChange &&
      onCtaFlowIdChange
  );
  const showTelegramUrlLabel =
    !hideLinkControls &&
    hideReplyCtaChrome &&
    linkCount > 0 &&
    typeof onTelegramUrlButtonLabelChange === "function";
  const effectiveCtaType: ScenarioReplyCtaType = supportsReplyCta
    ? (ctaType as ScenarioReplyCtaType)
    : "link";
  const showInlineCtaLinkInput =
    supportsReplyCta && effectiveCtaType === "link";
  const showLinkControls =
    !hideLinkControls &&
    !showInlineCtaLinkInput &&
    (!supportsReplyCta || effectiveCtaType === "link");

  return {
    supportsReplyCta,
    effectiveCtaType,
    showInlineCtaLinkInput,
    showLinkControls,
    showTelegramUrlLabel,
  };
}
