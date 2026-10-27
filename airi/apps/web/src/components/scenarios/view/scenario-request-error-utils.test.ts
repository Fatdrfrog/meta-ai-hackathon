import fs from "node:fs";
import path from "node:path";
import { ScenarioRequestError } from "@/lib/scenarios/client";
import {
  getScenarioRequestErrorBlockNodeIds,
  getScenarioRequestErrorCode,
  resolveScenarioRequestErrorCodeMessage,
  resolveScenarioRequestErrorMessage,
  translateScenarioErrorCode,
} from "./scenario-request-error-utils";

const LOCALES = ["en", "ru", "kz"] as const;

function loadScenariosMessages(
  locale: (typeof LOCALES)[number]
): Record<string, string> {
  const filePath = path.join(
    process.cwd(),
    "messages",
    "scenarios",
    locale,
    "page.json"
  );
  return (
    JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      Scenarios: Record<string, string>;
    }
  ).Scenarios;
}

const t = (key: string) =>
  ({
    condition_branch_requires_action_source:
      "Post-action condition nodes must be connected directly after one action node.",
    whatsappContactIncomplete:
      "Add a WhatsApp contact name before activating this scenario.",
    whatsappLocationIncomplete:
      "Add valid WhatsApp location coordinates before activating this scenario.",
    whatsappServiceMessageInvalid:
      "Complete the WhatsApp service message before activating this scenario.",
    whatsappTemplateRequired: "Select a WhatsApp template.",
    whatsappTemplateBindingsInvalid: "Complete the template message values.",
    whatsappTemplateBindingsRequireConversation:
      "Use recipient column mappings for the primary campaign message.",
    handoffNotificationInvalid:
      "Complete or clear the handoff notification target.",
    messageTriggerIncomplete: "Complete the trigger's message filter.",
    businessEventIntegrationPending:
      "Connect event execution before activating this scenario.",
    actionTypeInvalid:
      "Choose a supported action type before activating this scenario.",
    mixed_action_outcome_ownership:
      "Move legacy routing before adding outcomes.",
    saveFailed: "Failed to save scenario",
  })[key] || key;

describe("resolveScenarioRequestErrorMessage", () => {
  it.each([
    "whatsappTemplateRequired",
    "whatsappTemplateBindingsInvalid",
    "whatsappTemplateBindingsRequireConversation",
    "messageTriggerIncomplete",
    "businessEventIntegrationPending",
    "handoffNotificationInvalid",
    "generativeAIPromptInputUnavailable",
    "generativeAIPickedCardImageInvalid",
    "formAnswerUnavailable",
    "formAnswersKeyDuplicate",
    "whatsappTemplateFormRouteUnavailable",
    "whatsappTemplateFormRouteConditionTarget",
    "whatsappTemplateFormRouteInBulk",
  ])("translates runnable validation error %s", code => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code,
    });
    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t(code)
    );
  });
  it("prefers known translated scenario error codes", () => {
    const error = new ScenarioRequestError({
      message: "Linked branch is invalid",
      status: 400,
      code: "condition_branch_requires_action_source",
      codes: ["condition_branch_requires_action_source"],
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("condition_branch_requires_action_source")
    );
  });

  it("hides raw server text for unknown codes", () => {
    const error = new ScenarioRequestError({
      message: "Scenario 507f1f77bcf86cd799439011 failed on node abc-123",
      status: 409,
      code: "custom_code",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("saveFailed")
    );
  });

  it("preserves a server message when the response has no structured code", () => {
    const error = new ScenarioRequestError({
      message: "The scenario service is temporarily unavailable",
      status: 503,
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      "The scenario service is temporarily unavailable"
    );
  });

  it("keeps client error messages for non-request errors", () => {
    expect(
      resolveScenarioRequestErrorMessage(
        new Error("Failed to fetch"),
        t,
        "saveFailed"
      )
    ).toBe("Failed to fetch");
  });

  it("translates incomplete WhatsApp contact activation errors", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "whatsappContactIncomplete",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("whatsappContactIncomplete")
    );
  });

  it("translates incomplete WhatsApp location activation errors", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "whatsappLocationIncomplete",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("whatsappLocationIncomplete")
    );
  });

  it("translates invalid canonical WhatsApp service messages", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "whatsappServiceMessageInvalid",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("whatsappServiceMessageInvalid")
    );
  });

  it("translates unsupported action owners", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "actionTypeInvalid",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("actionTypeInvalid")
    );
  });

  it("translates action-routing compiler diagnostics", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "mixed_action_outcome_ownership",
    });

    expect(resolveScenarioRequestErrorMessage(error, t, "saveFailed")).toBe(
      t("mixed_action_outcome_ownership")
    );
  });

  it.each(LOCALES)("explains an unavailable collected answer in %s", locale => {
    const message =
      loadScenariosMessages(locale).generativeAIPromptInputUnavailable;
    expect(message?.trim()).toBeTruthy();
    if (locale !== "en") {
      expect(message).not.toBe(
        loadScenariosMessages("en").generativeAIPromptInputUnavailable
      );
    }
  });

  it.each(LOCALES)("explains form answer activation errors in %s", locale => {
    const messages = loadScenariosMessages(locale);
    for (const code of ["formAnswerUnavailable", "formAnswersKeyDuplicate"]) {
      expect(messages[code]?.trim()).toBeTruthy();
      expect(messages[code]).not.toMatch(/—/);
      if (locale !== "en") {
        expect(messages[code]).not.toBe(loadScenariosMessages("en")[code]);
      }
    }
  });

  it.each(LOCALES)("explains Form submitted route errors in %s", locale => {
    const messages = loadScenariosMessages(locale);
    for (const code of [
      "whatsappTemplateFormRouteUnavailable",
      "whatsappTemplateFormRouteConditionTarget",
      "whatsappTemplateFormRouteInBulk",
    ]) {
      expect(messages[code]).toContain(messages.serviceRouteFlowSubmitted);
      expect(messages[code]).not.toMatch(/—/);
      if (locale !== "en") {
        expect(messages[code]).not.toBe(loadScenariosMessages("en")[code]);
      }
    }
  });

  it("uses the fallback translation when there is no usable message", () => {
    expect(resolveScenarioRequestErrorMessage(null, t, "saveFailed")).toBe(
      t("saveFailed")
    );
  });
});

