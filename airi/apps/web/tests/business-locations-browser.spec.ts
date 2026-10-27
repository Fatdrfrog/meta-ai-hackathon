import {
  expect,
  test,
  type ConsoleMessage,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import * as XLSX from "xlsx";
import {
  buildScenarioBusinessLocationKey,
  MAX_SCENARIO_BUSINESS_LOCATIONS,
  measureScenarioLocationDistanceMeters,
} from "@icecore/scenario-contracts";
import {
  BUSINESS_LOCATION_EXPORT_HEADERS,
  parseBusinessLocationRows,
} from "../src/lib/business-locations/import";
import {
  MAX_BUSINESS_LOCATION_RECORDS,
  validateBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRecord,
  type BusinessLocationRowIssues,
  type BusinessLocationsErrorBody,
  type BusinessLocationsErrorCode,
} from "../src/lib/business-locations/types";
import {
  readCsvRows,
  toNumberedNonEmptyRows,
} from "../src/lib/spreadsheet/read-rows";
import enMessages from "../messages/settings/business-locations/en/page.json";
import ruMessages from "../messages/settings/business-locations/ru/page.json";
import kzMessages from "../messages/settings/business-locations/kz/page.json";

// Settings → Offices in Chromium: the real manager, dialogs, catalogs, CSS and
// HTTP client. Playwright answers the Offices API from per-test memory and
// validates writes with the same helper the API route uses.

const artifactDir =
  process.env.BUSINESS_LOCATIONS_BROWSER_ARTIFACT_DIR ||
  join(tmpdir(), "airi-business-locations-browser");

/** "desktop" is any width that shows the table (640 px and up). */
type Viewport = { name: "desktop" | "mobile"; width: number; height: number };
const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 1000 };
const MOBILE: Viewport = { name: "mobile", width: 375, height: 812 };
const VIEWPORTS = [DESKTOP, MOBILE];

type Locale = "en" | "ru" | "kz";
const translators = {
  en: createTranslator({
    locale: "en",
    messages: enMessages,
    namespace: "BusinessLocationsSettings",
  }),
  ru: createTranslator({
    locale: "ru",
    messages: ruMessages,
    namespace: "BusinessLocationsSettings",
  }),
  kz: createTranslator({
    locale: "kz",
    messages: kzMessages,
    namespace: "BusinessLocationsSettings",
  }),
};
const t = translators.en;

// ---------------------------------------------------------------------------
// Fixtures: 180 offices in Kazakhstan and Uzbekistan, Cyrillic names, long
// names and addresses, six inactive offices and one pin 640 km from its city.

type City = {
  name: string;
  country: "KZ" | "UZ";
  latitude: number;
  longitude: number;
  count: number;
  phone: string;
  district: string;
  maps: string;
};

const CITIES: City[] = [
  {
    name: "Алматы",
    country: "KZ",
    latitude: 43.238949,
    longitude: 76.889709,
    count: 40,
    phone: "+7 727",
    district: "Бостандыкский район",
    maps: "https://2gis.kz/almaty/firm/",
  },
  {
    name: "Астана",
    country: "KZ",
    latitude: 51.169392,
    longitude: 71.449074,
    count: 30,
    phone: "+7 7172",
    district: "район Есиль",
    maps: "https://2gis.kz/astana/firm/",
  },
  {
    name: "Шымкент",
    country: "KZ",
    latitude: 42.315514,
    longitude: 69.586907,
    count: 20,
    phone: "+7 7252",
    district: "Абайский район",
    maps: "https://2gis.kz/shymkent/firm/",
  },
  {
    name: "Караганда",
    country: "KZ",
    latitude: 49.806406,
    longitude: 73.085485,
    count: 15,
    phone: "+7 7212",
    district: "район имени Казыбек би",
    maps: "https://2gis.kz/karaganda/firm/",
  },
  {
    name: "Актобе",
    country: "KZ",
    latitude: 50.283937,
    longitude: 57.166978,
    count: 10,
    phone: "+7 7132",
    district: "район Астана",
    maps: "https://2gis.kz/aktobe/firm/",
  },
  {
    name: "Павлодар",
    country: "KZ",
    latitude: 52.287303,
    longitude: 76.967402,
    count: 8,
    phone: "+7 7182",
    district: "микрорайон Достык",
    maps: "https://2gis.kz/pavlodar/firm/",
  },
  {
    name: "Атырау",
    country: "KZ",
    latitude: 47.094495,
    longitude: 51.923771,
    count: 8,
    phone: "+7 7122",
    district: "микрорайон Нурсая",
    maps: "https://2gis.kz/atyrau/firm/",
  },
  {
    name: "Усть-Каменогорск",
    country: "KZ",
    latitude: 49.948759,
    longitude: 82.627851,
    count: 7,
    phone: "+7 7232",
    district: "микрорайон Защита",
    maps: "https://2gis.kz/ustkam/firm/",
  },
  {
    name: "Тараз",
    country: "KZ",
    latitude: 42.901183,
    longitude: 71.378309,
    count: 7,
    phone: "+7 7262",
    district: "микрорайон Мынбулак",
    maps: "https://2gis.kz/taraz/firm/",
  },
  {
    name: "Костанай",
    country: "KZ",
    latitude: 53.214917,
    longitude: 63.631672,
    count: 5,
    phone: "+7 7142",
    district: "микрорайон Юбилейный",
    maps: "https://2gis.kz/kostanay/firm/",
  },
  {
    name: "Ташкент",
    country: "UZ",
    latitude: 41.299496,
    longitude: 69.240073,
    count: 20,
    phone: "+998 71",
    district: "Мирзо-Улугбекский район",
    maps: "https://yandex.uz/maps/org/",
  },
  {
    name: "Самарканд",
    country: "UZ",
    latitude: 39.654167,
    longitude: 66.959722,
    count: 6,
    phone: "+998 66",
    district: "махалля Регистан",
    maps: "https://yandex.uz/maps/org/",
  },
  {
    name: "Бухара",
    country: "UZ",
    latitude: 39.767966,
    longitude: 64.421728,
    count: 4,
    phone: "+998 65",
    district: "махалля Ляби-хауз",
    maps: "https://yandex.uz/maps/org/",
  },
];
const STREETS = {
  KZ: [
    "Абая",
    "Достык",
    "Аль-Фараби",
    "Сейфуллина",
    "Толе би",
    "Райымбека",
    "Жибек жолы",
    "Сатпаева",
    "Тимирязева",
    "Розыбакиева",
    "Гагарина",
    "Байтурсынова",
    "Жандосова",
    "Момышулы",
    "Кабанбай батыра",
    "Желтоксан",
  ],
  UZ: [
    "Амира Темура",
    "Навои",
    "Бабура",
    "Мустакиллик",
    "Шота Руставели",
    "Бунёдкор",
    "Ойбек",
  ],
};
const MALLS = [
  "Mega",
  "Достык Плаза",
  "Есентай Молл",
  "Хан Шатыр",
  "Керуен",
  "Апорт",
];
const COUNTRY_NAMES_RU = { KZ: "Казахстан", UZ: "Узбекистан" };
const UPDATED_AT = "2026-10-05T08:00:00.000Z";
const OUTLIER_NAME = "Алматы Арена";

