import { createClient } from "@/lib/supabase/server";
import {
  buildWhatsAppInAppSignupDeepLink,
  normalizeWhatsAppInAppSignupPayload,
  validateWhatsAppInAppSignupPayload,
} from "@/lib/whatsapp/in-app-signup";
import { compactWhatsAppString } from "@icecore/shared/lib/whatsapp/value-utils";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

type JsonRecord = Record<string, unknown>;

export type WhatsAppSignupLinkStatus = "ACTIVE" | "DISABLED";

export type WhatsAppSignupLinkInput = {
  displayName?: string;
  signupMessage: string;
  confirmationMessage: string;
  privacyPolicyUrl: string;
  websiteUrl?: string;
  promoCode?: string;
  productLine?: string;
  shop?: string;
  campaign?: string;
  landingPage?: string;
  ad?: string;
  checkoutFlow?: string;
  messagingCustomerBaseId?: string;
};

export type WhatsAppSignupLinkRecord = {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  wabaId: string;
  phoneNumberId: string | null;
  businessPhoneNumber: string | null;
  metaSignupId: string;
  deepLinkUrl: string;
  displayName: string | null;
  signupMessage: string;
  confirmationMessage: string;
  privacyPolicyUrl: string;
  websiteUrl: string | null;
  promoCode: string | null;
  status: WhatsAppSignupLinkStatus;
  productLine: string | null;
  shop: string | null;
  campaign: string | null;
  landingPage: string | null;
  ad: string | null;
  checkoutFlow: string | null;
  messagingCustomerBaseId: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type WhatsAppMessagingCustomerBaseRecord = {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  businessId: string;
  wabaId: string | null;
  metaCustomerBaseId: string;
  name: string;
  isDefault: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type WhatsAppOptInEventRecord = {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  conversationId: string | null;
  waId: string | null;
  userId: string | null;
  status: boolean;
  source: string;
  metaSignupId: string | null;
  messagingCustomerBaseId: string | null;
  productLine: string | null;
  shop: string | null;
  campaign: string | null;
  landingPage: string | null;
  ad: string | null;
  checkoutFlow: string | null;
  eventAt: string | null;
  receivedAt: string | null;
};

type GraphSignupResponse = {
  id?: string;
  signup_id?: string;
};

type MessagingCustomerBaseGraphItem = {
  id?: string;
  name?: string;
  messaging_customer_base_id?: string;
  messaging_customer_base_name?: string;
};

type MessagingCustomerBaseGraphResponse = {
  data?: MessagingCustomerBaseGraphItem[];
  messaging_customer_bases?: MessagingCustomerBaseGraphItem[];
};

function compact(value: unknown): string | null {
  return compactWhatsAppString(value) || null;
}

function requireText(value: unknown, message: string): string {
  const normalized = compact(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function mapSignupRow(row: JsonRecord): WhatsAppSignupLinkRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceId: compact(row.source_id),
    wabaId: String(row.waba_id),
    phoneNumberId: compact(row.phone_number_id),
    businessPhoneNumber: compact(row.business_phone_number),
    metaSignupId: String(row.meta_signup_id),
    deepLinkUrl: String(row.deep_link_url),
    displayName: compact(row.display_name),
    signupMessage: String(row.signup_message || ""),
    confirmationMessage: String(row.confirmation_message || ""),
    privacyPolicyUrl: String(row.privacy_policy_url || ""),
    websiteUrl: compact(row.website_url),
    promoCode: compact(row.promo_code),
    status:
      String(row.status || "ACTIVE").toUpperCase() === "DISABLED"
        ? "DISABLED"
        : "ACTIVE",
    productLine: compact(row.product_line),
    shop: compact(row.shop),
    campaign: compact(row.campaign),
    landingPage: compact(row.landing_page),
    ad: compact(row.ad),
    checkoutFlow: compact(row.checkout_flow),
    messagingCustomerBaseId: compact(row.messaging_customer_base_id),
    createdAt: compact(row.created_at),
    updatedAt: compact(row.updated_at),
  };
}

function mapCustomerBaseRow(
  row: JsonRecord
): WhatsAppMessagingCustomerBaseRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceId: compact(row.source_id),
    businessId: String(row.business_id),
    wabaId: compact(row.waba_id),
    metaCustomerBaseId: String(row.meta_customer_base_id),
    name: String(row.name || ""),
    isDefault: row.is_default === true,
    createdAt: compact(row.created_at),
    updatedAt: compact(row.updated_at),
  };
}

