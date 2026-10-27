import {
  buildEmbeddedSignupCallbackPath,
  buildEmbeddedSignupFailureEventProperties,
  buildEmbeddedSignupLoginOptions,
  buildEmbeddedSignupSetupConfig,
  createEmbeddedSignupExitWaiter,
  createEmbeddedSignupSessionWaiter,
  getEmbeddedSignupFailureCopy,
  getEmbeddedSignupLaunchErrorCopy,
  resolveEmbeddedSignupConfigId,
  resolveEmbeddedSignupFlowFromEvent,
  isTrustedEmbeddedSignupMessageOrigin,
  isSuccessfulEmbeddedSignupEvent,
  parseEmbeddedSignupMessage,
  WHATSAPP_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID,
} from "./embedded-signup-button";

describe("buildEmbeddedSignupCallbackPath", () => {
  it("forwards Embedded Signup session asset IDs to the server callback", () => {
    const path = buildEmbeddedSignupCallbackPath({
      code: "code-1",
      workspaceId: "workspace-1",
      sessionInfo: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        messaging_account_id: "messaging-1",
        waac_id: "waac-1",
        cs_id: "cs-1",
        business_id: "business-1",
        catalog_ids: ["catalog-1", "catalog-2"],
      },
    });

    const url = new URL(path, "http://localhost");

    expect(url.pathname).toBe("/api/sources/whatsapp/callback");
    expect(url.searchParams.get("code")).toBe("code-1");
    expect(url.searchParams.get("state")).toBe("workspace-1");
    expect(url.searchParams.get("phone_number_id")).toBe("phone-1");
    expect(url.searchParams.get("waba_id")).toBe("waba-1");
    expect(url.searchParams.get("messaging_account_id")).toBe("messaging-1");
    expect(url.searchParams.get("waac_id")).toBe("waac-1");
    expect(url.searchParams.get("cs_id")).toBe("cs-1");
    expect(url.searchParams.has("paid_messaging_account_id")).toBe(false);
    expect(url.searchParams.get("business_id")).toBe("business-1");
    expect(url.searchParams.get("catalog_ids")).toBe("catalog-1,catalog-2");
  });

  it("marks WhatsApp Business app onboarding callbacks as coexistence", () => {
    const path = buildEmbeddedSignupCallbackPath({
      code: "code-1",
      workspaceId: "workspace-1",
      flow: "coexistence",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      sessionInfo: {
        waba_id: "waba-1",
      },
    });

    const url = new URL(path, "http://localhost");

    expect(url.searchParams.get("flow")).toBe("coexistence");
    expect(url.searchParams.get("event")).toBe(
      "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
    );
  });

  it("forwards multi-WABA session IDs returned by Meta grant-only signup", () => {
    const path = buildEmbeddedSignupCallbackPath({
      code: "code-1",
      workspaceId: "workspace-1",
      event: "FINISH_GRANT_ONLY_API_ACCESS",
      sessionInfo: {
        waba_ids: ["waba-1", "waba-2"],
      },
    });

    const url = new URL(path, "http://localhost");

    expect(url.searchParams.get("event")).toBe("FINISH_GRANT_ONLY_API_ACCESS");
    expect(url.searchParams.get("waba_ids")).toBe("waba-1,waba-2");
  });
});

describe("resolveEmbeddedSignupConfigId", () => {
  it("uses the full Cloud API config for Cloud API Embedded Signup", () => {
    expect(
      resolveEmbeddedSignupConfigId("cloud_api", {
        coexistenceConfigId: "coexistence-config",
        cloudConfigId: "cloud-config",
      })
    ).toEqual({
      configId: "cloud-config",
      envVarName: "NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID",
    });
  });

  it("uses the dedicated coexistence config for coexistence Embedded Signup", () => {
    expect(
      resolveEmbeddedSignupConfigId("coexistence", {
        coexistenceConfigId: "coexistence-config",
        cloudConfigId: "cloud-config",
      })
    ).toEqual({
      configId: "coexistence-config",
      envVarName: "NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID",
    });
  });

  it("falls back to the airi.chat coexistence config when no env override is set", () => {
    expect(
      resolveEmbeddedSignupConfigId("coexistence", {
        cloudConfigId: "cloud-config",
      })
    ).toEqual({
      configId: WHATSAPP_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID,
      envVarName: "NEXT_PUBLIC_META_COEXISTENCE_EMBEDDED_SIGNUP_CONFIG_ID",
    });
  });
});

