"use client";

import type {
  ScenarioInstagramButton,
  ScenarioInstagramConfig,
  ScenarioInstagramGenericCard,
  ScenarioInstagramMediaType,
  ScenarioInstagramMessageKind,
  TranslateFn,
} from "@/components/scenarios/types";
import {
  DEFAULT_INSTAGRAM_CONFIG,
  generateInstagramPayload,
  INSTAGRAM_GENERIC_CARD_MAX_COUNT,
  INSTAGRAM_QUICK_REPLY_MAX_COUNT,
  INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT,
  normalizeInstagramConfig,
} from "@/lib/scenarios/instagram-reply-config";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import { useDeferredBranchSync } from "../use-deferred-branch-sync";
import { useStableItemKeys } from "../use-stable-item-keys";
import {
  configKey,
  createCard,
  createPostbackButton,
  keepsFocusInBuilder,
  settleInstagramDraft,
} from "./instagram-reply-model";

type CommitOptions = { syncBranches?: boolean; markBranchDirty?: boolean };

const TEXT_EDIT: CommitOptions = { syncBranches: false };
const NON_ROUTE_EDIT: CommitOptions = {
  syncBranches: false,
  markBranchDirty: false,
};

/**
 * The config as the merchant types it. Each edit stores its normalized form,
 * which trims text and drops items without a title or a valid link, so the
 * inputs read from this draft: a trailing space, an emptied title or a Link
 * button without its link stays on screen until focus leaves the builder.
 * A config changed elsewhere (undo, another editor) replaces the draft.
 */
function useInstagramConfigDraft(committed: ScenarioInstagramConfig) {
  const committedKey = configKey(committed);
  const [state, setState] = useState(() => ({
    committedKey,
    draft: committed,
  }));
  let draft = state.draft;
  if (state.committedKey !== committedKey) {
    const ownCommit =
      configKey(normalizeInstagramConfig(state.draft)) === committedKey;
    draft = ownCommit ? state.draft : committed;
    setState({ committedKey, draft });
  }
  const setDraft = useCallback((next: ScenarioInstagramConfig) => {
    setState(current => ({ ...current, draft: next }));
  }, []);
  return [draft, setDraft] as const;
}

/**
 * The builder's draft and its edits. The preview and the fields read the
 * same lists and row keys, so a row keeps its key in both.
 */
