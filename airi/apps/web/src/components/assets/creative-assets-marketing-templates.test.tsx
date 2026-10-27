/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import type {
  TikTokDiscoveryCategory,
  TikTokDiscoveryMarket,
  TikTokMarketingTemplatesResponse,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import {
  TIKTOK_DISCOVERY_CATEGORIES,
  TIKTOK_DISCOVERY_MARKETS,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { CreativeAssetsMarketingTemplates } from "./creative-assets-marketing-templates";
import { installResizeObserver } from "@/test-support/dom-test-utils";

let mockLocale = "en";

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: () => (key: string) => key,
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const TEST_MESSAGES: Record<string, string> = {
  marketingTemplatesTitle: "Marketing templates",
  marketingTemplatesDescription: "Start from a ready template.",
  marketingTemplatesCount: "{count} templates",
  marketingTemplatesUse: "Use",
  marketingTemplatesCategoryAll: "All",
  marketingTemplatesCategoryUgc: "UGC",
  marketingTemplatesCategoryProduct: "Product",
  marketingTemplatesCategoryAvatar: "Avatar",
  marketingTemplatesCategoryVoice: "Voice",
  marketingTemplatesCategoryStory: "Story",
  marketingTemplatesCollectionAiri: "airi.chat templates",
  marketingTemplatesCollectionTikTok: "TikTok trends",
  marketingTemplatesCollectionNew: "New",
  marketingTemplatesTikTokMarketLabel: "Market",
  marketingTemplatesTikTokCategoryLabel: "Industry",
  marketingTemplatesTikTokSearch: "Search",
  marketingTemplatesTikTokNoResults: "No results",
  marketingTemplatesTikTokLoading: "Loading TikTok references",
  marketingTemplatesTikTokTitle: "TikTok inspiration",
  marketingTemplatesTikTokCount: "{count} references",
  marketingTemplatesTikTokReferenceNotice:
    "Public TikTok references open on TikTok and are inspiration, not reusable assets.",
  marketingTemplatesTikTokViewReference: "View on TikTok",
  marketingTemplatesTikTokResetFilters: "Reset filters",
  marketingTemplatesTikTokImageUnavailable: "Preview unavailable",
  marketingTemplatesTikTokRefreshing: "Refreshing references",
  marketingTemplatesTikTokUnavailableTitle: "TikTok trends are unavailable",
  marketingTemplatesTikTokTemporaryTitle:
    "TikTok trends are temporarily unavailable",
  marketingTemplatesTikTokEmptyTitle: "No references found",
  marketingTemplatesTikTokRetryableErrorTitle:
    "TikTok references could not be loaded",
  marketingTemplatesTikTokNonretryableErrorTitle:
    "TikTok trends are unavailable",
  marketingTemplatesTikTokRetry: "Retry",
  marketingTemplatesTikTokStaleWarning:
    "Showing saved references while TikTok is unavailable.",
  marketingTemplatesTikTokOpenReference:
    "Open {title} on TikTok (opens in new tab)",
  marketingTemplatesTikTokPresetPending: "Prompt preset coming later",
  referenceVideoUseIdea: "Use this idea",
  referenceVideoTitle: "Plan your video",
  referenceVideoOpenPlanner: "Plan with my assets",
  marketingTemplatesTikTokCategoryAll: "All industries",
  marketingTemplatesTikTokCategoryApparelAndAccessories:
    "Apparel and accessories",
  marketingTemplatesTikTokCategoryBabyKidsAndMaternity:
    "Baby, kids, and maternity",
  marketingTemplatesTikTokCategoryBeautyAndPersonalCare:
    "Beauty and personal care",
  marketingTemplatesTikTokCategoryBusinessServices: "Business services",
  marketingTemplatesTikTokCategoryEducation: "Education",
  marketingTemplatesTikTokCategoryFinancialServices: "Financial services",
  marketingTemplatesTikTokCategoryFoodAndBeverage: "Food and beverage",
  marketingTemplatesTikTokCategoryGames: "Games",
  marketingTemplatesTikTokCategoryHealth: "Health",
  marketingTemplatesTikTokCategoryHomeImprovement: "Home improvement",
  marketingTemplatesTikTokCategoryHouseholdProducts: "Household products",
  marketingTemplatesTikTokCategoryLifeServices: "Life services",
  marketingTemplatesTikTokCategoryNewsAndEntertainment:
    "News and entertainment",
  marketingTemplatesTikTokCategoryPets: "Pets",
  marketingTemplatesTikTokCategorySportsAndOutdoor: "Sports and outdoor",
  marketingTemplatesTikTokCategoryTechnology: "Technology",
  marketingTemplatesTikTokCategoryTravel: "Travel",
  marketingTemplatesTikTokCategoryVehicleAndTransportation:
    "Vehicle and transportation",
};

const translate = (key: string, values?: Record<string, number | string>) =>
  (TEST_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (token, name: string) =>
    values?.[name] === undefined ? token : String(values[name])
  );

installResizeObserver();

for (const [name, value] of Object.entries({
  scrollIntoView: jest.fn(),
  hasPointerCapture: jest.fn(() => false),
  setPointerCapture: jest.fn(),
  releasePointerCapture: jest.fn(),
})) {
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    value,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

type OkResponse = Extract<TikTokMarketingTemplatesResponse, { status: "ok" }>;

function okResponse(
  input: {
    title?: string;
    market?: TikTokDiscoveryMarket;
    category?: TikTokDiscoveryCategory;
    items?: OkResponse["items"];
    stale?: boolean;
    warning?: OkResponse["warning"];
  } = {}
): OkResponse {
  const market = input.market ?? "KZ";
  const category = input.category ?? "ALL";
  return {
    status: "ok",
    market,
    category,
    windowDays: 7,
    updatedAt: "2026-08-13T12:00:00.000Z",
    stale: input.stale ?? false,
    ...(input.warning ? { warning: input.warning } : {}),
    items: input.items ?? [
      {
        id: "tiktok:video-1",
        source: "tiktok_discovery",
        title: input.title ?? "Restaurant transformation",
        preset: null,
        reference: {
          providerVideoId: "video-1",
          shareUrl: "https://www.tiktok.com/@creator/video/1",
          thumbnailUrl: null,
          creatorName: "Creator",
          creatorUrl: "https://www.tiktok.com/@creator",
          hashtag: "restaurant",
          hashtagRank: 1,
          videoRank: 1,
          market,
          category,
          windowDays: 7,
        },
      },
    ],
  };
}

let fetchMock: jest.MockedFunction<typeof fetch>;
let storageValues: Map<string, string>;
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

beforeEach(() => {
  mockLocale = "en";
  storageValues = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: jest.fn((key: string) => storageValues.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => {
        storageValues.set(key, String(value));
      }),
      removeItem: jest.fn((key: string) => {
        storageValues.delete(key);
      }),
      clear: jest.fn(() => storageValues.clear()),
      key: jest.fn((index: number) => [...storageValues.keys()][index] ?? null),
      get length() {
        return storageValues.size;
      },
    } satisfies Storage,
  });
  fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalStorage) {
    Object.defineProperty(window, "localStorage", originalStorage);
  } else {
    Reflect.deleteProperty(window, "localStorage");
  }
});

