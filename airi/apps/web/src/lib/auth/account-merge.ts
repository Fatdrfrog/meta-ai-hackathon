import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createHash } from "crypto";
import "server-only";
import { firstOrSelf as getSingleRelation } from "@icecore/shared/lib/value-utils";

const DECIDED_EMAILS_METADATA_KEY = "airi_asset_merge_decided_emails";
const LEGACY_SKIP_METADATA_KEY = "airi_asset_merge_skip_signature";

type Relation<T> = T | T[] | null | undefined;

type WorkspaceJoin = {
  id?: string | null;
  name?: string | null;
  created_at?: string | null;
  companies?: Relation<{
    name?: string | null;
  }>;
};

type CompanyUserRow = {
  id?: string | number | null;
  user_id?: string | null;
  workspace_id?: string | null;
  role?: string | null;
  email?: string | null;
  created_at?: string | null;
  workspaces?: Relation<WorkspaceJoin>;
};

export type AccountMergeSupabaseClient = Pick<SupabaseClient, "auth" | "from">;

export type AccountMergeCandidate = {
  membershipId: string | number;
  legacyUserId: string;
  workspaceId: string;
  workspaceName: string;
  companyName: string | null;
  role: string;
  createdAt: string | null;
};

export type AccountMergePreview = {
  email: string;
  signature: string;
  candidates: AccountMergeCandidate[];
};

type VerifiedEmailUser = Pick<
  User,
  "id" | "email" | "confirmed_at" | "email_confirmed_at"
> &
  Partial<Pick<User, "app_metadata" | "user_metadata">>;

export type AccountMergePreviewOptions = {
  respectSkip?: boolean;
  supabase?: AccountMergeSupabaseClient;
};

type AccountMergeOperationOptions = {
  supabase?: AccountMergeSupabaseClient;
};

type MergeResult = {
  moved: number;
  deduplicated: number;
  workspaces: AccountMergeCandidate[];
};

export function normalizeAccountMergeEmail(
  email: string | null | undefined
): string {
  return email?.trim().toLowerCase() ?? "";
}

function hasVerifiedEmail(user: VerifiedEmailUser): boolean {
  return Boolean(user.email && user.email_confirmed_at);
}

export function getSafeAccountMergeNextPath(
  raw: string | null | undefined,
  fallback = "/onboarding"
): string {
  const value = raw?.trim();
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  if (value.startsWith("/auth/merge-assets")) {
    return fallback;
  }

  return value;
}

export function buildAccountMergePath(nextPath: string): string {
  const params = new URLSearchParams({
    next: getSafeAccountMergeNextPath(nextPath),
  });

  return `/auth/merge-assets?${params.toString()}`;
}

function buildSignature(candidates: AccountMergeCandidate[]): string {
  const stablePayload = candidates
    .map(candidate => ({
      legacyUserId: candidate.legacyUserId,
      membershipId: String(candidate.membershipId),
      workspaceId: candidate.workspaceId,
      role: candidate.role,
    }))
    .sort((left, right) =>
      `${left.legacyUserId}:${left.workspaceId}:${left.membershipId}`.localeCompare(
        `${right.legacyUserId}:${right.workspaceId}:${right.membershipId}`
      )
    );

  return createHash("sha256")
    .update(JSON.stringify(stablePayload))
    .digest("hex");
}

function getWorkspaceName(row: CompanyUserRow): {
  workspaceName: string;
  companyName: string | null;
} {
  const workspace = getSingleRelation(row.workspaces);
  const company = getSingleRelation(workspace?.companies);

  return {
    workspaceName:
      workspace?.name?.trim() || company?.name?.trim() || "Existing workspace",
    companyName: company?.name?.trim() || null,
  };
}

function escapePostgresLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function getDecisionMetadata(user: VerifiedEmailUser): Record<string, unknown> {
  return {
    ...toMetadataRecord(user.app_metadata),
    ...toMetadataRecord(user.user_metadata),
  };
}

