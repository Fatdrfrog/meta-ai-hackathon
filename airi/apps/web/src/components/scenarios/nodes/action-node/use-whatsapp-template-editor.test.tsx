/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  MEDAL_FLOW_ID,
  medalTemplateForm,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { updateScenarioWhatsAppTemplate } from "@/lib/scenarios/client";
import type { EditableWhatsAppTemplateEditorFormValues } from "../../builders/whatsapp/template-editor-utils";
import {
  ScenarioEditorDraftProvider,
  useScenarioEditorDraftStore,
} from "../../view/editor-drafts";
import { resolveMissingTemplateFlowNavigateScreens } from "./action-node-template-editor";
import { useWhatsAppTemplateEditor } from "./use-whatsapp-template-editor";

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/scenarios/client", () => ({
  updateScenarioWhatsAppTemplate: jest.fn(),
}));

jest.mock("./action-node-template-editor", () => ({
  ...jest.requireActual("./action-node-template-editor"),
  resolveMissingTemplateFlowNavigateScreens: jest.fn(),
}));

const updateTemplate = jest.mocked(updateScenarioWhatsAppTemplate);
const resolveScreens = jest.mocked(resolveMissingTemplateFlowNavigateScreens);
type EditorInput = Parameters<typeof useWhatsAppTemplateEditor>[0];
type UpdateResult = Awaited<ReturnType<typeof updateScenarioWhatsAppTemplate>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createInput(): EditorInput {
  return {
    id: "action-a",
    workspaceId: "workspace-a",
    templateId: "template-a",
    templateCategory: "UTILITY",
    nodeData: {
      uiActiveScenarioId: "scenario-a",
      actionWhatsAppTemplateName: "welcome",
      actionWhatsAppTemplateLanguage: "en_US",
      actionReplyText: "Saved body",
      actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Saved body" }],
    },
    patchNode: jest.fn(),
  };
}

function renderEditor(input = createInput()) {
  return renderHook(
    (props: EditorInput) => ({
      editor: useWhatsAppTemplateEditor(props),
      store: useScenarioEditorDraftStore(),
    }),
    {
      initialProps: input,
      wrapper: ({ children }: { children: ReactNode }) => (
        <ScenarioEditorDraftProvider>{children}</ScenarioEditorDraftProvider>
      ),
    }
  );
}