function mapOptInEventRow(row: JsonRecord): WhatsAppOptInEventRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceId: compact(row.source_id),
    conversationId: compact(row.conversation_id),
    waId: compact(row.wa_id),
    userId: compact(row.user_id),
    status: row.status === true,
    source: String(row.source || ""),
    metaSignupId: compact(row.meta_signup_id),
    messagingCustomerBaseId: compact(row.messaging_customer_base_id),
    productLine: compact(row.product_line),
    shop: compact(row.shop),
    campaign: compact(row.campaign),
    landingPage: compact(row.landing_page),
    ad: compact(row.ad),
    checkoutFlow: compact(row.checkout_flow),
    eventAt: compact(row.event_at),
    receivedAt: compact(row.received_at),
  };
}

export function buildWhatsAppSignupGraphPayload(
  input: WhatsAppSignupLinkInput
): JsonRecord {
  return normalizeWhatsAppInAppSignupPayload({
    signup_message: input.signupMessage,
    confirmation_message: input.confirmationMessage,
    privacy_policy_url: input.privacyPolicyUrl,
    ...(input.websiteUrl ? { website_url: input.websiteUrl } : {}),
    ...(input.promoCode ? { promo_code: input.promoCode } : {}),
    ...(input.displayName ? { display_name: input.displayName } : {}),
  });
}

