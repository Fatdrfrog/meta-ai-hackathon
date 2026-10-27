import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import {
  normalizeShopifyShopDomain,
  StoreEventValidationError,
} from "@/lib/commerce/integrations";
import { publicCart } from "@/lib/commerce/cart-state";
import { decryptMaybeString, encryptString } from "@/lib/crypto";
import connectDB from "@/lib/mongoose";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import WebsiteCart, { type WebsiteCartRow } from "@/models/website-cart";
import WebsiteCommerceSettingsModel, {
  type WebsiteCommerceSettings,
} from "@/models/website-commerce-settings";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import type { Source } from "@icecore/shared/types/sources";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

const responseHeaders = { "Cache-Control": "no-store" };

type RouteContext = {
  params: Promise<{ workspaceId: string; sourceId: string }>;
};
type WhatsAppChoice = { id: string; name: string };

function isUsableWhatsAppSource(
  source: Source | null | undefined
): source is Source {
  if (
    !source ||
    source.type !== "whatsapp" ||
    isWhatsAppCloudApiMessagingSuspended(source.credentials)
  ) {
    return false;
  }
  const credentials = normalizeWhatsAppCredentials(source.credentials);
  return Boolean(credentials.phoneNumberId && credentials.accessToken);
}

async function loadWidgetSource(workspaceId: string, sourceId: string) {
  const lookup = await fetchSourceWithCredentialsResult(sourceId, "web_widget");
  if (!lookup.ok) {
    return {
      error: NextResponse.json(
        { error: "Source lookup unavailable" },
        { status: 503, headers: responseHeaders }
      ),
    };
  }
  if (
    !lookup.source ||
    lookup.source.type !== "web_widget" ||
    lookup.source.id !== sourceId ||
    lookup.source.workspace_id !== workspaceId
  ) {
    return {
      error: NextResponse.json(
        { error: "Website source not found" },
        { status: 404, headers: responseHeaders }
      ),
    };
  }
  return { source: lookup.source };
}

