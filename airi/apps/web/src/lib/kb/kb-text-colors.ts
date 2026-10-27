export type KBColorKind = "text" | "highlight";

export type KBColorSwatch = {
  label: string;
  value: string;
};

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const TEXT_COLOR_SWATCHES: KBColorSwatch[] = [
  { label: "Slate", value: "#111827" },
  { label: "Gray", value: "#4b5563" },
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Amber", value: "#d97706" },
  { label: "Green", value: "#16a34a" },
  { label: "Blue", value: "#2563eb" },
  { label: "Violet", value: "#7c3aed" },
  { label: "Pink", value: "#db2777" },
];

const HIGHLIGHT_COLOR_SWATCHES: KBColorSwatch[] = [
  { label: "Yellow", value: "#fef3c7" },
  { label: "Amber", value: "#fde68a" },
  { label: "Orange", value: "#fed7aa" },
  { label: "Red", value: "#fecaca" },
  { label: "Green", value: "#bbf7d0" },
  { label: "Cyan", value: "#a5f3fc" },
  { label: "Blue", value: "#bfdbfe" },
  { label: "Violet", value: "#ddd6fe" },
  { label: "Pink", value: "#fbcfe8" },
];

function expandShortHex(value: string): string {
  if (value.length !== 4) return value.toLowerCase();

  const [, red = "", green = "", blue = ""] = value;
  return `#${red}${red}${green}${green}${blue}${blue}`.toLowerCase();
}

export function sanitizeKBColorValue(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (!HEX_COLOR_PATTERN.test(normalized)) return null;

  return expandShortHex(normalized);
}

export function readKBTextStyleColors(attrs: Record<string, unknown>): {
  textColor: string | null;
  highlightColor: string | null;
} {
  return {
    textColor: sanitizeKBColorValue(attrs.color),
    highlightColor: sanitizeKBColorValue(attrs.backgroundColor),
  };
}

export function getKBColorSwatches(kind: KBColorKind): KBColorSwatch[] {
  return kind === "text" ? TEXT_COLOR_SWATCHES : HIGHLIGHT_COLOR_SWATCHES;
}
