"use client";

import { readJsonResponse } from "@/lib/creative-assets/creative-asset-client-response";
import {
  buildTikTokMarketingTemplatesUrl,
  decodeTikTokMarketingTemplatesResponse,
  getTikTokDiscoveryPreferencesStorageKey,
  normalizeTikTokDiscoveryPreferences,
  TIKTOK_DISCOVERY_CATEGORIES,
  TIKTOK_DISCOVERY_MARKETS,
  type TikTokDiscoveryCategory,
  type TikTokDiscoveryMarket,
  type TikTokDiscoveryPreferences,
  type TikTokMarketingTemplatesResponse,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { useLocale } from "next-intl";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  TikTokInspirationView,
  type TikTokInspirationCatalogState,
  type MarketingTemplatesTranslationFn,
  type TikTokInspirationFilterOption,
  type TikTokInspirationViewProps,
} from "./creative-assets-tiktok-inspiration-view";

export type { MarketingTemplatesTranslationFn } from "./creative-assets-tiktok-inspiration-view";

type OkResponse = Extract<TikTokMarketingTemplatesResponse, { status: "ok" }>;
type TikTokTemplatesKey = readonly [
  "tiktok-marketing-templates",
  string,
  TikTokDiscoveryMarket,
  TikTokDiscoveryCategory,
];
type IdentifiedTikTokResponse = {
  identity: string;
  response: TikTokMarketingTemplatesResponse;
  allowRetainedSuccess: boolean;
};
type TikTokInspirationController = Omit<
  TikTokInspirationViewProps,
  "t" | "onUseReference"
>;

const CATEGORY_KEYS: Record<TikTokDiscoveryCategory, string> = {
  ALL: "marketingTemplatesTikTokCategoryAll",
  APPAREL_AND_ACCESSORIES:
    "marketingTemplatesTikTokCategoryApparelAndAccessories",
  BABY_KIDS_AND_MATERNITY:
    "marketingTemplatesTikTokCategoryBabyKidsAndMaternity",
  BEAUTY_AND_PERSONAL_CARE:
    "marketingTemplatesTikTokCategoryBeautyAndPersonalCare",
  BUSINESS_SERVICES: "marketingTemplatesTikTokCategoryBusinessServices",
  EDUCATION: "marketingTemplatesTikTokCategoryEducation",
  FINANCIAL_SERVICES: "marketingTemplatesTikTokCategoryFinancialServices",
  FOOD_AND_BEVERAGE: "marketingTemplatesTikTokCategoryFoodAndBeverage",
  GAMES: "marketingTemplatesTikTokCategoryGames",
  HEALTH: "marketingTemplatesTikTokCategoryHealth",
  HOME_IMPROVEMENT: "marketingTemplatesTikTokCategoryHomeImprovement",
  HOUSEHOLD_PRODUCTS: "marketingTemplatesTikTokCategoryHouseholdProducts",
  LIFE_SERVICES: "marketingTemplatesTikTokCategoryLifeServices",
  NEWS_AND_ENTERTAINMENT:
    "marketingTemplatesTikTokCategoryNewsAndEntertainment",
  PETS: "marketingTemplatesTikTokCategoryPets",
  SPORTS_AND_OUTDOOR: "marketingTemplatesTikTokCategorySportsAndOutdoor",
  TECHNOLOGY: "marketingTemplatesTikTokCategoryTechnology",
  TRAVEL: "marketingTemplatesTikTokCategoryTravel",
  VEHICLE_AND_TRANSPORTATION:
    "marketingTemplatesTikTokCategoryVehicleAndTransportation",
};

const RETAINED_SUCCESS_LIMIT = 8;
const DEFAULT_PREFERENCES: TikTokDiscoveryPreferences = {
  market: "KZ",
  category: "ALL",
};

class TikTokTemplatesRequestError extends Error {
  constructor(readonly identity: string) {
    super("TikTok inspiration request failed");
    this.name = "TikTokTemplatesRequestError";
  }
}

function invalidTikTokTemplatesResponse(
  identity: string
): IdentifiedTikTokResponse {
  return {
    identity,
    response: { status: "error", items: [], retryable: true },
    allowRetainedSuccess: false,
  };
}