describe("isSuccessfulEmbeddedSignupEvent", () => {
  it("accepts every Meta documented successful signup finish event", () => {
    expect(isSuccessfulEmbeddedSignupEvent("FINISH")).toBe(true);
    expect(isSuccessfulEmbeddedSignupEvent("FINISH_ONLY_WABA")).toBe(true);
    expect(
      isSuccessfulEmbeddedSignupEvent("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING")
    ).toBe(true);
    expect(isSuccessfulEmbeddedSignupEvent("FINISH_OBO_MIGRATION")).toBe(true);
    expect(
      isSuccessfulEmbeddedSignupEvent("FINISH_GRANT_ONLY_API_ACCESS")
    ).toBe(true);
  });
});

describe("isTrustedEmbeddedSignupMessageOrigin", () => {
  it("accepts Meta Facebook subdomains and rejects lookalikes", () => {
    expect(
      isTrustedEmbeddedSignupMessageOrigin("https://www.facebook.com")
    ).toBe(true);
    expect(
      isTrustedEmbeddedSignupMessageOrigin("https://web.facebook.com")
    ).toBe(true);
    expect(
      isTrustedEmbeddedSignupMessageOrigin("https://business.facebook.com")
    ).toBe(true);
    expect(isTrustedEmbeddedSignupMessageOrigin("http://facebook.com")).toBe(
      false
    );
    expect(
      isTrustedEmbeddedSignupMessageOrigin("https://evilfacebook.com")
    ).toBe(false);
    expect(
      isTrustedEmbeddedSignupMessageOrigin("https://www.facebook.com.evil.test")
    ).toBe(false);
  });
});

describe("buildEmbeddedSignupSetupConfig", () => {
  it("does not enable WhatsApp Business app migration by default for Cloud API signup", () => {
    expect(buildEmbeddedSignupSetupConfig({})).not.toHaveProperty(
      "allow_business_app_migration"
    );
  });

  it("enables WhatsApp Business app migration for explicit upgrade flows", () => {
    expect(
      buildEmbeddedSignupSetupConfig({
        allowBusinessAppMigration: false,
        intent: "upgrade",
      })
    ).toMatchObject({
      allow_business_app_migration: true,
    });
  });
});

describe("buildEmbeddedSignupLoginOptions", () => {
  it("uses the product-configured v4 flow without preview or session-version overrides", () => {
    expect(
      buildEmbeddedSignupLoginOptions({
        configId: "cloud-config",
        flow: "cloud_api",
        setup: {},
      })
    ).toStrictEqual({
      config_id: "cloud-config",
      auth_type: "rerequest",
      response_type: "code",
      override_default_response_type: true,
      extras: {
        setup: {},
      },
    });
  });

  it("keeps business prefill and the supported coexistence feature on stable v4", () => {
    expect(
      buildEmbeddedSignupLoginOptions({
        configId: "coexistence-config",
        flow: "coexistence",
        setup: {
          business: {
            name: "Example Co",
          },
        },
      })
    ).toStrictEqual({
      config_id: "coexistence-config",
      auth_type: "rerequest",
      response_type: "code",
      override_default_response_type: true,
      extras: {
        setup: {
          allow_business_app_migration: true,
          business: {
            name: "Example Co",
          },
        },
        featureType: "whatsapp_business_app_onboarding",
      },
    });
  });
});

describe("resolveEmbeddedSignupFlowFromEvent", () => {
  it("uses Meta's finish event when phone-first signup automatically selects coexistence", () => {
    const event = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
    const path = buildEmbeddedSignupCallbackPath({
      code: "code-1",
      workspaceId: "workspace-1",
      flow: resolveEmbeddedSignupFlowFromEvent(event),
      event,
      sessionInfo: { waba_id: "waba-1", phone_number_id: "phone-1" },
    });

    const url = new URL(path, "http://localhost");
    expect(url.searchParams.get("flow")).toBe("coexistence");
    expect(url.searchParams.get("waba_id")).toBe("waba-1");
    expect(url.searchParams.get("phone_number_id")).toBe("phone-1");
  });

  it("keeps the default finish event on Cloud API", () => {
    expect(resolveEmbeddedSignupFlowFromEvent("FINISH")).toBe("cloud_api");
  });
});