function renderCatalog(workspaceId: string, onApply = jest.fn()) {
  const cache = new Map();
  const node = (id: string) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <CreativeAssetsMarketingTemplates
        workspaceId={id}
        t={translate}
        onApply={onApply}
      />
    </SWRConfig>
  );
  const view = render(node(workspaceId));
  return {
    ...view,
    onApply,
    rerenderWorkspace: (id: string) => view.rerender(node(id)),
  };
}

async function chooseFilter(
  user: ReturnType<typeof userEvent.setup>,
  label: "Industry" | "Market",
  search: string,
  option: string | RegExp
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.type(screen.getByPlaceholderText("Search"), search);
  await user.click(await screen.findByRole("option", { name: option }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps airi.chat as the default and preserves static Apply", async () => {
  const user = userEvent.setup();
  const { onApply } = renderCatalog("workspace-1");

  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getAllByRole("button", { name: "Use" })[0]);

  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({
      id: expect.any(String),
      prompt: expect.any(String),
    })
  );
});

it("preserves the existing Airi category filter without fetching TikTok", async () => {
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  expect(screen.getByText("9 templates")).toBeVisible();
  await user.click(screen.getByTestId("marketing-template-category-product"));
  expect(screen.getByText("2 templates")).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("loads TikTok lazily and renders a reference without provider media", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(okResponse()));
  const { container, onApply } = renderCatalog("workspace-1");

  expect(fetchMock).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("tab", { name: "TikTok trends" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=KZ&category=ALL",
      { cache: "no-store" }
    )
  );
  const referenceLink = await screen.findByRole("link", {
    name: "Open Restaurant transformation on TikTok (opens in new tab)",
  });
  expect(referenceLink).toHaveAttribute("rel", "noopener noreferrer");
  expect(referenceLink).toHaveTextContent("View on TikTok");
  expect(screen.queryByText("Prompt preset coming later")).toBeNull();
  expect(container.querySelector("iframe, script, video, audio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
});

it("opens an attributed video plan from a TikTok idea without generating media", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(okResponse()));
  const { onApply } = renderCatalog("workspace-1");
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await user.click(
    await screen.findByRole("button", { name: "Use this idea" })
  );
  expect(screen.getByRole("dialog", { name: "Plan your video" })).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Restaurant transformation" })
  ).toHaveAttribute("href", "https://www.tiktok.com/@creator/video/1");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onApply).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Plan your video" })
    ).not.toBeInTheDocument()
  );
});

