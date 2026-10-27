import type {
  ScenarioInstagramButton,
  ScenarioInstagramConfig,
  ScenarioInstagramGenericCard,
  TranslateFn,
} from "@/components/scenarios/types";
import {
  generateInstagramPayload,
  normalizeInstagramConfig,
} from "@/lib/scenarios/instagram-reply-config";
import type { FocusEvent } from "react";

export function configKey(config: ScenarioInstagramConfig): string {
  return JSON.stringify(config);
}

/** Previews load only complete links, not one being typed. */
export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A Link button with text but no valid link yet, which storage can't hold. */
function isPendingLinkButton(button: ScenarioInstagramButton): boolean {
  return (
    button.type === "web_url" &&
    button.title.trim().length > 0 &&
    !isHttpUrl(button.url?.trim())
  );
}

/**
 * What the fields show once focus leaves the builder: the stored config, plus
 * the Link buttons still waiting for a link, so they stay on screen with an
 * error instead of disappearing. A change made elsewhere wins.
 */
export function settleInstagramDraft(
  draft: ScenarioInstagramConfig,
  stored: ScenarioInstagramConfig
): ScenarioInstagramConfig {
  const draftButtons = draft.buttons ?? [];
  if (
    !draftButtons.some(isPendingLinkButton) ||
    configKey(normalizeInstagramConfig(draft)) !== configKey(stored)
  ) {
    return stored;
  }
  // Stored buttons are the draft's non-pending buttons that have text, in order.
  const storedButtons = [...(stored.buttons ?? [])];
  const buttons = draftButtons.flatMap(button => {
    if (isPendingLinkButton(button)) {
      return [{ ...button, title: button.title.trim() }];
    }
    if (!button.title.trim()) return [];
    const storedButton = storedButtons.shift();
    return storedButton ? [storedButton] : [];
  });
  return { ...stored, buttons };
}

/** Focus moved to another field of the builder, or into a menu it opened. */
export function keepsFocusInBuilder(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  if (!(next instanceof Element)) return false;
  return (
    event.currentTarget.contains(next) ||
    next.closest("[data-radix-popper-content-wrapper]") !== null
  );
}

export function createPostbackButton(title: string): ScenarioInstagramButton {
  return {
    type: "postback",
    title,
    payload: generateInstagramPayload(title),
  };
}

export function createCard(index: number, t: TranslateFn) {
  return {
    id: `card-${index + 1}`,
    title: t("instagramDefaultCard", { n: index + 1 }),
    subtitle: "",
    buttons: [createPostbackButton(t("instagramDefaultCardButton"))],
  } satisfies ScenarioInstagramGenericCard;
}
