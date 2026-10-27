/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextEncoder } from "node:util";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { generateFlowJson } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import {
  META_STARTER_FLOW_JSON,
  DEMOSHOP_FLOW_JSON,
} from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import {
  fetchWhatsAppFlowDetails,
  getWhatsAppFlowPreviewUrl,
  updateWhatsAppFlow,
} from "@/lib/whatsapp/flows/client";
import { WhatsAppFlowEditor } from "./flow-editor";
import enMessages from "../../../messages/settings/integrations/en/page.json";
import ruMessages from "../../../messages/settings/integrations/ru/page.json";
import kzMessages from "../../../messages/settings/integrations/kz/page.json";

let mockPreviewLabels: { external: string; local: string } | null = null;

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    if (namespace === "WhatsAppFlows" && mockPreviewLabels) {
      if (key === "actions.preview") return mockPreviewLabels.external;
      if (key === "editor.preview") return mockPreviewLabels.local;
    }
    return key;
  },
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("@/components/scenarios/builders/whatsapp/field-editor", () => ({
  FlowFormEditorContent: ({
    flowConfig,
    onChange,
    renderPreview,
  }: {
    flowConfig: WhatsAppFlowConfig;
    onChange: (config: WhatsAppFlowConfig) => void;
    renderPreview?: (screenId?: string) => React.ReactNode;
  }) => (
    <div>
      <h3>{mockPreviewLabels?.local ?? "editor.preview"}</h3>
      {renderPreview?.(flowConfig.screens[0]?.id)}
      <button
        onClick={() =>
          onChange({
            ...flowConfig,
            screens: flowConfig.screens.map(s => ({
              ...s,
              fields: s.fields.map(f => ({ ...f, label: "Your name" })),
            })),
          })
        }
      >
        Change field label
      </button>
      <button
        onClick={() =>
          onChange({
            ...flowConfig,
            screens: flowConfig.screens.map(s => ({
              ...s,
              layoutContent: s.layoutContent?.map(component =>
                component.kind === "text" && component.type === "TextHeading"
                  ? { ...component, text: "Welcome to airi.chat" }
                  : component
              ),
            })),
          })
        }
      >
        Change welcome text
      </button>
      <button
        onClick={() =>
          onChange({
            ...flowConfig,
            screens: flowConfig.screens.map(s => ({
              ...s,
              fields: [
                ...s.fields,
                {
                  id: "new_field",
                  label: "",
                  fieldType: "TextInput",
                  required: false,
                },
              ],
            })),
          })
        }
      >
        Add unfinished field
      </button>
    </div>
  ),
}));
jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchWhatsAppFlowDetails: jest.fn(),
  updateWhatsAppFlow: jest.fn(),
  getWhatsAppFlowPreviewUrl: jest.fn(() => null),
}));

const getDetails = jest.mocked(fetchWhatsAppFlowDetails);
const update = jest.mocked(updateWhatsAppFlow);
const getPreviewUrl = jest.mocked(getWhatsAppFlowPreviewUrl);
const flow = {
  id: "123",
  name: "Contact form",
  categories: ["CONTACT_US"],
  status: "DRAFT",
};
const json = generateFlowJson({
  templateId: "custom",
  ctaText: "Open",
  flowUiLocale: "en",
  screens: [
    {
      id: "START",
      title: "Contact",
      fields: [
        { id: "name", label: "Name", fieldType: "TextInput", required: true },
      ],
    },
  ],
});
const onSaved = jest.fn();
const onClose = jest.fn();

beforeAll(() => {
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
});

function openEditor(overrides = {}) {
  return render(
    <WhatsAppFlowEditor
      workspaceId="workspace-1"
      sourceId="source-1"
      flow={{ ...flow, ...overrides }}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreviewLabels = null;
  getPreviewUrl.mockReturnValue(null);
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow, flowJson: json },
  });
  update.mockResolvedValue({
    ok: true,
    status: 200,
    data: { success: true, flow },
  });
  window.confirm = jest.fn(() => false);
});