it("offers the same planner while TikTok discovery is unavailable", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));
  const user = userEvent.setup();
  renderCatalog("workspace-1");
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Plan with my assets" }));
  expect(screen.getByRole("dialog", { name: "Plan your video" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("renders collection content as labelled tabpanels and keeps intent preloading network-free", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  expect(
    screen.getByRole("tabpanel", { name: "airi.chat templates" })
  ).toBeVisible();
  const tiktokTab = screen.getByRole("tab", { name: "TikTok trends" });
  await user.hover(tiktokTab);
  expect(fetchMock).not.toHaveBeenCalled();

  await user.click(tiktokTab);
  expect(
    await screen.findByRole("tabpanel", { name: "TikTok trends" })
  ).toBeVisible();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});

it("keeps the loaded TikTok panel warm across rapid collection toggles", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Restaurant transformation")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "airi.chat templates" }));
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));

  expect(screen.getByText("Restaurant transformation")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("uses stored workspace coordinates and persists keyboard-selected filters", async () => {
  storageValues.set(
    "airi:assets:tiktok-discovery-preferences:v1:workspace-1",
    JSON.stringify({ market: "UZ", category: "FOOD_AND_BEVERAGE" })
  );
  fetchMock.mockResolvedValue(
    jsonResponse({
      ...okResponse(),
      market: "UZ",
      category: "FOOD_AND_BEVERAGE",
    })
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=UZ&category=FOOD_AND_BEVERAGE",
      { cache: "no-store" }
    )
  );
  await user.click(screen.getByRole("combobox", { name: "Market" }));
  await user.type(screen.getByPlaceholderText("Search"), "KZ");
  await user.keyboard("{ArrowDown}{Enter}");

  expect(
    JSON.parse(
      storageValues.get(
        "airi:assets:tiktok-discovery-preferences:v1:workspace-1"
      )!
    )
  ).toMatchObject({ market: "KZ" });
});

it("searches localized categories and requests the selected coordinate", async () => {
  fetchMock.mockImplementation(async input => {
    const category = String(input).includes("FOOD_AND_BEVERAGE")
      ? "FOOD_AND_BEVERAGE"
      : "ALL";
    return jsonResponse(okResponse({ category }));
  });
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(
    user,
    "Industry",
    "Food and beverage",
    "Food and beverage"
  );

  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=KZ&category=FOOD_AND_BEVERAGE",
      { cache: "no-store" }
    )
  );
});

it("exposes every shared market and category through searchable selectors", async () => {
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  expect(TIKTOK_DISCOVERY_MARKETS).toHaveLength(246);
  expect(TIKTOK_DISCOVERY_CATEGORIES).toHaveLength(19);
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await user.click(screen.getByRole("combobox", { name: "Market" }));
  expect(await screen.findAllByRole("option")).toHaveLength(246);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("combobox", { name: "Industry" }));
  expect(await screen.findAllByRole("option")).toHaveLength(19);
});

it("maps the app's kz locale to kk for region labels", async () => {
  mockLocale = "kz";
  const displayNames = jest.spyOn(Intl, "DisplayNames").mockImplementation(
    () =>
      ({
        of: (code: string) => (code === "KZ" ? "Қазақстан" : code),
      }) as Intl.DisplayNames
  );
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await user.click(screen.getByRole("combobox", { name: "Market" }));
  expect(
    await screen.findByRole("option", { name: /Қазақстан.*KZ/ })
  ).toBeVisible();
  expect(displayNames).toHaveBeenCalledWith(["kk"], { type: "region" });
});

