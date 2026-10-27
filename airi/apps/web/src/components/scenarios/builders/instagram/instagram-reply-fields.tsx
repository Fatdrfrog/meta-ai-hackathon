"use client";

import type {
  ScenarioInstagramButton,
  ScenarioInstagramMediaType,
  ScenarioInstagramMessageKind,
  TranslateFn,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  INSTAGRAM_BUTTON_TITLE_MAX_CHARS,
  INSTAGRAM_GENERIC_CARD_MAX_COUNT,
  INSTAGRAM_QUICK_REPLY_MAX_COUNT,
  INSTAGRAM_QUICK_REPLY_TITLE_MAX_CHARS,
  INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT,
} from "@/lib/scenarios/instagram-reply-config";
import { cn } from "@/lib/utils";
import {
  Image as ImageIcon,
  Images,
  ListChecks,
  MessageCircle,
  MousePointerClick,
  Plus,
} from "lucide-react";
import type { SyntheticEvent } from "react";
import {
  ReplyOptionDeleteButton,
  ReplyOptionFieldRow,
} from "../reply-option-controls";
import { isHttpUrl } from "./instagram-reply-model";
import type { InstagramReplyEditor } from "./use-instagram-reply-editor";

const KIND_OPTIONS: Array<{
  kind: ScenarioInstagramMessageKind;
  labelKey: string;
  icon: typeof MessageCircle;
}> = [
  { kind: "text", labelKey: "instagramTypeText", icon: MessageCircle },
  {
    kind: "quick_replies",
    labelKey: "instagramTypeQuickReplies",
    icon: ListChecks,
  },
  {
    kind: "button_template",
    labelKey: "instagramTypeButtons",
    icon: MousePointerClick,
  },
  { kind: "generic_template", labelKey: "instagramTypeCards", icon: Images },
  { kind: "media", labelKey: "instagramTypeMedia", icon: ImageIcon },
];

const MEDIA_TYPE_OPTIONS: Array<{
  value: ScenarioInstagramMediaType;
  labelKey: string;
}> = [
  { value: "image", labelKey: "whatsappServiceMediaImage" },
  { value: "video", labelKey: "whatsappServiceMediaVideo" },
  { value: "audio", labelKey: "whatsappServiceMediaAudio" },
];

const FIELD_CLASS = "nodrag nopan h-8 bg-white text-xs dark:bg-zinc-950";

type FieldsProps = { editor: InstagramReplyEditor; t: TranslateFn };

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function LimitLine({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="text-center text-[11px] text-muted-foreground">
      {children}
    </p>
  );
}

function AddItemButton({
  label,
  limitReached,
  limitId,
  onClick,
}: {
  label: string;
  limitReached: boolean;
  limitId: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={stopPropagation}
      disabled={limitReached}
      aria-describedby={limitReached ? limitId : undefined}
      className="nodrag nopan nokey h-8 w-full bg-white text-xs dark:bg-zinc-950"
    >
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
      {label}
    </Button>
  );
}