async function loadWhatsAppChoices(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<WhatsAppChoice[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("id,name,workspace_id,type,credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not load WhatsApp sources");
  return ((data || []) as unknown as Source[])
    .filter(
      source =>
        source.workspace_id === workspaceId && isUsableWhatsAppSource(source)
    )
    .map(source => ({ id: source.id, name: source.name }));
}

async function loadRecentCarts(widgetSourceId: string) {
  const carts = await WebsiteCart.find({ widgetSourceId })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(10)
    .lean<WebsiteCartRow[]>();
  return carts.map(publicCart);
}

function settingsResponse(params: {
  request: Request;
  sourceId: string;
  settings: WebsiteCommerceSettings | null;
  /** The Tilda webhook URL carries its secret token; only managers get it. */
  revealTildaWebhook: boolean;
  whatsappSources: WhatsAppChoice[];
  recentCarts: ReturnType<typeof publicCart>[];
  webhookSecret?: string;
}) {
  const settings = params.settings;
  const webhookUrl = new URL(
    `/api/commerce/events/${encodeURIComponent(params.sourceId)}/generic`,
    params.request.url
  ).toString();
  const shopifyWebhookUrl = settings?.shopifyShopDomain
    ? new URL(
        `/api/commerce/events/${encodeURIComponent(params.sourceId)}/shopify`,
        params.request.url
      ).toString()
    : null;
  const tildaToken =
    params.revealTildaWebhook && settings?.tildaToken
      ? decryptMaybeString(settings.tildaToken)
      : "";
  const tildaWebhookUrl = tildaToken
    ? (() => {
        const url = new URL(
          `/api/commerce/events/${encodeURIComponent(params.sourceId)}/tilda`,
          params.request.url
        );
        url.searchParams.set("token", tildaToken);
        return url.toString();
      })()
    : null;
  return {
    enabled: settings?.enabled === true,
    whatsappSourceId: settings?.whatsappSourceId || null,
    shopifyShopDomain: settings?.shopifyShopDomain || null,
    hasWebhookSecret: Boolean(settings?.webhookSecret),
    hasShopifyWebhookSecret: Boolean(settings?.shopifyWebhookSecret),
    whatsappSources: params.whatsappSources,
    webhookUrl,
    shopifyWebhookUrl,
    tildaWebhookUrl,
    lastEventAt: settings?.lastEventAt
      ? new Date(settings.lastEventAt).toISOString()
      : null,
    recentCarts: params.recentCarts,
    ...(params.webhookSecret ? { webhookSecret: params.webhookSecret } : {}),
  };
}

async function buildResponse(params: {
  request: Request;
  sourceId: string;
  settings: WebsiteCommerceSettings | null;
  revealTildaWebhook: boolean;
  supabase: SupabaseClient;
  workspaceId: string;
  webhookSecret?: string;
}) {
  const [whatsappSources, recentCarts] = await Promise.all([
    loadWhatsAppChoices(params.supabase, params.workspaceId),
    loadRecentCarts(params.sourceId),
  ]);
  return settingsResponse({
    ...params,
    whatsappSources,
    recentCarts,
  });
}

export async function GET(request: Request, { params }: RouteContext) {
  const { workspaceId, sourceId } = await params;
  try {
    const access = await getAuthenticatedWorkspaceMembership(workspaceId);
    if (access.error) return access.error;
    const widget = await loadWidgetSource(workspaceId, sourceId);
    if (widget.error) return widget.error;
    await connectDB();
    const settings = await WebsiteCommerceSettingsModel.findOne({
      workspaceId,
      widgetSourceId: sourceId,
    }).lean<WebsiteCommerceSettings | null>();
    return NextResponse.json(
      await buildResponse({
        request,
        sourceId,
        settings,
        revealTildaWebhook: isWorkspaceManagerRole(access.membership.role),
        supabase: access.supabase,
        workspaceId,
      }),
      { headers: responseHeaders }
    );
  } catch {
    return NextResponse.json(
      { error: "Could not load website commerce settings" },
      { status: 500, headers: responseHeaders }
    );
  }
}

async function requireUsableWhatsAppSource(
  workspaceId: string,
  sourceId: string
) {
  const lookup = await fetchSourceWithCredentialsResult(sourceId, "whatsapp");
  if (!lookup.ok) throw new Error("WhatsApp source lookup unavailable");
  return Boolean(
    lookup.source?.workspace_id === workspaceId &&
      lookup.source.id === sourceId &&
      isUsableWhatsAppSource(lookup.source)
  );
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { workspaceId, sourceId } = await params;
  try {
    const access = await getAuthenticatedWorkspaceMembership(workspaceId);
    if (access.error) return access.error;
    if (!isWorkspaceManagerRole(access.membership.role)) {
      return NextResponse.json(
        { error: "Only managers and admins can update commerce settings" },
        { status: 403, headers: responseHeaders }
      );
    }
    const widget = await loadWidgetSource(workspaceId, sourceId);
    if (widget.error) return widget.error;

    let body: Record<string, unknown> | null;
    try {
      body = asNullableRecord(await readJsonBodyWithinLimit(request, 4 * 1024));
    } catch {
      body = null;
    }
    if (!body || (body.action !== "save" && body.action !== "rotate_secret")) {
      return NextResponse.json(
        { error: "Invalid commerce settings request" },
        { status: 400, headers: responseHeaders }
      );
    }

    await connectDB();
    let webhookSecret: string | undefined;
    let settings: WebsiteCommerceSettings | null;
    if (body.action === "rotate_secret") {
      if (Object.keys(body).some(key => key !== "action")) {
        return NextResponse.json(
          { error: "Invalid commerce settings request" },
          { status: 400, headers: responseHeaders }
        );
      }
      webhookSecret = randomBytes(32).toString("hex");
      const tildaToken = randomBytes(32).toString("hex");
      settings = await WebsiteCommerceSettingsModel.findOneAndUpdate(
        { workspaceId, widgetSourceId: sourceId },
        {
          $set: {
            webhookSecret: encryptString(webhookSecret),
            tildaToken: encryptString(tildaToken),
          },
          $setOnInsert: {
            workspaceId,
            widgetSourceId: sourceId,
            enabled: false,
            whatsappSourceId: null,
            shopifyShopDomain: null,
          },
        },
        { new: true, upsert: true, runValidators: true }
      ).lean<WebsiteCommerceSettings | null>();
    } else {
      const allowed = new Set([
        "action",
        "enabled",
        "whatsappSourceId",
        "shopifyShopDomain",
        "shopifyWebhookSecret",
      ]);
      if (
        Object.keys(body).some(key => !allowed.has(key)) ||
        typeof body.enabled !== "boolean" ||
        (body.whatsappSourceId !== null &&
          typeof body.whatsappSourceId !== "string")
      ) {
        return NextResponse.json(
          { error: "Invalid commerce settings request" },
          { status: 400, headers: responseHeaders }
        );
      }
      const whatsappSourceId =
        typeof body.whatsappSourceId === "string"
          ? body.whatsappSourceId.trim()
          : null;
      if (
        (body.enabled && !whatsappSourceId) ||
        (whatsappSourceId &&
          !(await requireUsableWhatsAppSource(workspaceId, whatsappSourceId)))
      ) {
        return NextResponse.json(
          { error: "Select an active WhatsApp source from this workspace" },
          { status: 409, headers: responseHeaders }
        );
      }
      const shopifyWebhookSecret = body.shopifyWebhookSecret;
      if (
        shopifyWebhookSecret !== undefined &&
        (typeof shopifyWebhookSecret !== "string" ||
          shopifyWebhookSecret.trim().length > 512)
      ) {
        return NextResponse.json(
          { error: "Invalid Shopify webhook secret" },
          { status: 400, headers: responseHeaders }
        );
      }
      const existing = await WebsiteCommerceSettingsModel.findOne({
        workspaceId,
        widgetSourceId: sourceId,
      })
        .select("tildaToken shopifyShopDomain")
        .lean<Pick<
          WebsiteCommerceSettings,
          "tildaToken" | "shopifyShopDomain"
        > | null>();
      const shopifyShopDomain = Object.prototype.hasOwnProperty.call(
        body,
        "shopifyShopDomain"
      )
        ? normalizeShopifyShopDomain(body.shopifyShopDomain)
        : existing?.shopifyShopDomain || null;
      const set: Record<string, unknown> = {
        enabled: body.enabled,
        whatsappSourceId: whatsappSourceId || null,
        shopifyShopDomain,
        ...(existing?.tildaToken
          ? {}
          : { tildaToken: encryptString(randomBytes(32).toString("hex")) }),
      };
      if (
        typeof shopifyWebhookSecret === "string" &&
        shopifyWebhookSecret.trim()
      ) {
        set.shopifyWebhookSecret = encryptString(shopifyWebhookSecret.trim());
      }
      settings = await WebsiteCommerceSettingsModel.findOneAndUpdate(
        { workspaceId, widgetSourceId: sourceId },
        {
          $set: set,
          $setOnInsert: { workspaceId, widgetSourceId: sourceId },
        },
        { new: true, upsert: true, runValidators: true }
      ).lean<WebsiteCommerceSettings | null>();
    }

    if (!settings) throw new Error("Commerce settings persistence failed");
    return NextResponse.json(
      await buildResponse({
        request,
        sourceId,
        settings,
        // Only managers reach this point (403 above).
        revealTildaWebhook: true,
        supabase: access.supabase,
        workspaceId,
        webhookSecret,
      }),
      { headers: responseHeaders }
    );
  } catch (error) {
    if (error instanceof StoreEventValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: responseHeaders }
      );
    }
    return NextResponse.json(
      { error: "Could not save website commerce settings" },
      { status: 500, headers: responseHeaders }
    );
  }
}
