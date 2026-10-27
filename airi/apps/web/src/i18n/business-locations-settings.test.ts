import { execFileSync } from "node:child_process";
import path from "path";
import { SCENARIO_BUSINESS_LOCATION_ISSUES } from "@icecore/scenario-contracts";
import type {
  BusinessLocationColumn,
  BusinessLocationImportErrorCode,
} from "@/lib/business-locations/import";
import { BUSINESS_LOCATIONS_ERROR_CODES } from "@/lib/business-locations/types";
import { loadSettingsClientMessages } from "./message-loader";

const LOCALES = ["en", "ru", "kz"] as const;
const TITLES = { en: "Offices", ru: "Филиалы", kz: "Филиалдар" } as const;

const IMPORT_ERROR_CODES = [
  "empty_file",
  "invalid_file",
  "invalid_encoding",
  "missing_columns",
  "too_many_rows",
  "invalid_row",
  "country_unknown",
  "coordinates_missing",
  "coordinates_short_link",
  "coordinates_no_point",
  "key_not_derivable",
  "duplicate_key",
  "active_invalid",
] as const satisfies readonly BusinessLocationImportErrorCode[];

const IMPORT_COLUMNS = [
  "key",
  "name",
  "country",
  "city",
  "address",
  "phone",
  "latitude",
  "longitude",
  "coordinates",
  "mapUrl",
  "tags",
  "active",
  "sortOrder",
] as const satisfies readonly BusinessLocationColumn[];

// Fails to compile when import.ts gains an error code or a column that the
// lists above, and so this test, would miss.
type Unlisted =
  | Exclude<
      BusinessLocationImportErrorCode,
      (typeof IMPORT_ERROR_CODES)[number]
    >
  | Exclude<BusinessLocationColumn, (typeof IMPORT_COLUMNS)[number]>;
const everyCodeListed: [Unlisted] extends [never] ? true : never = true;

type Messages = Record<string, unknown>;

async function loadOfficeMessages(locale: (typeof LOCALES)[number]) {
  const messages = await loadSettingsClientMessages(locale);
  return messages.BusinessLocationsSettings as Messages;
}

function readString(messages: Messages, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Messages)[part] : undefined,
      messages
    );
}

function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const leafKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") leaves.set(leafKey, value);
    else {
      for (const entry of flatten(value as Messages, leafKey)) {
        leaves.set(...entry);
      }
    }
  }
  return leaves;
}

/** The argument names a message uses, e.g. {name} and {count, plural, …}. */
function argumentNames(message: string): string[] {
  return [
    ...new Set(
      [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map(
        match => match[1]
      )
    ),
  ].sort();
}

test.each(LOCALES)(
  "loads complete Offices settings messages for %s",
  async locale => {
    const settings = await loadOfficeMessages(locale);

    expect(settings.title).toBe(TITLES[locale]);
    expect(everyCodeListed).toBe(true);
    const required = [
      ...BUSINESS_LOCATIONS_ERROR_CODES.map(code => `errors.${code}`),
      "errors.access_denied",
      "errors.unknown",
      ...SCENARIO_BUSINESS_LOCATION_ISSUES.map(issue => `issues.${issue}`),
      ...IMPORT_ERROR_CODES.map(code => `import.errors.${code}`),
      ...IMPORT_COLUMNS.map(column => `import.columnNames.${column}`),
    ];
    for (const key of required) {
      const value = readString(settings, key);
      expect([key, typeof value === "string" && value.trim() !== ""]).toEqual([
        key,
        true,
      ]);
    }
    expect(readString(settings, "errors.office_limit")).toContain("{limit}");
    expect(readString(settings, "import.rowError")).toContain("{row}");
    expect(readString(settings, "import.rowError")).toContain("{message}");
    expect(readString(settings, "dialog.mapUrlHint")).toContain("{token}");
  }
);

test("keeps the same keys and placeholders in every locale", async () => {
  const english = flatten(await loadOfficeMessages("en"));
  for (const locale of ["ru", "kz"] as const) {
    const translated = flatten(await loadOfficeMessages(locale));
    expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, message] of english) {
      expect([locale, key, argumentNames(translated.get(key)!)]).toEqual([
        locale,
        key,
        argumentNames(message),
      ]);
    }
  }
});

test("formats every message with next-intl in every locale", async () => {
  const catalogs = Object.fromEntries(
    await Promise.all(
      LOCALES.map(
        async locale => [locale, await loadOfficeMessages(locale)] as const
      )
    )
  );
  // next-intl is ESM-only; run its real formatter outside Jest's CJS loader.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { readFileSync } from "node:fs";
      import { createTranslator } from "next-intl";
      const catalogs = JSON.parse(readFileSync(0, "utf8"));
      const errors = [];
      const samples = {};
      const leaves = (node, prefix = "") =>
        Object.entries(node).flatMap(([key, value]) =>
          typeof value === "string"
            ? [[prefix + key, value]]
            : leaves(value, prefix + key + "."));
      for (const [locale, messages] of Object.entries(catalogs)) {
        const t = createTranslator({
          locale,
          messages: { BusinessLocationsSettings: messages },
          namespace: "BusinessLocationsSettings",
          onError: error => errors.push(locale + ": " + error.message),
        });
        for (const [key, message] of leaves(messages)) {
          const values = {};
          for (const [, name, kind] of message.matchAll(/\\{\\s*([A-Za-z_]\\w*)\\s*(?:,\\s*(plural|select))?/g)) {
            values[name] = kind === "plural" ? 2 : "x";
          }
          t(key, values);
        }
        samples[locale] = [1, 2, 5].map(count => [
          t("summary", { active: count, cities: count, countries: count }),
          t("import.deactivateMissing", { count }),
          t("import.submit", { count }),
        ]);
      }
      process.stdout.write(JSON.stringify({ errors, samples }));
      `,
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      input: JSON.stringify(catalogs),
      encoding: "utf8",
      windowsHide: true,
    }
  );
  const { errors, samples } = JSON.parse(output) as {
    errors: string[];
    samples: Record<string, string[][]>;
  };

  expect(errors).toEqual([]);
  expect(samples.en[0]).toEqual([
    "1 active office · 1 city · 1 country",
    "Deactivate 1 office missing from the file",
    "Import 1 office",
  ]);
  expect(samples.ru).toEqual([
    [
      "1 активный филиал · 1 город · 1 страна",
      "Деактивировать 1 филиал, которого нет в файле",
      "Импортировать 1 филиал",
    ],
    [
      "2 активных филиала · 2 города · 2 страны",
      "Деактивировать 2 филиала, которых нет в файле",
      "Импортировать 2 филиала",
    ],
    [
      "5 активных филиалов · 5 городов · 5 стран",
      "Деактивировать 5 филиалов, которых нет в файле",
      "Импортировать 5 филиалов",
    ],
  ]);
  expect(samples.kz[2]).toEqual([
    "5 белсенді филиал · 5 қала · 5 ел",
    "Файлда жоқ 5 филиалды өшіру",
    "5 филиалды импорттау",
  ]);
});