describe("useWhatsAppTemplateEditor ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateTemplate.mockReset().mockResolvedValue({ ok: true });
    resolveScreens.mockReset().mockImplementation(async ({ values }) => values);
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("ignores an old provider completion after an A to B to A visit and releases its lock", async () => {
    const input = createInput();
    const response = deferred<UpdateResult>();
    updateTemplate.mockReturnValueOnce(response.promise);
    const { result, rerender } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Draft A", {
        shouldDirty: true,
      });
    });
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.editor.save();
    });
    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1));

    rerender({
      ...input,
      nodeData: { ...input.nodeData, uiActiveScenarioId: "scenario-b" },
    });
    expect(result.current.editor.bodyText).toBe("Saved body");
    rerender(input);
    expect(result.current.editor.bodyText).toBe("Draft A");
    expect(result.current.editor.isUpdatePending).toBe(true);

    await act(async () => {
      response.resolve({ ok: true });
      await saving;
    });
    expect(input.patchNode).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.editor.bodyText).toBe("Draft A");
    expect(result.current.editor.isDirty).toBe(true);
    expect(result.current.editor.isUpdatePending).toBe(false);

    await act(async () => result.current.editor.save());
    expect(updateTemplate).toHaveBeenCalledTimes(2);
    expect(input.patchNode).toHaveBeenCalledWith(
      expect.objectContaining({ actionReplyText: "Draft A" })
    );
  });

  it("stops a stale Flow lookup before it can update the provider", async () => {
    const input = createInput();
    const lookup = deferred<EditableWhatsAppTemplateEditorFormValues>();
    resolveScreens.mockReturnValueOnce(lookup.promise);
    const { result, rerender } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Draft A", {
        shouldDirty: true,
      });
    });
    const submitted = result.current.editor.form.getValues();
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.editor.save();
    });
    await waitFor(() => expect(resolveScreens).toHaveBeenCalledTimes(1));
    rerender({ ...input, templateId: "template-b" });

    await act(async () => {
      lookup.resolve(submitted);
      await saving;
    });
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(input.patchNode).not.toHaveBeenCalled();
    rerender(input);
    expect(result.current.editor.bodyText).toBe("Draft A");
    expect(result.current.editor.isUpdatePending).toBe(false);
  });

  it("adopts through the originating patch command while preserving newer edits", async () => {
    const input = createInput();
    const response = deferred<UpdateResult>();
    updateTemplate.mockReturnValueOnce(response.promise);
    const { result, rerender } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Submitted", {
        shouldDirty: true,
      });
    });
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.editor.save();
    });
    await waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1));
    const newerPatch = jest.fn();
    rerender({ ...input, patchNode: newerPatch });
    expect(result.current.editor.bodyText).toBe("Submitted");
    act(() => {
      result.current.editor.form.setValue("bodyText", "Newer draft", {
        shouldDirty: true,
      });
    });

    await act(async () => {
      response.resolve({ ok: true });
      await saving;
    });
    expect(input.patchNode).toHaveBeenCalledTimes(1);
    expect(input.patchNode).toHaveBeenCalledWith(
      expect.objectContaining({ actionReplyText: "Submitted" })
    );
    expect(newerPatch).not.toHaveBeenCalled();
    expect(result.current.editor.bodyText).toBe("Newer draft");
    expect(result.current.editor.isDirty).toBe(true);
    expect(result.current.store.templateCount()).toBe(1);
  });

  it("keeps a rejected update as a local draft and permits a retry", async () => {
    const input = createInput();
    updateTemplate.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Provider rejected the update",
    });
    const { result } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Retry this draft", {
        shouldDirty: true,
      });
    });
    await act(async () => result.current.editor.save());
    expect(toast.error).toHaveBeenCalledWith(
      "whatsappTemplateMetaUpdateFailed",
      { description: "Provider rejected the update" }
    );
    expect(input.patchNode).not.toHaveBeenCalled();
    expect(result.current.editor.bodyText).toBe("Retry this draft");
    expect(result.current.editor.isDirty).toBe(true);
    expect(result.current.editor.isSubmitting).toBe(false);
    expect(result.current.editor.isUpdatePending).toBe(false);
    expect(result.current.store.templateCount()).toBe(1);

    await act(async () => result.current.editor.save());
    expect(updateTemplate).toHaveBeenCalledTimes(2);
    expect(input.patchNode).toHaveBeenCalledTimes(1);
    expect(result.current.editor.isDirty).toBe(false);
    expect(result.current.store.templateCount()).toBe(0);
  });

  it("confirms a saved template with the localized message, not the server's", async () => {
    const input = createInput();
    updateTemplate.mockResolvedValueOnce({
      ok: true,
      message: "Template updated successfully. It will be reviewed by Meta.",
    });
    const { result } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "New body", {
        shouldDirty: true,
      });
    });
    await act(async () => result.current.editor.save());
    expect(toast.success).toHaveBeenCalledWith(
      "whatsappTemplateMetaUpdateSuccess"
    );
  });

  it("saves each kept reply button with the id its route uses", async () => {
    const input = createInput();
    input.nodeData = {
      ...input.nodeData,
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Saved body" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "URL", text: "See plans", url: "https://shop.test" },
            { type: "QUICK_REPLY", text: "Basic" },
            { type: "QUICK_REPLY", text: "Premium" },
          ],
        },
      ],
    };
    const { result } = renderEditor(input);
    expect(result.current.editor.buttons.map(button => button.routeId)).toEqual(
      [undefined, 1, 2]
    );

    act(() => result.current.editor.removeButton(0));
    await act(async () => result.current.editor.save());

    expect(updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          { type: "BODY", text: "Saved body" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Basic" },
              { type: "QUICK_REPLY", text: "Premium" },
            ],
          },
        ],
      })
    );
    expect(input.patchNode).toHaveBeenCalledWith(
      expect.objectContaining({
        actionWhatsAppTemplateButtonIds: {
          version: 1,
          nextId: 10,
          buttons: [
            { id: 1, index: 0, text: "Basic" },
            { id: 2, index: 1, text: "Premium" },
          ],
        },
      })
    );
  });

  it("drops the old Flow's linked config, keeping the loaded fields' key, when Save points the form button at another Flow", async () => {
    const input = createInput();
    input.nodeData = {
      ...input.nodeData,
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Saved body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Choose",
              flow_id: MEDAL_FLOW_ID,
              flow_action: "navigate",
              navigate_screen: "SPORT",
            },
          ],
        },
      ],
      actionFlowConfig: {
        templateId: "linked-flow",
        ctaText: "Choose",
        screens: [],
        providerReference: {
          flowId: MEDAL_FLOW_ID,
          sourceId: "source-1",
          wabaId: "waba-1",
          providerStatus: "PUBLISHED",
        },
      },
      actionWhatsAppTemplateForm: medalTemplateForm(),
    };
    const patches = jest.mocked(input.patchNode).mock.calls;
    const { result } = renderEditor(input);

    act(() => result.current.editor.setBodyText("New body"));
    await act(async () => result.current.editor.save());
    expect(patches[0]?.[0]).not.toHaveProperty("actionWhatsAppTemplateForm");
    expect(patches[0]?.[0]).not.toHaveProperty("actionFlowConfig");

    act(() =>
      result.current.editor.updateButton(0, { flowId: "1571793974235171" })
    );
    act(() =>
      result.current.editor.updateButton(0, { navigateScreen: "WELCOME" })
    );
    await act(async () => result.current.editor.save());
    expect(updateTemplate).toHaveBeenCalledTimes(2);
    expect(Object.keys(patches[1]?.[0] ?? {})).toEqual(
      expect.arrayContaining([
        "actionFlowConfig",
        "actionReplyCtaType",
        "actionReplyCtaFlowId",
        "actionReplyCtaFlowName",
      ])
    );
    expect(patches[1]?.[0].actionFlowConfig).toBeUndefined();
    // The readers skip the old Flow's fields; loading the new form's keeps
    // their key.
    expect(patches[1]?.[0]).not.toHaveProperty("actionWhatsAppTemplateForm");
  });

  it("names the first problem of an invalid form in the toast", async () => {
    const input = createInput();
    const { result } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "", {
        shouldDirty: true,
      });
    });
    await act(async () => result.current.editor.save());
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("whatsappTemplateSaveInvalid", {
      description: "whatsappTemplateErrorBodyRequired",
    });
  });

  it("hides a thrown error's text from the save failure toast title", async () => {
    const input = createInput();
    updateTemplate.mockRejectedValueOnce(new Error("socket hang up"));
    const { result } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Body", {
        shouldDirty: true,
      });
    });
    await act(async () => result.current.editor.save());
    expect(toast.error).toHaveBeenCalledWith(
      "whatsappTemplateMetaUpdateFailed",
      { description: "socket hang up" }
    );
  });

  it("discards only the unpublished form draft without writing the graph or provider", () => {
    const input = createInput();
    const { result } = renderEditor(input);
    act(() => {
      result.current.editor.form.setValue("bodyText", "Discard me", {
        shouldDirty: true,
      });
    });
    expect(result.current.store.templateCount()).toBe(1);
    act(() => result.current.editor.discard());

    expect(result.current.editor.bodyText).toBe("Saved body");
    expect(result.current.editor.isDirty).toBe(false);
    expect(result.current.store.templateCount()).toBe(0);
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(input.patchNode).not.toHaveBeenCalled();
  });
});
