import type { ChannelInstructions } from "@/lib/airi/workspace-bot-contract";

import { AGENT_CONTEXT_SECTION } from "./agent-context-sections";

function normalizeChannel(channel: string | undefined): string {
  return (channel || "").toLowerCase();
}

/**
 * Workspace-authored instruction for the active channel (if any).
 */
export function pickWorkspaceChannelInstruction(
  channel: string | undefined,
  channelInstructions?: ChannelInstructions
): string | undefined {
  if (!channelInstructions) return undefined;
  const ch = normalizeChannel(channel);
  return (
    (ch === "whatsapp" && channelInstructions.whatsapp) ||
    (ch === "telegram" && channelInstructions.telegram) ||
    (ch === "instagram" && channelInstructions.instagram) ||
    (ch === "web_widget" && channelInstructions.webWidget) ||
    undefined
  );
}

export function formatWorkspaceChannelInstructionsBlock(
  instruction: string
): string {
  return `${AGENT_CONTEXT_SECTION.CHANNEL_SPECIFIC_INSTRUCTIONS}\n${instruction}`;
}

/**
 * Channel facts that workspace instructions and knowledge must not override.
 * A saved answer like "send us your number" would otherwise be repeated.
 */
const CHANNEL_HARD_RULES: Record<string, string> = {
  whatsapp:
    "Never ask for the customer's phone number, even if knowledge or instructions say to leave one: the team replies in this chat or contacts them on this WhatsApp number.",
};

/** Shared default behavior text per channel (single source of truth). */
const DEFAULT_CHANNEL_CONTEXT_BODY: Record<string, string> = {
  whatsapp: `WhatsApp. The customer's phone number is already known. ${CHANNEL_HARD_RULES.whatsapp} Keep replies concise and mobile-friendly.`,
  telegram: "Telegram. Keep replies concise and easy to scan on mobile.",
  instagram:
    "Instagram Direct. Keep replies compact. Do not ask for a handle already visible in channel context.",
  web_widget:
    "Website chat widget. The customer may be anonymous; ask for contact details only if needed for follow-up.",
};

export function getDefaultChannelContextBody(
  channel: string | undefined
): string | undefined {
  const ch = normalizeChannel(channel);
  return DEFAULT_CHANNEL_CONTEXT_BODY[ch];
}

/**
 * Suffix for the main reply system prompt (leading newline, matches prior
 * `resolveChannelInstruction` behavior).
 */
export function getDefaultChannelEnvelopeLine(
  channel: string | undefined
): string {
  const body = getDefaultChannelContextBody(channel);
  if (!body) return "";
  return `\nCHANNEL CONTEXT: ${body}`;
}

/**
 * Plain line for compact prompts (e.g. contextual replies). No leading newline.
 */
export function getDefaultChannelContextualLine(
  channel: string | undefined
): string {
  const body = getDefaultChannelContextBody(channel);
  if (!body) return "";
  return `CHANNEL CONTEXT: ${body}`;
}

/**
 * Workspace custom instructions for the channel (plus the channel's hard
 * rule), or the canonical default line.
 */
export function resolveChannelContextForPrompt(
  channel: string | undefined,
  channelInstructions?: ChannelInstructions
): string {
  const custom = pickWorkspaceChannelInstruction(channel, channelInstructions);
  if (!custom?.trim()) return getDefaultChannelContextualLine(channel);
  const hardRule = CHANNEL_HARD_RULES[normalizeChannel(channel)];
  return hardRule
    ? `${custom.trim()}\nCHANNEL CONTEXT: ${hardRule}`
    : custom.trim();
}