function readPreferences(workspaceId: string): TikTokDiscoveryPreferences {
  try {
    const raw = localStorage.getItem(
      getTikTokDiscoveryPreferencesStorageKey(workspaceId)
    );
    return normalizeTikTokDiscoveryPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writePreferences(
  workspaceId: string,
  value: TikTokDiscoveryPreferences
): void {
  try {
    localStorage.setItem(
      getTikTokDiscoveryPreferencesStorageKey(workspaceId),
      JSON.stringify(value)
    );
  } catch {
    // Storage can be blocked while the in-memory selection remains usable.
  }
}

function buildMarketOptions(
  displayNames: Intl.DisplayNames | null
): TikTokInspirationFilterOption<TikTokDiscoveryMarket>[] {
  return TIKTOK_DISCOVERY_MARKETS.map(code => {
    let localizedName: string | undefined;
    try {
      localizedName = displayNames?.of(code);
    } catch {
      localizedName = undefined;
    }
    const label =
      localizedName && localizedName !== code
        ? `${localizedName} (${code})`
        : code;
    return {
      value: code,
      label,
      searchValue: `${localizedName || code} ${code}`,
    };
  });
}

function retainSuccess(
  cache: Map<string, OkResponse>,
  identity: string,
  response: OkResponse
) {
  cache.delete(identity);
  cache.set(identity, response);
  while (cache.size > RETAINED_SUCCESS_LIMIT) {
    const oldestIdentity = cache.keys().next().value;
    if (oldestIdentity === undefined) break;
    cache.delete(oldestIdentity);
  }
}

function useTikTokInspirationController({
  workspaceId,
  t,
}: {
  workspaceId: string;
  t: MarketingTemplatesTranslationFn;
}): TikTokInspirationController {
  const locale = useLocale();
  const [preferences, setPreferences] = useState(() =>
    readPreferences(workspaceId)
  );
  const retainedSuccessRef = useRef<Map<string, OkResponse> | null>(null);
  if (retainedSuccessRef.current === null) {
    retainedSuccessRef.current = new Map<string, OkResponse>();
  }
  const retainedSuccess = retainedSuccessRef.current;
  const skeletonCount = useRef(4);
  const [retainedForFailure, setRetainedForFailure] = useState<{
    identity: string;
    response: OkResponse;
  } | null>(null);
  const markets = useMemo(() => {
    let displayNames: Intl.DisplayNames | null = null;
    try {
      if (typeof Intl.DisplayNames === "function") {
        displayNames = new Intl.DisplayNames(
          [locale === "kz" ? "kk" : locale],
          { type: "region" }
        );
      }
    } catch {
      displayNames = null;
    }
    return buildMarketOptions(displayNames);
  }, [locale]);
  const categories = useMemo(
    () =>
      TIKTOK_DISCOVERY_CATEGORIES.map(value => ({
        value,
        label: t(CATEGORY_KEYS[value]),
        searchValue: t(CATEGORY_KEYS[value]),
      })),
    [t]
  );

  const requestKey: TikTokTemplatesKey = [
    "tiktok-marketing-templates",
    workspaceId,
    preferences.market,
    preferences.category,
  ];
  const identity = requestKey.slice(1).join("\0");
  const { data, error, isLoading, isValidating, mutate } = useSWR<
    IdentifiedTikTokResponse,
    TikTokTemplatesRequestError
  >(
    requestKey,
    async ([, id, market, tiktokCategory]: TikTokTemplatesKey) => {
      const requestIdentity = [id, market, tiktokCategory].join("\0");
      try {
        const fetchResponse = await fetch(
          buildTikTokMarketingTemplatesUrl({
            workspaceId: id,
            market,
            category: tiktokCategory,
          }),
          { cache: "no-store" }
        );
        let rawResponse: unknown;
        try {
          rawResponse = await readJsonResponse<unknown>(fetchResponse);
        } catch (readError) {
          if (fetchResponse.ok) {
            return invalidTikTokTemplatesResponse(requestIdentity);
          }
          throw readError;
        }
        const response = decodeTikTokMarketingTemplatesResponse(rawResponse, {
          market,
          category: tiktokCategory,
        });
        if (response === null) {
          return invalidTikTokTemplatesResponse(requestIdentity);
        }
        return {
          identity: requestIdentity,
          response,
          allowRetainedSuccess: true,
        };
      } catch {
        throw new TikTokTemplatesRequestError(requestIdentity);
      }
    },
    {
      keepPreviousData: false,
      dedupingInterval: 30_000,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      onSuccess: payload => {
        if (payload.response.status === "ok") {
          retainSuccess(retainedSuccess, payload.identity, payload.response);
          skeletonCount.current = Math.max(
            4,
            Math.min(12, payload.response.items.length)
          );
          setRetainedForFailure(null);
          if (
            payload.identity === identity &&
            payload.response.market === preferences.market &&
            payload.response.category === preferences.category
          ) {
            writePreferences(workspaceId, {
              market: payload.response.market,
              category: payload.response.category,
            });
          }
          return;
        }
        if (!payload.allowRetainedSuccess) {
          retainedSuccess.delete(payload.identity);
        }
        const canUseRetained =
          payload.allowRetainedSuccess &&
          (payload.response.status === "temporarily_unavailable" ||
            (payload.response.status === "error" &&
              payload.response.retryable));
        const retained = canUseRetained
          ? retainedSuccess.get(payload.identity)
          : undefined;
        setRetainedForFailure(
          retained ? { identity: payload.identity, response: retained } : null
        );
      },
      onError: requestError => {
        const retained = retainedSuccess.get(requestError.identity);
        setRetainedForFailure(
          retained
            ? { identity: requestError.identity, response: retained }
            : null
        );
      },
    }
  );

  const currentPayload = data?.identity === identity ? data : undefined;
  const currentResponse = currentPayload?.response;
  const responseCanUseRetained =
    currentPayload?.allowRetainedSuccess === true &&
    (currentResponse?.status === "temporarily_unavailable" ||
      (currentResponse?.status === "error" && currentResponse.retryable));
  const retained =
    (error || responseCanUseRetained) &&
    retainedForFailure?.identity === identity
      ? retainedForFailure.response
      : undefined;
  const successfulResponse = retained
    ? retained
    : currentResponse?.status === "ok"
      ? currentResponse
      : undefined;
  const showStaleWarning = Boolean(
    successfulResponse && (successfulResponse.stale || retained)
  );

  const updatePreferences = useCallback(
    (next: TikTokDiscoveryPreferences) => {
      setPreferences(next);
      writePreferences(workspaceId, next);
    },
    [workspaceId]
  );
  const retry = useCallback(() => {
    void mutate();
  }, [mutate]);
  const resetFilters = useCallback(() => {
    updatePreferences(DEFAULT_PREFERENCES);
  }, [updatePreferences]);
  const canResetFilters =
    preferences.market !== DEFAULT_PREFERENCES.market ||
    preferences.category !== DEFAULT_PREFERENCES.category;
  let catalogState: TikTokInspirationCatalogState;
  if (successfulResponse) {
    catalogState = {
      kind: "success",
      response: successfulResponse,
      stale: showStaleWarning,
      refreshing: isValidating,
    };
  } else if (error) {
    catalogState = { kind: "transport_error", retrying: isValidating };
  } else if (isLoading || !currentResponse) {
    catalogState = { kind: "loading", skeletonCount: skeletonCount.current };
  } else if (currentResponse.status === "unavailable") {
    catalogState = { kind: "unavailable", retrying: isValidating };
  } else if (currentResponse.status === "temporarily_unavailable") {
    catalogState = {
      kind: "temporarily_unavailable",
      retrying: isValidating,
    };
  } else if (currentResponse.status === "error") {
    catalogState = {
      kind: "provider_error",
      retryable: currentResponse.retryable,
      retrying: isValidating,
    };
  } else {
    catalogState = {
      kind: "success",
      response: currentResponse,
      stale: false,
      refreshing: isValidating,
    };
  }

  return {
    preferences,
    markets,
    categories,
    catalogState,
    canResetFilters,
    onUpdatePreferences: updatePreferences,
    onRetry: retry,
    onResetFilters: resetFilters,
  };
}

export const CreativeAssetsTikTokInspiration = memo(
  function CreativeAssetsTikTokInspiration({
    workspaceId,
    t,
    onUseReference,
  }: {
    workspaceId: string;
    t: MarketingTemplatesTranslationFn;
    onUseReference: TikTokInspirationViewProps["onUseReference"];
  }) {
    const controller = useTikTokInspirationController({ workspaceId, t });

    return (
      <TikTokInspirationView
        {...controller}
        t={t}
        onUseReference={onUseReference}
      />
    );
  }
);