function pad(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

function round6(value: number) {
  return Math.round(value * 1e6) / 1e6;
}

/** A repeatable sequence in [0, 1), so every run gets the same catalog. */
function sequence(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function toRecord(input: BusinessLocationInput): BusinessLocationRecord {
  const result = validateBusinessLocationInput(input);
  if (!result.ok) {
    throw new Error(`Fixture ${input.key}: ${result.issues.join(", ")}`);
  }
  return { ...result.office, isActive: result.isActive, updatedAt: UPDATED_AT };
}

/** Offices for the given cities, with keys made the way an import makes them. */
function buildOffices(
  cities: readonly (City & { count: number })[],
  options: { firstIndex: number; takenKeys: Set<string>; houseBase: number }
): BusinessLocationInput[] {
  const random = sequence(options.firstIndex + 7);
  const inputs: BusinessLocationInput[] = [];
  let index = options.firstIndex;
  for (const city of cities) {
    const streets = STREETS[city.country];
    for (let n = 0; n < city.count; n += 1, index += 1) {
      const street = streets[(index * 5 + n) % streets.length];
      let house = options.houseBase + ((index * 17) % 180) + 1;
      const nameFor = () =>
        index % 9 === 4
          ? `Филиал №${index + 1} на проспекте ${street} с отдельным входом со стороны двора, пунктом выдачи заказов и круглосуточной поддержкой`
          : index % 5 === 2
            ? `ТРЦ «${MALLS[index % MALLS.length]}», ${street}, ${house}`
            : `${street}, ${house}`;
      let name = nameFor();
      let key = buildScenarioBusinessLocationKey({
        country: city.country,
        city: city.name,
        name,
      });
      while (!key || options.takenKeys.has(key)) {
        house += 1;
        name = nameFor();
        key = buildScenarioBusinessLocationKey({
          country: city.country,
          city: city.name,
          name,
        });
      }
      options.takenKeys.add(key);
      const longAddress = index % 6 === 1;
      const address = longAddress
        ? `г. ${city.name}, ${city.district}, проспект ${street}, ${house}/${(index % 9) + 1}, бизнес-центр «Нурлы Тау», блок 3Б, 12 этаж, офис 1204, вход со стороны парковки, ориентир — стеклянный павильон`
        : `г. ${city.name}, ул. ${street}, ${house}`;
      inputs.push({
        key,
        name,
        country: city.country,
        city: city.name,
        address,
        ...(index % 11 === 3
          ? {}
          : {
              phone: `${city.phone} ${300 + ((index * 37) % 700)} ${pad((index * 13) % 100)} ${pad((index * 29) % 100)}`,
            }),
        ...(index % 5 === 0
          ? { mapUrl: `${city.maps}70000001${pad(index, 5)}` }
          : {}),
        ...(index % 4 === 0
          ? { tags: ["ТРЦ"] }
          : index % 7 === 0
            ? { tags: ["24/7", "выдача заказов"] }
            : {}),
        latitude: round6(city.latitude + (random() - 0.5) * 0.12),
        longitude: round6(city.longitude + (random() - 0.5) * 0.16),
        isActive: index % 30 !== 29,
        sortOrder: index,
      });
    }
  }
  return inputs;
}

function buildCatalog(): BusinessLocationRecord[] {
  const takenKeys = new Set<string>();
  const inputs = buildOffices(CITIES, {
    firstIndex: 0,
    takenKeys,
    houseBase: 0,
  });
  // One Almaty office pinned 640 km north of its nearest Almaty office: a
  // latitude typed with the wrong first digit.
  const almaty = inputs.filter(input => input.city === "Алматы");
  const northmost = almaty.reduce((best, input) =>
    Number(input.latitude) > Number(best.latitude) ? input : best
  );
  const outlier = almaty[7];
  outlier.name = OUTLIER_NAME;
  outlier.key = "kz_almaty_arena";
  outlier.latitude = round6(Number(northmost.latitude) + 640 / 111.195);
  outlier.longitude = northmost.longitude;
  return inputs.map(toRecord);
}

const catalog = buildCatalog();
const outlierRecord = catalog.find(office => office.name === OUTLIER_NAME)!;
const outlierKm = Math.round(
  Math.min(
    ...catalog
      .filter(
        office =>
          office.isActive &&
          office.key !== outlierRecord.key &&
          office.cityKey === outlierRecord.cityKey
      )
      .map(office =>
        measureScenarioLocationDistanceMeters(outlierRecord, office)
      )
  ) / 1000
);
const longNameOffice = catalog.find(office => office.name.length > 120)!;
const longAddressOffice = catalog.find(
  office => (office.address?.length ?? 0) > 150
)!;

function summaryText(
  offices: readonly BusinessLocationRecord[],
  locale: Locale = "en"
) {
  const translate = translators[locale];
  const active = offices.filter(office => office.isActive);
  const inactive = offices.length - active.length;
  const text = translate("summary", {
    active: active.length,
    cities: new Set(active.map(office => `${office.country}:${office.cityKey}`))
      .size,
    countries: new Set(active.map(office => office.country)).size,
  });
  return inactive > 0
    ? `${text} · ${translate("summaryInactive", { count: inactive })}`
    : text;
}

// ---------------------------------------------------------------------------
// The Offices API, answered from memory with the route's rules: keys are
// unique, a create refuses a used key, and a save is limited to 500 active
// offices and 2000 records.

type ValidRow = {
  record: Omit<BusinessLocationRecord, "updatedAt">;
  sortOrder: number | undefined;
};
type ApiRequest = {
  method: string;
  body: Record<string, unknown> | null;
};
type MockOptions = {
  offices?: readonly BusinessLocationRecord[];
  /** Hold every list read until `releaseReads()`. */
  holdReads?: boolean;
  /** Fail this many list reads with 503 `load_failed`. */
  failReads?: number;
};

const teardownByPage = new WeakMap<Page, () => Promise<void>>();

test.afterEach(async ({ page }) => {
  const teardown = teardownByPage.get(page);
  if (!teardown) return;
  try {
    await teardown();
  } finally {
    teardownByPage.delete(page);
  }
});

const ALLOWED_INPUT_FIELDS = new Set<string>([
  "key",
  "name",
  "country",
  "city",
  "address",
  "phone",
  "mapUrl",
  "tags",
  "latitude",
  "longitude",
  "isActive",
  "sortOrder",
]);

function isPlainRow(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every(field => ALLOWED_INPUT_FIELDS.has(field)) &&
    ["address", "phone"].every(
      field => row[field] == null || typeof row[field] === "string"
    ) &&
    (row.isActive === undefined || typeof row.isActive === "boolean")
  );
}

function sortRecords(records: Iterable<BusinessLocationRecord>) {
  return [...records].sort(
    (left, right) =>
      Number(right.isActive) - Number(left.isActive) ||
      left.sortOrder - right.sortOrder ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

async function mockOfficesApi(page: Page, options: MockOptions = {}) {
  const errors: string[] = [];
  // Chromium logs every 4xx/5xx response as a console error. Only statuses
  // this mock chose to send are expected; anything else fails the test.
  const sentErrorStatuses: number[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const status = /status of (\d{3})/.exec(message.text())?.[1];
    const index = status ? sentErrorStatuses.indexOf(Number(status)) : -1;
    if (index >= 0 && message.location().url.includes("/business-locations")) {
      sentErrorStatuses.splice(index, 1);
      return;
    }
    errors.push(message.text());
  });

  const offices = new Map(
    (options.offices ?? catalog).map(office => [office.key, { ...office }])
  );
  const requests: ApiRequest[] = [];
  let failReads = options.failReads ?? 0;
  let readsReleased = !options.holdReads;
  const heldReads: Array<() => void> = [];
  const releaseReads = () => {
    readsReleased = true;
    heldReads.splice(0).forEach(resolve => resolve());
  };

  const list = () => sortRecords(offices.values());
  const refuse = (
    status: number,
    code: BusinessLocationsErrorCode,
    details: Partial<BusinessLocationsErrorBody> = {}
  ) => {
    sentErrorStatuses.push(status);
    return {
      status,
      json: { error: code, code, ...details } as BusinessLocationsErrorBody,
    };
  };

  function validateRows(
    values: readonly unknown[]
  ): { refusal: ReturnType<typeof refuse> } | { rows: ValidRow[] } {
    if (!values.every(isPlainRow)) {
      return { refusal: refuse(400, "invalid_request") };
    }
    const rows: ValidRow[] = [];
    const refused: BusinessLocationRowIssues[] = [];
    values.forEach((value, index) => {
      const result = validateBusinessLocationInput(value);
      if (result.ok) {
        rows.push({
          record: { ...result.office, isActive: result.isActive },
          sortOrder: result.sortOrder,
        });
      } else {
        const key = (value as { key?: unknown }).key;
        refused.push({
          index,
          key: typeof key === "string" ? key : null,
          issues: result.issues,
        });
      }
    });
    return refused.length > 0
      ? { refusal: refuse(400, "invalid_offices", { rows: refused }) }
      : { rows };
  }

  function store(row: ValidRow) {
    const previous = offices.get(row.record.key);
    offices.set(row.record.key, {
      ...row.record,
      sortOrder: row.sortOrder ?? previous?.sortOrder ?? 0,
      updatedAt: new Date().toISOString(),
    });
  }

  function save(body: Record<string, unknown> | null) {
    const deactivateMissing = body?.deactivateMissing;
    if (
      !body ||
      !Array.isArray(body.offices) ||
      body.offices.length < 1 ||
      body.offices.length > MAX_SCENARIO_BUSINESS_LOCATIONS ||
      (deactivateMissing !== undefined &&
        typeof deactivateMissing !== "boolean") ||
      Object.keys(body).some(
        field => field !== "offices" && field !== "deactivateMissing"
      )
    ) {
      return refuse(400, "invalid_request");
    }
    const validated = validateRows(body.offices);
    if ("refusal" in validated) return validated.refusal;
    const keys = validated.rows.map(row => row.record.key);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (duplicates.length > 0) {
      return refuse(400, "duplicate_keys", { keys: [...new Set(duplicates)] });
    }
    const rowKeys = new Set(keys);
    const created = keys.filter(key => !offices.has(key)).length;
    const activeAfter =
      validated.rows.filter(row => row.record.isActive).length +
      (deactivateMissing
        ? 0
        : [...offices.values()].filter(
            office => office.isActive && !rowKeys.has(office.key)
          ).length);
    if (activeAfter > MAX_SCENARIO_BUSINESS_LOCATIONS) {
      return refuse(409, "office_limit", {
        limit: MAX_SCENARIO_BUSINESS_LOCATIONS,
      });
    }
    if (offices.size + created > MAX_BUSINESS_LOCATION_RECORDS) {
      return refuse(409, "record_limit", {
        limit: MAX_BUSINESS_LOCATION_RECORDS,
      });
    }
    validated.rows.forEach(store);
    let deactivated = 0;
    if (deactivateMissing) {
      for (const office of offices.values()) {
        if (office.isActive && !rowKeys.has(office.key)) {
          office.isActive = false;
          deactivated += 1;
        }
      }
    }
    return {
      status: 200,
      json: {
        offices: list(),
        summary: {
          created,
          updated: validated.rows.length - created,
          deactivated,
        },
      },
    };
  }

  function create(body: Record<string, unknown> | null) {
    if (!body || Object.keys(body).length !== 1 || !("office" in body)) {
      return refuse(400, "invalid_request");
    }
    const validated = validateRows([body.office]);
    if ("refusal" in validated) return validated.refusal;
    const [row] = validated.rows;
    if (offices.has(row.record.key)) return refuse(409, "office_key_taken");
    if (
      row.record.isActive &&
      list().filter(office => office.isActive).length + 1 >
        MAX_SCENARIO_BUSINESS_LOCATIONS
    ) {
      return refuse(409, "office_limit", {
        limit: MAX_SCENARIO_BUSINESS_LOCATIONS,
      });
    }
    store(row);
    return {
      status: 201,
      json: { office: offices.get(row.record.key), offices: list() },
    };
  }

  await page.route("**/api/workspaces/*/business-locations", async route => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") {
      requests.push({ method, body: null });
      if (!readsReleased) {
        await new Promise<void>(resolve => heldReads.push(resolve));
      }
      if (failReads > 0) {
        failReads -= 1;
        await route.fulfill(refuse(503, "load_failed"));
        return;
      }
      await route.fulfill({ json: { offices: list() } });
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = request.postDataJSON() as Record<string, unknown>;
    } catch {
      body = null;
    }
    requests.push({ method, body });
    await route.fulfill(method === "POST" ? create(body) : save(body));
  });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));

  teardownByPage.set(page, async () => {
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });
    expect(errors).toEqual([]);
  });

  return {
    errors,
    requests,
    writes: () => requests.filter(request => request.method !== "GET"),
    reads: () => requests.filter(request => request.method === "GET").length,
    offices: () => list(),
    releaseReads,
    /** An office another manager added after this page loaded the list. */
    addBehindTheScenes: (record: BusinessLocationRecord) => {
      offices.set(record.key, { ...record });
    },
  };
}

