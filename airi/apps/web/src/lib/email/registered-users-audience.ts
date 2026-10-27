import "server-only";

import { requireAppAdmin } from "@/lib/auth/app-admin";
import type { BulkCampaignRecipient } from "@/lib/campaign/bulk-campaign-contracts";
import {
  isValidCampaignEmailAddress,
  normalizeCampaignEmail,
} from "@/lib/campaign/campaign-recipient-utils";
import {
  DEFAULT_EMAIL_CAMPAIGN_LOCALE,
  normalizeEmailCampaignLocale,
  type EmailCampaignLocale,
} from "@/lib/email/email-campaign-locales";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import type { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";
import {
  readTrimmedString as cleanString,
  firstOrSelf,
} from "@icecore/shared/lib/value-utils";

const AUTH_USERS_PAGE_SIZE = 1000;
const MAX_AUTH_USERS_PAGES = 500;
const DEFAULT_PREVIEW_LIMIT = 100;
const MAX_PREVIEW_LIMIT = 500;
const DEFAULT_AIRI_CHAT_COMPANY_ID = "d81123b4-b2fa-49d3-86af-25b4482b8269";
const DEFAULT_AIRI_CHAT_WORKSPACE_ID = "41b51d55-697c-4455-875a-9a7238bdf272";

type RegisteredUsersAuthAdminClient = Pick<
  typeof supabaseAdmin.auth.admin,
  "listUsers"
>;
type RegisteredUsersSupabaseClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

export type RegisteredUsersEmailAudience = {
  recipients: BulkCampaignRecipient[];
  totalAuthUsers: number;
  skippedUnconfirmed: number;
  skippedInvalidEmail: number;
  skippedAnonymous: number;
  skippedDuplicate: number;
};

export type RegisteredUsersEmailAudienceSummary = {
  total: number;
  totalAuthUsers: number;
  skippedUnconfirmed: number;
  skippedInvalidEmail: number;
  skippedAnonymous: number;
  skippedDuplicate: number;
  preview: RegisteredUsersEmailAudiencePreviewRow[];
};

export type RegisteredUsersEmailAudiencePreviewRow = {
  userId: string;
  email: string;
  name: string;
  registeredAt: string;
  locale: EmailCampaignLocale;
};

type JoinedCompany =
  | {
      id?: string | null;
      name?: string | null;
      slug?: string | null;
      lang?: string | null;
      airi_language?: string | null;
    }
  | Array<{
      id?: string | null;
      name?: string | null;
      slug?: string | null;
      lang?: string | null;
      airi_language?: string | null;
    }>
  | null
  | undefined;

type WorkspaceCompanyRow = {
  id?: string | null;
  company_id?: string | null;
  companies?: JoinedCompany;
};

type RegisteredUserWorkspaceLanguageRow = {
  user_id?: string | null;
  workspaces?: WorkspaceCompanyRow | WorkspaceCompanyRow[] | null | undefined;
};

type CompanyLanguageColumn = "airi_language" | "lang";

function parseIdAllowlist(
  value: string | undefined,
  fallback: string
): Set<string> {
  const ids = (value || fallback)
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
  return new Set(ids);
}

function getAiriChatCompanyIds(): Set<string> {
  return parseIdAllowlist(
    process.env.AIRI_CHAT_REGISTERED_USERS_COMPANY_IDS,
    DEFAULT_AIRI_CHAT_COMPANY_ID
  );
}

function getAiriChatWorkspaceIds(): Set<string> {
  return parseIdAllowlist(
    process.env.AIRI_CHAT_REGISTERED_USERS_WORKSPACE_IDS,
    DEFAULT_AIRI_CHAT_WORKSPACE_ID
  );
}

function readMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  keys: string[]
): string {
  if (!metadata) return "";
  for (const key of keys) {
    const value = cleanString(metadata[key]);
    if (value) return value;
  }
  return "";
}

function readAuthUserLocale(user: User): EmailCampaignLocale | null {
  const metadataKeys = [
    "locale",
    "language",
    "lang",
    "airi_language",
    "company_language",
    "workspace_language",
    "preferred_language",
  ];

  const metadataLocale = normalizeEmailCampaignLocale(
    readMetadataString(user.user_metadata, metadataKeys)
  );
  if (metadataLocale) return metadataLocale;

  for (const identity of user.identities || []) {
    const identityLocale = normalizeEmailCampaignLocale(
      readMetadataString(identity.identity_data, metadataKeys)
    );
    if (identityLocale) return identityLocale;
  }

  return null;
}

function readAuthUserName(user: User, email: string): string {
  const metadataName = readMetadataString(user.user_metadata, [
    "full_name",
    "name",
    "display_name",
    "first_name",
  ]);
  if (metadataName) return metadataName;

  for (const identity of user.identities || []) {
    const identityName = readMetadataString(identity.identity_data, [
      "full_name",
      "name",
      "display_name",
      "first_name",
    ]);
    if (identityName) return identityName;
  }

  const localPart = email
    .split("@")[0]
    ?.replace(/[._-]+/g, " ")
    .trim();
  return localPart || "there";
}

