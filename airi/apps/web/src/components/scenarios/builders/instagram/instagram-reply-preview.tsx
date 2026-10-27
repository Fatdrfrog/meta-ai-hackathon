"use client";

import type {
  ScenarioInstagramButton,
  ScenarioInstagramConfig,
  ScenarioInstagramGenericCard,
  ScenarioInstagramQuickReply,
  ScenarioReplyMode,
  TranslateFn,
} from "@/components/scenarios/types";
import { Textarea } from "@/components/ui/textarea";
import { Image as ImageIcon } from "lucide-react";
import { BranchConnectionDot } from "../reply-option-controls";
import { useStableItemKeys } from "../use-stable-item-keys";
import { isHttpUrl } from "./instagram-reply-model";
import type { InstagramReplyEditor } from "./use-instagram-reply-editor";

type ConnectionLabel = (payload?: string) => string;

/** The reply bubble: the fixed text as an input, or a note that AI writes it. */
export function InstagramMessageBubble({
  replyMode,
  disabled,
  messageText,
  onMessageTextChange,
  onMessageTextCommit,
  t,
}: {
  replyMode: ScenarioReplyMode;
  disabled: boolean;
  messageText: string;
  onMessageTextChange: (next: string) => void;
  onMessageTextCommit?: () => void;
  t: TranslateFn;
}) {
  return (
    <div className="ml-auto max-w-[86%] rounded-[22px_22px_6px_22px] bg-[#405DE6] px-3 py-2 text-white shadow-sm">
      {replyMode === "fixed" ? (
        <Textarea
          rows={4}
          disabled={disabled}
          value={messageText}
          aria-label={t("scenarioMessageEditorLabel")}
          onChange={event => onMessageTextChange(event.target.value)}
          onBlur={onMessageTextCommit}
          placeholder={t("actionReplyTextPlaceholder")}
          className="nodrag nopan min-h-[96px] resize-none border-0 bg-transparent p-0 text-[12px] leading-5 text-white placeholder:text-white/65 shadow-none disabled:cursor-not-allowed disabled:opacity-80 focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      ) : (
        <p className="min-h-[44px] text-[12px] italic leading-5 text-white/80">
          {t("whatsappServiceAiPreview")}
        </p>
      )}
    </div>
  );
}

/** What the message type adds under the bubble. */
export function InstagramReplyPreview({
  editor,
  t,
}: {
  editor: InstagramReplyEditor;
  t: TranslateFn;
}) {
  const {
    draft,
    normalizedConfig,
    connected,
    quickReplies,
    quickReplyKeys,
    buttons,
    buttonKeys,
    cards,
  } = editor;
  const connectionLabel = (payload?: string) =>
    t(
      payload && connected.has(payload)
        ? "sourceHandleStatusConnected"
        : "sourceHandleStatusUnlinked"
    );

  return (
    <>
      {draft.kind === "quick_replies" && quickReplies.length > 0 ? (
        <QuickRepliesPreview
          quickReplies={quickReplies}
          keys={quickReplyKeys}
          connected={connected}
          connectionLabel={connectionLabel}
        />
      ) : null}

      {draft.kind === "button_template" ? (
        <ButtonsPreview
          buttons={buttons}
          keys={buttonKeys}
          connected={connected}
          connectionLabel={connectionLabel}
        />
      ) : null}

      {draft.kind === "generic_template" ? (
        <CardsPreview
          cards={cards}
          connected={connected}
          connectionLabel={connectionLabel}
        />
      ) : null}

      {draft.kind === "media" ? (
        <MediaPreview config={normalizedConfig} />
      ) : null}
    </>
  );
}

