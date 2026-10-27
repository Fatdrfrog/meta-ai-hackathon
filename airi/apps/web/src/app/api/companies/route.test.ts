const mockAuthGetUser = jest.fn();
const mockAuthUpdateUser = jest.fn();
const mockCreateClient = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
const mockTrackUserRegistration = jest.fn();
const mockTrackWorkspaceCreated = jest.fn();
const mockSetCompanyProperties = jest.fn();
const mockFlushServerPostHog = jest.fn();
const mockUsersUpsert = jest.fn();
const mockOnboardingProgressUpsert = jest.fn();
const mockSourcesDelete = jest.fn();
const mockSourcesDeleteEq = jest.fn();
const mockCompaniesUpdate = jest.fn();
const mockCompaniesUpdateEq = jest.fn();
const mockSendRegistrationFollowUpEmail = jest.fn();
const mockGetWorkspaceEmailAutomationSettings = jest.fn();
const mockNormalizeRegistrationPhone = jest.fn();
const mockUpsertRegisteredBusinessPhoneContact = jest.fn();
const mockEnsureNewWorkspaceAiriDefaults = jest.fn();

const AIRI_WORKSPACE_ID = "41b51d55-697c-4455-875a-9a7238bdf272";

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  ensureNewWorkspaceAiriDefaults: (...args: unknown[]) =>
    mockEnsureNewWorkspaceAiriDefaults(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}));

jest.mock("@/lib/analytics", () => ({
  trackUserRegistration: (...args: unknown[]) =>
    mockTrackUserRegistration(...args),
  trackWorkspaceCreated: (...args: unknown[]) =>
    mockTrackWorkspaceCreated(...args),
  setCompanyProperties: (...args: unknown[]) =>
    mockSetCompanyProperties(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  flushServerPostHog: (...args: unknown[]) => mockFlushServerPostHog(...args),
}));

jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: async () => "granted",
}));

jest.mock("@/lib/email/registration-follow-up", () => ({
  sendRegistrationFollowUpEmail: (...args: unknown[]) =>
    mockSendRegistrationFollowUpEmail(...args),
}));

jest.mock("@/lib/email/email-automation-settings", () => ({
  getWorkspaceEmailAutomationSettings: (...args: unknown[]) =>
    mockGetWorkspaceEmailAutomationSettings(...args),
}));

jest.mock("@/lib/customers/registration-contact", () => ({
  normalizeRegistrationPhone: (...args: unknown[]) =>
    mockNormalizeRegistrationPhone(...args),
  upsertRegisteredBusinessPhoneContact: (...args: unknown[]) =>
    mockUpsertRegisteredBusinessPhoneContact(...args),
}));

import { POST } from "./route";