describe("legacy routing conversion failures", () => {
  // Failures that recur for the same scenario revision.
  const persistentFailures = [
    ["legacy_action_routing_not_eligible", 409],
    ["legacy_action_routing_pending_timer_identity_invalid", 409],
    ["legacy_action_routing_external_state_invalid", 409],
  ] as const;
  const failures = [
    ...persistentFailures,
    ["legacy_action_routing_timer_ingress_unavailable", 503],
  ] as const;
  const reloadPrompt: Record<(typeof LOCALES)[number], RegExp> = {
    en: /\breload/i,
    ru: /перезагруз/i,
    kz: /қайта жүкте/i,
  };

  it.each(LOCALES)("explains each conversion failure in %s", locale => {
    const messages = loadScenariosMessages(locale);
    const localeT = (key: string) => messages[key] ?? key;

    for (const [code, status] of failures) {
      const error = new ScenarioRequestError({
        message: "Legacy routing conversion failed on the server.",
        status,
        code,
      });

      expect(messages[code]).toEqual(expect.any(String));
      expect(
        resolveScenarioRequestErrorMessage(error, localeT, "saveFailed")
      ).toBe(messages[code]);
    }
  });

  it.each(LOCALES)(
    "does not promise in %s that reloading fixes a persistent failure",
    locale => {
      const messages = loadScenariosMessages(locale);

      for (const [code] of persistentFailures) {
        expect(messages[code]).not.toMatch(reloadPrompt[locale]);
      }
    }
  );
});

describe("delayed CTA follow-up diagnostics", () => {
  const codes = [
    "unsupported_action_branch_delay_handle",
    "multiple_action_branch_delay_targets",
  ] as const;

  it.each(LOCALES)("explains each diagnostic in %s", locale => {
    const messages = loadScenariosMessages(locale);
    const localeT = (key: string) => messages[key] ?? key;

    for (const code of codes) {
      const error = new ScenarioRequestError({
        message: "Invalid scenario graph",
        status: 400,
        code,
      });

      expect(messages[code]).toEqual(expect.any(String));
      expect(messages[code]).not.toBe(code);
      expect(
        resolveScenarioRequestErrorMessage(error, localeT, "saveFailed")
      ).toBe(messages[code]);
      expect(translateScenarioErrorCode(code, localeT, "saveFailed")).toBe(
        messages[code]
      );
    }
  });
});

describe("scenario request error accessors", () => {
  it("reads the blocking node ids and primary code", () => {
    const error = new ScenarioRequestError({
      message: "Invalid scenario graph",
      status: 400,
      code: "singleFlowRequired",
      nodeIds: ["node-a", "node-b"],
    });

    expect(getScenarioRequestErrorBlockNodeIds(error)).toEqual([
      "node-a",
      "node-b",
    ]);
    expect(getScenarioRequestErrorCode(error)).toBe("singleFlowRequired");
  });

  it("returns safe defaults for other errors", () => {
    expect(getScenarioRequestErrorBlockNodeIds(new Error("boom"))).toEqual([]);
    expect(getScenarioRequestErrorCode(new Error("boom"))).toBeNull();
  });
});