function QuickRepliesPreview({
  quickReplies,
  keys,
  connected,
  connectionLabel,
}: {
  quickReplies: readonly ScenarioInstagramQuickReply[];
  keys: readonly string[];
  connected: ReadonlySet<string>;
  connectionLabel: ConnectionLabel;
}) {
  return (
    <div className="ml-auto flex max-w-[88%] flex-wrap justify-end gap-1">
      {quickReplies.map((option, index) => (
        <span
          key={keys[index]}
          className="flex items-center gap-1 rounded-full border border-[#405DE6]/30 bg-white px-2 py-1 text-[11px] font-medium text-[#405DE6] shadow-sm dark:bg-zinc-950"
        >
          {option.title}
          <BranchConnectionDot
            connected={connected.has(option.payload)}
            label={connectionLabel(option.payload)}
            payload={option.payload}
            missingClassName="border-pink-300 bg-pink-200"
          />
        </span>
      ))}
    </div>
  );
}

function ButtonsPreview({
  buttons,
  keys,
  connected,
  connectionLabel,
}: {
  buttons: readonly ScenarioInstagramButton[];
  keys: readonly string[];
  connected: ReadonlySet<string>;
  connectionLabel: ConnectionLabel;
}) {
  return (
    <div className="ml-auto w-[86%] overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      {buttons.map((button, index) => (
        <div
          key={keys[index]}
          className="flex min-h-8 items-center justify-center gap-1 border-b border-zinc-100 px-3 py-2 text-[12px] font-semibold text-[#405DE6] last:border-b-0 dark:border-zinc-800"
        >
          {button.title}
          <BranchConnectionDot
            connected={Boolean(button.payload && connected.has(button.payload))}
            label={connectionLabel(button.payload)}
            payload={button.type === "postback" ? button.payload : undefined}
            missingClassName="border-pink-300 bg-pink-200"
          />
        </div>
      ))}
    </div>
  );
}

/** The first two cards, as the carousel opens. */
function CardsPreview({
  cards,
  connected,
  connectionLabel,
}: {
  cards: readonly ScenarioInstagramGenericCard[];
  connected: ReadonlySet<string>;
  connectionLabel: ConnectionLabel;
}) {
  return (
    <div className="ml-auto flex max-w-[92%] gap-2 overflow-hidden">
      {cards.slice(0, 2).map(card => (
        <div
          key={card.id}
          className="w-[168px] shrink-0 overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
        >
          <div className="aspect-[1.6] bg-gradient-to-tr from-[#FCAF45]/80 via-[#E1306C]/80 to-[#405DE6]/80">
            {isHttpUrl(card.imageUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={card.imageUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <div className="space-y-0.5 p-2">
            <p className="truncate text-[12px] font-semibold">{card.title}</p>
            {card.subtitle ? (
              <p className="truncate text-[10px] text-zinc-500">
                {card.subtitle}
              </p>
            ) : null}
          </div>
          <CardButtonsPreview
            buttons={card.buttons ?? []}
            connected={connected}
            connectionLabel={connectionLabel}
          />
        </div>
      ))}
    </div>
  );
}

function CardButtonsPreview({
  buttons,
  connected,
  connectionLabel,
}: {
  buttons: readonly ScenarioInstagramButton[];
  connected: ReadonlySet<string>;
  connectionLabel: ConnectionLabel;
}) {
  const keys = useStableItemKeys(buttons);
  return (
    <>
      {buttons.map((button, index) => (
        <div
          key={keys[index]}
          className="flex items-center justify-center gap-1 border-t border-zinc-100 px-2 py-1.5 text-[11px] font-semibold text-[#405DE6] dark:border-zinc-800"
        >
          {button.title}
          <BranchConnectionDot
            connected={Boolean(button.payload && connected.has(button.payload))}
            label={connectionLabel(button.payload)}
            payload={button.type === "postback" ? button.payload : undefined}
            missingClassName="border-pink-300 bg-pink-200"
          />
        </div>
      ))}
    </>
  );
}

/** Reads the stored config, which keeps only a valid link, not the typed one. */
function MediaPreview({ config }: { config: ScenarioInstagramConfig }) {
  return (
    <div className="ml-auto w-[86%] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex aspect-video items-center justify-center">
        {config.mediaUrl && config.mediaType === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={config.mediaUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-7 w-7 text-zinc-400" aria-hidden />
        )}
      </div>
    </div>
  );
}
