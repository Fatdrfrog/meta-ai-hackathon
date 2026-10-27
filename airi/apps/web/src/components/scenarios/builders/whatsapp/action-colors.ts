/**
 * Scenarios: WhatsApp template list / interactive action label and control color.
 * Use for preview bubbles, CTA label strip, and related icons (not the OS status bar #075e54).
 */
export const WHATSAPP_ACTION_BUTTON_COLOR = "#1b8755" as const;

/** Tailwind arbitrary-value classes (import where `cn()` is used). */
export const waActionButton = {
  text: "text-[#1b8755]",
  inlineEditText:
    "text-[15px] font-normal text-[#1b8755] [&_.ProseMirror]:text-[#1b8755] [&_.ProseMirror]:text-center",
  textMuted: "text-[#1b8755]/85",
  placeholder: "placeholder:text-[#1b8755]/45",
  placeholderDark: "dark:placeholder:text-[#1b8755]/40",
  focusRing: "focus-visible:ring-2 focus-visible:ring-[#1b8755]/30",
  icon: "text-[#1b8755]",
  /** Shadcn `<Button />` may override `text-*`; use on icon CTAs. */
  textShadcnOverride: "!text-[#1b8755]",
} as const;