describe("getEmbeddedSignupLaunchErrorCopy", () => {
  it("maps Meta's opaque NotFoundError to the configuration copy", () => {
    const error = new DOMException(
      "The object can not be found here.",
      "NotFoundError"
    );

    expect(getEmbeddedSignupLaunchErrorCopy(error, "cloud_api")).toEqual({
      key: "launchErrors.configNotFound",
      flowLabelKey: "flowLabels.cloud_api",
    });
  });

  it("maps SDK failures and anything else", () => {
    expect(
      getEmbeddedSignupLaunchErrorCopy(
        new Error("Facebook SDK script failed"),
        "coexistence"
      )
    ).toEqual({
      key: "launchErrors.sdkNotReady",
      flowLabelKey: "flowLabels.coexistence",
    });
    expect(
      getEmbeddedSignupLaunchErrorCopy(new Error("boom"), "cloud_api").key
    ).toBe("launchErrors.generic");
  });
});

describe("createEmbeddedSignupSessionWaiter", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout,
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("keeps waiting long enough for Meta session logging to return asset IDs", async () => {
    const waiter = createEmbeddedSignupSessionWaiter();
    let resolved:
      | Awaited<
          ReturnType<
            ReturnType<typeof createEmbeddedSignupSessionWaiter>["wait"]
          >
        >
      | "pending" = "pending";

    const promise = waiter.wait().then(result => {
      resolved = result;
      return result;
    });

    jest.advanceTimersByTime(4_999);
    await Promise.resolve();

    expect(resolved).toBe("pending");

    waiter.set("FINISH", {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
    });

    await expect(promise).resolves.toEqual({
      event: "FINISH",
      data: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
      },
    });
  });
});

describe("parseEmbeddedSignupMessage", () => {
  it("returns successful finish events with their session assets", () => {
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { waba_id: "waba-1", phone_number_id: "phone-1" },
        })
      )
    ).toEqual({
      kind: "finish",
      event: "FINISH",
      data: { waba_id: "waba-1", phone_number_id: "phone-1" },
    });
  });

  it("keeps the screen where the customer abandoned Meta's flow", () => {
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "CANCEL",
          data: { current_step: "PHONE_NUMBER_SETUP" },
        })
      )
    ).toEqual({
      kind: "cancelled",
      event: "CANCEL",
      currentStep: "PHONE_NUMBER_SETUP",
    });
  });

  it("reads a user-reported error that Meta also sends as CANCEL", () => {
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "CANCEL",
          data: {
            error_message: "Your verified name violates WhatsApp guidelines.",
            error_code: 524126,
            session_id: "f34b51dab5e0498",
            timestamp: "1746041036",
          },
        })
      )
    ).toEqual({
      kind: "error",
      event: "CANCEL",
      errorMessage: "Your verified name violates WhatsApp guidelines.",
      errorCode: "524126",
      sessionId: "f34b51dab5e0498",
    });
  });

  it("accepts the older error_id field and bounds long Meta text", () => {
    const parsed = parseEmbeddedSignupMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      data: { error_id: "4242", error_message: "x".repeat(500) },
    });

    expect(parsed).toMatchObject({ kind: "error", errorCode: "4242" });
    const errorMessage =
      parsed?.kind === "error" ? parsed.errorMessage : undefined;
    expect(errorMessage).toHaveLength(300);
    expect(errorMessage?.endsWith("…")).toBe(true);
  });

  it("treats Meta's ERROR event as an error even without details", () => {
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR" })
      )
    ).toEqual({ kind: "error", event: "ERROR" });
  });

  it("ignores other message types, unknown events and non-JSON payloads", () => {
    expect(parseEmbeddedSignupMessage("not json")).toBeNull();
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({ type: "OTHER", event: "CANCEL" })
      )
    ).toBeNull();
    expect(
      parseEmbeddedSignupMessage(
        JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "PROGRESS" })
      )
    ).toBeNull();
  });
});

