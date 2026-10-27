import "server-only";

import { connectDB } from "@/lib/mongoose";
import {
  formatWhatsAppGraphApiError,
  resolveWhatsAppAccountContext,
} from "@/lib/whatsapp/account/resolution";
import {
  WhatsAppWelcomeSequenceModel,
  type IWhatsAppWelcomeSequence,
} from "@/models/whatsapp-welcome-sequence";
import { buildGraphApiUrl } from "@icecore/shared/lib/meta/graph-version";
import type {
  CreateWhatsAppWelcomeMessageSequencePayload,
  GraphApiErrorBody,
  UpdateWhatsAppWelcomeMessageSequencePayload,
  WhatsAppWelcomeMessageSequence,
  WhatsAppWelcomeMessageSequenceIceBreaker,
} from "@icecore/shared/types/whatsapp";
import { cleanString } from "@icecore/shared/lib/value-utils";

type MetaWelcomeSequence = {
  sequence_id?: string;
  id?: string;
  name?: string;
  welcome_message_sequence?: unknown;
  is_used_in_ad?: boolean;
  created_time?: string;
  updated_time?: string;
};

type GraphListResponse<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: GraphApiErrorBody;
};

type GraphSequenceListPayload =
  | MetaWelcomeSequence[]
  | GraphListResponse<MetaWelcomeSequence>;

type GraphMutationResponse = {
  sequence_id?: string;
  success?: boolean;
  error?: GraphApiErrorBody;
};

export class WelcomeSequenceRequestError extends Error {
  status: number;
  graphCode?: number | string;
  graphType?: string;

  constructor(params: {
    graphCode?: number | string;
    graphType?: string;
    message: string;
    status: number;
  }) {
    super(params.message);
    this.name = "WelcomeSequenceRequestError";
    this.status = params.status;
    this.graphCode = params.graphCode;
    this.graphType = params.graphType;
  }
}

const MAX_SEQUENCE_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 1024;
const MAX_AUTOFILL_LENGTH = 200;
const MAX_ICE_BREAKERS = 3;
const MAX_ICE_BREAKER_TITLE_LENGTH = 80;

async function parseGraphResponse<T = unknown>(res: Response): Promise<T> {
  const raw = await res.text();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function normalizeIceBreakers(
  value: unknown
): WhatsAppWelcomeMessageSequenceIceBreaker[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      const record =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      const title = cleanString(record.title, MAX_ICE_BREAKER_TITLE_LENGTH);
      return title ? { title } : null;
    })
    .filter(
      (item): item is WhatsAppWelcomeMessageSequenceIceBreaker => item !== null
    )
    .slice(0, MAX_ICE_BREAKERS);
}

function parseWelcomeSequenceObject(value: unknown): {
  text: string;
  autofillMessageContent: string;
  iceBreakers: WhatsAppWelcomeMessageSequenceIceBreaker[];
} {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const autofill =
    record.autofill_message &&
    typeof record.autofill_message === "object" &&
    !Array.isArray(record.autofill_message)
      ? (record.autofill_message as Record<string, unknown>)
      : {};

  return {
    text: cleanString(record.text, MAX_TEXT_LENGTH),
    autofillMessageContent: cleanString(autofill.content, MAX_AUTOFILL_LENGTH),
    iceBreakers: normalizeIceBreakers(record.ice_breakers),
  };
}

function normalizeSequencePayload(
  input:
    | CreateWhatsAppWelcomeMessageSequencePayload
    | UpdateWhatsAppWelcomeMessageSequencePayload,
  options?: { requireContent?: boolean }
) {
  const text = cleanString(input.text, MAX_TEXT_LENGTH);
  const autofillMessageContent = cleanString(
    input.autofillMessageContent,
    MAX_AUTOFILL_LENGTH
  );
  const iceBreakers = normalizeIceBreakers(input.iceBreakers);

  if (
    options?.requireContent &&
    !text &&
    !autofillMessageContent &&
    iceBreakers.length === 0
  ) {
    throw new Error(
      "Add welcome text, an autofill message, or at least one ice breaker."
    );
  }

  return {
    text,
    autofillMessageContent,
    iceBreakers,
  };
}