it("falls back to country codes when Intl.DisplayNames throws", async () => {
  jest.spyOn(Intl, "DisplayNames").mockImplementation(() => {
    throw new RangeError("unsupported locale");
  });
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await user.click(screen.getByRole("combobox", { name: "Market" }));
  expect(await screen.findByRole("option", { name: "KZ" })).toBeVisible();
});

it("falls back to country codes when Intl.DisplayNames is unavailable", async () => {
  const originalDisplayNames = Intl.DisplayNames;
  Object.defineProperty(Intl, "DisplayNames", {
    configurable: true,
    value: undefined,
  });
  try {
    fetchMock.mockResolvedValue(jsonResponse(okResponse()));
    const user = userEvent.setup();
    renderCatalog("workspace-1");

    await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
    await user.click(screen.getByRole("combobox", { name: "Market" }));
    expect(await screen.findByRole("option", { name: "KZ" })).toBeVisible();
  } finally {
    Object.defineProperty(Intl, "DisplayNames", {
      configurable: true,
      value: originalDisplayNames,
    });
  }
});

it.each(["blocked storage", "malformed JSON"] as const)(
  "uses safe defaults for %s",
  async failure => {
    if (failure === "blocked storage") {
      (window.localStorage.getItem as jest.Mock).mockImplementationOnce(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    } else {
      storageValues.set(
        "airi:assets:tiktok-discovery-preferences:v1:workspace-1",
        "{not-json"
      );
    }
    fetchMock.mockResolvedValue(jsonResponse(okResponse()));
    const user = userEvent.setup();
    renderCatalog("workspace-1");

    await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=KZ&category=ALL",
        { cache: "no-store" }
      )
    );
  }
);

it("rejects stored coordinates that are not exact shared constants", async () => {
  storageValues.set(
    "airi:assets:tiktok-discovery-preferences:v1:workspace-1",
    JSON.stringify({ market: "kz", category: "food_and_beverage" })
  );
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=KZ&category=ALL",
      { cache: "no-store" }
    )
  );
});

it("keeps filter selection usable when localStorage writes fail", async () => {
  (window.localStorage.setItem as jest.Mock).mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  fetchMock.mockImplementation(async input =>
    jsonResponse(
      okResponse({ market: String(input).includes("market=UZ") ? "UZ" : "KZ" })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(user, "Market", "UZ", /Uzbekistan.*UZ/);

  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=UZ&category=ALL",
      { cache: "no-store" }
    )
  );
});

it("persists an API-resolved coordinate without mutating the request key", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(okResponse({ market: "KZ", category: "ALL" }))
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Restaurant transformation")).toBeVisible();
  await waitFor(() =>
    expect(
      storageValues.get(
        "airi:assets:tiktok-discovery-preferences:v1:workspace-1"
      )
    ).toBe(JSON.stringify({ market: "KZ", category: "ALL" }))
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects an initial OK response whose coordinates do not match the request", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(okResponse({ market: "UZ", title: "Wrong coordinate" }))
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));

  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();
  expect(screen.queryByText("Wrong coordinate")).toBeNull();
  expect(screen.queryByText("New")).toBeNull();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it.each([
  [
    "an array payload",
    () => [{ ...okResponse().items[0], title: "Unsafe array item" }],
    "Unsafe array item",
  ],
  [
    "an array reference",
    () => ({
      ...okResponse(),
      items: [
        {
          ...okResponse().items[0],
          title: "Malformed reference",
          reference: [],
        },
      ],
    }),
    "Malformed reference",
  ],
  [
    "more than twelve items",
    () => ({
      ...okResponse(),
      items: Array.from({ length: 13 }, (_, index) => {
        const item = okResponse().items[0];
        const providerVideoId = `oversized-${index}`;
        return {
          ...item,
          id: `tiktok:${providerVideoId}`,
          title: `Oversized item ${index}`,
          reference: { ...item.reference, providerVideoId },
        };
      }),
    }),
    "Oversized item 0",
  ],
  [
    "a truthy preset",
    () => ({
      ...okResponse(),
      items: [
        {
          ...okResponse().items[0],
          title: "Forged preset",
          preset: { id: "forged", prompt: "untrusted" },
        },
      ],
    }),
    "Forged preset",
  ],
] as const)(
  "rejects %s without cards, capability, persistence, or retention",
  async (_name, buildPayload, unsafeTitle) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildPayload()))
      .mockRejectedValueOnce(new Error("same-coordinate transport failure"));
    const user = userEvent.setup();
    const { onApply } = renderCatalog("workspace-1");

    await user.click(screen.getByRole("tab", { name: "TikTok trends" }));

    const errorTitle = await screen.findByText(
      "TikTok references could not be loaded"
    );
    expect(errorTitle).toBeVisible();
    expect(errorTitle).toHaveClass("line-clamp-none", "break-words");
    expect(screen.queryByText(unsafeTitle)).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(unsafeTitle)).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  }
);

