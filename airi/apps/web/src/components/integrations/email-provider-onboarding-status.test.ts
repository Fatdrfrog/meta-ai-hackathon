import {
  deriveEmailProviderOnboardingStatus,
  type EmailProviderOnboardingStatus,
} from "./email-provider-onboarding-status";

const pendingManagedState = {
  domain: "example.com",
  verificationStatus: "pending_dns" as const,
  dkimVerified: false,
  returnPathVerified: false,
  dns: {
    dkimHost: "pm._domainkey.example.com",
    dkimValue: "dkim-value",
    returnPathHost: "pm-bounces.example.com",
    returnPathValue: "pm.mtasv.net",
  },
};

const baseProvider = {
  id: "provider_1",
  verificationStatus: "disconnected" as const,
  status: "inactive" as const,
  mode: "platform_managed" as const,
  defaultFromAddress: "hello@example.com",
  managedState: null,
};

describe("deriveEmailProviderOnboardingStatus", () => {
  it.each([
    {
      name: "disconnected provider",
      input: {
        provider: null,
        emailProviderStatus: "disconnected" as const,
      },
      expected: "not_set_up" as EmailProviderOnboardingStatus,
    },
    {
      name: "setup request in flight",
      input: {
        provider: null,
        emailProviderStatus: "disconnected" as const,
        isSettingUp: true,
      },
      expected: "setting_up" as EmailProviderOnboardingStatus,
    },
    {
      name: "pending domain records",
      input: {
        provider: {
          ...baseProvider,
          verificationStatus: "pending_dns" as const,
          managedState: pendingManagedState,
        },
        emailProviderStatus: "pending_dns" as const,
      },
      expected: "add_domain_records" as EmailProviderOnboardingStatus,
    },
    {
      name: "verification request in flight",
      input: {
        provider: {
          ...baseProvider,
          verificationStatus: "pending_dns" as const,
          managedState: pendingManagedState,
        },
        emailProviderStatus: "pending_dns" as const,
        isChecking: true,
      },
      expected: "checking" as EmailProviderOnboardingStatus,
    },
    {
      name: "verified provider",
      input: {
        provider: {
          ...baseProvider,
          verificationStatus: "verified" as const,
          status: "active" as const,
          managedState: {
            ...pendingManagedState,
            verificationStatus: "verified" as const,
            dkimVerified: true,
            returnPathVerified: true,
          },
        },
        emailProviderStatus: "connected" as const,
      },
      expected: "ready" as EmailProviderOnboardingStatus,
    },
    {
      name: "provider setup error",
      input: {
        provider: {
          ...baseProvider,
          verificationStatus: "error" as const,
          managedState: {
            ...pendingManagedState,
            verificationStatus: "error" as const,
            lastError: "Domain could not be verified",
          },
        },
        emailProviderStatus: "disconnected" as const,
      },
      expected: "error" as EmailProviderOnboardingStatus,
    },
  ])("returns $expected for $name", ({ input, expected }) => {
    expect(deriveEmailProviderOnboardingStatus(input)).toBe(expected);
  });
});