// ---------------------------------------------------------------------------
// Page helpers.

async function openOffices(
  page: Page,
  viewport: Viewport,
  options: { locale?: Locale; theme?: "dark" } = {}
) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  if (options.theme === "dark") {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  }
  const query = new URLSearchParams({
    locale: options.locale ?? "en",
    ...(options.theme ? { theme: options.theme } : {}),
  });
  await page.goto(`/business-locations-browser.html?${query}`);
  await expect(page).toHaveTitle("Offices browser validation");
  await expect(page.locator("vite-error-overlay, nextjs-portal")).toHaveCount(
    0
  );
}

/** Every visible heading, in order; an open dialog hides the page's own. */
async function expectHeadings(page: Page, expected: readonly string[]) {
  await expect
    .poll(async () =>
      (await page.getByRole("heading").allInnerTexts()).map(text => text.trim())
    )
    .toEqual(expected);
}

/**
 * Nothing scrolls sideways: the page, the settings column, an open dialog, or
 * the office table, whose own scroller would hide the row actions.
 */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth) {
      problems.push(`document ${root.scrollWidth} > ${window.innerWidth}`);
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-testid="settings-main"], [role="dialog"], [role="alertdialog"], [data-slot="table-container"]'
    )) {
      if (element.scrollWidth > element.clientWidth + 1) {
        const name =
          element.dataset.slot ?? element.getAttribute("role") ?? "main";
        problems.push(
          `${name} ${element.scrollWidth} > ${element.clientWidth}`
        );
      }
    }
    return problems;
  });
  expect(overflow).toEqual([]);
}