function toRegisteredUserRecipient(
  user: User,
  email: string,
  locale: EmailCampaignLocale
): BulkCampaignRecipient {
  const userId = cleanString(user.id);
  const name = readAuthUserName(user, email);
  const createdAt = cleanString(user.created_at);

  return {
    email,
    name,
    fields: {
      user_id: userId,
      auth_user_id: userId,
      email,
      created_at: createdAt,
      locale,
      language: locale,
    },
    variables: {
      userId,
      authUserId: userId,
      email,
      userEmail: email,
      name,
      full_name: name,
      recipientName: name,
      userName: name,
      createdAt,
      registeredAt: createdAt,
      locale,
      language: locale,
    },
  };
}

function getPositivePage(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function getTotalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isConfirmedEmailUser(user: User): boolean {
  return Boolean(cleanString(user.email_confirmed_at || user.confirmed_at));
}

function readWorkspaceCompanyLocaleForColumn(
  workspace: WorkspaceCompanyRow | null,
  column: CompanyLanguageColumn
): EmailCampaignLocale | null {
  const company = firstOrSelf(workspace?.companies);
  return normalizeEmailCampaignLocale(company?.[column]);
}

async function readRegisteredUserCompanyLocalesForColumn(params: {
  supabase: RegisteredUsersSupabaseClient;
  userIds: string[];
  column: CompanyLanguageColumn;
}): Promise<Map<string, EmailCampaignLocale>> {
  const localeByUserId = new Map<string, EmailCampaignLocale>();
  if (params.userIds.length === 0) return localeByUserId;

  const { data, error } = await params.supabase
    .from("company_users")
    .select(
      `
        user_id,
        workspaces!fk_workspace (
          id,
          company_id,
          companies!workspaces_company_id_fkey (
            ${params.column}
          )
        )
      `
    )
    .in("user_id", params.userIds)
    .limit(10_000);

  if (error || !Array.isArray(data)) {
    return localeByUserId;
  }

  for (const row of data as RegisteredUserWorkspaceLanguageRow[]) {
    const userId = cleanString(row.user_id);
    if (!userId || localeByUserId.has(userId)) continue;

    const locale = readWorkspaceCompanyLocaleForColumn(
      firstOrSelf(row.workspaces),
      params.column
    );
    if (locale) {
      localeByUserId.set(userId, locale);
    }
  }

  return localeByUserId;
}

async function resolveRegisteredUserCompanyLocales(params: {
  supabase: RegisteredUsersSupabaseClient;
  userIds: string[];
}): Promise<Map<string, EmailCampaignLocale>> {
  const localeByUserId = new Map<string, EmailCampaignLocale>();
  const userIds = Array.from(new Set(params.userIds.filter(Boolean)));
  if (userIds.length === 0) return localeByUserId;

  const airiLanguageLocales = await readRegisteredUserCompanyLocalesForColumn({
    ...params,
    userIds,
    column: "airi_language",
  });
  for (const [userId, locale] of airiLanguageLocales) {
    localeByUserId.set(userId, locale);
  }

  const unresolvedUserIds = userIds.filter(
    userId => !localeByUserId.has(userId)
  );
  if (unresolvedUserIds.length === 0) return localeByUserId;

  const legacyLangLocales = await readRegisteredUserCompanyLocalesForColumn({
    ...params,
    userIds: unresolvedUserIds,
    column: "lang",
  });
  for (const [userId, locale] of legacyLangLocales) {
    if (!localeByUserId.has(userId)) {
      localeByUserId.set(userId, locale);
    }
  }

  return localeByUserId;
}

export async function isRegisteredUsersEmailAudienceEnabledForWorkspace(params: {
  workspaceId: string;
}): Promise<boolean> {
  const access = await requireAppAdmin();
  if (access.response) return false;
  if (
    !(await checkUserWorkspaceAccess(
      access.supabase,
      access.userId,
      params.workspaceId
    ))
  ) {
    return false;
  }

  const { data, error } = await access.supabase
    .from("workspaces")
    .select("id, company_id, companies!workspaces_company_id_fkey(id)")
    .eq("id", params.workspaceId)
    .maybeSingle();

  if (error || !data) return false;

  const row = data as WorkspaceCompanyRow;
  const company = firstOrSelf(row.companies);
  const allowedWorkspaceIds = getAiriChatWorkspaceIds();
  const allowedCompanyIds = getAiriChatCompanyIds();
  const workspaceId = cleanString(row.id);
  const workspaceCompanyId = cleanString(row.company_id);
  const joinedCompanyId = cleanString(company?.id);

  return (
    Boolean(workspaceId && allowedWorkspaceIds.has(workspaceId)) ||
    Boolean(workspaceCompanyId && allowedCompanyIds.has(workspaceCompanyId)) ||
    Boolean(joinedCompanyId && allowedCompanyIds.has(joinedCompanyId))
  );
}

export async function resolveRegisteredUsersEmailAudience(params: {
  workspaceId: string;
  authAdmin?: RegisteredUsersAuthAdminClient;
  supabase?: RegisteredUsersSupabaseClient;
}): Promise<RegisteredUsersEmailAudience> {
  if (!(await isRegisteredUsersEmailAudienceEnabledForWorkspace(params))) {
    throw new Error(
      "Forbidden: Platform admin and eligible workspace membership required"
    );
  }
  const authAdmin = params.authAdmin ?? supabaseAdmin.auth.admin;
  const acceptedUsers: Array<{ user: User; email: string }> = [];
  const seenEmails = new Set<string>();
  let pageCount = 0;
  let totalAuthUsers = 0;
  let skippedUnconfirmed = 0;
  let skippedInvalidEmail = 0;
  let skippedAnonymous = 0;
  let skippedDuplicate = 0;

  let page = 1;

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_AUTH_USERS_PAGES) {
      throw new Error("Registered auth users pagination exceeded safety limit");
    }

    const { data, error } = await authAdmin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });

    if (error) {
      throw error;
    }

    const users = ((data?.users || []) as User[]).filter(
      user => user && typeof user === "object"
    );
    totalAuthUsers += users.length;

    for (const user of users) {
      const email = normalizeCampaignEmail(user.email || "");
      if (!email || !isValidCampaignEmailAddress(email)) {
        skippedInvalidEmail += 1;
        continue;
      }

      if (user.is_anonymous) {
        skippedAnonymous += 1;
        continue;
      }

      if (!isConfirmedEmailUser(user)) {
        skippedUnconfirmed += 1;
        continue;
      }

      if (seenEmails.has(email)) {
        skippedDuplicate += 1;
        continue;
      }

      seenEmails.add(email);
      acceptedUsers.push({ user, email });
    }

    const total = getTotalCount(data?.total);
    const nextPage = getPositivePage(data?.nextPage);
    const lastPage = getPositivePage(data?.lastPage);
    if (lastPage && page >= lastPage) {
      break;
    }
    if (nextPage && nextPage > page) {
      page = nextPage;
      continue;
    }
    if (total !== null && page * AUTH_USERS_PAGE_SIZE < total) {
      page += 1;
      continue;
    }
    if (users.length < AUTH_USERS_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  const companyLocaleByUserId = params.supabase
    ? await resolveRegisteredUserCompanyLocales({
        supabase: params.supabase,
        userIds: acceptedUsers.map(({ user }) => cleanString(user.id)),
      })
    : new Map<string, EmailCampaignLocale>();
  const recipients = acceptedUsers.map(({ user, email }) => {
    const userId = cleanString(user.id);
    const locale =
      readAuthUserLocale(user) ||
      companyLocaleByUserId.get(userId) ||
      DEFAULT_EMAIL_CAMPAIGN_LOCALE;
    return toRegisteredUserRecipient(user, email, locale);
  });

  return {
    recipients,
    totalAuthUsers,
    skippedUnconfirmed,
    skippedInvalidEmail,
    skippedAnonymous,
    skippedDuplicate,
  };
}