it("revokes same-identity retained cards after a malformed response", async () => {
  const validResponse = okResponse({
    title: "Initially valid reference",
    stale: true,
    warning: "provider_unavailable",
  });
  fetchMock
    .mockResolvedValueOnce(jsonResponse(validResponse))
    .mockResolvedValueOnce(
      jsonResponse({
        ...validResponse,
        items: [
          {
            ...validResponse.items[0],
            title: "Forged preset reference",
            preset: { id: "forged", prompt: "untrusted" },
          },
        ],
      })
    )
    .mockRejectedValueOnce(new Error("same-coordinate transport failure"));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Initially valid reference")).toBeVisible();
  await waitFor(() => expect(window.localStorage.setItem).toHaveBeenCalled());
  (window.localStorage.setItem as jest.Mock).mockClear();

  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();
  expect(screen.queryByText("Initially valid reference")).toBeNull();
  expect(screen.queryByText("Forged preset reference")).toBeNull();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()
  );
  expect({
    retainedCardVisibleAfterTransport:
      screen.queryByText("Initially valid reference") !== null,
    safeErrorVisibleAfterTransport:
      screen.queryByText("TikTok references could not be loaded") !== null,
  }).toEqual({
    retainedCardVisibleAfterTransport: false,
    safeErrorVisibleAfterTransport: true,
  });
  expect(screen.queryByText("Forged preset reference")).toBeNull();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("drops same-coordinate retained cards when a later OK response has mismatched coordinates", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          title: "Saved KZ",
          stale: true,
          warning: "provider_unavailable",
        })
      )
    )
    .mockRejectedValueOnce(new Error("temporary KZ failure"))
    .mockResolvedValueOnce(
      jsonResponse(okResponse({ market: "UZ", title: "Mismatched UZ" }))
    );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Saved KZ")).toBeVisible();
  (window.localStorage.setItem as jest.Mock).mockClear();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Saved KZ")).toBeVisible();
  const warningTitle = screen.getByText(
    "Showing saved references while TikTok is unavailable."
  );
  expect(warningTitle).toBeVisible();
  expect(warningTitle).toHaveClass("line-clamp-none", "break-words");
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();
  expect(screen.queryByText("Saved KZ")).toBeNull();
  expect(screen.queryByText("Mismatched UZ")).toBeNull();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("never renders a response from the prior workspace", async () => {
  const first = deferred<Response>();
  fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
    jsonResponse({
      ...okResponse(),
      items: [
        {
          ...okResponse().items[0],
          id: "tiktok:workspace-b",
          title: "Workspace B",
          reference: {
            ...okResponse().items[0].reference,
            providerVideoId: "workspace-b",
          },
        },
      ],
    })
  );
  const user = userEvent.setup();
  const view = renderCatalog("workspace-a");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  view.rerenderWorkspace("workspace-b");
  expect(screen.queryByTestId("tiktok-template-skeleton")).toBeNull();
  expect(
    screen.getByRole("tab", { name: "airi.chat templates" })
  ).toHaveAttribute("data-state", "active");
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Workspace B")).toBeVisible();
  first.resolve(
    jsonResponse({
      ...okResponse(),
      items: [
        {
          ...okResponse().items[0],
          id: "tiktok:workspace-a",
          title: "Workspace A",
          reference: {
            ...okResponse().items[0].reference,
            providerVideoId: "workspace-a",
          },
        },
      ],
    })
  );
  await waitFor(() => expect(screen.queryByText("Workspace A")).toBeNull());
});