export function useInstagramReplyEditor({
  config,
  connectedPayloads,
  onConfigChange,
  onBranchOptionsChanged,
  t,
}: {
  config?: ScenarioInstagramConfig;
  connectedPayloads?: readonly string[];
  onConfigChange: (next: ScenarioInstagramConfig) => void;
  onBranchOptionsChanged?: (next: ScenarioInstagramConfig) => void;
  t: TranslateFn;
}) {
  const [editingLinkIndex, setEditingLinkIndex] = useState<number | null>(null);
  /** Button whose link field takes focus when its type menu closes. */
  const focusLinkOnCloseRef = useRef<number | null>(null);
  const normalizedConfig = useMemo(
    () => normalizeInstagramConfig(config ?? DEFAULT_INSTAGRAM_CONFIG),
    [config]
  );
  const [draft, setDraft] = useInstagramConfigDraft(normalizedConfig);
  const connected = useMemo(
    () => new Set(connectedPayloads ?? []),
    [connectedPayloads]
  );

  const { commitValue: commitConfigValue, syncDirtyBranches } =
    useDeferredBranchSync({
      value: normalizedConfig,
      onChange: onConfigChange,
      onBranchOptionsChanged,
    });

  const commitConfig = useCallback(
    (next: ScenarioInstagramConfig, options: CommitOptions = {}) => {
      const normalized = normalizeInstagramConfig(next);
      commitConfigValue(normalized, options);
    },
    [commitConfigValue]
  );

  /** Shows `next` as typed and stores its normalized form. */
  const commitDraft = useCallback(
    (next: ScenarioInstagramConfig, options: CommitOptions = {}) => {
      setDraft(next);
      const normalized = normalizeInstagramConfig(next);
      if (
        options.syncBranches === false &&
        configKey(normalized) === configKey(normalizedConfig)
      ) {
        return;
      }
      commitConfigValue(normalized, options);
    },
    [commitConfigValue, normalizedConfig, setDraft]
  );

  /**
   * When focus leaves the builder, routes catch up and the fields show what was
   * stored. Moving between its fields keeps the draft, so an emptied item
   * doesn't vanish (and shift the rows) while the merchant is still editing.
   */
  const handleBuilderBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (keepsFocusInBuilder(event)) return;
      syncDirtyBranches();
      setDraft(settleInstagramDraft(draft, normalizedConfig));
    },
    [draft, normalizedConfig, setDraft, syncDirtyBranches]
  );

  useEffect(() => {
    if (
      JSON.stringify(normalizeInstagramConfig(config)) ===
      JSON.stringify(normalizedConfig)
    ) {
      return;
    }
    commitConfig(normalizedConfig);
  }, [commitConfig, config, normalizedConfig]);

  const quickReplies = useMemo(
    () => draft.quickReplies ?? [],
    [draft.quickReplies]
  );
  const buttons = useMemo(() => draft.buttons ?? [], [draft.buttons]);
  const cards = useMemo(() => draft.cards ?? [], [draft.cards]);
  const quickReplyKeys = useStableItemKeys(quickReplies);
  const buttonKeys = useStableItemKeys(buttons);

  const updateKind = useCallback(
    (kind: ScenarioInstagramMessageKind) => {
      if (kind === draft.kind) return;
      if (kind === "quick_replies") {
        commitDraft({ kind, quickReplies });
        return;
      }
      if (kind === "button_template") {
        commitDraft({
          kind,
          buttons:
            buttons.length > 0
              ? buttons
              : [createPostbackButton(t("instagramDefaultButton", { n: 1 }))],
        });
        return;
      }
      if (kind === "generic_template") {
        commitDraft({
          kind,
          cards: cards.length > 0 ? cards : [createCard(0, t)],
        });
        return;
      }
      if (kind === "media") {
        commitDraft({
          kind,
          mediaType: draft.mediaType ?? "image",
          mediaUrl: draft.mediaUrl ?? "",
        });
        return;
      }
      commitDraft({ kind });
    },
    [buttons, cards, commitDraft, draft, quickReplies, t]
  );

  const updateQuickReply = useCallback(
    (index: number, title: string) => {
      const next = [...quickReplies];
      const current = next[index];
      if (!current) return;
      next[index] = { ...current, title };
      commitDraft(
        { ...draft, kind: "quick_replies", quickReplies: next },
        TEXT_EDIT
      );
    },
    [commitDraft, draft, quickReplies]
  );

  const addQuickReply = useCallback(() => {
    if (quickReplies.length >= INSTAGRAM_QUICK_REPLY_MAX_COUNT) return;
    const title = t("instagramDefaultOption", { n: quickReplies.length + 1 });
    commitDraft({
      ...draft,
      kind: "quick_replies",
      quickReplies: [
        ...quickReplies,
        { title, payload: generateInstagramPayload(title) },
      ],
    });
  }, [commitDraft, draft, quickReplies, t]);

  const removeQuickReply = useCallback(
    (index: number) => {
      commitDraft({
        ...draft,
        kind: "quick_replies",
        quickReplies: quickReplies.filter(
          (_, itemIndex) => itemIndex !== index
        ),
      });
    },
    [commitDraft, draft, quickReplies]
  );

  const updateButton = useCallback(
    (
      index: number,
      patch: Partial<ScenarioInstagramButton>,
      options: CommitOptions = {}
    ) => {
      const next = [...buttons];
      const current = next[index];
      if (!current) return;
      next[index] = { ...current, ...patch } as ScenarioInstagramButton;
      commitDraft({ ...draft, buttons: next }, options);
    },
    [buttons, commitDraft, draft]
  );

  /** A Link button has no route, so its text leaves the routes alone. */
  const updateButtonTitle = useCallback(
    (index: number, title: string) => {
      updateButton(
        index,
        { title },
        buttons[index]?.type === "web_url" ? NON_ROUTE_EDIT : TEXT_EDIT
      );
    },
    [buttons, updateButton]
  );

  const updateButtonUrl = useCallback(
    (index: number, url: string) => {
      updateButton(index, { url }, NON_ROUTE_EDIT);
    },
    [updateButton]
  );

  const changeButtonType = useCallback(
    (index: number, type: ScenarioInstagramButton["type"]) => {
      const current = buttons[index];
      if (!current || current.type === type) return;
      focusLinkOnCloseRef.current = type === "web_url" ? index : null;
      updateButton(
        index,
        type === "web_url"
          ? { type, payload: undefined, url: "" }
          : {
              type,
              url: undefined,
              payload: generateInstagramPayload(current.title),
            }
      );
    },
    [buttons, updateButton]
  );

  const handleButtonTypeMenuOpenChange = useCallback((open: boolean) => {
    if (open) focusLinkOnCloseRef.current = null;
  }, []);

  /** Whether closing this button's type menu should focus its link field. */
  const takeLinkFocusOnMenuClose = useCallback((index: number) => {
    if (focusLinkOnCloseRef.current !== index) return false;
    focusLinkOnCloseRef.current = null;
    return true;
  }, []);

  const addButton = useCallback(() => {
    if (buttons.length >= INSTAGRAM_TEMPLATE_BUTTON_MAX_COUNT) return;
    commitDraft({
      ...draft,
      buttons: [
        ...buttons,
        createPostbackButton(
          t("instagramDefaultButton", { n: buttons.length + 1 })
        ),
      ],
    });
  }, [buttons, commitDraft, draft, t]);

  const removeButton = useCallback(
    (index: number) => {
      commitDraft({
        ...draft,
        buttons: buttons.filter((_, itemIndex) => itemIndex !== index),
      });
    },
    [buttons, commitDraft, draft]
  );

  const updateCard = useCallback(
    (index: number, patch: Partial<ScenarioInstagramGenericCard>) => {
      const next = [...cards];
      const current = next[index];
      if (!current) return;
      next[index] = { ...current, ...patch };
      commitDraft(
        { ...draft, kind: "generic_template", cards: next },
        NON_ROUTE_EDIT
      );
    },
    [cards, commitDraft, draft]
  );

  const addCard = useCallback(() => {
    if (cards.length >= INSTAGRAM_GENERIC_CARD_MAX_COUNT) return;
    commitDraft({
      ...draft,
      kind: "generic_template",
      cards: [...cards, createCard(cards.length, t)],
    });
  }, [cards, commitDraft, draft, t]);

  const removeCard = useCallback(
    (index: number) => {
      commitDraft({
        ...draft,
        kind: "generic_template",
        cards: cards.filter((_, itemIndex) => itemIndex !== index),
      });
    },
    [cards, commitDraft, draft]
  );

  const updateMediaType = useCallback(
    (mediaType: ScenarioInstagramMediaType) => {
      commitDraft({ ...draft, kind: "media", mediaType });
    },
    [commitDraft, draft]
  );

  const updateMediaUrl = useCallback(
    (mediaUrl: string) => {
      commitDraft({ ...draft, kind: "media", mediaUrl }, NON_ROUTE_EDIT);
    },
    [commitDraft, draft]
  );

  return {
    draft,
    normalizedConfig,
    connected,
    quickReplies,
    quickReplyKeys,
    buttons,
    buttonKeys,
    cards,
    editingLinkIndex,
    setEditingLinkIndex,
    handleBuilderBlur,
    updateKind,
    updateQuickReply,
    addQuickReply,
    removeQuickReply,
    updateButtonTitle,
    updateButtonUrl,
    changeButtonType,
    handleButtonTypeMenuOpenChange,
    takeLinkFocusOnMenuClose,
    addButton,
    removeButton,
    updateCard,
    addCard,
    removeCard,
    updateMediaType,
    updateMediaUrl,
  };
}

export type InstagramReplyEditor = ReturnType<typeof useInstagramReplyEditor>;