function toMetaWelcomeSequence(params: {
  text?: string;
  autofillMessageContent?: string;
  iceBreakers?: WhatsAppWelcomeMessageSequenceIceBreaker[];
}) {
  const payload: Record<string, unknown> = {};
  if (params.text) payload.text = params.text;
  if (params.autofillMessageContent) {
    payload.autofill_message = { content: params.autofillMessageContent };
  }
  if (params.iceBreakers && params.iceBreakers.length > 0) {
    payload.ice_breakers = params.iceBreakers.map(item => ({
      title: item.title,
    }));
  }
  return payload;
}

function appendWelcomeSequenceParams(
  body: URLSearchParams,
  payload: {
    text?: string;
    autofillMessageContent?: string;
    iceBreakers?: WhatsAppWelcomeMessageSequenceIceBreaker[];
  }
) {
  body.set(
    "welcome_message_sequence",
    JSON.stringify(toMetaWelcomeSequence(payload))
  );
}

function throwWelcomeSequenceGraphError(
  response: GraphMutationResponse | GraphListResponse<unknown>,
  status: number,
  fallback: string
): never {
  const error = response.error;
  throw new WelcomeSequenceRequestError({
    status,
    graphCode: error?.code,
    graphType: error?.type,
    message: formatWhatsAppGraphApiError(error, fallback),
  });
}

function fromDbSequence(
  sequence: IWhatsAppWelcomeSequence
): WhatsAppWelcomeMessageSequence {
  return {
    id: sequence.sequenceId,
    name: sequence.name,
    text: sequence.text || undefined,
    autofillMessageContent: sequence.autofillMessageContent || undefined,
    iceBreakers: sequence.iceBreakers || [],
    is_used_in_ad: sequence.isUsedInAd,
    created_time: sequence.metaCreatedTime || undefined,
    updated_time: sequence.metaUpdatedTime || undefined,
    sourceId: sequence.sourceId || undefined,
    wabaId: sequence.wabaId,
    lastSyncedAt: sequence.lastSyncedAt.toISOString(),
  };
}

async function upsertSequence(params: {
  workspaceId: string;
  sourceId?: string;
  wabaId: string;
  metaSequence: MetaWelcomeSequence;
}): Promise<WhatsAppWelcomeMessageSequence | null> {
  const sequenceId = cleanString(
    params.metaSequence.sequence_id || params.metaSequence.id,
    100
  );
  const name = cleanString(params.metaSequence.name, MAX_SEQUENCE_NAME_LENGTH);
  if (!sequenceId || !name) return null;

  const content = parseWelcomeSequenceObject(
    params.metaSequence.welcome_message_sequence
  );
  const now = new Date();
  const doc = await WhatsAppWelcomeSequenceModel.findOneAndUpdate(
    {
      workspaceId: params.workspaceId,
      sequenceId,
    },
    {
      $set: {
        workspaceId: params.workspaceId,
        sourceId: params.sourceId || null,
        wabaId: params.wabaId,
        sequenceId,
        name,
        text: content.text || null,
        autofillMessageContent: content.autofillMessageContent || null,
        iceBreakers: content.iceBreakers,
        isUsedInAd: params.metaSequence.is_used_in_ad === true,
        metaCreatedTime: params.metaSequence.created_time || null,
        metaUpdatedTime: params.metaSequence.updated_time || null,
        lastSyncedAt: now,
      },
    },
    { new: true, upsert: true }
  ).lean<IWhatsAppWelcomeSequence>();

  return doc ? fromDbSequence(doc) : null;
}

async function resolveSequenceAccount(workspaceId: string) {
  return resolveWhatsAppAccountContext({
    workspaceId,
    probeEdge: "welcome_message_sequences",
    logScope: "welcome message sequences",
    failureMessage:
      "Cannot access WhatsApp welcome message sequences for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account.",
  });
}