it("reads the next workspace preference before its first TikTok request", async () => {
  storageValues.set(
    "airi:assets:tiktok-discovery-preferences:v1:workspace-b",
    JSON.stringify({ market: "UZ", category: "GAMES" })
  );
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  const view = renderCatalog("workspace-a");

  view.rerenderWorkspace("workspace-b");
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-b/assets/marketing-templates/tiktok?market=UZ&category=GAMES",
      { cache: "no-store" }
    )
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("never renders a late response from the prior market", async () => {
  const first = deferred<Response>();
  fetchMock
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(
      jsonResponse(okResponse({ market: "UZ", title: "UZ result" }))
    );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(user, "Market", "UZ", /Uzbekistan.*UZ/);
  expect(await screen.findByText("UZ result")).toBeVisible();
  await act(async () => {
    first.resolve(jsonResponse(okResponse({ market: "KZ", title: "Late KZ" })));
  });
  await waitFor(() => expect(screen.queryByText("Late KZ")).toBeNull());
  expect(screen.getByText("UZ result")).toBeVisible();
});

it("never renders a late response from the prior category", async () => {
  const all = deferred<Response>();
  fetchMock.mockReturnValueOnce(all.promise).mockResolvedValueOnce(
    jsonResponse(
      okResponse({
        category: "FOOD_AND_BEVERAGE",
        title: "Food result",
      })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(
    user,
    "Industry",
    "Food and beverage",
    "Food and beverage"
  );
  expect(await screen.findByText("Food result")).toBeVisible();
  await act(async () => {
    all.resolve(
      jsonResponse(okResponse({ category: "ALL", title: "Late All" }))
    );
  });
  await waitFor(() => expect(screen.queryByText("Late All")).toBeNull());
  expect(screen.getByText("Food result")).toBeVisible();
});

it("ignores a late market response whose body matches the new market instead of its request", async () => {
  const first = deferred<Response>();
  fetchMock
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(
      jsonResponse(okResponse({ market: "UZ", title: "Current UZ" }))
    );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(user, "Market", "UZ", /Uzbekistan.*UZ/);
  expect(await screen.findByText("Current UZ")).toBeVisible();
  (window.localStorage.setItem as jest.Mock).mockClear();

  await act(async () => {
    first.resolve(
      jsonResponse(okResponse({ market: "UZ", title: "Late market body" }))
    );
  });

  await waitFor(() =>
    expect(screen.queryByText("Late market body")).toBeNull()
  );
  expect(screen.getByText("Current UZ")).toBeVisible();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("ignores a late category response whose body matches the new category instead of its request", async () => {
  const first = deferred<Response>();
  fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
    jsonResponse(
      okResponse({
        category: "FOOD_AND_BEVERAGE",
        title: "Current food",
      })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  await chooseFilter(
    user,
    "Industry",
    "Food and beverage",
    "Food and beverage"
  );
  expect(await screen.findByText("Current food")).toBeVisible();
  (window.localStorage.setItem as jest.Mock).mockClear();

  await act(async () => {
    first.resolve(
      jsonResponse(
        okResponse({
          category: "FOOD_AND_BEVERAGE",
          title: "Late category body",
        })
      )
    );
  });

  await waitFor(() =>
    expect(screen.queryByText("Late category body")).toBeNull()
  );
  expect(screen.getByText("Current food")).toBeVisible();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("ignores a late mismatched OK response from the prior workspace", async () => {
  const first = deferred<Response>();
  fetchMock
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(
      jsonResponse(okResponse({ title: "Current workspace" }))
    );
  const user = userEvent.setup();
  const view = renderCatalog("workspace-a");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  view.rerenderWorkspace("workspace-b");
  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Current workspace")).toBeVisible();
  (window.localStorage.setItem as jest.Mock).mockClear();

  await act(async () => {
    first.resolve(
      jsonResponse(
        okResponse({ market: "UZ", title: "Late prior workspace body" })
      )
    );
  });

  await waitFor(() =>
    expect(screen.queryByText("Late prior workspace body")).toBeNull()
  );
  expect(screen.getByText("Current workspace")).toBeVisible();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("retains success only for the same coordinate and replaces it with empty ok", async () => {
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          title: "Saved KZ",
          stale: true,
          warning: "provider_unavailable",
        })
      )
    )
    .mockRejectedValueOnce(new Error("temporary KZ failure"))
    .mockRejectedValueOnce(new Error("temporary UZ failure"))
    .mockResolvedValueOnce(jsonResponse(okResponse({ items: [] })));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Saved KZ")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Saved KZ")).toBeVisible();

  await chooseFilter(user, "Market", "UZ", /Uzbekistan.*UZ/);
  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();
  expect(screen.queryByText("Saved KZ")).toBeNull();

  await chooseFilter(user, "Market", "KZ", /Kazakhstan.*KZ/);
  expect(await screen.findByText("No references found")).toBeVisible();
  expect(screen.queryByText("Saved KZ")).toBeNull();
});

const productStates: Array<[TikTokMarketingTemplatesResponse, string]> = [
  [{ status: "unavailable", items: [] }, "TikTok trends are unavailable"],
  [
    { status: "temporarily_unavailable", items: [] },
    "TikTok trends are temporarily unavailable",
  ],
  [
    { status: "error", items: [], retryable: true },
    "TikTok references could not be loaded",
  ],
  [
    { status: "error", items: [], retryable: false },
    "TikTok trends are unavailable",
  ],
  [{ ...okResponse(), items: [] }, "No references found"],
];

it.each(productStates)("renders product state %#", async (response, title) => {
  fetchMock.mockResolvedValue(jsonResponse(response));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText(title)).toBeVisible();
  expect(
    screen.queryByText(/connect|reconnect|advertiser|approval/i)
  ).toBeNull();
});

it("shows exactly four skeletons while the first request is pending", async () => {
  fetchMock.mockReturnValue(new Promise<Response>(() => {}));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findAllByTestId("tiktok-template-skeleton")).toHaveLength(
    4
  );
});

it("preserves the prior grid footprint while a new coordinate is loading", async () => {
  const base = okResponse().items[0];
  const pending = deferred<Response>();
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          items: Array.from({ length: 12 }, (_, index) => ({
            ...base,
            id: `tiktok:video-${index + 1}`,
            title: `Reference ${index + 1}`,
            reference: {
              ...base.reference,
              providerVideoId: `video-${index + 1}`,
              shareUrl: `https://www.tiktok.com/@creator/video/${index + 1}`,
              videoRank: index + 1,
            },
          })),
        })
      )
    )
    .mockReturnValueOnce(pending.promise);
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Reference 12")).toBeVisible();
  await chooseFilter(user, "Market", "UZ", /Uzbekistan.*UZ/);

  expect(await screen.findAllByTestId("tiktok-template-skeleton")).toHaveLength(
    12
  );
});