function postCompany(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

function signInFounder(
  userMetadata: Record<string, unknown> = { full_name: "Founder" }
) {
  mockAuthGetUser.mockResolvedValue({
    data: {
      user: {
        id: "user-1",
        email: "founder@example.com",
        user_metadata: userMetadata,
      },
    },
  });
}

/** create_signup_workspace returns one row; by default a new workspace. */
function mockSignupRpc(row: Record<string, unknown> = {}) {
  mockSupabaseRpc.mockResolvedValue({
    data: [
      {
        company_id: "company-1",
        workspace_id: "workspace-1",
        source_id: null,
        workspace_name: "Acme Support",
        created: true,
        ...row,
      },
    ],
    error: null,
  });
}

describe("POST /api/companies", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: mockAuthGetUser,
        updateUser: mockAuthUpdateUser.mockResolvedValue({ error: null }),
      },
    });

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "users") {
        return {
          upsert: mockUsersUpsert.mockResolvedValue({ error: null }),
        };
      }

      if (table === "sources") {
        const deleteQuery = { eq: mockSourcesDeleteEq, error: null };
        mockSourcesDeleteEq.mockReturnValue(deleteQuery);

        return {
          delete: mockSourcesDelete.mockReturnValue(deleteQuery),
        };
      }

      if (table === "companies") {
        return {
          update: mockCompaniesUpdate.mockReturnValue({
            eq: mockCompaniesUpdateEq.mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "workspace_onboarding_progress") {
        return {
          upsert: mockOnboardingProgressUpsert.mockResolvedValue({
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    mockFlushServerPostHog.mockResolvedValue(undefined);
    mockSendRegistrationFollowUpEmail.mockResolvedValue({
      ok: true,
      providerMessageId: "pm-message-1",
    });
    mockGetWorkspaceEmailAutomationSettings.mockResolvedValue({
      workspaceId: AIRI_WORKSPACE_ID,
      registrationFollowUpEnabled: true,
      registrationFollowUpTemplate: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}",
      },
      updatedAt: null,
      updatedBy: null,
    });
    mockNormalizeRegistrationPhone.mockImplementation((value: unknown) => {
      if (typeof value !== "string") return null;
      if (/[A-Za-z]/.test(value)) return null;
      const digits = value.replace(/\D+/g, "");
      return digits.length >= 6 ? digits : null;
    });
    mockUpsertRegisteredBusinessPhoneContact.mockResolvedValue({
      status: "created",
      customerId: "customer-1",
      phone: "77012345678",
    });
    mockEnsureNewWorkspaceAiriDefaults.mockResolvedValue(undefined);
  });

  it("creates a signup workspace and tracks analytics when the rpc creates a new workspace", async () => {
    signInFounder();

    mockSignupRpc({
      source_id: "source-1",
      workspace_name: "Общественный Фонд Ержана Татишева",
    });

    const response = await postCompany({
      name: "  Общественный   Фонд Ержана Татишева  ",
      business_context: "  Помогаем семьям  ",
      dynamic_context_tags: [" дети ", "", "образование"],
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: "Company and workspace created successfully!",
      workspaceId: "workspace-1",
      companyId: "company-1",
      deduplicated: false,
    });

    expect(mockSupabaseRpc).toHaveBeenCalledWith("create_signup_workspace", {
      input_user_id: "user-1",
      input_user_email: "founder@example.com",
      input_workspace_name: "Общественный Фонд Ержана Татишева",
      input_business_context: "Помогаем семьям",
      input_dynamic_context_tags: ["дети", "образование"],
      input_source_type: "telegram",
    });
    expect(mockEnsureNewWorkspaceAiriDefaults).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      updatedBy: "user-1",
    });
    expect(mockSourcesDelete).toHaveBeenCalledTimes(1);
    expect(mockSourcesDeleteEq).toHaveBeenNthCalledWith(1, "id", "source-1");
    expect(mockSourcesDeleteEq).toHaveBeenNthCalledWith(
      2,
      "workspace_id",
      "workspace-1"
    );
    expect(mockSourcesDeleteEq).toHaveBeenNthCalledWith(3, "type", "telegram");
    expect(mockUsersUpsert).toHaveBeenCalledWith(
      {
        id: "user-1",
        full_name: "Founder",
        avatar_url: null,
      },
      { onConflict: "id" }
    );
    expect(mockTrackUserRegistration).toHaveBeenCalledWith(
      "user-1",
      "company-1",
      "workspace-1",
      "admin",
      "self_signup",
      "founder@example.com",
      "Founder",
      { consent: "granted" }
    );
    expect(mockTrackUserRegistration).toHaveBeenCalledTimes(1);
    expect(mockTrackWorkspaceCreated).toHaveBeenCalledWith(
      "company-1",
      "workspace-1",
      "Общественный Фонд Ержана Татишева",
      "user-1",
      { consent: "granted" }
    );
    expect(mockSetCompanyProperties).toHaveBeenCalledWith("company-1", {
      company_name: "Общественный Фонд Ержана Татишева",
      business_context: "Помогаем семьям",
      dynamic_context_tags: ["дети", "образование"],
    });
    expect(mockGetWorkspaceEmailAutomationSettings).toHaveBeenCalledWith(
      AIRI_WORKSPACE_ID
    );
    expect(mockSendRegistrationFollowUpEmail).toHaveBeenCalledWith({
      userId: "user-1",
      userEmail: "founder@example.com",
      userName: "Founder",
      companyId: "company-1",
      workspaceId: "workspace-1",
      senderWorkspaceId: AIRI_WORKSPACE_ID,
      workspaceName: expect.any(String),
      template: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}",
      },
    });
    expect(mockFlushServerPostHog).toHaveBeenCalledTimes(1);
  });

  it("skips the registration follow-up when workspace automation disables it", async () => {
    signInFounder();
    mockGetWorkspaceEmailAutomationSettings.mockResolvedValue({
      workspaceId: AIRI_WORKSPACE_ID,
      registrationFollowUpEnabled: false,
      registrationFollowUpTemplate: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}",
      },
      updatedAt: null,
      updatedBy: null,
    });
    mockSignupRpc();

    const response = await postCompany({
      name: "Acme Support",
      business_context: "Support team",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    expect(mockGetWorkspaceEmailAutomationSettings).toHaveBeenCalledWith(
      AIRI_WORKSPACE_ID
    );
    expect(mockSendRegistrationFollowUpEmail).not.toHaveBeenCalled();
  });

  it("stores an optional signup phone in the Airi hidden WhatsApp contacts list", async () => {
    signInFounder();
    mockSignupRpc();

    const response = await postCompany({
      name: "Acme Support",
      phone: "+7 (701) 234-56-78",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    expect(mockNormalizeRegistrationPhone).toHaveBeenCalledWith(
      "+7 (701) 234-56-78"
    );
    expect(mockUpsertRegisteredBusinessPhoneContact).toHaveBeenCalledWith({
      senderWorkspaceId: AIRI_WORKSPACE_ID,
      registeredCompanyId: "company-1",
      registeredWorkspaceId: "workspace-1",
      registeredWorkspaceName: "Acme Support",
      userId: "user-1",
      userEmail: "founder@example.com",
      userName: "Founder",
      phone: "77012345678",
    });
  });

  it("saves the signup phone as the user's WhatsApp test number", async () => {
    signInFounder();
    mockSignupRpc();

    const response = await postCompany({
      name: "Acme Support",
      phone: "+7 (701) 234-56-78",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    expect(mockAuthUpdateUser).toHaveBeenCalledWith({
      data: { whatsapp_test_phone: "77012345678" },
    });
  });

  it("creates the workspace when the test number can't be saved", async () => {
    signInFounder();
    mockSignupRpc();
    mockAuthUpdateUser.mockRejectedValue(new Error("auth down"));

    const response = await postCompany({
      name: "Acme Support",
      phone: "+7 (701) 234-56-78",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
  });

  it("saves no test number without a signup phone", async () => {
    signInFounder();
    mockSignupRpc();

    await postCompany({ name: "Acme Support", accepted_privacy: true });

    expect(mockAuthUpdateUser).not.toHaveBeenCalled();
  });

  it("stores an optional signup referral source on the company row", async () => {
    signInFounder();
    mockSignupRpc();

    const response = await postCompany({
      name: "Acme Support",
      signup_referral_source: "  Product   Hunt  ",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    expect(mockCompaniesUpdate).toHaveBeenCalledWith({
      signup_referral_source: "Product Hunt",
    });
    expect(mockCompaniesUpdateEq).toHaveBeenCalledWith("id", "company-1");
    expect(mockSetCompanyProperties).toHaveBeenCalledWith("company-1", {
      company_name: "Acme Support",
      business_context: "Acme Support",
      dynamic_context_tags: undefined,
      signup_referral_source: "Product Hunt",
    });
  });

  it("rejects a non-empty invalid optional signup phone before creating the workspace", async () => {
    signInFounder();

    const response = await postCompany({
      name: "Acme Support",
      phone: "not a phone",
      accepted_privacy: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Phone number is invalid",
    });
    expect(mockSupabaseRpc).not.toHaveBeenCalled();
    expect(mockUpsertRegisteredBusinessPhoneContact).not.toHaveBeenCalled();
  });

  it("keeps signup successful when optional phone contact persistence fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    signInFounder();
    mockSignupRpc();
    mockUpsertRegisteredBusinessPhoneContact.mockRejectedValue(
      new Error("mongo unavailable")
    );

    try {
      const response = await postCompany({
        name: "Acme Support",
        phone: "+7 (701) 234-56-78",
        accepted_privacy: true,
      });

      expect(response.status).toBe(200);
      expect(mockFlushServerPostHog).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps signup successful when registration follow-up settings fail to load", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    signInFounder();
    mockGetWorkspaceEmailAutomationSettings.mockRejectedValue(
      new Error("mongo unavailable")
    );
    mockSignupRpc();

    try {
      const response = await postCompany({
        name: "Acme Support",
        business_context: "Support team",
        accepted_privacy: true,
      });

      expect(response.status).toBe(200);
      expect(mockSendRegistrationFollowUpEmail).not.toHaveBeenCalled();
      expect(mockFlushServerPostHog).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns an existing member's workspace without changing its referral or tracking duplicate analytics", async () => {
    signInFounder({ name: "Founder" });

    mockSignupRpc({
      source_id: "source-1",
      workspace_name: "Общественный Фонд Ержана Татишева",
      created: false,
    });

    const response = await postCompany({
      name: "Общественный Фонд Ержана Татишева",
      business_context: "Помогаем семьям",
      signup_referral_source: "Attempted referral overwrite",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: "Existing workspace returned successfully.",
      workspaceId: "workspace-1",
      companyId: "company-1",
      deduplicated: true,
    });

    expect(mockSourcesDelete).not.toHaveBeenCalled();
    expect(mockCompaniesUpdate).not.toHaveBeenCalled();
    expect(mockEnsureNewWorkspaceAiriDefaults).not.toHaveBeenCalled();
    expect(mockTrackUserRegistration).not.toHaveBeenCalled();
    expect(mockTrackWorkspaceCreated).not.toHaveBeenCalled();
    expect(mockSetCompanyProperties).not.toHaveBeenCalled();
    expect(mockSendRegistrationFollowUpEmail).not.toHaveBeenCalled();
    expect(mockFlushServerPostHog).not.toHaveBeenCalled();
  });

  it("creates a workspace with company name only and falls back business context to the name", async () => {
    signInFounder({ name: "Founder" });

    mockSignupRpc({ source_id: "source-1" });

    const response = await postCompany({
      name: "Acme Support",
      accepted_privacy: true,
    });

    expect(response.status).toBe(200);
    expect(mockSupabaseRpc).toHaveBeenCalledWith("create_signup_workspace", {
      input_user_id: "user-1",
      input_user_email: "founder@example.com",
      input_workspace_name: "Acme Support",
      input_business_context: "Acme Support",
      input_dynamic_context_tags: null,
      input_source_type: "telegram",
    });
  });

  it("rejects direct company creation when privacy is not accepted", async () => {
    signInFounder({ name: "Founder" });

    const response = await postCompany({ name: "Acme Support" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Privacy Policy must be accepted to proceed",
    });
    expect(mockSupabaseRpc).not.toHaveBeenCalled();
  });

  it("rejects malformed request fields before creating the workspace", async () => {
    signInFounder({ name: "Founder" });

    const response = await postCompany({
      name: "Acme Support",
      dynamic_context_tags: [123],
      accepted_privacy: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid company data",
    });
    expect(mockSupabaseRpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Supabase failure",
      failure: {
        code: "XX000",
        message: "connection string contains super-secret-password",
        details: "private database host",
      },
    },
    {
      label: "general failure",
      failure: new Error("internal token is super-secret-token"),
    },
  ])("returns a stable safe 500 for a $label", async ({ failure }) => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    signInFounder({ name: "Founder" });
    mockSupabaseRpc.mockImplementation(async () => {
      if (failure instanceof Error) throw failure;
      return { data: null, error: failure };
    });

    try {
      const response = await postCompany({
        name: "Acme Support",
        accepted_privacy: true,
      });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: "Unable to create company. Please try again.",
        code: "company_creation_failed",
      });
      expect(JSON.stringify(body)).not.toContain("super-secret");
      expect(JSON.stringify(body)).not.toContain("private database host");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanitizes database-raised validation text", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    signInFounder({ name: "Founder" });
    mockSupabaseRpc.mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "policy rejected secret tenant details",
      },
    });

    try {
      const response = await postCompany({
        name: "Acme Support",
        accepted_privacy: true,
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: "Invalid company data" });
      expect(JSON.stringify(body)).not.toContain("secret tenant details");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