export async function listWelcomeMessageSequences(
  workspaceId: string,
  options?: { limit?: number }
): Promise<{ sequences: WhatsAppWelcomeMessageSequence[] }> {
  await connectDB();
  const { wabaId, accessToken, sourceId } =
    await resolveSequenceAccount(workspaceId);
  const limit =
    typeof options?.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(Math.floor(options.limit), 500))
      : 100;
  const sequences: WhatsAppWelcomeMessageSequence[] = [];
  let nextUrl: string | undefined = buildGraphApiUrl(
    `${wabaId}/welcome_message_sequences?${new URLSearchParams({
      limit: String(Math.min(limit, 100)),
    }).toString()}`
  );
  let pageCount = 0;

  while (nextUrl && pageCount < 50 && sequences.length < limit) {
    const res: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const response = await parseGraphResponse<GraphSequenceListPayload>(res);
    const error = Array.isArray(response) ? undefined : response.error;
    if (!res.ok || error) {
      throwWelcomeSequenceGraphError(
        { error },
        res.status,
        `Failed to fetch welcome message sequences: ${res.status}`
      );
    }

    const pageSequences = Array.isArray(response)
      ? response
      : response.data || [];
    for (const metaSequence of pageSequences) {
      const normalized = await upsertSequence({
        workspaceId,
        sourceId,
        wabaId,
        metaSequence,
      });
      if (normalized) sequences.push(normalized);
      if (sequences.length >= limit) break;
    }

    nextUrl = Array.isArray(response) ? undefined : response.paging?.next;
    pageCount += 1;
  }

  if (sequences.length > 0) {
    return { sequences };
  }

  const cached = await WhatsAppWelcomeSequenceModel.find({
    workspaceId,
    wabaId,
  })
    .sort({ updatedAt: -1 })
    .lean<IWhatsAppWelcomeSequence[]>();
  return { sequences: cached.map(fromDbSequence) };
}