it.each([429, 503])(
  "renders transport %i as a retryable state",
  async status => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unavailable" }, status));
    const user = userEvent.setup();
    renderCatalog("workspace-1");

    await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
    const errorTitle = await screen.findByText(
      "TikTok references could not be loaded"
    );
    expect(errorTitle).toBeVisible();
    expect(errorTitle).toHaveClass("line-clamp-none", "break-words");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  }
);

it("disables Retry while revalidating and replaces the error on success", async () => {
  const retry = deferred<Response>();
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
    .mockReturnValueOnce(retry.promise);
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  const button = await screen.findByRole("button", { name: "Retry" });
  await user.click(button);
  expect(button).toBeDisabled();
  await act(async () => {
    retry.resolve(jsonResponse(okResponse({ title: "Recovered" })));
  });
  expect(await screen.findByText("Recovered")).toBeVisible();
});

it.each([
  [{ status: "unavailable", items: [] }, false],
  [okResponse(), true],
] as const)(
  "shows a reference count only after a usable provider response %#",
  async (response, expected) => {
    fetchMock.mockResolvedValue(jsonResponse(response));
    const user = userEvent.setup();
    renderCatalog("workspace-1");

    await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("1 references") !== null).toBe(expected);
  }
);

it("keeps same-coordinate stale cards with a provider warning", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(
      okResponse({
        title: "Saved reference",
        stale: true,
        warning: "provider_unavailable",
      })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("Saved reference")).toBeVisible();
  const warningTitle = screen.getByText(
    "Showing saved references while TikTok is unavailable."
  );
  expect(warningTitle).toBeVisible();
  expect(warningTitle).toHaveClass("line-clamp-none", "break-words");
});

it("renders a safe attributed reference card with bounded text and media", async () => {
  const longTitle = "A very long TikTok reference title ".repeat(12).trim();
  const base = okResponse({ title: longTitle }).items[0];
  fetchMock.mockResolvedValue(
    jsonResponse(
      okResponse({
        items: [
          {
            ...base,
            reference: {
              ...base.reference,
              thumbnailUrl: "https://p16.muscdn.com/object/preview.jpg",
            },
          },
        ],
      })
    )
  );
  const user = userEvent.setup();
  const { container } = renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  const title = await screen.findByText(longTitle);
  expect(title).toHaveClass("line-clamp-2");
  const image = screen.getByRole("img", { name: longTitle });
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("decoding", "async");
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  const link = screen.getByRole("link", {
    name: `Open ${longTitle} on TikTok (opens in new tab)`,
  });
  expect(link).toHaveAttribute("href", base.reference.shareUrl);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(container.querySelector("iframe, script, video, audio")).toBeNull();
});