async function capture(page: Page, name: string) {
  await mkdir(artifactDir, { recursive: true });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 8000,
  });
  await expectNoHorizontalOverflow(page);
  await expect(page.locator("body")).not.toContainText(
    "BusinessLocationsSettings."
  );
  await page.screenshot({
    path: join(artifactDir, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

/** The table on desktop, the cards on a phone. */
function officeItems(page: Page, viewport: Viewport, locale: Locale = "en") {
  const title = translators[locale]("title");
  return viewport.name === "desktop"
    ? page.getByRole("table", { name: title }).locator("tbody tr")
    : page.getByRole("list", { name: title }).getByRole("listitem");
}

function officeItem(page: Page, viewport: Viewport, name: string) {
  return officeItems(page, viewport).filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function waitForCatalog(
  page: Page,
  offices: readonly BusinessLocationRecord[],
  locale: Locale = "en"
) {
  await expect(
    page.getByText(summaryText(offices, locale), { exact: true })
  ).toBeVisible();
}

async function isFocused(locator: Locator) {
  return locator.evaluate(element => element === document.activeElement);
}

/** Presses Tab until the target has focus. */
async function tabTo(page: Page, target: Locator, limit = 40) {
  for (let step = 0; step < limit; step += 1) {
    if (await isFocused(target)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

function headerButtons(page: Page, locale: Locale = "en") {
  const translate = translators[locale];
  return {
    exportCsv: page.getByRole("button", {
      name: translate("actions.export"),
      exact: true,
    }),
    importFile: page.getByRole("button", {
      name: translate("actions.import"),
      exact: true,
    }),
    add: page.getByRole("button", {
      name: translate("actions.add"),
      exact: true,
    }),
  };
}

async function readDownload(page: Page, trigger: () => Promise<void>) {
  const downloadEvent = page.waitForEvent("download");
  await trigger();
  const download = await downloadEvent;
  const path = await download.path();
  return {
    filename: download.suggestedFilename(),
    bytes: await readFile(path),
  };
}

/** A cell as the export writes it: formula guard, then quotes when needed. */
function exportCell(value: unknown) {
  if (value === undefined || value === null) return "";
  let cell = String(value);
  if (typeof value === "string" && /^ *(?:[=+\-@]|[\t\r\n])/.test(cell)) {
    cell = `'${cell}`;
  }
  return /[",;\r\n]|^\s|\s$/.test(cell)
    ? `"${cell.replaceAll('"', '""')}"`
    : cell;
}

function decimalComma(value: number) {
  return String(value).replace(".", ",");
}

function semicolonCell(value: string) {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const BOM = String.fromCharCode(0xfeff);
const RUSSIAN_HEADER = [
  "код",
  "название",
  "страна",
  "город",
  "адрес",
  "телефон",
  "широта",
  "долгота",
  "теги",
  "активен",
];

function russianRow(office: BusinessLocationInput): string[] {
  return [
    office.key,
    office.name,
    COUNTRY_NAMES_RU[office.country as "KZ" | "UZ"],
    office.city,
    office.address ?? "",
    office.phone ?? "",
    decimalComma(Number(office.latitude)),
    decimalComma(Number(office.longitude)),
    (office.tags ?? []).join(", "),
    office.isActive === false ? "нет" : "да",
  ];
}

/** A Russian Excel style CSV: UTF-8 with BOM, semicolons, comma decimals. */
function russianCsv(rows: readonly string[][]) {
  return Buffer.from(
    BOM +
      [RUSSIAN_HEADER, ...rows]
        .map(row => row.map(semicolonCell).join(";"))
        .join("\r\n"),
    "utf8"
  );
}

/**
 * 180 rows: 150 offices already in the catalog (20 with a new phone) and 30
 * new ones. The catalog's first 30 offices are not in the file.
 */
function buildImportFile() {
  const kept = catalog.slice(30);
  const updatedKeys = new Set(kept.slice(0, 20).map(office => office.key));
  const takenKeys = new Set(catalog.map(office => office.key));
  const fresh = buildOffices(
    [
      { ...CITIES[9], count: 10 },
      { ...CITIES[10], count: 12 },
      { ...CITIES[11], count: 8 },
    ],
    { firstIndex: 500, takenKeys, houseBase: 200 }
  ).map(office => ({ ...office, isActive: true }));
  const rows = [
    ...kept.map(office =>
      russianRow({
        ...office,
        phone: updatedKeys.has(office.key)
          ? `+7 700 555 ${pad(office.sortOrder % 100)} ${pad((office.sortOrder * 7) % 100)}`
          : office.phone,
      })
    ),
    ...fresh.map(russianRow),
  ];
  const missing = catalog.slice(0, 30).filter(office => office.isActive).length;
  return { rows, kept, fresh, missing };
}

async function chooseImportFile(
  page: Page,
  dialog: Locator,
  buttonName: string,
  file: { name: string; mimeType: string; buffer: Buffer }
) {
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: buttonName, exact: true }).click();
  await (await chooser).setFiles(file);
}

// ---------------------------------------------------------------------------
// Tests.

for (const viewport of VIEWPORTS) {
  test(`${viewport.name} shows loading, then the catalog with its summary and outlier pin`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page, { holdReads: true });
    await openOffices(page, viewport);
    const buttons = headerButtons(page);
    await expect(
      page.getByRole("status", { name: t("loading"), exact: true })
    ).toBeVisible();
    await expect(buttons.exportCsv).toBeDisabled();
    await expect(buttons.importFile).toBeDisabled();
    await expect(buttons.add).toBeDisabled();
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-manager-loading`);

    api.releaseReads();
    await waitForCatalog(page, catalog);
    await expect(officeItems(page, viewport)).toHaveCount(catalog.length);
    expect(outlierKm).toBeGreaterThanOrEqual(635);
    expect(outlierKm).toBeLessThanOrEqual(645);
    await expect(
      page.getByText(
        t("outliers.item", {
          name: OUTLIER_NAME,
          km: outlierKm,
          city: outlierRecord.city,
        }),
        { exact: true }
      )
    ).toBeVisible();
    await expect(buttons.exportCsv).toBeEnabled();
    await expect(buttons.add).toBeEnabled();
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-manager-list`);

    // Long names and addresses stay inside the list: the table clamps them
    // and keeps the full text as a title, a card wraps them.
    const longItem = officeItem(page, viewport, longNameOffice.name);
    await longItem.scrollIntoViewIfNeeded();
    await expect(longItem).toBeVisible();
    const addressItem = officeItem(page, viewport, longAddressOffice.name);
    await expect(addressItem).toContainText(longAddressOffice.address!);
    if (viewport.name === "desktop") {
      await expect(
        addressItem
          .getByTitle(longAddressOffice.address!, { exact: true })
          .filter({ visible: true })
      ).toHaveCount(1);
      await expect(
        longItem
          .getByTitle(longNameOffice.name, { exact: true })
          .filter({ visible: true })
      ).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    } else {
      await capture(page, `${viewport.name}-manager-long-text`);
    }
    expect(api.reads()).toBe(1);
  });

  test(`${viewport.name} load error offers Retry, which loads the catalog`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page, { failReads: 1 });
    await openOffices(page, viewport);
    await expect(page.getByText(t("loadError"), { exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: t("retry"), exact: true });
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-manager-load-error`);
    await tabTo(page, retry);
    await page.keyboard.press("Enter");
    await waitForCatalog(page, catalog);
    expect(api.reads()).toBe(2);
    await expectNoHorizontalOverflow(page);
  });

  test(`${viewport.name} empty catalog for a manager`, async ({ page }) => {
    await mockOfficesApi(page, { offices: [] });
    await openOffices(page, viewport);
    const buttons = headerButtons(page);
    const empty = page.getByText(t("empty.title"), { exact: true });
    await expect(empty).toBeVisible();
    await expect(buttons.exportCsv).toBeDisabled();
    await expectHeadings(page, [t("title"), t("empty.title")]);
    await expect(
      page.getByText(t("empty.manager"), { exact: true })
    ).toBeVisible();
    // Header and empty state both offer Add and Import.
    await expect(buttons.add).toHaveCount(2);
    await expect(buttons.importFile).toHaveCount(2);
    await capture(page, `${viewport.name}-manager-empty`);
    const emptyAdd = buttons.add.last();
    await emptyAdd.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectHeadings(page, [t("dialog.addTitle")]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(emptyAdd).toBeFocused();
  });

  test(`${viewport.name} search filters by name, key, city, address and phone`, async ({
    page,
  }) => {
    await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const search = page.getByRole("searchbox", {
      name: t("search.label"),
      exact: true,
    });
    const items = officeItems(page, viewport);
    // The fields the search covers, compared without case.
    const matching = (query: string) =>
      catalog.filter(office =>
        [office.name, office.key, office.city, office.address, office.phone]
          .filter((value): value is string => Boolean(value))
          .some(value =>
            value.toLocaleLowerCase().includes(query.toLocaleLowerCase())
          )
      ).length;

    await search.fill("ШЫМКЕНТ");
    expect(matching("ШЫМКЕНТ")).toBe(
      catalog.filter(office => office.city === "Шымкент").length
    );
    await expect(items).toHaveCount(matching("ШЫМКЕНТ"));
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-manager-search`);

    for (const query of [
      "uz_tashkent",
      catalog.find(office => office.phone)!.phone!,
      "бизнес-центр «нурлы тау»",
      OUTLIER_NAME.toLowerCase(),
    ]) {
      expect(matching(query)).toBeGreaterThan(0);
      await search.fill(query);
      await expect(items).toHaveCount(matching(query));
    }
    await search.fill("Караганды-Сортировочная");
    await expect(page.getByText(t("noMatches"), { exact: true })).toBeVisible();
    await expect(items).toHaveCount(0);
    await capture(page, `${viewport.name}-manager-search-empty`);
    await search.fill("");
    await expect(items).toHaveCount(catalog.length);
  });

  test(`${viewport.name} adds an office: derived key, pasted coordinates and map links`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const { add } = headerButtons(page);
    await add.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectHeadings(page, [t("dialog.addTitle")]);

    // A new office starts in the country most offices are in.
    const country = dialog.getByRole("combobox", {
      name: t("dialog.country"),
    });
    await expect(country).toHaveText("Kazakhstan (KZ)");
    await country.click();
    await page.getByPlaceholder(t("countrySelect.search")).fill("uzbek");
    await page.getByRole("option", { name: "Uzbekistan (UZ)" }).click();
    await expect(country).toHaveText("Uzbekistan (UZ)");
    await country.click();
    await page.getByPlaceholder(t("countrySelect.search")).fill("KZ");
    await page.keyboard.press("Enter");
    await expect(country).toHaveText("Kazakhstan (KZ)");
    // The list is portalled outside the dialog; a wheel or trackpad still
    // scrolls it.
    await country.click();
    const countryList = page.locator("[cmdk-list]");
    await expect(countryList).toBeVisible();
    await countryList.hover();
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => countryList.evaluate(element => element.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(countryList).toHaveCount(0);
    await expect(dialog).toBeVisible();

    const name = "Абай даңғылы, 150";
    await dialog.getByLabel(t("dialog.name"), { exact: true }).fill(name);
    await dialog.getByLabel(t("dialog.city"), { exact: true }).fill("Алматы");
    const key = buildScenarioBusinessLocationKey({
      country: "KZ",
      city: "Алматы",
      name,
    })!;
    const keyInput = dialog.getByLabel(t("dialog.key"), { exact: true });
    await expect(keyInput).toHaveValue(key);
    await expect(keyInput).toBeEditable();
    await expect(
      dialog.getByText(t("dialog.keyHint"), { exact: true })
    ).toBeVisible();

    const coordinates = dialog.getByLabel(t("dialog.coordinates"), {
      exact: true,
    });
    const pinned = (point: string) =>
      dialog.getByText(t("dialog.coordinatesPoint", { point }), {
        exact: true,
      });
    await coordinates.fill("43,238949, 76,889709");
    await expect(pinned("43.238949, 76.889709")).toBeVisible();
    await coordinates.fill(
      "https://www.google.com/maps/place/Abay+Ave+150,+Almaty/@43.2389,76.8897,17z/data=!3m1!4b1!4m6!3m5!1s0x38836e7d16c5cbab:0x3d44668fad986d76!8m2!3d43.240112!4d76.90533!16s"
    );
    await expect(pinned("43.240112, 76.90533")).toBeVisible();
    await coordinates.fill("https://maps.app.goo.gl/u7Qe5dJ1k2Lm3N4o9");
    await expect(
      dialog.getByText(t("dialog.coordinatesShortLink"), { exact: true })
    ).toBeInViewport();
    await expectHeadings(page, [t("dialog.addTitle")]);
    await capture(page, `${viewport.name}-add-short-link`);
    await coordinates.fill("https://www.google.com/maps?q=Abay+Avenue+150");
    await expect(
      dialog.getByText(t("dialog.coordinatesNoPoint"), { exact: true })
    ).toBeVisible();
    await coordinates.fill("43.240112, 76.90533");
    await expect(pinned("43.240112, 76.90533")).toBeVisible();

    const address = "г. Алматы, проспект Абая, 150, 1 этаж";
    const phone = "+7 727 355 01 50";
    await dialog
      .getByLabel(`${t("dialog.address")} (${t("dialog.optional")})`, {
        exact: true,
      })
      .fill(address);
    await dialog
      .getByLabel(`${t("dialog.phone")} (${t("dialog.optional")})`, {
        exact: true,
      })
      .fill(phone);
    const tags = dialog.getByLabel(
      `${t("dialog.tags")} (${t("dialog.optional")})`,
      { exact: true }
    );
    await tags.fill("ТРЦ");
    await tags.press("Enter");
    await expect(dialog.getByText("ТРЦ", { exact: true })).toBeVisible();
    await capture(page, `${viewport.name}-add-dialog`);

    const submit = dialog.getByRole("button", {
      name: t("dialog.create"),
      exact: true,
    });
    let savedKey = key;
    if (viewport.name === "desktop") {
      // Another manager adds the same key after this page loaded the list.
      api.addBehindTheScenes({ ...catalog[0], key, name: "Абай (Аружан)" });
      await submit.click();
      await expect(
        dialog.getByText(t("errors.office_key_taken"), { exact: true })
      ).toBeVisible();
      await expect(keyInput).toHaveAttribute("aria-invalid", "true");
      await expect(keyInput).toBeFocused();
      await capture(page, `${viewport.name}-add-key-taken`);
      savedKey = `${key}_2`;
      await keyInput.fill(savedKey);
    }
    await submit.click();
    await expect(
      page.getByText(t("toasts.added", { name }), { exact: true })
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    const lastWrite = api.writes().at(-1)!;
    expect(lastWrite.method).toBe("POST");
    expect(lastWrite.body).toEqual({
      office: {
        key: savedKey,
        name,
        country: "KZ",
        city: "Алматы",
        address,
        phone,
        latitude: 43.240112,
        longitude: 76.90533,
        isActive: true,
        tags: ["ТРЦ"],
      },
    });
    await expect(officeItems(page, viewport)).toHaveCount(api.offices().length);
    await page
      .getByRole("searchbox", { name: t("search.label") })
      .fill(savedKey);
    await expect(officeItems(page, viewport)).toHaveCount(1);
    await expect(officeItem(page, viewport, name)).toContainText(phone);
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-add-saved`);
  });

  test(`${viewport.name} edits an office and keeps its key read-only`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const office = catalog[1];
    const edit = page.getByRole("button", {
      name: t("actions.editOffice", { name: office.name }),
      exact: true,
    });
    await edit.click();
    const dialog = page.getByRole("dialog");
    await expectHeadings(page, [t("dialog.editTitle")]);
    const keyInput = dialog.getByLabel(t("dialog.key"), { exact: true });
    await expect(keyInput).toHaveValue(office.key);
    await expect(keyInput).toHaveAttribute("readonly", "");
    await expect(keyInput).not.toBeEditable();
    await expect(
      dialog.getByText(t("dialog.keyLocked"), { exact: true })
    ).toBeVisible();
    await expect(
      dialog.getByLabel(t("dialog.coordinates"), { exact: true })
    ).toHaveValue(`${office.latitude}, ${office.longitude}`);
    const phone = dialog.getByLabel(
      `${t("dialog.phone")} (${t("dialog.optional")})`,
      { exact: true }
    );
    await expect(phone).toHaveValue(office.phone ?? "");
    await phone.fill("+7 727 222 33 44");
    await capture(page, `${viewport.name}-edit-dialog`);
    await dialog
      .getByRole("button", { name: t("dialog.save"), exact: true })
      .click();
    await expect(
      page.getByText(t("toasts.saved", { name: office.name }), {
        exact: true,
      })
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(edit).toBeFocused();
    const [write] = api.writes();
    expect(write.method).toBe("PUT");
    const sent = (write.body?.offices as BusinessLocationInput[])[0];
    expect(write.body?.deactivateMissing).toBeUndefined();
    expect(sent).toMatchObject({
      key: office.key,
      name: office.name,
      phone: "+7 727 222 33 44",
      sortOrder: office.sortOrder,
      latitude: office.latitude,
      longitude: office.longitude,
      isActive: true,
    });
    await expect(officeItem(page, viewport, office.name)).toContainText(
      "+7 727 222 33 44"
    );
    await expectHeadings(page, [t("title")]);
    await expectNoHorizontalOverflow(page);
  });

  test(`${viewport.name} deactivates after a confirm and activates without one`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const office = catalog[5];
    const deactivate = page.getByRole("button", {
      name: t("actions.deactivateOffice", { name: office.name }),
      exact: true,
    });
    await deactivate.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(
        t("deactivateDialog.description", { name: office.name }),
        { exact: true }
      )
    ).toBeVisible();
    await expectHeadings(page, [
      t("deactivateDialog.title", { name: office.name }),
    ]);
    await capture(page, `${viewport.name}-deactivate-confirm`);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(deactivate).toBeFocused();
    expect(api.writes()).toHaveLength(0);

    await page.keyboard.press("Enter");
    await confirm
      .getByRole("button", { name: t("deactivateDialog.confirm"), exact: true })
      .click();
    await expect(
      page.getByText(t("toasts.deactivated", { name: office.name }), {
        exact: true,
      })
    ).toBeVisible();
    const item = officeItem(page, viewport, office.name);
    await expect(item).toContainText(t("status.inactive"));
    expect(api.writes()[0].body).toEqual({
      offices: [expect.objectContaining({ key: office.key, isActive: false })],
    });
    await waitForCatalog(page, api.offices());
    const activate = page.getByRole("button", {
      name: t("actions.activateOffice", { name: office.name }),
      exact: true,
    });
    // Focus comes back to the row's toggle after the save.
    await expect(activate).toBeFocused();
    await activate.scrollIntoViewIfNeeded();
    await capture(page, `${viewport.name}-deactivated-row`);
    await activate.click();
    await expect(
      page.getByText(t("toasts.activated", { name: office.name }), {
        exact: true,
      })
    ).toBeVisible();
    await expect(item).toContainText(t("status.active"));
    await expect(deactivate).toBeFocused();
    expect(api.writes()[1].body).toEqual({
      offices: [expect.objectContaining({ key: office.key, isActive: true })],
    });
    await waitForCatalog(page, catalog);
    await expectHeadings(page, [t("title")]);
    await expectNoHorizontalOverflow(page);
  });

  test(`${viewport.name} imports a 180-row semicolon CSV with Russian headers`, async ({
    page,
  }) => {
    const api = await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const { importFile } = headerButtons(page);
    await importFile.click();
    const dialog = page.getByRole("dialog");
    await expectHeadings(page, [t("import.title")]);
    await expect(
      dialog.getByText(t("import.columnsHint"), { exact: true })
    ).toBeVisible();
    const submit = dialog.getByRole("button", {
      name: /^Import/,
    });
    await expect(submit).toBeDisabled();

    // The same file with problems first: an unknown country, an unreadable
    // latitude and a key on two rows.
    const file = buildImportFile();
    const broken = file.rows.map(row => [...row]);
    broken[2][2] = "Атлантида";
    broken[4][6] = "сорок три";
    broken[8][0] = broken[9][0];
    await chooseImportFile(page, dialog, t("import.chooseFile"), {
      name: "филиалы-с-ошибками.csv",
      mimeType: "text/csv",
      buffer: russianCsv(broken),
    });
    await expect(
      dialog.getByText(t("import.errorsTitle", { count: 4 }), { exact: true })
    ).toBeVisible();
    for (const [row, message] of [
      [4, t("import.errors.country_unknown")],
      [
        6,
        t("import.errors.invalid_row", {
          issues: t("issues.latitude_invalid"),
        }),
      ],
      [10, t("import.errors.duplicate_key", { key: broken[9][0] })],
      [11, t("import.errors.duplicate_key", { key: broken[9][0] })],
    ] as const) {
      await expect(
        dialog.getByText(t("import.rowError", { row, message }), {
          exact: true,
        })
      ).toBeVisible();
    }
    await expect(submit).toBeDisabled();
    await capture(page, `${viewport.name}-import-errors`);

    await chooseImportFile(page, dialog, t("import.chooseAnotherFile"), {
      name: "филиалы.csv",
      mimeType: "text/csv",
      buffer: russianCsv(file.rows),
    });
    await expect(
      dialog.getByText(
        t("import.preview", {
          created: file.fresh.length,
          updated: 20,
          unchanged: file.kept.length - 20,
          missing: file.missing,
        }),
        { exact: true }
      )
    ).toBeVisible();
    await expect(
      dialog.getByText(
        t("import.keptColumns", {
          columns: [
            t("import.columnNames.mapUrl"),
            t("import.columnNames.sortOrder"),
          ].join(", "),
        }),
        { exact: true }
      )
    ).toBeVisible();
    await expect(
      dialog.getByText(
        t("outliers.item", {
          name: OUTLIER_NAME,
          km: outlierKm,
          city: outlierRecord.city,
        }),
        { exact: true }
      )
    ).toBeVisible();
    const deactivateMissing = dialog.getByRole("checkbox", {
      name: t("import.deactivateMissing", { count: file.missing }),
    });
    await expect(deactivateMissing).not.toBeChecked();
    await expect(submit).toHaveText(
      t("import.submit", { count: file.rows.length })
    );
    await expect(submit).toBeEnabled();
    await expectHeadings(page, [t("import.title")]);
    await capture(page, `${viewport.name}-import-preview`);
    await deactivateMissing.check();
    await expect(deactivateMissing).toBeChecked();
    await capture(page, `${viewport.name}-import-preview-deactivate`);

    await submit.click();
    await expect(
      page.getByText(
        t("import.success", {
          created: file.fresh.length,
          updated: file.kept.length,
          deactivated: file.missing,
        }),
        { exact: true }
      )
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(importFile).toBeFocused();
    const [write] = api.writes();
    expect(write.method).toBe("PUT");
    expect(write.body?.deactivateMissing).toBe(true);
    const sent = write.body?.offices as BusinessLocationInput[];
    expect(sent).toHaveLength(file.rows.length);
    // Offices already in the catalog keep the map link and sort order the
    // file has no column for.
    const keptWithMap = file.kept.find(office => office.mapUrl)!;
    expect(sent.find(office => office.key === keptWithMap.key)).toMatchObject({
      mapUrl: keptWithMap.mapUrl,
      sortOrder: keptWithMap.sortOrder,
    });
    await waitForCatalog(page, api.offices());
    await expect(officeItems(page, viewport)).toHaveCount(
      catalog.length + file.fresh.length
    );
    await expectHeadings(page, [t("title")]);
    await capture(page, `${viewport.name}-import-done`);
  });

  test(`${viewport.name} keyboard reaches header and row actions, and Escape returns focus`, async ({
    page,
  }) => {
    await mockOfficesApi(page);
    await openOffices(page, viewport);
    await waitForCatalog(page, catalog);
    const buttons = headerButtons(page);

    await page.keyboard.press("Tab");
    await expect(buttons.exportCsv).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(buttons.importFile).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(buttons.add).toBeFocused();

    for (const [trigger, title] of [
      [buttons.add, t("dialog.addTitle")],
      [buttons.importFile, t("import.title")],
    ] as const) {
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectHeadings(page, [title]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }

    const first = catalog[0];
    await page.getByRole("searchbox", { name: t("search.label") }).focus();
    const edit = page.getByRole("button", {
      name: t("actions.editOffice", { name: first.name }),
      exact: true,
    });
    await tabTo(page, edit);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectHeadings(page, [t("dialog.editTitle")]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(edit).toBeFocused();

    const deactivate = page.getByRole("button", {
      name: t("actions.deactivateOffice", { name: first.name }),
      exact: true,
    });
    await page.keyboard.press("Tab");
    await expect(deactivate).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(deactivate).toBeFocused();
    await expectHeadings(page, [t("title")]);
    await expectNoHorizontalOverflow(page);
  });
}

test("desktop exports a CSV with BOM, export headers and Cyrillic rows that re-import", async ({
  page,
}) => {
  await mockOfficesApi(page);
  await openOffices(page, DESKTOP);
  await waitForCatalog(page, catalog);
  const download = await readDownload(page, () =>
    headerButtons(page).exportCsv.click()
  );
  expect(download.filename).toMatch(/^offices-\d{4}-\d{2}-\d{2}\.csv$/);
  expect([...download.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = download.bytes.toString("utf8").slice(1);
  const lines = text.split("\r\n");
  expect(lines[0]).toBe(BUSINESS_LOCATION_EXPORT_HEADERS.join(","));
  expect(lines).toHaveLength(catalog.length + 1);
  // The first office has every column, a phone that needs the formula
  // guard and an address with commas.
  const office = catalog[0];
  expect(office.phone?.startsWith("+")).toBe(true);
  expect(office.mapUrl).toBeTruthy();
  expect(office.tags.length).toBeGreaterThan(0);
  expect(lines[1]).toBe(
    [
      office.key,
      office.name,
      office.country,
      office.city,
      office.address,
      office.phone,
      office.latitude,
      office.longitude,
      office.mapUrl,
      office.tags.join(", "),
      office.isActive,
      office.sortOrder,
    ]
      .map(exportCell)
      .join(",")
  );
  expect(lines[1]).toMatch(/[А-Яа-яЁё]/);
  // Active offices first, and the file reads back as the same offices.
  const csv = readCsvRows(text);
  const parsed = parseBusinessLocationRows(
    toNumberedNonEmptyRows(csv.rows, csv.sourceRowNumbers)
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows.map(row => row.input.key)).toEqual(
    sortRecords(catalog).map(record => record.key)
  );
  await expectHeadings(page, [t("title")]);
  await capture(page, "desktop-export-done");
});

test("desktop imports an Excel file with Kazakh headers and derived keys", async ({
  page,
}) => {
  const api = await mockOfficesApi(page);
  await openOffices(page, DESKTOP);
  await waitForCatalog(page, catalog);
  const rows: unknown[][] = [
    ["атауы", "ел", "қала", "мекенжайы", "ендік", "бойлық", "тегтер"],
  ];
  const districts = ["Чиланзар", "Юнусабад", "Сергели", "Яккасарай"];
  // Kazakh country names: Chromium has none in Intl.DisplayNames, so this
  // checks the CLDR table in lib/geo.
  for (let index = 0; index < 12; index += 1) {
    const district = districts[index % districts.length];
    rows.push([
      `${district}, ${index + 1}-квартал`,
      "Өзбекстан",
      "Ташкент",
      `${district} ауданы, ${index + 1}-квартал, ${10 + index}-үй`,
      round6(41.28 + index * 0.004),
      round6(69.21 + index * 0.005),
      index % 2 === 0 ? "жаңа; 24/7" : "",
    ]);
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    "Филиалдар"
  );
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;

  await headerButtons(page).importFile.click();
  const dialog = page.getByRole("dialog");
  await chooseImportFile(page, dialog, t("import.chooseFile"), {
    name: "филиалдар.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  const active = catalog.filter(office => office.isActive).length;
  await expect(
    dialog.getByText(
      t("import.preview", {
        created: 12,
        updated: 0,
        unchanged: 0,
        missing: active,
      }),
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    dialog.getByText(t("import.derivedKeys", { count: 12 }), { exact: true })
  ).toBeVisible();
  const deactivateMissing = dialog.getByRole("checkbox", {
    name: t("import.deactivateMissing", { count: active }),
  });
  await expect(deactivateMissing).not.toBeChecked();
  await expectHeadings(page, [t("import.title")]);
  await capture(page, "desktop-import-xlsx-preview");
  await dialog
    .getByRole("button", { name: t("import.submit", { count: 12 }) })
    .click();
  await expect(
    page.getByText(
      t("import.success", { created: 12, updated: 0, deactivated: 0 }),
      { exact: true }
    )
  ).toBeVisible();
  const [write] = api.writes();
  expect(write.body?.deactivateMissing).toBe(false);
  const sent = write.body?.offices as BusinessLocationInput[];
  expect(sent).toHaveLength(12);
  expect(sent[0]).toMatchObject({
    key: buildScenarioBusinessLocationKey({
      country: "UZ",
      city: "Ташкент",
      name: "Чиланзар, 1-квартал",
    }),
    country: "UZ",
    latitude: 41.28,
    longitude: 69.21,
    tags: ["жаңа", "24/7"],
  });
  await waitForCatalog(page, api.offices());
  await expectHeadings(page, [t("title")]);
  await expectNoHorizontalOverflow(page);
});

for (const scenario of [
  { name: "desktop-ru-manager-list", viewport: DESKTOP, locale: "ru" },
  { name: "mobile-kz-manager-list", viewport: MOBILE, locale: "kz" },
  {
    name: "desktop-dark-manager-list",
    viewport: DESKTOP,
    locale: "en",
    theme: "dark",
  },
  {
    name: "mobile-dark-manager-list",
    viewport: MOBILE,
    locale: "en",
    theme: "dark",
  },
] as const) {
  test(`${scenario.name} renders the translated catalog`, async ({ page }) => {
    await mockOfficesApi(page);
    await openOffices(page, scenario.viewport, {
      locale: scenario.locale,
      ...("theme" in scenario ? { theme: scenario.theme } : {}),
    });
    const translate = translators[scenario.locale];
    await waitForCatalog(page, catalog, scenario.locale);
    await expect(
      officeItems(page, scenario.viewport, scenario.locale)
    ).toHaveCount(catalog.length);
    await expect(
      page.getByText(
        translate("outliers.item", {
          name: OUTLIER_NAME,
          km: outlierKm,
          city: outlierRecord.city,
        }),
        { exact: true }
      )
    ).toBeVisible();
    await expect(headerButtons(page, scenario.locale).add).toBeVisible();
    await expectHeadings(page, [translate("title")]);
    await capture(page, scenario.name);
  });
}

test("the table keeps its row actions in view from 640 to 1920 px in en, ru and kz", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await mockOfficesApi(page);
  for (const locale of ["en", "ru", "kz"] as const) {
    const translate = translators[locale];
    for (const width of [640, 768, 1024, 1280, 1440, 1920]) {
      await openOffices(
        page,
        { name: "desktop", width, height: 900 },
        { locale }
      );
      await waitForCatalog(page, catalog, locale);
      await expectNoHorizontalOverflow(page);
      const table = page.getByRole("table", { name: translate("title") });
      const deactivate = table.getByRole("button", {
        name: translate("actions.deactivateOffice", {
          name: longNameOffice.name,
        }),
        exact: true,
      });
      const tableBox = (await table.boundingBox())!;
      const buttonBox = (await deactivate.boundingBox())!;
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
        tableBox.x + tableBox.width
      );
      if (
        (locale === "ru" && width === 640) ||
        (locale === "kz" && width === 1024)
      ) {
        await expectHeadings(page, [translate("title")]);
        await capture(page, `width-${width}-${locale}-manager-list`);
      }
    }
  }
});

test("mobile dialogs keep their title in view when something scrolls the sheet", async ({
  page,
}) => {
  await mockOfficesApi(page);
  await openOffices(page, MOBILE);
  await waitForCatalog(page, catalog);
  const buttons = headerButtons(page);
  for (const [trigger, title] of [
    [buttons.add, t("dialog.addTitle")],
    [buttons.importFile, t("import.title")],
  ] as const) {
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Focus and scrollIntoView can scroll a sheet whose overflow is only
    // hidden, and the drawer's background below it then shows as a blank
    // sheet with the title out of view. Only the fields may scroll.
    expect(
      await dialog.evaluate(element => {
        element.scrollTop = 200;
        return element.scrollTop;
      })
    ).toBe(0);
    await expect(
      dialog.getByRole("heading", { name: title, exact: true })
    ).toBeInViewport();
    await expectHeadings(page, [title]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});