describe("translateScenarioErrorCode", () => {
  it("uses the fallback for a code without a dedicated message", () => {
    expect(translateScenarioErrorCode("some_internal_code", t, "generic")).toBe(
      t("generic")
    );
  });
});

describe("scenario asset upload failures", () => {
  const uploadCodes = [
    "scenario_asset_upload_too_large",
    "scenario_asset_upload_unsupported_file",
    "scenario_asset_upload_network_failed",
    "scenario_asset_upload_auth_required",
    "scenario_asset_upload_forbidden",
    "scenario_asset_upload_rejected",
    "scenario_asset_upload_unavailable",
  ] as const;

  it.each(uploadCodes)("localizes the known upload failure %s", code => {
    const error = new ScenarioRequestError({
      message:
        "Provider internal reason: private bucket policy rejected this object",
      status: 400,
      code,
    });

    expect(
      resolveScenarioRequestErrorMessage(error, t, "actionImageUploadFailed")
    ).toBe(code);
  });

  it.each([
    [401, "scenario_asset_upload_auth_required"],
    [403, "scenario_asset_upload_forbidden"],
    [413, "scenario_asset_upload_too_large"],
    [502, "scenario_asset_upload_unavailable"],
    [503, "scenario_asset_upload_unavailable"],
    [504, "scenario_asset_upload_unavailable"],
  ])("explains HTTP %s even without a JSON error code", (status, key) => {
    const error = new ScenarioRequestError({
      message: "Failed to upload file",
      status: Number(status),
    });

    expect(
      resolveScenarioRequestErrorMessage(error, t, "actionImageUploadFailed")
    ).toBe(key);
  });

  it.each([
    new Error("Storage private-bucket credential rejected"),
    new ScenarioRequestError({
      message: "Storage private-bucket credential rejected",
      status: 500,
    }),
    new ScenarioRequestError({
      message: "Storage private-bucket credential rejected",
      status: 500,
      code: "scenario_asset_upload_failed",
    }),
  ])("hides unknown upload internals: %s", error => {
    expect(
      resolveScenarioRequestErrorMessage(error, t, "actionImageUploadFailed")
    ).toBe("actionImageUploadFailed");
  });

  it.each(LOCALES)("explains upload failures in %s", locale => {
    const messages = loadScenariosMessages(locale);
    const localeT = (key: string) => messages[key] ?? key;

    for (const code of uploadCodes) {
      const error = new ScenarioRequestError({
        message: "Provider internal reason",
        status: 400,
        code,
      });
      const message = resolveScenarioRequestErrorMessage(
        error,
        localeT,
        "actionImageUploadFailed"
      );
      expect(message).toBe(messages[code]);
      expect(message?.trim()).toBeTruthy();
      expect(message).not.toBe(code);
      if (locale !== "en") {
        expect(message).not.toBe(loadScenariosMessages("en")[code]);
      }
    }
  });

  it.each(LOCALES)("provides media limit and format details in %s", locale => {
    const messages = loadScenariosMessages(locale);
    expect(messages.whatsappServiceMediaFileTooLarge).toContain("{maxSize}");
    const formats = messages.whatsappServiceCarouselMediaUnsupported;
    for (const detail of [
      "JPEG",
      "PNG",
      "{imageMaxSize}",
      "MP4",
      "3GP",
      "{videoMaxSize}",
    ]) {
      expect(formats).toContain(detail);
    }
  });
});

describe("resolveScenarioRequestErrorCodeMessage", () => {
  it.each([
    "company_scenario_limit_exceeded",
    "company_conversation_limit_exceeded",
  ])("translates the %s plan refusal", code => {
    const error = new ScenarioRequestError({
      message: "Free plan scenario limit reached. Upgrade to Pro.",
      status: 402,
      code,
    });
    expect(
      resolveScenarioRequestErrorCodeMessage(error, t, "createFailed")
    ).toBe(t(code));
  });

  it("never shows the server's own English text", () => {
    const uncoded = new ScenarioRequestError({
      message: "Scenario 507f1f77bcf86cd799439011 could not be created",
      status: 500,
    });
    expect(
      resolveScenarioRequestErrorCodeMessage(uncoded, t, "createFailed")
    ).toBe("createFailed");
    expect(
      resolveScenarioRequestErrorCodeMessage(
        new Error("Network down"),
        t,
        "createFailed"
      )
    ).toBe("createFailed");
  });

  it("has copy for the plan refusals in every locale", () => {
    for (const locale of LOCALES) {
      const messages = loadScenariosMessages(locale);
      expect(messages.company_scenario_limit_exceeded).toBeTruthy();
      expect(messages.company_conversation_limit_exceeded).toBeTruthy();
    }
  });
});