it.each([
  ["en", enMessages.WhatsAppFlows, "Meta preview"],
  ["ru", ruMessages.WhatsAppFlows, "Предпросмотр Meta"],
  ["kz", kzMessages.WhatsAppFlows, "Meta алдын ала қарауы"],
] as const)(
  "names the external provider action Meta preview in %s while retaining the local preview heading",
  async (_locale, messages, expectedLabel) => {
    mockPreviewLabels = {
      external: messages.actions.preview,
      local: messages.editor.preview,
    };
    const url = "https://business.facebook.com/wa/manage/flows/?flow_id=123";
    getPreviewUrl.mockReturnValue(url);
    openEditor();
    fireEvent.click(
      await screen.findByRole("button", { name: "editor.advanced" })
    );
    const link = await screen.findByRole("link", { name: expectedLabel });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      screen.getByRole("heading", { name: messages.editor.preview })
    ).toBeTruthy();
  }
);

it("saves visual changes as draft JSON without publishing", async () => {
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const payload = update.mock.calls.find(
    ([p]) => p.operation === "update_json"
  )?.[0];
  expect(payload).toMatchObject({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    flowId: "123",
    operation: "update_json",
  });
  if (payload?.operation !== "update_json")
    throw new Error("Expected JSON save");
  expect(
    JSON.parse(payload.flowJson).screens[0].layout.children[0].children[0].label
  ).toBe("Your name");
  expect(update.mock.calls.some(([p]) => p.operation === "publish")).toBe(
    false
  );
});

it("keeps technical tools in Advanced without replacing or losing the active editor", async () => {
  getPreviewUrl.mockReturnValue(
    "https://business.facebook.com/wa/manage/flows/?flow_id=123"
  );
  openEditor();
  const activeEditor = await screen.findByRole("button", {
    name: "Change field label",
  });
  expect(screen.queryByLabelText("dialogs.create.nameLabel")).toBeNull();
  expect(screen.queryByRole("button", { name: "editor.export" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "editor.json" })).toBeNull();
  expect(screen.queryByRole("link", { name: "actions.preview" })).toBeNull();

  fireEvent.click(activeEditor);
  const advanced = screen.getByRole("button", { name: "editor.advanced" });
  fireEvent.click(advanced);
  expect(screen.getByLabelText("dialogs.create.nameLabel")).toBeTruthy();
  expect(screen.getByRole("button", { name: "editor.import" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "editor.export" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "actions.preview" })).toBeTruthy();
  expect(screen.getByText("editor.savedBeforePreview")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change field label" })).toBe(
    activeEditor
  );
  fireEvent.click(advanced);
  expect(screen.getByRole("button", { name: "Change field label" })).toBe(
    activeEditor
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const saved = update.mock.calls.find(
    ([request]) => request.operation === "update_json"
  )?.[0];
  if (saved?.operation !== "update_json") throw new Error("Expected JSON save");
  expect(
    JSON.parse(saved.flowJson).screens[0].layout.children[0].children[0].label
  ).toBe("Your name");
});

it("opens complete JSON from Advanced and returns to visual editing without changing the document", async () => {
  openEditor();
  await screen.findByRole("button", { name: "Change field label" });
  fireEvent.click(screen.getByRole("button", { name: "editor.advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "editor.json" }));
  const source = await screen.findByRole("textbox", {
    name: "editor.sourceLabel",
  });
  expect(JSON.parse((source as HTMLTextAreaElement).value)).toEqual(json);
  expect(screen.queryByRole("button", { name: "editor.export" })).toBeNull();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "editor.visual" }));
  fireEvent.click(screen.getByRole("tab", { name: "editor.visual" }));
  expect(
    await screen.findByRole("button", { name: "Change field label" })
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "editor.save" }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

it("retains the local test answer and completion when switching to JSON and back", async () => {
  openEditor();
  const answer = await screen.findByRole("textbox", { name: "Name *" });
  fireEvent.change(answer, { target: { value: "Ayan" } });
  fireEvent.click(screen.getByRole("button", { name: "simulationSubmitForm" }));
  expect(screen.getByText("flowAuthoring.previewCompleted")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "editor.advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "editor.json" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "editor.visual" }));
  fireEvent.click(screen.getByRole("tab", { name: "editor.visual" }));
  expect(screen.getByRole("textbox", { name: "Name *" })).toBe(answer);
  expect((answer as HTMLInputElement).value).toBe("Ayan");
  expect(screen.getByText("flowAuthoring.previewCompleted")).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it("visually edits a branching 6.3 draft without changing its completion bindings", async () => {
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow, flowJson: DEMOSHOP_FLOW_JSON },
  });
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const payload = update.mock.calls.find(
    ([p]) => p.operation === "update_json"
  )?.[0];
  if (payload?.operation !== "update_json")
    throw new Error("Expected JSON save");
  const saved = JSON.parse(payload.flowJson);
  const expected = JSON.parse(JSON.stringify(DEMOSHOP_FLOW_JSON));
  expected.screens
    .slice(1)
    .forEach((s: { layout: { children: Array<Record<string, unknown>> } }) => {
      s.layout.children.forEach(field => {
        if (field.type !== "Footer") field.label = "Your name";
      });
    });
  expect(saved).toEqual(expected);
  expect(update.mock.calls.some(([p]) => p.operation === "publish")).toBe(
    false
  );
});

it("opens the saved Meta starter visually and preserves every property when editing welcome text", async () => {
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow, flowJson: META_STARTER_FLOW_JSON },
  });
  openEditor();
  await waitFor(() => expect(screen.queryByText("editor.loading")).toBeNull());
  expect(
    (screen.getByRole("tab", { name: "editor.visual" }) as HTMLButtonElement)
      .disabled
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "editor.publish",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Change welcome text" }));
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const upload = update.mock.calls.find(
    ([p]) => p.operation === "update_json"
  )?.[0];
  if (upload?.operation !== "update_json")
    throw new Error("Expected JSON save");
  const expected = JSON.parse(JSON.stringify(META_STARTER_FLOW_JSON));
  expected.screens[0].layout.children[0] = {
    type: "TextHeading",
    text: "Welcome to airi.chat",
  };
  expect(JSON.parse(upload.flowJson)).toEqual(expected);
  expect(update.mock.calls.some(([p]) => p.operation === "publish")).toBe(
    false
  );
});

it("preserves unsupported Meta components in complete JSON editing", async () => {
  const advanced = {
    version: "7.3",
    screens: [
      {
        id: "START",
        title: "Rich form",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextHeading",
              text: "Welcome",
              visible: "${data.show_heading}",
            },
          ],
        },
      },
    ],
  };
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow, flowJson: advanced },
  });
  openEditor();
  const source = await screen.findByRole("textbox", {
    name: "editor.sourceLabel",
  });
  expect(JSON.parse((source as HTMLTextAreaElement).value)).toEqual(advanced);
  fireEvent.change(source, {
    target: { value: JSON.stringify({ ...advanced, version: "7.2" }) },
  });
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const payload = update.mock.calls.find(
    ([p]) => p.operation === "update_json"
  )?.[0];
  if (payload?.operation !== "update_json")
    throw new Error("Expected JSON save");
  expect(JSON.parse(payload.flowJson).screens[0].layout.children[0]).toEqual(
    advanced.screens[0].layout.children[0]
  );
});