export async function getRegisteredUsersEmailAudienceSummary(params: {
  workspaceId: string;
  authAdmin?: RegisteredUsersAuthAdminClient;
  supabase?: RegisteredUsersSupabaseClient;
  previewLimit?: number;
}): Promise<RegisteredUsersEmailAudienceSummary> {
  const audience = await resolveRegisteredUsersEmailAudience(params);
  const previewLimit = Math.max(
    0,
    Math.min(
      MAX_PREVIEW_LIMIT,
      Math.floor(params.previewLimit ?? DEFAULT_PREVIEW_LIMIT)
    )
  );
  return {
    total: audience.recipients.length,
    totalAuthUsers: audience.totalAuthUsers,
    skippedUnconfirmed: audience.skippedUnconfirmed,
    skippedInvalidEmail: audience.skippedInvalidEmail,
    skippedAnonymous: audience.skippedAnonymous,
    skippedDuplicate: audience.skippedDuplicate,
    preview: audience.recipients.slice(0, previewLimit).map(recipient => ({
      userId: recipient.variables?.userId || recipient.fields?.user_id || "",
      email: recipient.email || "",
      name: recipient.name || "",
      registeredAt: recipient.variables?.registeredAt || "",
      locale:
        normalizeEmailCampaignLocale(
          recipient.variables?.locale || recipient.fields?.locale
        ) || DEFAULT_EMAIL_CAMPAIGN_LOCALE,
    })),
  };
}
