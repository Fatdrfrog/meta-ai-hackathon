import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  createGeneratedTemplateTargetDigest,
  readGeneratedTemplateScenarioUpdate,
} from "./generated-template-submission";

function target(): Partial<ScenarioNodeData> {
  return {
    kind: "action",
    actionType: "whatsapp_template",
    actionReplyText: "Hello",
    actionWhatsAppTemplateId: "old-template",
    actionWhatsAppTemplateName: "generated_offer",
    actionWhatsAppTemplateLanguage: "en_US",
    actionWhatsAppTemplateCategory: "MARKETING",
    actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hello" }],
    generatedTemplateDraft: {
      id: "draft-1",
      name: "generated_offer",
      language: "en_US",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      status: "draft",
    },
  };
}

describe("createGeneratedTemplateTargetDigest", () => {
  it("changes for selected template and generated draft edits", () => {
    const baseline = target();
    const digest = createGeneratedTemplateTargetDigest(baseline);

    expect(
      createGeneratedTemplateTargetDigest({
        ...baseline,
        actionWhatsAppTemplateName: "manual_override",
      })
    ).not.toBe(digest);
    expect(
      createGeneratedTemplateTargetDigest({
        ...baseline,
        generatedTemplateDraft: {
          ...baseline.generatedTemplateDraft!,
          status: "rejected",
        },
      })
    ).not.toBe(digest);
  });

  it.each([
    { headerMediaUrl: "https://example.com/header.png" },
    { headerMediaFormat: "IMAGE" as const },
  ])("changes when draft media metadata changes: %j", draftPatch => {
    const baseline = target();
    expect(
      createGeneratedTemplateTargetDigest({
        ...baseline,
        generatedTemplateDraft: {
          ...baseline.generatedTemplateDraft!,
          ...draftPatch,
        },
      })
    ).not.toBe(createGeneratedTemplateTargetDigest(baseline));
  });

  it("ignores unrelated action fields", () => {
    const baseline = target();
    expect(
      createGeneratedTemplateTargetDigest({
        ...baseline,
        actionReplyCtaLabel: "unrelated edit",
      })
    ).toBe(createGeneratedTemplateTargetDigest(baseline));
  });
});

describe("readGeneratedTemplateScenarioUpdate", () => {
  const validUpdate = {
    nodeId: "action-1",
    previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
    scenarioUpdatedAt: "2026-01-01T00:00:00.001Z",
    patch: {
      generatedTemplateDraft: {
        id: "draft-1",
        name: "offer",
        language: "en",
        status: "rejected",
        components: [{ type: "BODY", text: "" }],
      },
    },
  };

  it("accepts a structurally safe incomplete rejected draft", () => {
    expect(readGeneratedTemplateScenarioUpdate(validUpdate)).toEqual(
      validUpdate
    );
  });

  it("accepts the step's reply-button ids with the template", () => {
    const update = {
      ...validUpdate,
      patch: {
        ...validUpdate.patch,
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Premium" }],
          },
        ],
        actionWhatsAppTemplateButtonIds: {
          version: 1,
          nextId: 10,
          buttons: [{ id: 1, index: 0, text: "Premium" }],
        },
      },
    };

    expect(readGeneratedTemplateScenarioUpdate(update)).toEqual(update);
  });

  it.each([
    { ...validUpdate, nodeId: " action-1 " },
    {
      ...validUpdate,
      patch: {
        generatedTemplateDraft: {
          ...validUpdate.patch.generatedTemplateDraft,
          status: { toString: (): string => "rejected" },
        },
      },
    },
    {
      ...validUpdate,
      patch: {
        generatedTemplateDraft: {
          ...validUpdate.patch.generatedTemplateDraft,
          components: [null],
        },
      },
    },
    {
      ...validUpdate,
      patch: {
        ...validUpdate.patch,
        actionWhatsAppTemplateButtonIds: { version: 1, buttons: "Premium" },
      },
    },
  ])("rejects unsafe update %#", update => {
    expect(readGeneratedTemplateScenarioUpdate(update)).toBeNull();
  });
});