it("keeps provider validation details visible and prevents publication", async () => {
  update.mockResolvedValue({
    ok: false,
    status: 400,
    data: {
      error: "Invalid label",
      validation_errors: [{ message: "Label is too long", line_start: 8 }],
    },
  });
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  expect(await screen.findByText(/Label is too long/)).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "editor.publish",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  expect(screen.getByText("editor.publishNeedsValidation")).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it("prevents JSON changes on published versions", async () => {
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow: { ...flow, status: "PUBLISHED" }, flowJson: json },
  });
  openEditor({ status: "PUBLISHED" });
  expect(await screen.findByText("editor.readOnly")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Change field label" })
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "editor.save" })).toBeNull();
});

it("does not invent a replacement for a failed JSON download", async () => {
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: { flow, flowJson: null, flowJsonError: "Download failed" },
  });
  openEditor();
  expect(await screen.findByText("Download failed")).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "editor.publish",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
});

it("requires a saved document before publishing visual changes", async () => {
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  expect(
    (
      screen.getByRole("button", {
        name: "editor.publish",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  const explanation = screen.getByText("editor.publishNeedsSave");
  expect(
    screen
      .getByRole("button", { name: "editor.publish" })
      .getAttribute("aria-describedby")
  ).toBe(explanation.id);
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(screen.queryByText("editor.publishNeedsSave")).toBeNull();
  update.mockResolvedValue({
    ok: true,
    status: 200,
    data: { success: true, flow: { ...flow, status: "PUBLISHED" } },
  });
  fireEvent.click(screen.getByRole("button", { name: "editor.publish" }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "publish", flowId: "123" })
    )
  );
  expect(await screen.findByText("editor.readOnly")).toBeTruthy();
});

it("protects unsaved changes when closing", async () => {
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  fireEvent.click(screen.getAllByRole("button", { name: "editor.close" })[0]);
  expect(window.confirm).toHaveBeenCalledWith("editor.discardConfirm");
  expect(onClose).not.toHaveBeenCalled();
});

it("blocks publication when an unrecognized provider validation error exists", async () => {
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      flow: {
        ...flow,
        validation_errors: [{ error_type: "JSON_SCHEMA_ERROR" }],
      },
      flowJson: json,
    },
  });
  openEditor();
  await screen.findByRole("button", { name: "Change field label" });
  expect(
    (
      screen.getByRole("button", {
        name: "editor.publish",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
});

it("ignores completion of a save after the editor has closed", async () => {
  let finish!: (value: Awaited<ReturnType<typeof updateWhatsAppFlow>>) => void;
  update.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const view = openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Change field label" })
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  view.unmount();
  await import("@testing-library/react").then(({ act }) =>
    act(async () =>
      finish({ ok: true, status: 200, data: { success: true, flow } })
    )
  );
  expect(onSaved).not.toHaveBeenCalled();
});

it("does not send malformed source JSON to the provider", async () => {
  openEditor();
  await screen.findByRole("button", { name: "Change field label" });
  fireEvent.click(screen.getByRole("button", { name: "editor.advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "editor.json" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "editor.sourceLabel" }),
    { target: { value: "{" } }
  );
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  expect(await screen.findByText("editor.invalidJson")).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it("keeps incomplete visual fields editable until save validation", async () => {
  openEditor();
  fireEvent.click(
    await screen.findByRole("button", { name: "Add unfinished field" })
  );
  expect(
    screen.getByRole("button", { name: "Add unfinished field" })
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  expect(await screen.findByText("editor.invalidJson")).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it("retains managed ownership when detail reads omit list annotations", async () => {
  openEditor({
    managedArtifact: {
      operationId: "op-1",
      ledgerStatus: "COMPLETED",
      stage: "COMPLETED",
      cleanupEligibility: "NOT_TERMINAL",
      scenarioId: "scenario-1",
    },
  });
  expect(await screen.findByText("editor.managedReadOnly")).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("editor.loading")).toBeNull());
  expect(screen.getByText("editor.managedReadOnly")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "editor.save" })).toBeNull();
});

it("edits endpoint documents as complete JSON without simulating unknown server routes", async () => {
  const endpointJson = {
    version: "7.3",
    data_api_version: "4.0",
    routing_model: { START: [] },
    screens: [
      {
        id: "START",
        title: "Server form",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "Footer",
              label: "Next",
              "on-click-action": {
                name: "data_exchange",
                payload: { choice: "${data.choice}" },
              },
            },
          ],
        },
      },
    ],
  };
  getDetails.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      flow: {
        ...flow,
        endpoint_uri: "https://merchant.example/flow",
        application: { id: "app-1" },
      },
      flowJson: endpointJson,
    },
  });
  openEditor();
  const source = await screen.findByRole("textbox", {
    name: "editor.sourceLabel",
  });
  expect(
    screen.queryByRole("button", { name: "Change field label" })
  ).toBeNull();
  expect(screen.getByRole("heading", { name: "Server form" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("simulationActionUnavailable")).toBeTruthy();
  fireEvent.change(source, { target: { value: JSON.stringify(endpointJson) } });
  fireEvent.click(screen.getByRole("button", { name: "editor.save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const payload = update.mock.calls.find(
    ([p]) => p.operation === "update_json"
  )?.[0];
  if (payload?.operation !== "update_json")
    throw new Error("Expected JSON save");
  expect(JSON.parse(payload.flowJson)).toEqual(endpointJson);
  expect(payload).not.toHaveProperty("endpointUri");
  expect(payload).not.toHaveProperty("applicationId");
});