export async function getWelcomeMessageSequence(
  workspaceId: string,
  sequenceIdInput: string
): Promise<{ sequence: WhatsAppWelcomeMessageSequence | null }> {
  await connectDB();
  const { wabaId, accessToken, sourceId } =
    await resolveSequenceAccount(workspaceId);
  const sequenceId = cleanString(sequenceIdInput, 100);
  if (!sequenceId) throw new Error("sequenceId is required.");

  const res: Response = await fetch(
    buildGraphApiUrl(
      `${wabaId}/welcome_message_sequences?${new URLSearchParams({
        sequence_id: sequenceId,
      }).toString()}`
    ),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  const response = await parseGraphResponse<GraphSequenceListPayload>(res);
  const error = Array.isArray(response) ? undefined : response.error;
  if (!res.ok || error) {
    throwWelcomeSequenceGraphError(
      { error },
      res.status,
      `Failed to fetch welcome message sequence: ${res.status}`
    );
  }

  const metaSequence = Array.isArray(response)
    ? response[0]
    : response.data?.[0];
  const sequence = metaSequence
    ? await upsertSequence({
        workspaceId,
        sourceId,
        wabaId,
        metaSequence,
      })
    : null;

  return { sequence };
}

export async function createWelcomeMessageSequence(
  workspaceId: string,
  payload: CreateWhatsAppWelcomeMessageSequencePayload
): Promise<WhatsAppWelcomeMessageSequence> {
  await connectDB();
  const { wabaId, accessToken, sourceId } =
    await resolveSequenceAccount(workspaceId);
  const name = cleanString(payload.name, MAX_SEQUENCE_NAME_LENGTH);
  if (!name) throw new Error("Sequence name is required.");
  const normalized = normalizeSequencePayload(payload, {
    requireContent: true,
  });
  const body = new URLSearchParams();
  body.set("name", name);
  appendWelcomeSequenceParams(body, normalized);

  const res = await fetch(
    buildGraphApiUrl(`${wabaId}/welcome_message_sequences`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  const response = await parseGraphResponse<GraphMutationResponse>(res);
  if (!res.ok || response.error || !response.sequence_id) {
    throwWelcomeSequenceGraphError(
      response,
      res.status,
      `Failed to create welcome message sequence: ${res.status}`
    );
  }

  const created = await upsertSequence({
    workspaceId,
    sourceId,
    wabaId,
    metaSequence: {
      sequence_id: response.sequence_id,
      name,
      welcome_message_sequence: toMetaWelcomeSequence(normalized),
      is_used_in_ad: false,
    },
  });
  if (!created) throw new Error("Meta did not return a sequence ID.");
  return created;
}

export async function updateWelcomeMessageSequence(
  workspaceId: string,
  payload: UpdateWhatsAppWelcomeMessageSequencePayload
): Promise<WhatsAppWelcomeMessageSequence> {
  await connectDB();
  const { wabaId, accessToken, sourceId } =
    await resolveSequenceAccount(workspaceId);
  const sequenceId = cleanString(payload.sequenceId, 100);
  if (!sequenceId) throw new Error("sequenceId is required.");
  const name = payload.name
    ? cleanString(payload.name, MAX_SEQUENCE_NAME_LENGTH)
    : "";
  const normalized = normalizeSequencePayload(payload);
  const existing = await WhatsAppWelcomeSequenceModel.findOne({
    workspaceId,
    sequenceId,
  }).lean<IWhatsAppWelcomeSequence>();
  if (existing?.isUsedInAd) {
    throw new Error(
      "This welcome message sequence is linked to an active ad and cannot be updated."
    );
  }

  const body = new URLSearchParams();
  body.set("sequence_id", sequenceId);
  if (name) body.set("name", name);
  if (
    normalized.text ||
    normalized.autofillMessageContent ||
    normalized.iceBreakers.length > 0
  ) {
    appendWelcomeSequenceParams(body, normalized);
  }

  const res = await fetch(
    buildGraphApiUrl(`${wabaId}/welcome_message_sequences`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  const response = await parseGraphResponse<GraphMutationResponse>(res);
  if (!res.ok || response.error || response.success === false) {
    throwWelcomeSequenceGraphError(
      response,
      res.status,
      `Failed to update welcome message sequence: ${res.status}`
    );
  }

  const updated = await upsertSequence({
    workspaceId,
    sourceId,
    wabaId,
    metaSequence: {
      sequence_id: sequenceId,
      name: name || existing?.name || sequenceId,
      welcome_message_sequence:
        normalized.text ||
        normalized.autofillMessageContent ||
        normalized.iceBreakers.length > 0
          ? toMetaWelcomeSequence(normalized)
          : toMetaWelcomeSequence({
              text: existing?.text || undefined,
              autofillMessageContent:
                existing?.autofillMessageContent || undefined,
              iceBreakers: existing?.iceBreakers || [],
            }),
      is_used_in_ad: existing?.isUsedInAd === true,
    },
  });
  if (!updated) throw new Error("Failed to refresh welcome sequence cache.");
  return updated;
}

export async function deleteWelcomeMessageSequence(
  workspaceId: string,
  sequenceIdInput: string
): Promise<{ success: true }> {
  await connectDB();
  const { wabaId, accessToken } = await resolveSequenceAccount(workspaceId);
  const sequenceId = cleanString(sequenceIdInput, 100);
  if (!sequenceId) throw new Error("sequenceId is required.");

  const cached = await WhatsAppWelcomeSequenceModel.findOne({
    workspaceId,
    sequenceId,
  }).lean<IWhatsAppWelcomeSequence>();
  if (cached?.isUsedInAd) {
    throw new Error(
      "This welcome message sequence is linked to an active ad and cannot be deleted."
    );
  }

  const body = new URLSearchParams();
  body.set("sequence_id", sequenceId);
  const res = await fetch(
    buildGraphApiUrl(`${wabaId}/welcome_message_sequences`),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  const response = await parseGraphResponse<GraphMutationResponse>(res);
  if (!res.ok || response.error || response.success === false) {
    throwWelcomeSequenceGraphError(
      response,
      res.status,
      `Failed to delete welcome message sequence: ${res.status}`
    );
  }

  await WhatsAppWelcomeSequenceModel.deleteOne({ workspaceId, sequenceId });
  return { success: true };
}
