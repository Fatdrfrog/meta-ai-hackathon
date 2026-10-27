import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  CustomerWebhookUrlError,
  encryptCustomerWebhookSecret,
  validateCustomerWebhookUrl,
} from "@/lib/customer-webhook-config";
import { requireCustomerApiAdmin } from "./access";
import { CUSTOMER_WEBHOOK_EVENTS } from "./contracts";
import { customerApiResponse } from "./response";
import {
  CustomerApiKeySchema,
  CustomerWebhookSchema,
  CustomerWebhookUpdateSchema,
} from "./schema";

const API_KEY_COLUMNS =
  "id,name,key_prefix,permissions,is_active,expires_at,last_used_at,created_at,rate_limit_per_minute";
const WEBHOOK_COLUMNS =
  "id,url,events,description,is_active,created_at,last_triggered_at";
const DELIVERY_COLUMNS =
  "id,event_type,response_status,error_message,attempt_number,delivered_at,created_at,next_retry_at";
const MAX_KEYS = 100;
const MAX_WEBHOOKS = 20;
const ID_SCHEMA = z.string().uuid();

type Row = Record<string, unknown>;
type ManagementAction = (userId: string) => Promise<Response>;

class CredentialMutationError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function project(row: Row, columns: string): Row {
  return Object.fromEntries(
    columns.split(",").map(column => [column, row[column]])
  );
}

function apiKeySummary(row: Row) {
  return project(row, API_KEY_COLUMNS);
}

function webhookSummary(row: Row) {
  return project(row, WEBHOOK_COLUMNS);
}

async function withAdmin(workspaceId: string, action: ManagementAction) {
  if (!ID_SCHEMA.safeParse(workspaceId).success) {
    return customerApiResponse({ error: "Invalid workspace ID" }, 400);
  }
  try {
    const access = await requireCustomerApiAdmin(workspaceId);
    if (!access.ok) return access.response;
    return await action(access.userId);
  } catch (error) {
    if (error instanceof CredentialMutationError) {
      return customerApiResponse({ error: error.message }, error.status);
    }
    if (error instanceof JsonBodyTooLargeError) {
      return customerApiResponse({ error: error.message }, 413);
    }
    if (
      error instanceof InvalidJsonBodyError ||
      error instanceof CustomerWebhookUrlError
    ) {
      return customerApiResponse({ error: error.message }, 400);
    }
    // Provider/database errors must not expose keys, signing secrets, or customer data.
    return customerApiResponse(
      { error: "Unable to update API integration settings" },
      500
    );
  }
}

async function readBody<T extends z.ZodTypeAny>(request: Request, schema: T) {
  const parsed = schema.safeParse(
    await readJsonBodyWithinLimit(request, 16 * 1024)
  );
  if (!parsed.success) {
    throw new InvalidJsonBodyError(
      parsed.error.issues[0]?.message || "Invalid request body"
    );
  }
  return parsed.data as z.infer<T>;
}

async function mutateCredential(
  userId: string,
  workspaceId: string,
  kind: "api_key" | "webhook",
  action: "create" | "revoke" | "update" | "disable",
  credentialId: string | null,
  values: Row = {}
) {
  // The browser precheck is for UX. The database rechecks the current actor's
  // exact membership while holding the same locks as the credential write.
  const { data, error } = await supabaseAdmin.rpc(
    "mutate_customer_api_credential",
    {
      input_actor_id: userId,
      input_workspace_id: workspaceId,
      input_kind: kind,
      input_action: action,
      input_credential_id: credentialId,
      input_data: values,
    }
  );
  if (error) {
    if (error.code === "42501") {
      throw new CredentialMutationError(
        "Workspace admin access required",
        403
      );
    }
    if (error.code === "P0002") {
      throw new CredentialMutationError(
        kind === "api_key" ? "API key not found" : "Webhook not found",
        404
      );
    }
    if (error.code === "54000") {
      throw new CredentialMutationError(
        kind === "api_key"
          ? "Revoke an API key before creating another (maximum 100 active keys)"
          : "Disable a webhook before creating another (maximum 20 active webhooks)",
        409
      );
    }
    if (error.code === "40001") {
      throw new CredentialMutationError(
        "Webhook changed; refresh and retry",
        409
      );
    }
    if (error.code === "22023") {
      throw new CredentialMutationError("Invalid integration settings", 400);
    }
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.id) {
    throw new Error("Credential mutation returned no summary");
  }
  return data as Row;
}

