// ISO 3166-1 alpha-2 country codes and their names in the app languages.
// Client-safe: no "use client", no server-only modules.
//
// TIKTOK_DISCOVERY_MARKETS (lib/creative-assets/tiktok-marketing-templates.ts)
// is not reused: it is the list of TikTok markets, it lacks CW (Curaçao),
// MF (Saint Martin) and SX (Sint Maarten), and it belongs to another feature.

import { KAZAKH_COUNTRY_NAMES } from "./kazakh-country-names";

/** Every ISO 3166-1 alpha-2 code (249), sorted. */
export const ISO_COUNTRY_CODES = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
] as const;

export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

const ISO_COUNTRY_CODE_SET: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);

/** The languages whose country names resolveCountryCode accepts. */
const COUNTRY_NAME_LANGUAGES = ["en", "ru", "kk"] as const;

const regionNamesByLanguage = new Map<string, Intl.DisplayNames | null>();
let countryCodeByName: Map<string, IsoCountryCode> | null = null;

function getRegionNames(locale: string): Intl.DisplayNames | null {
  // The app calls Kazakh "kz"; Intl knows it as "kk".
  const language = locale === "kz" ? "kk" : locale;
  const cached = regionNamesByLanguage.get(language);
  if (cached !== undefined) return cached;

  let regionNames: Intl.DisplayNames | null = null;
  try {
    if (typeof Intl.DisplayNames === "function") {
      regionNames = new Intl.DisplayNames([language], { type: "region" });
    }
  } catch {
    regionNames = null;
  }
  regionNamesByLanguage.set(language, regionNames);
  return regionNames;
}

function getRegionName(
  regionNames: Intl.DisplayNames | null,
  code: string
): string | null {
  try {
    const name = regionNames?.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * The country's name in an Intl language, or null. Kazakh names come from
 * the CLDR table, because Chromium-based browsers have none.
 */
function getCountryName(language: string, code: string): string | null {
  if (language === "kk") {
    return ISO_COUNTRY_CODE_SET.has(code)
      ? KAZAKH_COUNTRY_NAMES[code as IsoCountryCode]
      : null;
  }
  return getRegionName(getRegionNames(language), code);
}

function foldCountryName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/ё/g, "е");
}

function getCountryCodeByName(): Map<string, IsoCountryCode> {
  if (countryCodeByName) return countryCodeByName;
  const codeByName = new Map<string, IsoCountryCode>();
  for (const language of COUNTRY_NAME_LANGUAGES) {
    for (const code of ISO_COUNTRY_CODES) {
      const name = getCountryName(language, code);
      if (!name) continue;
      const key = foldCountryName(name);
      if (!codeByName.has(key)) codeByName.set(key, code);
    }
  }
  countryCodeByName = codeByName;
  return codeByName;
}

/**
 * The country's name in an app locale: "Kazakhstan" for ("KZ", "en") and
 * "Қазақстан" for ("KZ", "kz"). The code itself when the browser has no name.
 */
export function getCountryLabel(code: string, locale: string): string {
  const language = locale === "kz" ? "kk" : locale;
  return getCountryName(language, code.toUpperCase()) ?? code;
}

/**
 * The ISO code for "kz", "KZ", "Kazakhstan", "Казахстан" or "Қазақстан":
 * a listed code in any case, or a country name in English, Russian or Kazakh,
 * ignoring case, extra spaces and ё/е. Anything else is null.
 */
export function resolveCountryCode(value: unknown): IsoCountryCode | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (!text) return null;

  const code = text.toUpperCase();
  if (ISO_COUNTRY_CODE_SET.has(code)) return code as IsoCountryCode;
  return getCountryCodeByName().get(foldCountryName(text)) ?? null;
}