export async function listWhatsAppSignupLinks(params: {
  workspaceId: string;
  sourceId?: string | null;
}): Promise<{ links: WhatsAppSignupLinkRecord[] }> {
  const supabase = await createClient();
  let query = supabase
    .from("whatsapp_signup_links")
    .select("*")
    .eq("workspace_id", params.workspaceId)
    .order("created_at", { ascending: false });

  if (params.sourceId) {
    query = query.eq("source_id", params.sourceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    links: Array.isArray(data) ? (data as JsonRecord[]).map(mapSignupRow) : [],
  };
}

export async function listWhatsAppOptInEvents(params: {
  workspaceId: string;
  sourceId?: string | null;
  limit?: number;
}): Promise<{ subscribers: WhatsAppOptInEventRecord[] }> {
  const supabase = await createClient();
  let query = supabase
    .from("whatsapp_opt_in_events")
    .select("*")
    .eq("workspace_id", params.workspaceId)
    .order("received_at", { ascending: false })
    .limit(Math.min(Math.max(params.limit || 200, 1), 500));

  if (params.sourceId) {
    query = query.eq("source_id", params.sourceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    subscribers: Array.isArray(data)
      ? (data as JsonRecord[]).map(mapOptInEventRow)
      : [],
  };
}

export async function createWhatsAppSignupLink(params: {
  accessToken: string;
  businessPhoneNumber: string;
  input: WhatsAppSignupLinkInput;
  phoneNumberId?: string | null;
  sourceId?: string | null;
  wabaId: string;
  workspaceId: string;
}): Promise<WhatsAppSignupLinkRecord> {
  const issues = validateWhatsAppInAppSignupPayload({
    signup_message: params.input.signupMessage,
    confirmation_message: params.input.confirmationMessage,
    privacy_policy_url: params.input.privacyPolicyUrl,
    website_url: params.input.websiteUrl,
    promo_code: params.input.promoCode,
  });
  if (issues.length > 0) {
    throw new Error(issues.map(issue => issue.message).join(" "));
  }

  const client = getWhatsAppGraphClient();
  const graphResponse = await client.postJson<GraphSignupResponse>(
    `${encodeURIComponent(params.wabaId)}/signups`,
    {
      token: params.accessToken,
      body: buildWhatsAppSignupGraphPayload(params.input),
    }
  );
  const metaSignupId = requireText(
    graphResponse.id || graphResponse.signup_id,
    "Meta did not return a signup ID"
  );
  const deepLinkUrl = buildWhatsAppInAppSignupDeepLink({
    businessPhoneNumber: params.businessPhoneNumber,
    signupId: metaSignupId,
  });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("whatsapp_signup_links")
    .insert({
      workspace_id: params.workspaceId,
      source_id: params.sourceId || null,
      waba_id: params.wabaId,
      phone_number_id: params.phoneNumberId || null,
      business_phone_number: params.businessPhoneNumber,
      meta_signup_id: metaSignupId,
      deep_link_url: deepLinkUrl,
      display_name: params.input.displayName || null,
      signup_message: params.input.signupMessage,
      confirmation_message: params.input.confirmationMessage,
      privacy_policy_url: params.input.privacyPolicyUrl,
      website_url: params.input.websiteUrl || null,
      promo_code: params.input.promoCode || null,
      status: "ACTIVE",
      product_line: params.input.productLine || null,
      shop: params.input.shop || null,
      campaign: params.input.campaign || null,
      landing_page: params.input.landingPage || null,
      ad: params.input.ad || null,
      checkout_flow: params.input.checkoutFlow || null,
      messaging_customer_base_id: params.input.messagingCustomerBaseId || null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return mapSignupRow(data as JsonRecord);
}

export async function updateWhatsAppSignupLink(params: {
  accessToken: string;
  input: Partial<WhatsAppSignupLinkInput> & {
    status?: WhatsAppSignupLinkStatus;
  };
  signupLinkId: string;
  workspaceId: string;
}): Promise<WhatsAppSignupLinkRecord> {
  const supabase = await createClient();
  const { data: existing, error: existingError } = await supabase
    .from("whatsapp_signup_links")
    .select("*")
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.signupLinkId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (!existing) throw new Error("WhatsApp signup link not found");

  const existingRecord = mapSignupRow(existing as JsonRecord);
  const graphBody: JsonRecord = {};
  if (params.input.signupMessage !== undefined) {
    graphBody.signup_message = params.input.signupMessage;
  }
  if (params.input.confirmationMessage !== undefined) {
    graphBody.confirmation_message = params.input.confirmationMessage;
  }
  if (params.input.websiteUrl !== undefined) {
    graphBody.website_url = params.input.websiteUrl || null;
  }
  if (params.input.promoCode !== undefined) {
    graphBody.promo_code = params.input.promoCode || null;
  }
  if (params.input.displayName !== undefined) {
    graphBody.display_name = params.input.displayName || null;
  }
  if (params.input.status !== undefined) {
    graphBody.status = params.input.status;
  }

  if (Object.keys(graphBody).length > 0) {
    await getWhatsAppGraphClient().postJson(
      `signups/${encodeURIComponent(existingRecord.metaSignupId)}`,
      {
        token: params.accessToken,
        body: graphBody,
      }
    );
  }

  const updatePatch: JsonRecord = {
    ...(params.input.displayName !== undefined
      ? { display_name: params.input.displayName || null }
      : {}),
    ...(params.input.signupMessage !== undefined
      ? { signup_message: params.input.signupMessage }
      : {}),
    ...(params.input.confirmationMessage !== undefined
      ? { confirmation_message: params.input.confirmationMessage }
      : {}),
    ...(params.input.websiteUrl !== undefined
      ? { website_url: params.input.websiteUrl || null }
      : {}),
    ...(params.input.promoCode !== undefined
      ? { promo_code: params.input.promoCode || null }
      : {}),
    ...(params.input.status !== undefined
      ? { status: params.input.status }
      : {}),
    ...(params.input.productLine !== undefined
      ? { product_line: params.input.productLine || null }
      : {}),
    ...(params.input.shop !== undefined
      ? { shop: params.input.shop || null }
      : {}),
    ...(params.input.campaign !== undefined
      ? { campaign: params.input.campaign || null }
      : {}),
    ...(params.input.landingPage !== undefined
      ? { landing_page: params.input.landingPage || null }
      : {}),
    ...(params.input.ad !== undefined ? { ad: params.input.ad || null } : {}),
    ...(params.input.checkoutFlow !== undefined
      ? { checkout_flow: params.input.checkoutFlow || null }
      : {}),
    ...(params.input.messagingCustomerBaseId !== undefined
      ? {
          messaging_customer_base_id:
            params.input.messagingCustomerBaseId || null,
        }
      : {}),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("whatsapp_signup_links")
    .update(updatePatch)
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.signupLinkId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapSignupRow(data as JsonRecord);
}

async function getDefaultMessagingCustomerBaseId(params: {
  accessToken: string;
  wabaId: string;
}): Promise<string | null> {
  try {
    const response = await getWhatsAppGraphClient().getJson<JsonRecord>(
      `${encodeURIComponent(params.wabaId)}/default_messaging_customer_base`,
      { token: params.accessToken }
    );
    return (
      compact(response.messaging_customer_base_id) ||
      compact(response.id) ||
      null
    );
  } catch {
    return null;
  }
}

async function cacheMessagingCustomerBases(params: {
  bases: Array<{ id: string; name: string }>;
  businessId: string;
  defaultBaseId?: string | null;
  sourceId?: string | null;
  wabaId?: string | null;
  workspaceId: string;
}): Promise<WhatsAppMessagingCustomerBaseRecord[]> {
  const rows = params.bases.map(base => ({
    workspace_id: params.workspaceId,
    source_id: params.sourceId || null,
    business_id: params.businessId,
    waba_id: params.wabaId || null,
    meta_customer_base_id: base.id,
    name: base.name,
    is_default: Boolean(
      params.defaultBaseId && params.defaultBaseId === base.id
    ),
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("whatsapp_messaging_customer_bases")
    .upsert(rows, {
      onConflict: "workspace_id,meta_customer_base_id",
    })
    .select("*");
  if (error) throw new Error(error.message);
  return Array.isArray(data)
    ? (data as JsonRecord[]).map(mapCustomerBaseRow)
    : [];
}

export async function listMessagingCustomerBases(params: {
  accessToken: string;
  businessId: string;
  sourceId?: string | null;
  wabaId?: string | null;
  workspaceId: string;
}): Promise<{ bases: WhatsAppMessagingCustomerBaseRecord[] }> {
  const response =
    await getWhatsAppGraphClient().getJson<MessagingCustomerBaseGraphResponse>(
      `${encodeURIComponent(params.businessId)}/messaging_customer_base`,
      { token: params.accessToken }
    );
  const rawBases = response.messaging_customer_bases || response.data || [];
  const bases = rawBases
    .map(item => ({
      id: compact(item.id || item.messaging_customer_base_id),
      name: compact(item.name || item.messaging_customer_base_name),
    }))
    .filter((item): item is { id: string; name: string } =>
      Boolean(item.id && item.name)
    );
  const defaultBaseId = params.wabaId
    ? await getDefaultMessagingCustomerBaseId({
        accessToken: params.accessToken,
        wabaId: params.wabaId,
      })
    : null;

  return {
    bases: await cacheMessagingCustomerBases({
      bases,
      businessId: params.businessId,
      defaultBaseId,
      sourceId: params.sourceId,
      wabaId: params.wabaId,
      workspaceId: params.workspaceId,
    }),
  };
}

export async function createMessagingCustomerBase(params: {
  accessToken: string;
  businessId: string;
  name: string;
  sourceId?: string | null;
  wabaId?: string | null;
  workspaceId: string;
}): Promise<WhatsAppMessagingCustomerBaseRecord> {
  const name = requireText(
    params.name,
    "Messaging customer base name is required"
  );
  const response = await getWhatsAppGraphClient().postJson<JsonRecord>(
    `${encodeURIComponent(params.businessId)}/messaging_customer_base`,
    {
      token: params.accessToken,
      body: { messaging_customer_base_name: name },
    }
  );
  const metaCustomerBaseId = requireText(
    response.messaging_customer_base_id || response.id,
    "Meta did not return a messaging customer base ID"
  );
  const [base] = await cacheMessagingCustomerBases({
    bases: [{ id: metaCustomerBaseId, name }],
    businessId: params.businessId,
    sourceId: params.sourceId,
    wabaId: params.wabaId,
    workspaceId: params.workspaceId,
  });
  return base;
}

export async function setDefaultMessagingCustomerBase(params: {
  accessToken: string;
  customerBaseId: string;
  sourceId?: string | null;
  wabaId: string;
  workspaceId: string;
}): Promise<{ customerBaseId: string }> {
  const customerBaseId = requireText(
    params.customerBaseId,
    "Messaging customer base ID is required"
  );
  const supabase = await createClient();
  const { data: cachedBase, error: cachedBaseError } = await supabase
    .from("whatsapp_messaging_customer_bases")
    .select("id")
    .eq("workspace_id", params.workspaceId)
    .eq("waba_id", params.wabaId)
    .eq("meta_customer_base_id", customerBaseId)
    .maybeSingle();
  if (cachedBaseError) throw new Error(cachedBaseError.message);
  if (!cachedBase) {
    throw new Error(
      "Messaging customer base is not cached. Refresh customer bases and try again."
    );
  }

  await getWhatsAppGraphClient().postJson(
    `${encodeURIComponent(params.wabaId)}/default_messaging_customer_base`,
    {
      token: params.accessToken,
      body: { messaging_customer_base_id: customerBaseId },
    }
  );

  const now = new Date().toISOString();
  const { data: selected, error: selectedError } = await supabase
    .from("whatsapp_messaging_customer_bases")
    .update({ is_default: true, updated_at: now })
    .eq("workspace_id", params.workspaceId)
    .eq("waba_id", params.wabaId)
    .eq("meta_customer_base_id", customerBaseId)
    .select("id")
    .maybeSingle();
  if (selectedError) throw new Error(selectedError.message);
  if (!selected)
    throw new Error("Messaging customer base default was not saved");

  const { error } = await supabase
    .from("whatsapp_messaging_customer_bases")
    .update({ is_default: false, updated_at: now })
    .eq("workspace_id", params.workspaceId)
    .eq("waba_id", params.wabaId)
    .neq("meta_customer_base_id", customerBaseId);
  if (error) throw new Error(error.message);

  return { customerBaseId };
}
