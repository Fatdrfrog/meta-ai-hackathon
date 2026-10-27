import {
  buildCampaignWhatsappRecipientPayload,
  collectCampaignTemplateVariables,
} from "@/lib/campaign/campaign-recipient-utils";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { createServerLogger } from "@/lib/observability/server-logs";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsappTemplate } from "@/lib/whatsapp";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  readWhatsAppTestPhone,
  WHATSAPP_TEST_PHONE_METADATA_KEY,
  WHATSAPP_TEST_SEND_HOURLY_LIMIT,
  WhatsAppTestSendRequestSchema,
  type WhatsAppTestSendErrorCode,
} from "@/lib/whatsapp/test-send";
import { readWhatsAppTemplateExampleValues } from "@/lib/whatsapp/templates/parameter-format";
import {
  refreshWhatsAppTemplateMediaForSend,
  resolveApprovedWhatsAppTemplateForSend,
} from "@/lib/whatsapp/templates/send-lookup";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { NextResponse } from "next/server";

/**
 * Sends an approved template to the signed-in manager's own WhatsApp, so a
 * campaign can be checked on a phone before it goes out. Tests skip campaign
 * contact limits, so they are capped per user instead.
 */

const testSendLogger = createServerLogger("api.sources.whatsapp.test_send");

const testSendLimiter = createRateLimiter({
  requests: WHATSAPP_TEST_SEND_HOURLY_LIMIT,
  window: "1 h",
  prefix: "whatsapp:test-send",
});

function fail(
  code: WhatsAppTestSendErrorCode,
  status: number,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({ ok: false, code, ...extra }, { status });
}

/** The workspace check's English errors, as codes the dialog translates. */
function failForAccess(status: number) {
  if (status === 401 || status === 403) return fail("not_allowed", status);
  if (status === 400) return fail("invalid_request", 400);
  return fail("whatsapp_not_connected", 409);
}

const RECIPIENT_NOT_ALLOWED_CODES = new Set([131030]);
const RECIPIENT_UNREACHABLE_CODES = new Set([131026]);
const RECIPIENT_IS_SENDER_CODES = new Set([131021]);
const BILLING_CODES = new Set([131042]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
const TOKEN_CODES = new Set([190]);
const TEMPLATE_PARAMETER_CODES = new Set([132000, 132005, 132007, 132012]);
const TEMPLATE_MISSING_CODES = new Set([132001]);

function classifySendError(error: unknown): {
  code: WhatsAppTestSendErrorCode;
  providerCode?: number;
} {
  if (!(error instanceof MetaGraphRequestError)) return { code: "send_failed" };
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as { error?: { code?: unknown } }).error
      : undefined;
  const providerCode =
    typeof details?.code === "number" ? details.code : undefined;
  if (providerCode === undefined) return { code: "send_failed" };
  const code: WhatsAppTestSendErrorCode = RECIPIENT_NOT_ALLOWED_CODES.has(
    providerCode
  )
    ? "recipient_not_allowed"
    : RECIPIENT_UNREACHABLE_CODES.has(providerCode)
      ? "recipient_unreachable"
      : RECIPIENT_IS_SENDER_CODES.has(providerCode)
        ? "recipient_is_sender"
        : BILLING_CODES.has(providerCode)
          ? "meta_billing"
          : RATE_LIMIT_CODES.has(providerCode)
            ? "meta_rate_limited"
            : TOKEN_CODES.has(providerCode)
              ? "token_invalid"
              : TEMPLATE_PARAMETER_CODES.has(providerCode)
                ? "template_parameters"
                : TEMPLATE_MISSING_CODES.has(providerCode)
                  ? "template_unavailable"
                  : "send_failed";
  return { code, providerCode };
}

/** The number this user last sent a test to, for the dialog's prefill. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("not_allowed", 401);
  return NextResponse.json(
    { phone: readWhatsAppTestPhone(user.user_metadata) },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function POST(request: Request) {
  const parsed = WhatsAppTestSendRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return fail("invalid_request", 400);
  const body = parsed.data;

  const access = await getWhatsAppWorkspaceContext(body.workspaceId, {
    requireManager: true,
    requirePhoneNumber: true,
    sourceId: body.sourceId,
  });
  if (access.error) return failForAccess(access.error.status);
  const { context } = access;
  if (!context.accessToken || !context.phoneNumberId) {
    return fail("whatsapp_not_connected", 409);
  }

  try {
    const limit = await checkRateLimit(
      testSendLimiter,
      context.user.id,
      WHATSAPP_TEST_SEND_HOURLY_LIMIT
    );
    if (!limit.success) {
      return fail("rate_limited", 429, {
        retryAt: new Date(limit.reset).toISOString(),
      });
    }
  } catch {
    // A limiter outage must not block a manager's own test.
  }

  const to = normalizeWhatsAppPhone(body.to);
  if (!to) return fail("invalid_phone", 400);

  const supabase = await createClient();
  let template;
  try {
    ({ template } = await resolveApprovedWhatsAppTemplateForSend({
      workspaceId: body.workspaceId,
      templateName: body.templateName,
      languageCode: body.language,
      sourceId: context.sourceId,
      supabase,
    }));
  } catch {
    return fail("template_unavailable", 409);
  }
  if (!template) return fail("template_unavailable", 409);

  const requiredTemplateVariables = collectCampaignTemplateVariables(
    template.components
  );
  const payload = buildCampaignWhatsappRecipientPayload({
    workspaceId: body.workspaceId,
    recipient: {
      phone: to,
      ...(body.recipientName ? { name: body.recipientName } : {}),
      variables: {
        ...readWhatsAppTemplateExampleValues(template.components),
        ...Object.fromEntries(
          Object.entries(body.variables ?? {}).filter(([, value]) =>
            value.trim()
          )
        ),
      },
    },
    sourceId: context.sourceId,
    templateName: template.name,
    templateComponents: template.components,
    requiredTemplateVariables,
    strictRequiredTemplateVariables: true,
  });
  if (payload.missingRequired.length > 0) {
    return fail("template_variables_missing", 400, {
      variables: payload.missingRequired,
    });
  }
  if (payload.headerMediaMissing) return fail("header_media_missing", 400);

  try {
    const components = await refreshWhatsAppTemplateMediaForSend({
      workspaceId: body.workspaceId,
      sourceId: context.sourceId,
      expectedWabaId: context.wabaId,
      templateName: template.name,
      languageCode: template.language,
      components: payload.components,
      supabase,
      useTemplateMedia: true,
    });
    const sent = await sendWhatsappTemplate(
      context.phoneNumberId,
      context.accessToken,
      to,
      template.name,
      template.language,
      components,
      {
        requirePhoneRecipient: true,
        messagingAccountId: context.credentials.messagingAccountId,
      }
    );

    // Remembering the number is a convenience; the test already went out.
    await supabase.auth
      .updateUser({ data: { [WHATSAPP_TEST_PHONE_METADATA_KEY]: to } })
      .catch(() => undefined);
    await captureFunnelEvent({
      event: "test_sent",
      userId: context.user.id,
      workspaceId: body.workspaceId,
      properties: {
        channel: "whatsapp",
        origin: body.origin,
        template_category: template.category,
      },
    });

    return NextResponse.json({ ok: true, to, messageId: sent.messageId });
  } catch (error) {
    const classified = classifySendError(error);
    testSendLogger.warn("test_send_failed", {
      workspaceId: body.workspaceId,
      code: classified.code,
      providerCode: classified.providerCode,
    });
    return fail(classified.code, 502, {
      ...(classified.providerCode !== undefined
        ? { providerCode: classified.providerCode }
        : {}),
    });
  }
}
