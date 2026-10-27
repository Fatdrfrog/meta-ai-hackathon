import { KB_GOOGLE_FONT_OPTIONS } from "./kb-google-font-options";

export type KBGoogleFontOption = {
  family: string;
  category: string;
};

const GOOGLE_FONTS_BASE_URL = "https://fonts.googleapis.com/css2";
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,79}$/;
const FONT_DECLARATION_PATTERN =
  /font-family\s*:\s*([^;"']+|"[^"]+"|'[^']+')/gi;
const GOOGLE_FONTS_LINK_ID = "kb-google-fonts-stylesheet";

const GOOGLE_FONT_OPTIONS = KB_GOOGLE_FONT_OPTIONS.filter(
  font => sanitizeKBGoogleFontFamily(font.family) !== null
);
const GOOGLE_FONT_FAMILY_SET = new Set(
  GOOGLE_FONT_OPTIONS.map(option => option.family)
);

export function getKBGoogleFontOptions(): KBGoogleFontOption[] {
  return GOOGLE_FONT_OPTIONS;
}

export function sanitizeKBGoogleFontFamily(
  value: string | null | undefined
): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || !FONT_FAMILY_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeFontFamilyToken(value: string): string | null {
  const firstFamily = value.split(",")[0]?.trim();
  const unquoted = firstFamily?.replace(/^['"]|['"]$/g, "");

  return sanitizeKBGoogleFontFamily(unquoted);
}

export function extractKBGoogleFontFamilies(html: string): string[] {
  const families: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = FONT_DECLARATION_PATTERN.exec(html)) !== null) {
    const family = normalizeFontFamilyToken(match[1] ?? "");
    if (!family || !GOOGLE_FONT_FAMILY_SET.has(family) || seen.has(family)) {
      continue;
    }

    seen.add(family);
    families.push(family);
  }

  return families;
}

export function buildKBGoogleFontsStylesheetHref(
  families: Array<string | null | undefined>
): string | null {
  const uniqueFamilies = Array.from(
    new Set(
      families
        .map(sanitizeKBGoogleFontFamily)
        .filter(
          (family): family is string =>
            family !== null && GOOGLE_FONT_FAMILY_SET.has(family)
        )
    )
  );

  if (uniqueFamilies.length === 0) {
    return null;
  }

  const familyParams = uniqueFamilies
    .map(family => `family=${encodeURIComponent(family).replace(/%20/g, "+")}`)
    .join("&");

  return `${GOOGLE_FONTS_BASE_URL}?${familyParams}&display=swap`;
}

export function ensureKBGoogleFontsLoaded(
  families: Array<string | null | undefined>
) {
  if (typeof document === "undefined") return;

  const existing = document.getElementById(
    GOOGLE_FONTS_LINK_ID
  ) as HTMLLinkElement | null;
  const existingFamilies =
    existing?.dataset.families?.split("|").filter(Boolean) ?? [];
  const nextFamilies = Array.from(
    new Set([...existingFamilies, ...families].map(sanitizeKBGoogleFontFamily))
  ).filter((family): family is string => Boolean(family));
  const href = buildKBGoogleFontsStylesheetHref(nextFamilies);

  if (!href) return;

  const link = existing ?? document.createElement("link");
  link.id = GOOGLE_FONTS_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.families = nextFamilies.join("|");
  link.dataset.kbGoogleFonts = "true";

  if (!existing) {
    document.head.appendChild(link);
  }
}