export async function listCustomerApiKeys(workspaceId: string) {
  return withAdmin(workspaceId, async () => {
    const { data, error } = await supabaseAdmin
      .from("api_keys")
      .select(API_KEY_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("is_active", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(MAX_KEYS);
    if (error) throw error;
    return customerApiResponse({ apiKeys: (data || []).map(apiKeySummary) });
  });
}

export async function createCustomerApiKey(
  request: Request,
  workspaceId: string
) {
  return withAdmin(workspaceId, async userId => {
    const input = await readBody(request, CustomerApiKeySchema);
    const secret = `sk_${randomBytes(32).toString("hex")}`;
    const data = await mutateCredential(
      userId,
      workspaceId,
      "api_key",
      "create",
      null,
      {
        name: input.name,
        key_prefix: secret.slice(0, 11),
        key_hash: createHash("sha256").update(secret).digest("hex"),
        permissions: input.permissions,
        expires_at: input.expires_at ?? null,
      }
    );
    return customerApiResponse({ apiKey: apiKeySummary(data), secret }, 201);
  });
}

export async function revokeCustomerApiKey(workspaceId: string, keyId: string) {
  return withAdmin(workspaceId, async userId => {
    if (!ID_SCHEMA.safeParse(keyId).success)
      return customerApiResponse({ error: "Invalid API key ID" }, 400);
    const data = await mutateCredential(
      userId,
      workspaceId,
      "api_key",
      "revoke",
      keyId
    );
    return customerApiResponse({ apiKey: apiKeySummary(data) });
  });
}

export async function listCustomerWebhooks(workspaceId: string) {
  return withAdmin(workspaceId, async () => {
    const { data, error } = await supabaseAdmin
      .from("webhook_subscriptions")
      .select(WEBHOOK_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("is_active", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(MAX_WEBHOOKS);
    if (error) throw error;
    return customerApiResponse({
      webhooks: (data || []).map(webhookSummary),
      supportedEvents: CUSTOMER_WEBHOOK_EVENTS,
    });
  });
}

export async function createCustomerWebhook(
  request: Request,
  workspaceId: string
) {
  return withAdmin(workspaceId, async userId => {
    const input = await readBody(request, CustomerWebhookSchema);
    const url = await validateCustomerWebhookUrl(input.url);
    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    const data = await mutateCredential(
      userId,
      workspaceId,
      "webhook",
      "create",
      null,
      {
        url,
        secret: encryptCustomerWebhookSecret(secret),
        events: input.events,
        description: input.description || null,
      }
    );
    return customerApiResponse({ webhook: webhookSummary(data), secret }, 201);
  });
}

export async function updateCustomerWebhook(
  request: Request,
  workspaceId: string,
  webhookId: string
) {
  return withAdmin(workspaceId, async userId => {
    if (!ID_SCHEMA.safeParse(webhookId).success)
      return customerApiResponse({ error: "Invalid webhook ID" }, 400);
    const input = await readBody(request, CustomerWebhookUpdateSchema);
    const { data: current, error: readError } = await supabaseAdmin
      .from("webhook_subscriptions")
      .select("id,is_active,url")
      .eq("workspace_id", workspaceId)
      .eq("id", webhookId)
      .maybeSingle();
    if (readError) throw readError;
    if (!current)
      return customerApiResponse({ error: "Webhook not found" }, 404);

    const update: Row = {};
    // Activation and rotation revalidate older endpoints under the URL policy.
    if (input.url !== undefined) {
      update.url = await validateCustomerWebhookUrl(input.url);
    } else if (input.is_active === true || input.rotate_secret) {
      const expectedUrl = current.url;
      await validateCustomerWebhookUrl(expectedUrl);
      // Do not overwrite an endpoint edited while DNS validation was in flight.
      update.expected_url = expectedUrl;
    }
    if (input.events !== undefined) update.events = input.events;
    if (input.description !== undefined)
      update.description = input.description || null;
    if (input.is_active !== undefined) update.is_active = input.is_active;
    const secret = input.rotate_secret
      ? `whsec_${randomBytes(32).toString("hex")}`
      : undefined;
    if (secret) update.secret = encryptCustomerWebhookSecret(secret);
    const data = await mutateCredential(
      userId,
      workspaceId,
      "webhook",
      "update",
      webhookId,
      update
    );
    return customerApiResponse({
      webhook: webhookSummary(data),
      ...(secret ? { secret } : {}),
    });
  });
}

export async function disableCustomerWebhook(
  workspaceId: string,
  webhookId: string
) {
  return withAdmin(workspaceId, async userId => {
    if (!ID_SCHEMA.safeParse(webhookId).success)
      return customerApiResponse({ error: "Invalid webhook ID" }, 400);
    const data = await mutateCredential(
      userId,
      workspaceId,
      "webhook",
      "disable",
      webhookId
    );
    return customerApiResponse({ webhook: webhookSummary(data) });
  });
}

export async function listCustomerWebhookDeliveries(
  request: Request,
  workspaceId: string,
  webhookId: string
) {
  return withAdmin(workspaceId, async () => {
    if (!ID_SCHEMA.safeParse(webhookId).success)
      return customerApiResponse({ error: "Invalid webhook ID" }, 400);
    const rawLimit = new URL(request.url).searchParams.get("limit") ?? "20";
    if (
      !/^\d+$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > 100
    ) {
      return customerApiResponse(
        { error: "limit must be between 1 and 100" },
        400
      );
    }
    const { data: webhook, error: webhookError } = await supabaseAdmin
      .from("webhook_subscriptions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("id", webhookId)
      .maybeSingle();
    if (webhookError) throw webhookError;
    if (!webhook)
      return customerApiResponse({ error: "Webhook not found" }, 404);
    const { data, error } = await supabaseAdmin
      .from("webhook_delivery_logs")
      .select(DELIVERY_COLUMNS)
      .eq("webhook_id", webhookId)
      .order("created_at", { ascending: false })
      .limit(Number(rawLimit));
    if (error) throw error;
    return customerApiResponse({
      deliveries: (data || []).map(row => project(row, DELIVERY_COLUMNS)),
    });
  });
}
