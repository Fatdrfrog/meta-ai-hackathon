import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import { encryptString } from "@/lib/crypto";
import {
  readWhatsAppConversionsConfiguration,
  type WhatsAppConversionsSettings,
} from "@/lib/conversions/source-config";
import { provisionWhatsAppConversionDataset } from "@/lib/meta-ads/whatsapp-conversions-api";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import {
  getWhatsAppWorkspaceContext,
  type WhatsAppWorkspaceContext,
} from "@/lib/whatsapp/get-workspace-context";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { WhatsAppFlowSourceBindingFenceConflictError } from "@/lib/whatsapp/flows/source-binding-fence-store";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { getWhatsAppWebhookSourceSkip } from "@icecore/shared/lib/whatsapp/source-state";
import type { Source } from "@icecore/shared/types/sources";

type RouteContext = {
  params: Promise<{ workspaceId: string; sourceId: string }>;
};
const headers = { "Cache-Control": "no-store" };
const unavailable = (credentials: unknown) =>
  getWhatsAppWebhookSourceSkip({ type: "whatsapp", credentials } as Source) !==
  null;

function settings(
  request: Request,
  context: WhatsAppWorkspaceContext,
  credentials: unknown = context.rawCredentials
): WhatsAppConversionsSettings {
  const raw = asWhatsAppRecord(credentials);
  const config = unavailable(raw)
    ? null
    : readWhatsAppConversionsConfiguration(raw);
  const hasWebhookSecret = Boolean(raw.sales_webhook_secret);
  return {
    enabled: config?.enabled === true,
    datasetId: config?.dataset_id ?? null,
    wabaId: normalizeWhatsAppAccountIdentifiers(raw).wabaId ?? null,
    hasWebhookSecret,
    webhookEnabled:
      hasWebhookSecret &&
      !unavailable(raw) &&
      raw.sales_webhook_enabled === true,
    webhookUrl: new URL(
      `/api/conversions/events/${encodeURIComponent(context.sourceId!)}`,
      request.url
    ).toString(),
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { workspaceId, sourceId } = await params;
  try {
    const result = await getWhatsAppWorkspaceContext(workspaceId, {
      sourceId,
      requireCredentials: false,
    });
    if (result.error) return result.error;
    return NextResponse.json(settings(request, result.context), { headers });
  } catch {
    return NextResponse.json(
      { error: "Could not load conversion settings.", code: "load_failed" },
      { status: 500, headers }
    );
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { workspaceId, sourceId } = await params;
  try {
    const result = await getWhatsAppWorkspaceContext(workspaceId, {
      sourceId,
      requireCredentials: false,
      requireManager: true,
    });
    if (result.error) return result.error;
    let body: unknown;
    try {
      body = await readJsonBodyWithinLimit(request, 1024);
    } catch {
      return NextResponse.json(
        { error: "Invalid settings request.", code: "invalid_request" },
        { status: 400, headers }
      );
    }
    const record = asWhatsAppRecord(body);
    const action = record.action;
    if (
      Object.keys(record).length !== 1 ||
      typeof action !== "string" ||
      ![
        "enable_meta",
        "disable_meta",
        "rotate_webhook_secret",
        "disable_webhook",
      ].includes(String(action))
    ) {
      return NextResponse.json(
        { error: "Invalid settings action.", code: "invalid_request" },
        { status: 400, headers }
      );
    }
    const context = result.context;
    const raw = asWhatsAppRecord(context.rawCredentials);
    const wabaId = context.wabaId || "";
    const activating =
      action === "enable_meta" || action === "rotate_webhook_secret";
    if (activating && unavailable(raw)) {
      return NextResponse.json(
        {
          error: "Reconnect WhatsApp before enabling sales integrations.",
          code: "reconnect_required",
        },
        { status: 409, headers }
      );
    }
    const oldConfig = asWhatsAppRecord(raw.conversions_api);
    const boundary = Object.prototype.hasOwnProperty.call(
      oldConfig,
      "attribution_boundary_at"
    )
      ? { attribution_boundary_at: oldConfig.attribution_boundary_at }
      : {};
    const patch: Record<string, unknown> = {};
    let webhookSecret: string | undefined;
    if (action === "enable_meta") {
      if (!wabaId || !context.accessToken) {
        return NextResponse.json(
          {
            error: "Reconnect WhatsApp before enabling Meta sales feedback.",
            code: "reconnect_required",
          },
          { status: 409, headers }
        );
      }
      let datasetId: string;
      try {
        const appConfig = getMetaServerAppConfig();
        const metadata = await debugConfiguredMetaAccessToken(
          context.accessToken,
          { appConfig }
        );
        const validity = evaluateMetaAccessToken(metadata, {
          appId: appConfig.appId,
        });
        const scopes = new Set(
          Array.isArray(metadata.scopes) ? metadata.scopes : []
        );
        if (
          !validity.valid ||
          !scopes.has("whatsapp_business_management") ||
          !scopes.has("whatsapp_business_manage_events")
        ) {
          return NextResponse.json(
            {
              error:
                "Reconnect WhatsApp with business management and business event permissions before enabling feedback.",
              code: "meta_setup_failed",
            },
            { status: 409, headers }
          );
        }
        datasetId = await provisionWhatsAppConversionDataset({
          wabaId,
          accessToken: context.accessToken,
        });
      } catch {
        return NextResponse.json(
          {
            error:
              "Meta setup failed. Reconnect WhatsApp with business management and business event permissions, then try again.",
            code: "meta_setup_failed",
          },
          { status: 502, headers }
        );
      }
      patch.conversions_api = {
        enabled: true,
        dataset_id: datasetId,
        waba_id: wabaId,
        configured_at: new Date().toISOString(),
        ...boundary,
        ...(oldConfig.waba_id === wabaId &&
        oldConfig.test_event_code !== undefined
          ? { test_event_code: oldConfig.test_event_code }
          : {}),
      };
      if (
        !readWhatsAppConversionsConfiguration({
          ...raw,
          conversions_api: patch.conversions_api,
        })
      ) {
        return NextResponse.json(
          {
            error:
              "Saved conversion configuration is invalid. Review it before enabling feedback.",
            code: "source_changed",
          },
          { status: 409, headers }
        );
      }
    } else if (action === "disable_meta") {
      const config = readWhatsAppConversionsConfiguration(raw);
      patch.conversions_api = config
        ? { ...config, enabled: false }
        : { enabled: false, ...boundary };
    } else if (action === "rotate_webhook_secret") {
      webhookSecret = randomBytes(32).toString("hex");
      patch.sales_webhook_secret = encryptString(webhookSecret);
      patch.sales_webhook_enabled = true;
    } else {
      patch.sales_webhook_enabled = false;
    }
    const updated = await updateCurrentWhatsAppSourceCredentials({
      workspaceId,
      sourceId,
      expectedWabaId: wabaId,
      expectedCredentials: {
        ...(action === "enable_meta"
          ? { access_token: raw.access_token, accessToken: raw.accessToken }
          : {}),
        ...Object.fromEntries(Object.keys(patch).map(key => [key, raw[key]])),
      },
      buildCredentials: current => {
        if (activating && unavailable(current))
          throw new WhatsAppFlowSourceBindingFenceConflictError();
        return { ...current, ...patch };
      },
    });
    return NextResponse.json(
      {
        ...settings(request, context, updated.credentials),
        ...(webhookSecret ? { webhookSecret } : {}),
      },
      { headers }
    );
  } catch (error) {
    const conflict =
      error instanceof WhatsAppFlowSourceBindingFenceConflictError;
    return NextResponse.json(
      {
        error: conflict
          ? "The WhatsApp connection changed. Reload settings and try again."
          : "Could not save conversion settings.",
        code: conflict ? "source_changed" : "save_failed",
      },
      { status: conflict ? 409 : 500, headers }
    );
  }
}