it("replaces a provider thumbnail that fails to load with the safe fallback", async () => {
  const base = okResponse().items[0];
  fetchMock.mockResolvedValue(
    jsonResponse(
      okResponse({
        items: [
          {
            ...base,
            reference: {
              ...base.reference,
              thumbnailUrl: "https://p16.muscdn.com/object/broken-preview.jpg",
            },
          },
        ],
      })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  const image = await screen.findByRole("img", {
    name: "Restaurant transformation",
  });
  fireEvent.error(image);

  expect(image).not.toBeInTheDocument();
  expect(
    screen.getByTestId("tiktok-template-thumbnail-fallback")
  ).toHaveAccessibleName("Preview unavailable");
});

it("tries a refreshed thumbnail URL for the same TikTok reference after retry", async () => {
  const base = okResponse().items[0];
  const firstThumbnail = "https://p16.muscdn.com/object/expired-preview.jpg";
  const refreshedThumbnail =
    "https://p16.muscdn.com/object/refreshed-preview.jpg";
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          stale: true,
          warning: "provider_unavailable",
          items: [
            {
              ...base,
              reference: {
                ...base.reference,
                thumbnailUrl: firstThumbnail,
              },
            },
          ],
        })
      )
    )
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          items: [
            {
              ...base,
              reference: {
                ...base.reference,
                thumbnailUrl: refreshedThumbnail,
              },
            },
          ],
        })
      )
    );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  fireEvent.error(
    await screen.findByRole("img", { name: "Restaurant transformation" })
  );
  expect(
    screen.getByTestId("tiktok-template-thumbnail-fallback")
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(
    await screen.findByRole("img", { name: "Restaurant transformation" })
  ).toHaveAttribute("src", refreshedThumbnail);
  expect(screen.queryByTestId("tiktok-template-thumbnail-fallback")).toBeNull();
});

it("rejects a response with non-TikTok links or unsafe thumbnails", async () => {
  const base = okResponse().items[0];
  fetchMock.mockResolvedValue(
    jsonResponse(
      okResponse({
        items: [
          {
            ...base,
            reference: {
              ...base.reference,
              shareUrl: "https://www.tiktok.com.evil.example/video/1",
              thumbnailUrl: "https://evil.example/tracker.jpg",
            },
          },
        ],
      })
    )
  );
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(
    await screen.findByText("TikTok references could not be loaded")
  ).toBeVisible();
  expect(screen.queryByText("Restaurant transformation")).toBeNull();
  expect(
    screen.queryByRole("link", { name: /Open Restaurant transformation/ })
  ).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByTestId("tiktok-template-thumbnail-fallback")).toBeNull();
  expect(screen.queryByText("New")).toBeNull();
  expect(window.localStorage.setItem).not.toHaveBeenCalled();
});

it("uses a deterministic fallback and never offers Apply for a null preset", async () => {
  fetchMock.mockResolvedValue(jsonResponse(okResponse()));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(
    await screen.findByTestId("tiktok-template-thumbnail-fallback")
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
});

it("resets an empty filtered coordinate to the safe default discovery filters", async () => {
  storageValues.set(
    "airi:assets:tiktok-discovery-preferences:v1:workspace-1",
    JSON.stringify({ market: "UZ", category: "FOOD_AND_BEVERAGE" })
  );
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse(
        okResponse({
          market: "UZ",
          category: "FOOD_AND_BEVERAGE",
          items: [],
        })
      )
    )
    .mockResolvedValueOnce(jsonResponse(okResponse({ items: [] })));
  const user = userEvent.setup();
  renderCatalog("workspace-1");

  await user.click(screen.getByRole("tab", { name: "TikTok trends" }));
  expect(await screen.findByText("No references found")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Reset filters" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-1/assets/marketing-templates/tiktok?market=KZ&category=ALL",
      { cache: "no-store" }
    )
  );
  expect(screen.getByRole("combobox", { name: "Market" })).toHaveTextContent(
    /Kazakhstan.*KZ/
  );
  expect(screen.getByRole("combobox", { name: "Industry" })).toHaveTextContent(
    "All industries"
  );
});
