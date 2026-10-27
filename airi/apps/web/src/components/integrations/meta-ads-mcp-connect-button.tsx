"use client";

import { Button } from "@/components/ui/button";
import {
  connectMetaAdsMcpViaFacebookSdk,
  type ConnectMetaAdsMcpResult,
} from "@/lib/meta-ads/connect-meta-ads-mcp-client";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";

type MetaAdsMcpConnectButtonProps = {
  workspaceId: string;
  label: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  disabled?: boolean;
  allowCreateGraphSource?: boolean;
  intent?: "reporting" | "ai_ads";
  onPendingChange?: (pending: boolean) => void;
  onConnected?: (
    result: Extract<ConnectMetaAdsMcpResult, { ok: true }>
  ) => void | Promise<void>;
};

const RECOVERABLE_CONNECTION_ERRORS = new Set([
  "server_not_configured",
  "ads_permissions_missing",
  "no_ad_accounts",
  "ad_accounts_unavailable",
  "token_verification_failed",
  "forbidden",
  "unauthorized",
]);

export function MetaAdsMcpConnectButton({
  workspaceId,
  label,
  variant,
  size,
  className,
  disabled = false,
  allowCreateGraphSource = false,
  intent = "ai_ads",
  onPendingChange,
  onConnected,
}: MetaAdsMcpConnectButtonProps) {
  const t = useTranslations("MetaAdsIntegration");
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    if (isLoading || disabled) return;
    setIsLoading(true);
    onPendingChange?.(true);
    try {
      const result = await connectMetaAdsMcpViaFacebookSdk({
        workspaceId,
        allowCreateGraphSource,
        intent,
      });
      if (!result.ok) {
        if (!result.cancelled) {
          toast.error(
            result.errorCode &&
              RECOVERABLE_CONNECTION_ERRORS.has(result.errorCode)
              ? t(`errors.${result.errorCode}.message`)
              : t("experience.connectionFailed")
          );
        }
        return;
      }
      if (!result.reportingReady) {
        toast.warning(t("experience.chooseAccount"));
      } else if (intent === "reporting") {
        toast.success(t("experience.reportingConnected"));
      } else if (result.readiness.canRead) {
        toast.success(
          result.readiness.canWrite
            ? t("mcp.toast.ready")
            : t("mcp.toast.readOnly")
        );
      } else {
        toast.warning(t("mcp.toast.connectedNeedsAction"));
      }
      await onConnected?.(result);
    } catch {
      toast.error(t("experience.connectionFailed"));
    } finally {
      setIsLoading(false);
      onPendingChange?.(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={disabled || isLoading}
      onClick={() => {
        void handleClick();
      }}
    >
      {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      {label}
    </Button>
  );
}