async function getFreshCurrentUser(
  supabase: AccountMergeSupabaseClient,
  expectedUser: VerifiedEmailUser
): Promise<User> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    throw error;
  }

  if (
    !data.user ||
    data.user.id !== expectedUser.id ||
    normalizeAccountMergeEmail(data.user.email) !==
      normalizeAccountMergeEmail(expectedUser.email)
  ) {
    throw new Error("Could not verify account merge identity");
  }

  return data.user;
}

function getDecidedEmails(metadata: Record<string, unknown>): string[] {
  const raw = metadata[DECIDED_EMAILS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(email => normalizeAccountMergeEmail(String(email)))
    .filter(Boolean);
}

async function rememberAccountMergeDecision(
  supabase: AccountMergeSupabaseClient,
  user: VerifiedEmailUser,
  email: string
): Promise<void> {
  const normalizedEmail = normalizeAccountMergeEmail(email);
  if (!normalizedEmail) {
    return;
  }

  const freshUser = await getFreshCurrentUser(supabase, user);
  const metadata = getDecisionMetadata(freshUser);
  const decidedEmails = new Set(getDecidedEmails(metadata));
  decidedEmails.add(normalizedEmail);

  const { error } = await supabase.auth.updateUser({
    data: {
      [DECIDED_EMAILS_METADATA_KEY]: [...decidedEmails].sort(),
      [LEGACY_SKIP_METADATA_KEY]: null,
    },
  });
  if (error) throw error;
}

async function getLegacyMembershipRows(
  supabase: AccountMergeSupabaseClient,
  currentUserId: string,
  email: string
): Promise<CompanyUserRow[]> {
  const normalizedEmail = normalizeAccountMergeEmail(email);
  const rowsByMembership = new Map<string, CompanyUserRow>();

  const { data, error } = await supabase
    .from("company_users")
    .select(
      `
          id,
          user_id,
          workspace_id,
          role,
          email,
          created_at,
          workspaces!fk_workspace (
            id,
            name,
            created_at,
            companies!workspaces_company_id_fkey (
              name
            )
          )
        `
    )
    .ilike("email", escapePostgresLikePattern(email))
    .neq("user_id", currentUserId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  for (const row of (data ?? []) as CompanyUserRow[]) {
    if (
      row.id === null ||
      row.id === undefined ||
      normalizeAccountMergeEmail(row.email) !== normalizedEmail
    ) {
      continue;
    }

    rowsByMembership.set(String(row.id), row);
  }

  return [...rowsByMembership.values()];
}

export async function getAccountMergePreviewForUser(
  user: VerifiedEmailUser,
  options: AccountMergePreviewOptions = {}
): Promise<AccountMergePreview | null> {
  if (!user.id || !user.email || !hasVerifiedEmail(user)) return null;

  const supabase = options.supabase ?? (await createClient());
  const currentUser = await getFreshCurrentUser(supabase, user);
  return getAccountMergePreviewForVerifiedUser(currentUser, options);
}

async function getAccountMergePreviewForVerifiedUser(
  user: VerifiedEmailUser,
  options: Pick<AccountMergePreviewOptions, "respectSkip"> = {}
): Promise<AccountMergePreview | null> {
  const rawEmail = user.email?.trim() ?? "";
  const email = normalizeAccountMergeEmail(rawEmail);
  if (!user.id || !email || !hasVerifiedEmail(user)) {
    return null;
  }

  // Legacy rows can be outside the current account's workspace memberships.
  // Use the trusted reader only after the session identity and email are verified.
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const rows = await getLegacyMembershipRows(supabaseAdmin, user.id, rawEmail);
  const legacyUserIds = [
    ...new Set(rows.flatMap(row => (row.user_id ? [row.user_id] : []))),
  ];
  const legacyIdentities = new Map(
    await Promise.all(
      legacyUserIds.map(async legacyUserId => {
        const { data, error } =
          await supabaseAdmin.auth.admin.getUserById(legacyUserId);
        if (error && error.status !== 404) throw error;
        return [
          legacyUserId,
          !error &&
            data.user?.id === legacyUserId &&
            normalizeAccountMergeEmail(data.user.email) === email,
        ] as const;
      })
    )
  );
  const candidates = rows.flatMap(row => {
    if (
      row.id === null ||
      row.id === undefined ||
      !row.user_id ||
      !row.workspace_id ||
      !legacyIdentities.get(row.user_id)
    ) {
      return [];
    }

    const { workspaceName, companyName } = getWorkspaceName(row);

    return [
      {
        membershipId: row.id,
        legacyUserId: row.user_id,
        workspaceId: row.workspace_id,
        workspaceName,
        companyName,
        role: row.role || "manager",
        createdAt: row.created_at ?? null,
      },
    ];
  });

  if (candidates.length === 0) {
    return null;
  }

  const signature = buildSignature(candidates);

  if (options.respectSkip) {
    const metadata = getDecisionMetadata(user);
    const decidedEmails = getDecidedEmails(metadata);
    if (
      decidedEmails.includes(email) ||
      metadata[LEGACY_SKIP_METADATA_KEY] === signature
    ) {
      return null;
    }
  }

  return {
    email,
    signature,
    candidates,
  };
}

export async function getAccountMergeRedirectPath(
  user: VerifiedEmailUser,
  nextPath: string,
  options: AccountMergePreviewOptions = {}
): Promise<string | null> {
  const preview = await getAccountMergePreviewForUser(user, {
    ...options,
    respectSkip: true,
  });

  if (!preview) {
    return null;
  }

  return buildAccountMergePath(nextPath);
}

export async function rememberAccountMergeSkip(
  user: VerifiedEmailUser,
  options: AccountMergeOperationOptions = {}
): Promise<void> {
  const supabase = options.supabase ?? (await createClient());
  const currentUser = await getFreshCurrentUser(supabase, user);
  const preview = await getAccountMergePreviewForVerifiedUser(currentUser);
  if (!preview) {
    return;
  }

  await rememberAccountMergeDecision(supabase, currentUser, preview.email);
}

async function syncCurrentUserProfile(
  supabase: AccountMergeSupabaseClient,
  user: User
): Promise<void> {
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const fullName = (metadata?.full_name || metadata?.name) as
    | string
    | undefined;
  const avatarUrl = metadata?.avatar_url as string | undefined;

  const { error } = await supabase.from("users").upsert(
    {
      id: user.id,
      full_name: fullName ?? user.email?.split("@")[0] ?? null,
      avatar_url: avatarUrl ?? null,
    },
    { onConflict: "id" }
  );
  if (error) {
    throw error;
  }
}

export async function mergeAccountAssetsForUser(
  user: User,
  options: AccountMergeOperationOptions = {}
): Promise<MergeResult> {
  const supabase = options.supabase ?? (await createClient());
  const currentUser = await getFreshCurrentUser(supabase, user);
  const preview = await getAccountMergePreviewForVerifiedUser(currentUser);
  if (!preview) {
    return { moved: 0, deduplicated: 0, workspaces: [] };
  }

  await syncCurrentUserProfile(supabase, currentUser);

  const { supabaseAdmin } = await import("@/lib/supabase/admin");

  // The RPC locks and revalidates every candidate before transferring grants.
  // It owns strongest-role resolution and rolls back the entire batch on failure.
  const { data, error } = await supabaseAdmin.rpc(
    "merge_verified_account_memberships",
    {
      input_user_id: currentUser.id,
      input_verified_email: preview.email,
      input_candidates: preview.candidates.map(candidate => ({
        membership_id: candidate.membershipId,
        legacy_user_id: candidate.legacyUserId,
        workspace_id: candidate.workspaceId,
        expected_role: candidate.role,
      })),
    }
  );
  if (error) throw error;
  const result = getSingleRelation(data) as {
    moved: number;
    deduplicated: number;
  } | null;
  if (!result) throw new Error("Account membership merge returned no result");

  await rememberAccountMergeDecision(supabase, currentUser, preview.email);

  return {
    moved: result.moved,
    deduplicated: result.deduplicated,
    workspaces: preview.candidates,
  };
}