/** The message type picker and the fields of the chosen type. */
export function InstagramReplyFields({
  editor,
  idPrefix,
  t,
}: FieldsProps & { idPrefix: string }) {
  const kind = editor.draft.kind;
  return (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        value={kind}
        aria-label={t("instagramTypeLabel")}
        className="nodrag nopan nokey flex w-full flex-wrap gap-1"
        onValueChange={value => {
          const option = KIND_OPTIONS.find(item => item.kind === value);
          if (option) editor.updateKind(option.kind);
        }}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        {KIND_OPTIONS.map(option => {
          const Icon = option.icon;
          return (
            <ToggleGroupItem
              key={option.kind}
              value={option.kind}
              className="h-7 flex-none gap-1 rounded-md px-2 text-[11px] first:rounded-md last:rounded-md data-[state=on]:bg-white data-[state=on]:text-[#E1306C] data-[state=on]:shadow-sm dark:data-[state=on]:bg-zinc-950"
            >
              <Icon className="h-3 w-3" aria-hidden />
              {t(option.labelKey)}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {kind === "quick_replies" ? (
        <QuickReplyFields
          editor={editor}
          limitId={`${idPrefix}-quick-replies`}
          t={t}
        />
      ) : null}

      {/* Cards carry their own buttons; Instagram has no buttons under a carousel. */}
      {kind === "button_template" ? (
        <ButtonFields editor={editor} idPrefix={idPrefix} t={t} />
      ) : null}

      {kind === "generic_template" ? (
        <CardFields editor={editor} limitId={`${idPrefix}-cards`} t={t} />
      ) : null}

      {kind === "media" ? <MediaFields editor={editor} t={t} /> : null}
    </>
  );
}

function QuickReplyFields({
  editor,
  limitId,
  t,
}: FieldsProps & { limitId: string }) {
  const { quickReplies, quickReplyKeys } = editor;
  const limitReached = quickReplies.length >= INSTAGRAM_QUICK_REPLY_MAX_COUNT;
  return (
    <div className="space-y-1">
      {quickReplies.map((option, index) => (
        <ReplyOptionFieldRow key={quickReplyKeys[index]}>
          <Input
            value={option.title}
            maxLength={INSTAGRAM_QUICK_REPLY_TITLE_MAX_CHARS}
            aria-label={t("instagramInputLabelOption")}
            placeholder={t("instagramPlaceholderOption")}
            onChange={event =>
              editor.updateQuickReply(index, event.target.value)
            }
            className={FIELD_CLASS}
          />
          <ReplyOptionDeleteButton
            label={t("instagramRemoveOption")}
            className="h-8 w-8"
            onClick={() => editor.removeQuickReply(index)}
          />
        </ReplyOptionFieldRow>
      ))}
      <AddItemButton
        label={t("instagramAddOption")}
        limitReached={limitReached}
        limitId={limitId}
        onClick={editor.addQuickReply}
      />
      {limitReached ? (
        <LimitLine id={limitId}>
          {t("instagramLimitOptions", {
            count: INSTAGRAM_QUICK_REPLY_MAX_COUNT,
          })}
        </LimitLine>
      ) : null}
    </div>
  );
}

function ButtonFields({
  editor,
  idPrefix,
  t,
}: FieldsProps & { idPrefix: string }) {
  const { buttons, buttonKeys } = editor;
  const limitId = `${idPrefix}-buttons`;
  const limitReached = buttons.length >= INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT;
  return (
    <div className="space-y-1">
      {buttons.map((button, index) => (
        <ButtonField
          key={buttonKeys[index]}
          button={button}
          index={index}
          linkId={`${idPrefix}-button-${index}-link`}
          editor={editor}
          t={t}
        />
      ))}
      <AddItemButton
        label={t("instagramAddButton")}
        limitReached={limitReached}
        limitId={limitId}
        onClick={editor.addButton}
      />
      {limitReached ? (
        <LimitLine id={limitId}>
          {t("instagramLimitButtons", {
            count: INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT,
          })}
        </LimitLine>
      ) : null}
    </div>
  );
}

type ButtonFieldProps = FieldsProps & {
  button: ScenarioInstagramButton;
  index: number;
  linkId: string;
};

/** A button's type, text and, for a Link button, its link. */
function ButtonField({ button, index, linkId, editor, t }: ButtonFieldProps) {
  return (
    <div className="space-y-1">
      <ReplyOptionFieldRow>
        <Select
          value={button.type}
          onOpenChange={editor.handleButtonTypeMenuOpenChange}
          onValueChange={value =>
            editor.changeButtonType(
              index,
              value as ScenarioInstagramButton["type"]
            )
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("instagramInputLabelButtonType")}
            className="nodrag nopan nokey w-auto shrink-0 gap-1 bg-white px-2 text-xs dark:bg-zinc-950"
            onPointerDown={stopPropagation}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            onCloseAutoFocus={event => {
              if (!editor.takeLinkFocusOnMenuClose(index)) return;
              const link = document.getElementById(linkId);
              if (!link) return;
              event.preventDefault();
              link.focus();
            }}
          >
            <SelectItem value="postback">
              {t("whatsappServiceActionReplyButton")}
            </SelectItem>
            <SelectItem value="web_url">
              {t("whatsappServiceActionWebsite")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={button.title}
          maxLength={INSTAGRAM_BUTTON_TITLE_MAX_CHARS}
          aria-label={t("buttonText")}
          placeholder={t("instagramPlaceholderButton")}
          onChange={event =>
            editor.updateButtonTitle(index, event.target.value)
          }
          className={cn(FIELD_CLASS, "min-w-0 flex-1")}
        />
        <ReplyOptionDeleteButton
          label={t("instagramRemoveButton")}
          className="h-8 w-8"
          onClick={() => editor.removeButton(index)}
        />
      </ReplyOptionFieldRow>
      {button.type === "web_url" ? (
        <ButtonLinkField
          button={button}
          index={index}
          linkId={linkId}
          editor={editor}
          t={t}
        />
      ) : null}
    </div>
  );
}

/** Says the link is invalid only once the merchant leaves the field. */
function ButtonLinkField({
  button,
  index,
  linkId,
  editor,
  t,
}: ButtonFieldProps) {
  const linkErrorId = `${linkId}-error`;
  const showLinkError =
    editor.editingLinkIndex !== index && !isHttpUrl(button.url?.trim());
  return (
    <>
      <Input
        id={linkId}
        type="url"
        inputMode="url"
        value={button.url ?? ""}
        aria-label={t("instagramInputLabelLink")}
        aria-invalid={showLinkError || undefined}
        aria-describedby={showLinkError ? linkErrorId : undefined}
        placeholder={t("instagramPlaceholderLink")}
        onChange={event => editor.updateButtonUrl(index, event.target.value)}
        onFocus={() => editor.setEditingLinkIndex(index)}
        onBlur={() => editor.setEditingLinkIndex(null)}
        className={FIELD_CLASS}
      />
      {showLinkError ? (
        <p
          id={linkErrorId}
          className="text-[11px] leading-snug text-destructive"
        >
          {t("instagramLinkInvalid")}
        </p>
      ) : null}
    </>
  );
}

function CardFields({ editor, limitId, t }: FieldsProps & { limitId: string }) {
  const { cards } = editor;
  const limitReached = cards.length >= INSTAGRAM_GENERIC_CARD_MAX_COUNT;
  return (
    <div className="space-y-1.5">
      {cards.map((card, index) => (
        <div
          key={card.id}
          className="space-y-1 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <ReplyOptionFieldRow>
            <Input
              value={card.title}
              aria-label={t("instagramInputLabelCardTitle")}
              placeholder={t("instagramPlaceholderCardTitle")}
              onChange={event =>
                editor.updateCard(index, { title: event.target.value })
              }
              className="nodrag nopan h-8 text-xs"
            />
            <ReplyOptionDeleteButton
              label={t("instagramRemoveCard")}
              className="h-8 w-8"
              onClick={() => editor.removeCard(index)}
            />
          </ReplyOptionFieldRow>
          <Input
            value={card.subtitle ?? ""}
            aria-label={t("instagramInputLabelCardSubtitle")}
            placeholder={t("instagramPlaceholderCardSubtitle")}
            onChange={event =>
              editor.updateCard(index, { subtitle: event.target.value })
            }
            className="nodrag nopan h-8 text-xs"
          />
          <Input
            type="url"
            inputMode="url"
            value={card.imageUrl ?? ""}
            aria-label={t("instagramInputLabelCardImage")}
            placeholder={t("instagramPlaceholderImageLink")}
            onChange={event =>
              editor.updateCard(index, { imageUrl: event.target.value })
            }
            className="nodrag nopan h-8 text-xs"
          />
        </div>
      ))}
      <AddItemButton
        label={t("instagramAddCard")}
        limitReached={limitReached}
        limitId={limitId}
        onClick={editor.addCard}
      />
      {limitReached ? (
        <LimitLine id={limitId}>
          {t("instagramLimitCards", {
            count: INSTAGRAM_GENERIC_CARD_MAX_COUNT,
          })}
        </LimitLine>
      ) : null}
    </div>
  );
}

function MediaFields({ editor, t }: FieldsProps) {
  return (
    <ReplyOptionFieldRow>
      <Select
        value={editor.draft.mediaType ?? "image"}
        onValueChange={value =>
          editor.updateMediaType(value as ScenarioInstagramMediaType)
        }
      >
        <SelectTrigger
          size="sm"
          aria-label={t("instagramInputLabelMediaType")}
          className="nodrag nopan nokey w-auto shrink-0 gap-1 bg-white px-2 text-xs dark:bg-zinc-950"
          onPointerDown={stopPropagation}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MEDIA_TYPE_OPTIONS.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="url"
        inputMode="url"
        value={editor.draft.mediaUrl ?? ""}
        aria-label={t("instagramInputLabelMediaLink")}
        placeholder={t("instagramPlaceholderMediaLink")}
        onChange={event => editor.updateMediaUrl(event.target.value)}
        className={cn(FIELD_CLASS, "min-w-0 flex-1")}
      />
    </ReplyOptionFieldRow>
  );
}
