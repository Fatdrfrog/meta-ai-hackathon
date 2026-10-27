import type { EmailProviderStatus } from "@/types/integrations";

type ProviderVerificationStatus =
  | "disconnected"
  | "pending_dns"
  | "verified"
  | "error";

type ManagedVerificationStatus = "pending_dns" | "verified" | "error";

type EmailProviderOnboardingManagedState = {
  verificationStatus?: ManagedVerificationStatus;
  dns?: {
    dkimHost?: string;
    dkimValue?: string;
    returnPathHost?: string;
    returnPathValue?: string;
  } | null;
  lastError?: string;
} | null;

export type EmailProviderOnboardingProvider = {
  verificationStatus?: ProviderVerificationStatus;
  status?: "active" | "inactive";
  managedState?: EmailProviderOnboardingManagedState;
} | null;

export type EmailProviderOnboardingStatus =
  | "not_set_up"
  | "setting_up"
  | "add_domain_records"
  | "checking"
  | "ready"
  | "error";

export function hasCompleteDomainRecords(
  managedState: EmailProviderOnboardingManagedState | undefined
): boolean {
  const dns = managedState?.dns;
  return Boolean(
    dns?.dkimHost && dns.dkimValue && dns.returnPathHost && dns.returnPathValue
  );
}

export function deriveEmailProviderOnboardingStatus({
  provider,
  emailProviderStatus,
  isSettingUp = false,
  isChecking = false,
}: {
  provider: EmailProviderOnboardingProvider;
  emailProviderStatus: EmailProviderStatus;
  isSettingUp?: boolean;
  isChecking?: boolean;
}): EmailProviderOnboardingStatus {
  if (isSettingUp) return "setting_up";
  if (isChecking) return "checking";

  if (
    provider?.verificationStatus === "verified" ||
    provider?.managedState?.verificationStatus === "verified" ||
    emailProviderStatus === "connected" ||
    provider?.status === "active"
  ) {
    return "ready";
  }

  if (
    provider?.verificationStatus === "error" ||
    provider?.managedState?.verificationStatus === "error"
  ) {
    return "error";
  }

  if (
    provider?.verificationStatus === "pending_dns" ||
    provider?.managedState?.verificationStatus === "pending_dns" ||
    emailProviderStatus === "pending_dns"
  ) {
    return hasCompleteDomainRecords(provider?.managedState)
      ? "add_domain_records"
      : "error";
  }

  return "not_set_up";
}
