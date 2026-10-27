import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { toArray } from "@icecore/shared/lib/value-utils";

const KB_CUSTOM_DOMAIN_HIT_TTL_MS = 5 * 60 * 1000;
const KB_CUSTOM_DOMAIN_MISS_TTL_MS = 60 * 1000;

type MaybeArray<T> = T | T[] | null | undefined;

type KbSettingsLookupRow = {
  workspace_id: string | null;
  workspaces?: MaybeArray<{
    companies?: MaybeArray<{
      slug: string | null;
    }>;
  }>;
};

type KbCustomDomainCacheEntry = {
  companySlug: string | null;
  expiresAt: number;
};

const kbCustomDomainCache = new Map<string, KbCustomDomainCacheEntry>();
const kbCustomDomainInFlight = new Map<string, Promise<string | null>>();

let kbCustomDomainSupabase: SupabaseClient | null = null;

function getKbCustomDomainSupabaseClient(): SupabaseClient {
  if (kbCustomDomainSupabase) {
    return kbCustomDomainSupabase;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase environment variables are not configured");
  }

  kbCustomDomainSupabase = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return kbCustomDomainSupabase;
}

export function normalizeKbCustomDomainHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

function readCompanySlugFromKbSettingsRow(
  row: KbSettingsLookupRow | null
): string | null {
  for (const workspace of toArray(row?.workspaces)) {
    for (const company of toArray(workspace?.companies)) {
      const slug = company?.slug?.trim();
      if (slug) {
        return slug;
      }
    }
  }

  return null;
}

async function fetchKbCustomDomainCompanySlug(
  host: string
): Promise<string | null> {
  const supabase = getKbCustomDomainSupabaseClient();
  const { data, error } = await supabase
    .from("kb_settings")
    .select(
      `
      custom_domain,
      workspace_id,
      workspaces!inner (
        company_id,
        companies!inner (
          slug
        )
      )
    `
    )
    .eq("custom_domain", host)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return readCompanySlugFromKbSettingsRow(
    (data as KbSettingsLookupRow) ?? null
  );
}

export async function resolveKbCustomDomainCompanySlug(
  host: string
): Promise<string | null> {
  const normalizedHost = normalizeKbCustomDomainHost(host);
  if (!normalizedHost) {
    return null;
  }

  const cached = kbCustomDomainCache.get(normalizedHost);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.companySlug;
  }

  const existingLookup = kbCustomDomainInFlight.get(normalizedHost);
  if (existingLookup) {
    return existingLookup;
  }

  const lookupPromise = fetchKbCustomDomainCompanySlug(normalizedHost)
    .then(companySlug => {
      kbCustomDomainCache.set(normalizedHost, {
        companySlug,
        expiresAt:
          Date.now() +
          (companySlug
            ? KB_CUSTOM_DOMAIN_HIT_TTL_MS
            : KB_CUSTOM_DOMAIN_MISS_TTL_MS),
      });
      return companySlug;
    })
    .finally(() => {
      kbCustomDomainInFlight.delete(normalizedHost);
    });

  kbCustomDomainInFlight.set(normalizedHost, lookupPromise);
  return lookupPromise;
}