describe("getEmbeddedSignupFailureCopy", () => {
  it("shows Meta's own error text when Meta reports one", () => {
    expect(
      getEmbeddedSignupFailureCopy({
        kind: "error",
        event: "CANCEL",
        errorMessage: "Display name rejected.",
      })
    ).toEqual({
      title: "failure.errorTitle",
      description: "failure.errorDescription",
      values: { message: "Display name rejected." },
    });
  });

  it("keeps Meta's internal step id out of the customer copy", () => {
    expect(
      getEmbeddedSignupFailureCopy({
        kind: "cancelled",
        event: "CANCEL",
        currentStep: "BUSINESS_ACCOUNT_SELECTION",
      })
    ).toEqual({
      title: "failure.cancelledTitle",
      description: "failure.cancelledDescription",
    });
  });

  it("explains a finished Meta flow that sent airi.chat no code", () => {
    expect(
      getEmbeddedSignupFailureCopy({
        kind: "finished_without_code",
        event: "FINISH",
        wabaId: "waba-1",
      })
    ).toEqual({
      title: "failure.finishedWithoutCodeTitle",
      description: "failure.finishedWithoutCodeDescription",
    });
  });

  it("explains a window that closed without any Meta event", () => {
    expect(getEmbeddedSignupFailureCopy({ kind: "closed" })).toEqual({
      title: "failure.closedTitle",
      description: "failure.closedDescription",
    });
  });
});

describe("buildEmbeddedSignupFailureEventProperties", () => {
  it("reports why signup failed with Meta's identifiers for support", () => {
    expect(
      buildEmbeddedSignupFailureEventProperties({
        failure: {
          kind: "error",
          event: "CANCEL",
          errorMessage: "Display name rejected.",
          errorCode: "524126",
          sessionId: "session-1",
        },
        flow: "coexistence",
        intent: "new",
        workspaceId: "workspace-1",
        loginStatus: "unknown",
      })
    ).toEqual({
      outcome: "error",
      flow: "coexistence",
      intent: "new",
      workspace_id: "workspace-1",
      fb_login_status: "unknown",
      meta_event: "CANCEL",
      current_step: undefined,
      error_code: "524126",
      error_message: "Display name rejected.",
      meta_session_id: "session-1",
    });
  });

  it("marks a window that closed without a code or Meta event", () => {
    expect(
      buildEmbeddedSignupFailureEventProperties({
        failure: { kind: "closed" },
        flow: "cloud_api",
        intent: "upgrade",
      })
    ).toMatchObject({
      outcome: "closed",
      flow: "cloud_api",
      intent: "upgrade",
      meta_event: undefined,
    });
  });
});

describe("buildEmbeddedSignupFailureEventProperties for finished flows", () => {
  it("keeps the WhatsApp asset ids Meta reported before the code went missing", () => {
    expect(
      buildEmbeddedSignupFailureEventProperties({
        failure: {
          kind: "finished_without_code",
          event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          wabaId: "waba-1",
          phoneNumberId: "phone-1",
        },
        flow: "coexistence",
        intent: "new",
        workspaceId: "workspace-1",
        loginStatus: "unknown",
      })
    ).toMatchObject({
      outcome: "finished_without_code",
      meta_event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
    });
  });
});

describe("createEmbeddedSignupExitWaiter", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout,
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("picks up a CANCEL that Meta posts just after the login callback", async () => {
    const waiter = createEmbeddedSignupExitWaiter();
    const promise = waiter.wait();

    jest.advanceTimersByTime(1_000);
    waiter.set({ kind: "cancelled", event: "CANCEL", currentStep: "STEP" });

    await expect(promise).resolves.toEqual({
      kind: "cancelled",
      event: "CANCEL",
      currentStep: "STEP",
    });
  });

  it("gives up quickly when Meta sends no session event", async () => {
    const waiter = createEmbeddedSignupExitWaiter();
    const promise = waiter.wait();

    jest.advanceTimersByTime(1_500);

    await expect(promise).resolves.toBeNull();
  });
});
