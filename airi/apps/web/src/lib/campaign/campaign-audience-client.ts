import { readBulkCampaignResponseError } from "./bulk-campaign-client";
import type { BulkCampaignChannel } from "./bulk-campaign-contracts";
import type { CampaignBirthdayImportResult } from "@icecore/scenario-contracts";

export type CampaignConnectedSource = {
  id: string;
  type?: string | null;
  name?: string | null;
  credentials?: {
    bot_username?: string | null;
    display_phone_number?: string | null;
    verified_name?: string | null;
  } | null;
  full_address?: string | null;
};

export type CampaignTelegramSource = CampaignConnectedSource & {
  type: string;
};

export type BulkCampaignPickerChannel = "whatsapp" | "telegram" | "email";

export function formatCampaignConnectedSourceLabel(
  source: CampaignConnectedSource
): string {
  const bot = source.credentials?.bot_username?.trim().replace(/^@/, "");
  if (bot) return `@${bot}`;
  const phone = source.credentials?.display_phone_number?.trim();
  if (phone) return phone;
  const verified = source.credentials?.verified_name?.trim();
  if (verified) return verified;
  const email = source.full_address?.trim();
  if (email) return email;
  return source.name?.trim() || source.id;
}

export function resolveBulkCampaignPickerSourceIds(params: {
  channel: BulkCampaignPickerChannel;
  whatsappSourceId?: string | null;
  telegramSourceId?: string | null;
  emailSourceId?: string | null;
}): string[] | undefined {
  const sourceId =
    params.channel === "whatsapp"
      ? params.whatsappSourceId
      : params.channel === "telegram"
        ? params.telegramSourceId
        : params.emailSourceId;
  const trimmed = sourceId?.trim();
  return trimmed ? [trimmed] : undefined;
}

export type CampaignBirthdayProtection = {
  active?: boolean;
  protectedTodayCount?: number;
  availableRecipientLimit?: number | null;
  dailyLimit?: number | null;
  scenarioId?: string;
  scenarioName?: string | null;
};

export type CampaignBirthdayImportRecipient = {
  phone?: string;
  chatId?: string;
  sourceId?: string | null;
  name?: string;
  birthday?: string;
  fields?: Record<string, string>;
};

export async function fetchWorkspaceTelegramSources(
  workspaceId: string
): Promise<CampaignTelegramSource[]> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations`
  );
  const data = (await response.json().catch(() => null)) as {
    sources?: CampaignTelegramSource[];
    error?: string;
  } | null;
  if (!response.ok) {
    throw readBulkCampaignResponseError(
      response,
      data,
      "Failed to load Telegram sources"
    );
  }
  return (data?.sources || []).filter(
    source => source.type === "telegram" && source.id
  );
}

export async function fetchTelegramSubscriberTotal(params: {
  workspaceId: string;
  sourceId: string;
}): Promise<number> {
  const response = await fetch(
    `/api/sources/telegram/${encodeURIComponent(params.sourceId)}/subscribers?workspaceId=${encodeURIComponent(params.workspaceId)}&limit=1`
  );
  const data = (await response.json().catch(() => null)) as {
    total?: number;
    error?: string;
  } | null;
  if (!response.ok) {
    throw readBulkCampaignResponseError(
      response,
      data,
      "Failed to load Telegram subscribers"
    );
  }
  return data?.total || 0;
}

export async function fetchCampaignBirthdayProtection(params: {
  workspaceId: string;
  dailyLimit: number;
  signal?: AbortSignal;
}): Promise<CampaignBirthdayProtection | null> {
  const query = new URLSearchParams({
    workspaceId: params.workspaceId,
    dailyLimit: String(params.dailyLimit),
  });
  const response = await fetch(
    `/api/campaigns/birthday-protection?${query.toString()}`,
    params.signal ? { signal: params.signal } : undefined
  );
  const data = (await response
    .json()
    .catch(() => null)) as CampaignBirthdayProtection | null;
  if (!response.ok) {
    throw readBulkCampaignResponseError(
      response,
      data,
      "Failed to load birthday campaign protection"
    );
  }
  return data;
}

const birthdayImportCountKeys = [
  "total",
  "imported",
  "updated",
  "skippedMissingPhone",
  "skippedMissingChatId",
  "skippedIneligibleTelegramSubscriber",
  "skippedMissingBirthday",
  "skippedInvalidBirthday",
] as const satisfies ReadonlyArray<keyof CampaignBirthdayImportResult>;

export class CampaignBirthdayImportError extends Error {
  constructor(
    message: string,
    readonly result: CampaignBirthdayImportResult | null
  ) {
    super(message);
    this.name = "CampaignBirthdayImportError";
  }
}

function parseBirthdayImportResult(
  data: unknown,
  expectedTotal: number
): CampaignBirthdayImportResult | null {
  if (!data || typeof data !== "object") return null;
  const counts = data as Record<string, unknown>;
  if (
    birthdayImportCountKeys.some(
      key => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0
    )
  )
    return null;
  const result = Object.fromEntries(
    birthdayImportCountKeys.map(key => [key, counts[key]])
  ) as CampaignBirthdayImportResult;
  const accountedRows = birthdayImportCountKeys
    .filter(key => key !== "total")
    .reduce((sum, key) => sum + result[key], 0);
  if (result.total !== expectedTotal || accountedRows !== result.total)
    return null;
  return result;
}

export async function importCampaignBirthdays(params: {
  workspaceId: string;
  channel: BulkCampaignChannel;
  sourceId?: string;
  recipients: CampaignBirthdayImportRecipient[];
  errorFallback: string;
}): Promise<CampaignBirthdayImportResult> {
  const response = await fetch("/api/campaigns/birthday-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: params.workspaceId,
      channel: params.channel,
      ...(params.channel === "telegram" ? { sourceId: params.sourceId } : {}),
      recipients: params.recipients,
    }),
  });
  const data: unknown = await response.json().catch(() => null);
  const result = parseBirthdayImportResult(data, params.recipients.length);
  if (!response.ok) {
    throw new CampaignBirthdayImportError(
      readBulkCampaignResponseError(
        response,
        data,
        params.errorFallback
      ).message,
      result
    );
  }
  if (!result || result.imported + result.updated === 0) {
    throw new CampaignBirthdayImportError(params.errorFallback, result);
  }
  return result;
}
