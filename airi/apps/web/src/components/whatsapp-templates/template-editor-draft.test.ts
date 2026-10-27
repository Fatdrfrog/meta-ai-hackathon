/**
 * @jest-environment jsdom
 */
import {
  clearTemplateEditorDraft,
  getTemplateEditorDraftKey,
  hasTemplateEditorDraftContent,
  isTemplateEditorDraftFromThisPage,
  readRestorableTemplateEditorDraft,
  readTemplateEditorDraft,
  snapshotTemplateEditorValues,
  TEMPLATE_EDITOR_DRAFT_TTL_MS,
  writeTemplateEditorDraft,
} from "./template-editor-draft";
import type { TemplateFormValues } from "./template-editor-form-utils";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

function draftValues(
  overrides: Partial<TemplateFormValues> = {}
): TemplateFormValues {
  return {
    name: "car_alarm",
    targetPlatform: "whatsapp",
    category: "MARKETING",
    bodyText: "Hello",
    buttons: [{ clientId: "whatsapp-1", type: "QUICK_REPLY", text: "Yes" }],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("template editor drafts", () => {
  it("keys new templates per workspace and existing templates by id", () => {
    expect(getTemplateEditorDraftKey({ workspaceId: "ws-1" })).toBe(
      "airi.templateEditorDraft.v1:ws-1:new"
    );
    expect(
      getTemplateEditorDraftKey({ workspaceId: "ws-1", templateId: "db-7" })
    ).toBe("airi.templateEditorDraft.v1:ws-1:edit:db-7");
  });

  it("reads back what was written", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    writeTemplateEditorDraft(key, draftValues(), NOW);

    expect(readTemplateEditorDraft(key, NOW + 1000)).toEqual({
      savedAt: NOW,
      values: draftValues(),
    });
  });

  it("drops a draft older than seven days", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    writeTemplateEditorDraft(key, draftValues(), NOW);

    expect(
      readTemplateEditorDraft(key, NOW + TEMPLATE_EDITOR_DRAFT_TTL_MS + 1)
    ).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("drops a corrupted draft instead of restoring it", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    window.localStorage.setItem(key, "{not json");
    expect(readTemplateEditorDraft(key, NOW)).toBeNull();

    window.localStorage.setItem(
      key,
      JSON.stringify({ savedAt: NOW, values: { name: 5 } })
    );
    expect(readTemplateEditorDraft(key, NOW)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("prunes other expired drafts when writing", () => {
    const staleKey = getTemplateEditorDraftKey({
      workspaceId: "ws-old",
      templateId: "db-1",
    });
    const unrelatedKey = "airi.someOtherSetting";
    writeTemplateEditorDraft(staleKey, draftValues(), NOW);
    window.localStorage.setItem(unrelatedKey, "keep");

    const freshKey = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    writeTemplateEditorDraft(
      freshKey,
      draftValues(),
      NOW + TEMPLATE_EDITOR_DRAFT_TTL_MS + 1
    );

    expect(window.localStorage.getItem(staleKey)).toBeNull();
    expect(window.localStorage.getItem(unrelatedKey)).toBe("keep");
    expect(window.localStorage.getItem(freshKey)).not.toBeNull();
  });

  it("tells a draft this page wrote from one an earlier page load left", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    writeTemplateEditorDraft(key, draftValues(), NOW);
    expect(
      isTemplateEditorDraftFromThisPage(key, readTemplateEditorDraft(key, NOW)!)
    ).toBe(true);

    window.localStorage.setItem(
      key,
      JSON.stringify({ savedAt: NOW + 5, values: draftValues() })
    );
    expect(
      isTemplateEditorDraftFromThisPage(key, readTemplateEditorDraft(key, NOW)!)
    ).toBe(false);
  });

  it("restores a draft over the template defaults only when it holds edits", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    const defaults = draftValues({ name: "", bodyText: "", buttons: [] });

    expect(readRestorableTemplateEditorDraft(key, defaults)).toBeNull();

    writeTemplateEditorDraft(key, { ...defaults, category: "UTILITY" });
    expect(readRestorableTemplateEditorDraft(key, defaults)).toBeNull();

    // Another page load's draft: a page knows its own by the exact savedAt it
    // wrote, so this must not land in the same millisecond as the write above.
    window.localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now() + 1,
        values: { name: "car_alarm", targetPlatform: "whatsapp" },
      })
    );
    expect(readRestorableTemplateEditorDraft(key, defaults)).toEqual({
      values: { ...defaults, name: "car_alarm" },
      fromThisPage: false,
    });

    writeTemplateEditorDraft(key, draftValues());
    expect(readRestorableTemplateEditorDraft(key, defaults)?.fromThisPage).toBe(
      true
    );
  });

  it("clears a draft", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    writeTemplateEditorDraft(key, draftValues(), NOW);
    clearTemplateEditorDraft(key);

    expect(readTemplateEditorDraft(key, NOW)).toBeNull();
  });

  it("counts typed text and media as draft content, not settings", () => {
    const empty = draftValues({
      name: "",
      bodyText: "",
      buttons: [],
      hasCarousel: true,
      carouselHeaderFormat: "IMAGE",
      carouselCards: [
        {
          clientId: "card-1",
          headerFormat: "IMAGE",
          headerMediaExample: "",
          bodyText: " ",
          buttons: [{ clientId: "b-1", type: "QUICK_REPLY", text: "" }],
        },
      ],
    });
    expect(hasTemplateEditorDraftContent(empty)).toBe(false);

    expect(
      hasTemplateEditorDraftContent({
        ...empty,
        carouselCards: [
          {
            ...empty.carouselCards![0],
            headerMediaExample: "https://cdn.example.com/card.png",
          },
        ],
      })
    ).toBe(true);
    expect(
      hasTemplateEditorDraftContent({
        ...empty,
        variableExamples: { first_name: "Samal" },
      })
    ).toBe(true);
    expect(hasTemplateEditorDraftContent(draftValues())).toBe(true);
  });

  it("compares drafts regardless of key order", () => {
    const { name, ...rest } = draftValues();
    expect(snapshotTemplateEditorValues({ ...rest, name })).toBe(
      snapshotTemplateEditorValues(draftValues())
    );
  });

  it("compares drafts without per-load client ids", () => {
    const loaded = draftValues({
      buttons: [{ clientId: "whatsapp-9", type: "QUICK_REPLY", text: "Yes" }],
    });

    expect(snapshotTemplateEditorValues(loaded)).toBe(
      snapshotTemplateEditorValues(draftValues())
    );
    expect(
      snapshotTemplateEditorValues(draftValues({ bodyText: "Hi" }))
    ).not.toBe(snapshotTemplateEditorValues(draftValues()));
  });

  it("never throws when storage is unavailable", () => {
    const key = getTemplateEditorDraftKey({ workspaceId: "ws-1" });
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    expect(() =>
      writeTemplateEditorDraft(key, draftValues(), NOW)
    ).not.toThrow();
    expect(readTemplateEditorDraft(key, NOW)).toBeNull();
    expect(() => clearTemplateEditorDraft(key)).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
