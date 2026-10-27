"use client";

import { Button } from "@/components/ui/button";
import {
  createFacebookLoginCallback,
  loadFacebookSDK,
  type FacebookLoginOptions,
  type FacebookLoginResponse,
} from "@/lib/facebook-sdk";
import { captureClientEvent } from "@/lib/posthog/client";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ComponentProps } from "react";
import { toast } from "sonner";

export interface EmbeddedSignupSessionInfo {
  phone_number_id?: string;
  cs_id?: string;
  waba_id?: string;
  messaging_account_id?: string;
  waac_id?: string;
  waba_ids?: string[];
  business_id?: string;
  catalog_ids?: string[];
  ad_account_ids?: string[];
  page_ids?: string[];
  dataset_ids?: string[];
}

export interface EmbeddedSignupSessionResult {
  data?: EmbeddedSignupSessionInfo;
  event: string;
}

export type EmbeddedSignupFlow = "cloud_api" | "coexistence";

export const WHATSAPP_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID =
  "1574370290915799";

export function buildEmbeddedSignupCallbackPath({
  code,
  workspaceId,
  intent = "new",
  flow,
  event,
  sessionInfo,
}: {
  code: string;
  workspaceId?: string;
  intent?: "new" | "upgrade";
  flow?: EmbeddedSignupFlow;
  event?: string;
  sessionInfo?: EmbeddedSignupSessionInfo | null;
}) {
  const params = new URLSearchParams({
    code,
    embedded: "true",
  });

  if (workspaceId) {
    params.set("state", workspaceId);
  }

  if (intent === "upgrade") {
    params.set("intent", "upgrade");
  }

  if (flow) {
    params.set("flow", flow);
  }

  if (event) {
    params.set("event", event);
  }

  if (sessionInfo?.phone_number_id) {
    params.set("phone_number_id", sessionInfo.phone_number_id);
  }

  if (sessionInfo?.cs_id) {
    params.set("cs_id", sessionInfo.cs_id);
  }

  if (sessionInfo?.waba_id) {
    params.set("waba_id", sessionInfo.waba_id);
  }

  if (sessionInfo?.messaging_account_id) {
    params.set("messaging_account_id", sessionInfo.messaging_account_id);
  }

  if (sessionInfo?.waac_id) {
    params.set("waac_id", sessionInfo.waac_id);
  }

  if (Array.isArray(sessionInfo?.waba_ids) && sessionInfo.waba_ids.length > 0) {
    params.set("waba_ids", sessionInfo.waba_ids.join(","));
  }

  if (sessionInfo?.business_id) {
    params.set("business_id", sessionInfo.business_id);
  }

  if (
    Array.isArray(sessionInfo?.catalog_ids) &&
    sessionInfo.catalog_ids.length > 0
  ) {
    params.set("catalog_ids", sessionInfo.catalog_ids.join(","));
  }

  return `/api/sources/whatsapp/callback?${params.toString()}`;
}

export function isSuccessfulEmbeddedSignupEvent(eventName: string) {
  return (
    eventName === "FINISH" ||
    eventName === "FINISH_ONLY_WABA" ||
    eventName === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ||
    eventName === "FINISH_OBO_MIGRATION" ||
    eventName === "FINISH_GRANT_ONLY_API_ACCESS"
  );
}

export function isTrustedEmbeddedSignupMessageOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      (url.hostname === "facebook.com" ||
        url.hostname.endsWith(".facebook.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Why Meta's window closed without a code. Meta reports both an abandoned flow
 * (`current_step`) and a user-reported error (`error_message`) as CANCEL.
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 */
export type EmbeddedSignupExit =
  | { kind: "cancelled"; event: string; currentStep?: string }
  | {
      kind: "error";
      event: string;
      errorMessage?: string;
      errorCode?: string;
      sessionId?: string;
    };

export type EmbeddedSignupMessage =
  | { kind: "finish"; event: string; data?: EmbeddedSignupSessionInfo }
  | EmbeddedSignupExit;

/**
 * A failed attempt. "finished_without_code" means Meta reported a finished
 * flow (its WhatsApp assets may exist) but sent no code; "closed" means Meta
 * sent no code and no session event.
 */
export type EmbeddedSignupFailure =
  | EmbeddedSignupExit
  | {
      kind: "finished_without_code";
      event: string;
      wabaId?: string;
      phoneNumberId?: string;
    }
  | { kind: "closed" };

function readEmbeddedSignupText(value: unknown, maxLength = 120) {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function parseEmbeddedSignupMessage(
  raw: unknown
): EmbeddedSignupMessage | null {
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const { type, event, data } = payload as {
    type?: unknown;
    event?: unknown;
    data?: unknown;
  };
  if (type !== "WA_EMBEDDED_SIGNUP" || typeof event !== "string") return null;

  if (isSuccessfulEmbeddedSignupEvent(event)) {
    return {
      kind: "finish",
      event,
      data: data as EmbeddedSignupSessionInfo | undefined,
    };
  }
  if (event !== "CANCEL" && event !== "ERROR") return null;

  const details =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const errorMessage = readEmbeddedSignupText(details.error_message, 300);
  const errorCode = readEmbeddedSignupText(
    details.error_code ?? details.error_id
  );

  if (event === "ERROR" || errorMessage || errorCode) {
    return {
      kind: "error",
      event,
      errorMessage,
      errorCode,
      sessionId: readEmbeddedSignupText(details.session_id),
    };
  }

  return {
    kind: "cancelled",
    event,
    currentStep: readEmbeddedSignupText(details.current_step),
  };
}

export function getEmbeddedSignupFailureCopy(failure: EmbeddedSignupFailure): {
  title: string;
  description: string;
  values?: Record<string, string>;
} {
  if (failure.kind === "error") {
    return failure.errorMessage
      ? {
          title: "failure.errorTitle",
          description: "failure.errorDescription",
          values: { message: failure.errorMessage },
        }
      : {
          title: "failure.errorTitle",
          description: "failure.errorDescriptionGeneric",
        };
  }

  // Meta's step ids are internal English enums; they go to telemetry only.
  if (failure.kind === "cancelled") {
    return {
      title: "failure.cancelledTitle",
      description: "failure.cancelledDescription",
    };
  }

  if (failure.kind === "finished_without_code") {
    return {
      title: "failure.finishedWithoutCodeTitle",
      description: "failure.finishedWithoutCodeDescription",
    };
  }

  return {
    title: "failure.closedTitle",
    description: "failure.closedDescription",
  };
}

export function buildEmbeddedSignupFailureEventProperties({
  failure,
  flow,
  intent,
  workspaceId,
  loginStatus,
}: {
  failure: EmbeddedSignupFailure;
  flow: EmbeddedSignupFlow;
  intent: "new" | "upgrade";
  workspaceId?: string;
  loginStatus?: string;
}): Record<string, string | undefined> {
  return {
    outcome: failure.kind,
    flow,
    intent,
    workspace_id: workspaceId,
    fb_login_status: readEmbeddedSignupText(loginStatus),
    meta_event: failure.kind === "closed" ? undefined : failure.event,
    current_step:
      failure.kind === "cancelled" ? failure.currentStep : undefined,
    error_code: failure.kind === "error" ? failure.errorCode : undefined,
    error_message: failure.kind === "error" ? failure.errorMessage : undefined,
    meta_session_id: failure.kind === "error" ? failure.sessionId : undefined,
    waba_id:
      failure.kind === "finished_without_code" ? failure.wabaId : undefined,
    phone_number_id:
      failure.kind === "finished_without_code"
        ? failure.phoneNumberId
        : undefined,
  };
}

export function resolveEmbeddedSignupFlowFromEvent(
  eventName?: string
): EmbeddedSignupFlow {
  return eventName === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
    ? "coexistence"
    : "cloud_api";
}

export function resolveEmbeddedSignupConfigId(
  flow: EmbeddedSignupFlow = "cloud_api",
  env: {
    coexistenceConfigId?: string;
    cloudConfigId?: string;
  } = {
    coexistenceConfigId:
      process.env.NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID,
    cloudConfigId: process.env.NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID,
  }
) {
  if (flow === "coexistence") {
    return {
      configId:
        env.coexistenceConfigId?.trim() ||
        WHATSAPP_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID,
      envVarName: "NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID",
    };
  }

  return {
    configId: env.cloudConfigId?.trim() || undefined,
    envVarName: "NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID",
  };
}

export const EMBEDDED_SIGNUP_SESSION_WAIT_TIMEOUT_MS = 5_000;
// Meta posts CANCEL just before its window closes; allow it to arrive after
// the FB.login callback without holding the button for long.
export const EMBEDDED_SIGNUP_EXIT_WAIT_TIMEOUT_MS = 1_500;

function createLatestValueWaiter<T>(defaultTimeoutMs: number) {
  let latest: T | null = null;
  let pendingResolver: ((value: T | null) => void) | null = null;

  return {
    set(value: T) {
      latest = value;
      pendingResolver?.(latest);
      pendingResolver = null;
    },
    peek() {
      return latest;
    },
    wait(timeoutMs = defaultTimeoutMs) {
      if (latest) {
        return Promise.resolve(latest);
      }

      return new Promise<T | null>(resolve => {
        pendingResolver = resolve;
        window.setTimeout(() => {
          if (pendingResolver === resolve) {
            pendingResolver = null;
            resolve(latest);
          }
        }, timeoutMs);
      });
    },
  };
}

export function createEmbeddedSignupSessionWaiter() {
  const waiter = createLatestValueWaiter<EmbeddedSignupSessionResult>(
    EMBEDDED_SIGNUP_SESSION_WAIT_TIMEOUT_MS
  );

  return {
    set(event: string, data?: EmbeddedSignupSessionInfo) {
      waiter.set({ event, data });
    },
    peek: waiter.peek,
    wait: waiter.wait,
  };
}

export function createEmbeddedSignupExitWaiter() {
  return createLatestValueWaiter<EmbeddedSignupExit>(
    EMBEDDED_SIGNUP_EXIT_WAIT_TIMEOUT_MS
  );
}

export interface EmbeddedSignupButtonProps {
  label?: string;
  workspaceId?: string;
  /** Optional business prefill; Meta controls which screens appear in v4. */
  businessName?: string;
  businessEmail?: string;
  businessPhone?: string;
  /**
   * When true, the user is asked to migrate an existing WA Business
   * app number. Set false for pure Cloud API / new-account connections.
   */
  allowBusinessAppMigration?: boolean;
  /**
   * "new" (default) runs a standard Embedded Signup connect flow.
   * "upgrade" forces business app migration and signals the callback to
   * clear coexistence flags so the WABA moves to full Cloud API mode.
   */
  intent?: "new" | "upgrade";
  flow?: EmbeddedSignupFlow;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  disabled?: boolean;
}

export function buildEmbeddedSignupSetupConfig({
  businessName,
  businessEmail,
  businessPhone,
  allowBusinessAppMigration = false,
  intent = "new",
}: Pick<
  EmbeddedSignupButtonProps,
  | "businessName"
  | "businessEmail"
  | "businessPhone"
  | "allowBusinessAppMigration"
  | "intent"
>) {
  const setupConfig: Record<string, unknown> = {};

  if (businessName || businessEmail || businessPhone) {
    setupConfig.business = {
      ...(businessName && { name: businessName }),
      ...(businessEmail && { email: businessEmail }),
      ...(businessPhone && { phone: businessPhone }),
    };
  }

  const shouldAllowMigration =
    intent === "upgrade" ? true : allowBusinessAppMigration;
  if (shouldAllowMigration) {
    setupConfig.allow_business_app_migration = true;
  }

  return setupConfig;
}

export function buildEmbeddedSignupLoginOptions({
  configId,
  flow,
  setup,
}: {
  configId: string;
  flow: EmbeddedSignupFlow;
  setup: Record<string, unknown>;
}): FacebookLoginOptions {
  const resolvedSetup =
    flow === "coexistence"
      ? {
          ...setup,
          allow_business_app_migration: true,
        }
      : setup;

  return {
    config_id: configId,
    auth_type: "rerequest",
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: resolvedSetup,
      // Product selection in Facebook Login for Business enables stable v4,
      // including session logging. Do not override it with a preview version.
      // The coexistence featureType remains supported by v4.
      // @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions
      ...(flow === "coexistence"
        ? { featureType: "whatsapp_business_app_onboarding" as const }
        : {}),
    },
  };
}

export type EmbeddedSignupLaunchErrorCopy = {
  key:
    | "launchErrors.configNotFound"
    | "launchErrors.sdkNotReady"
    | "launchErrors.generic";
  flowLabelKey: "flowLabels.cloud_api" | "flowLabels.coexistence";
};

/** Maps a launch failure to translated copy in the EmbeddedSignupButton namespace. */
export function getEmbeddedSignupLaunchErrorCopy(
  error: unknown,
  flow: EmbeddedSignupFlow
): EmbeddedSignupLaunchErrorCopy {
  const flowLabelKey =
    flow === "cloud_api" ? "flowLabels.cloud_api" : "flowLabels.coexistence";
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;

  if (
    name === "NotFoundError" ||
    /object can not be found/i.test(message) ||
    /object cannot be found/i.test(message)
  ) {
    return { key: "launchErrors.configNotFound", flowLabelKey };
  }

  if (/sdk/i.test(message)) {
    return { key: "launchErrors.sdkNotReady", flowLabelKey };
  }

  return { key: "launchErrors.generic", flowLabelKey };
}

export function EmbeddedSignupButton({
  label,
  workspaceId,
  businessName,
  businessEmail,
  businessPhone,
  allowBusinessAppMigration = false,
  intent = "new",
  flow = "cloud_api",
  variant,
  size,
  className,
  disabled = false,
}: EmbeddedSignupButtonProps) {
  const t = useTranslations("EmbeddedSignupButton");
  const [isLoading, setIsLoading] = useState(false);
  const [sdkReady, setSdkReady] = useState(
    () => typeof window !== "undefined" && Boolean(window.FB)
  );
  const [sdkLoadError, setSdkLoadError] = useState<string | null>(null);
  const launchErrorMessage = (error: unknown) => {
    const copy = getEmbeddedSignupLaunchErrorCopy(error, flow);
    return t(copy.key, { flow: t(copy.flowLabelKey) });
  };

  // Preload even while the button is disabled (for example until the
  // Business app eligibility box is ticked), so the first click opens Meta
  // instead of hitting "still loading". loadFacebookSDK is memoised.
  useEffect(() => {
    const appId = process.env.NEXT_PUBLIC_META_APP_ID;
    const { configId } = resolveEmbeddedSignupConfigId(flow);
    if (!appId || !configId) return;

    let cancelled = false;
    loadFacebookSDK()
      .then(() => {
        if (!cancelled) {
          setSdkReady(true);
          setSdkLoadError(null);
        }
      })
      .catch(error => {
        if (cancelled) return;
        const copy = getEmbeddedSignupLaunchErrorCopy(error, flow);
        setSdkReady(false);
        setSdkLoadError(t(copy.key, { flow: t(copy.flowLabelKey) }));
        console.warn("Facebook SDK preload failed", error);
      });

    return () => {
      cancelled = true;
    };
  }, [flow, t]);

  const handleClick = async () => {
    setIsLoading(true);
    let removeMessageHandler: (() => void) | null = null;

    // Get workspace ID from URL (we're in /panel/w/[workspaceId]/settings/integrations)
    const pathParts = window.location.pathname.split("/");
    const workspaceIdIndex = pathParts.indexOf("w") + 1;
    const currentWorkspaceId = workspaceId || pathParts[workspaceIdIndex];
    const telemetry = {
      flow,
      intent,
      workspace_id: currentWorkspaceId || undefined,
    };
    // Clicks that never reach Meta still need a record.
    const reportLaunchFailure = (outcome: string, error?: unknown) => {
      captureClientEvent("whatsapp_embedded_signup_failed", {
        ...telemetry,
        outcome,
        error_name: error instanceof Error ? error.name : undefined,
      });
    };

    try {
      const appId = process.env.NEXT_PUBLIC_META_APP_ID;
      const { configId, envVarName } = resolveEmbeddedSignupConfigId(flow);

      if (!appId || !configId) {
        reportLaunchFailure("config_missing");
        console.error("Embedded Signup is not configured", {
          missing: appId ? envVarName : "NEXT_PUBLIC_META_APP_ID",
        });
        toast.error(t("launchErrors.configMissing"));
        setIsLoading(false);
        return;
      }

      if (sdkLoadError) {
        reportLaunchFailure("sdk_unavailable");
        toast.error(sdkLoadError);
        setIsLoading(false);
        return;
      }

      const facebookSdk = window.FB;
      if (!facebookSdk || !sdkReady) {
        reportLaunchFailure("sdk_loading");
        void loadFacebookSDK().catch(error => {
          console.warn("Facebook SDK load failed after click", error);
        });
        toast.error(t("sdkLoading"));
        setIsLoading(false);
        return;
      }

      const sessionInfoWaiter = createEmbeddedSignupSessionWaiter();
      const exitWaiter = createEmbeddedSignupExitWaiter();

      // Message event listener for session logging
      const messageHandler = (event: MessageEvent) => {
        if (!isTrustedEmbeddedSignupMessageOrigin(event.origin)) return;

        const message = parseEmbeddedSignupMessage(event.data);
        if (message?.kind === "finish") {
          sessionInfoWaiter.set(message.event, message.data);
        } else if (message) {
          exitWaiter.set(message);
        }
      };

      window.addEventListener("message", messageHandler);
      removeMessageHandler = () => {
        window.removeEventListener("message", messageHandler);
      };

      // Meta rolls out Phone Number First through the configured v4 flow.
      // @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
      const setupConfig = buildEmbeddedSignupSetupConfig({
        businessName,
        businessEmail,
        businessPhone,
        allowBusinessAppMigration,
        intent,
      });

      captureClientEvent("whatsapp_embedded_signup_started", telemetry);

      const handleLoginResponse = async (response: FacebookLoginResponse) => {
        const code = response.authResponse?.code;
        if (code) {
          const sessionResult = await sessionInfoWaiter.wait();
          captureClientEvent("whatsapp_embedded_signup_code_received", {
            ...telemetry,
            meta_event: sessionResult?.event,
          });
          // Redirect to callback with code, embedded flag, and workspace state
          window.location.href = buildEmbeddedSignupCallbackPath({
            code,
            workspaceId: currentWorkspaceId,
            intent,
            flow: resolveEmbeddedSignupFlowFromEvent(sessionResult?.event),
            event: sessionResult?.event,
            sessionInfo: sessionResult?.data,
          });
        } else {
          // A FINISH without a code means Meta may already hold the customer's
          // WhatsApp assets; report it apart from a plain close.
          const exit = sessionInfoWaiter.peek()
            ? null
            : await exitWaiter.wait();
          const finished = sessionInfoWaiter.peek();
          const failure: EmbeddedSignupFailure = finished
            ? {
                kind: "finished_without_code",
                event: finished.event,
                wabaId: readEmbeddedSignupText(finished.data?.waba_id),
                phoneNumberId: readEmbeddedSignupText(
                  finished.data?.phone_number_id
                ),
              }
            : (exit ?? { kind: "closed" });
          captureClientEvent(
            "whatsapp_embedded_signup_failed",
            buildEmbeddedSignupFailureEventProperties({
              failure,
              flow,
              intent,
              workspaceId: telemetry.workspace_id,
              loginStatus: response.status,
            })
          );
          const copy = getEmbeddedSignupFailureCopy(failure);
          toast.error(t(copy.title), {
            description: t(copy.description, copy.values),
            // The recovery steps take longer to read than the default 4 s.
            duration: 10_000,
          });
          setIsLoading(false);
        }

        // Clean up listener
        removeMessageHandler?.();
      };

      facebookSdk.login(
        createFacebookLoginCallback(handleLoginResponse, error => {
          reportLaunchFailure("callback_failed", error);
          removeMessageHandler?.();
          setIsLoading(false);
        }),
        buildEmbeddedSignupLoginOptions({
          configId,
          flow,
          setup: setupConfig,
        })
      );
    } catch (error) {
      removeMessageHandler?.();
      reportLaunchFailure("launch_failed", error);
      console.error("Embedded Signup launch failed", error);
      toast.error(launchErrorMessage(error));
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleClick}
      disabled={isLoading || disabled}
      className={className}
      variant={variant}
      size={size}
    >
      {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {label ?? t("defaultLabel")}
    </Button>
  );
}
