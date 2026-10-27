/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import {
  buildWhatsAppTemplateButtonSourceHandleId,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import type {
  ScenarioFlowNode,
  ScenarioSummary,
  ScenarioWhatsAppTemplate,
} from "../types";
import { useScenarioActivationImpactGuard } from "./scenario-activation-impact";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.screen ? `${key}:${values.screen}` : key,
}));

const mockToastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

const mockSwrMutate = jest.fn();
jest.mock("swr", () => ({
  ...jest.requireActual("swr"),
  mutate: (...args: unknown[]) => mockSwrMutate(...args),
}));

const originalFetch = global.fetch;
const FLOW_ID = "2244981489363579";

const scenario: ScenarioSummary = {
  _id: "scenario-1",
  name: "Обновленные дожимы",
  description: "",
  status: "draft",
  mode: "conversation",
  priority: 0,
  presetId: null,
  presetVersion: null,
  segmentKey: null,
  matchingRole: "default",
  entryPolicy: "once_per_conversation",
  linkedParentScenarioIds: [],
  nodeCount: 1,
  edgeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const medalNode = {
  id: "node-medal",
  type: "actionNode",
  position: { x: 0, y: 0 },
  data: {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "medal_pick_1",
    actionWhatsAppTemplateLanguage: "kk",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "Таңдау",
            flow_id: Number(FLOW_ID),
            flow_action: "NAVIGATE",
            navigate_screen: "QUESTION_ONE",
          },
        ],
      },
    ],
  },
} as unknown as ScenarioFlowNode;

function renderGuard(
  workspaceId: string,
  saveScenarioSettings = jest.fn(() => true)
) {
  return renderHook(() =>
    useScenarioActivationImpactGuard({
      workspaceId,
      activeScenario: scenario,
      activeScenarioName: scenario.name,
      activeScenarioStatus: "draft",
      activeScenarioNodes: [medalNode],
      activeScenarioEdges: [],
      scenarios: [scenario],
      whatsAppTemplates: [],
      saveScenarioSettings,
      t: key => key,
    })
  );
}

afterEach(() => {
  global.fetch = originalFetch;
});

it("opens the activation dialog at once and adds a warning when a template Flow can't open", async () => {
  let respond: (value: unknown) => void = () => undefined;
  global.fetch = jest.fn(
    () =>
      new Promise(resolve => {
        respond = resolve;
      })
  ) as unknown as typeof fetch;
  const saveScenarioSettings = jest.fn(() => true);
  const { result } = renderGuard("ws-activation-flow", saveScenarioSettings);

  await act(async () => {
    await result.current.saveScenarioSettingsWithActivationGuard({
      scenarioId: "scenario-1",
      status: "active",
      priority: 0,
    });
  });

  expect(result.current.pendingActivationImpact?.impact.pendingChecks).toBe(
    true
  );

  await act(async () => {
    respond({
      ok: true,
      status: 200,
      json: async () => ({
        facts: [
          {
            flowId: FLOW_ID,
            state: "found",
            name: "Message templates_medal_pick_1_MARKETING_9b1bc",
            status: "PUBLISHED",
            screenIds: ["SURVEY_FORM"],
            checkedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });

  await waitFor(() => {
    expect(result.current.pendingActivationImpact?.impact.pendingChecks).toBe(
      false
    );
  });
  expect(result.current.pendingActivationImpact?.impact.issues).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      title: "activationImpactTemplateFlowTitle",
      description: "flowHealth.screenMissing:QUESTION_ONE",
    })
  );

  // Warnings never block: confirming still activates.
  act(() => {
    result.current.confirmActivationImpact();
  });
  expect(saveScenarioSettings).toHaveBeenCalledWith({
    scenarioId: "scenario-1",
    status: "active",
    priority: 0,
  });
});

it("lists reply-button differences at once, without asking Meta", async () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  const replyButtons = (...texts: string[]) =>
    [
      { type: "BODY", text: "Which plan do you want?" },
      {
        type: "BUTTONS",
        buttons: texts.map(text => ({ type: "QUICK_REPLY", text })),
      },
    ] as WhatsAppComponent[];
  const planNode = {
    id: "node-plan",
    type: "actionNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "pick_plan",
      actionWhatsAppTemplateLanguage: "en",
      actionWhatsAppTemplateComponents: replyButtons("Basic", "Premium"),
    },
  } as unknown as ScenarioFlowNode;
  const saveScenarioSettings = jest.fn(() => true);
  const { result } = renderHook(() =>
    useScenarioActivationImpactGuard({
      workspaceId: "ws-activation-buttons",
      activeScenario: scenario,
      activeScenarioName: scenario.name,
      activeScenarioStatus: "draft",
      activeScenarioNodes: [planNode],
      activeScenarioEdges: [
        {
          id: "plan-premium",
          source: "node-plan",
          sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(1),
          target: "premium-follow-up",
        },
      ],
      scenarios: [scenario],
      whatsAppTemplates: [
        {
          name: "pick_plan",
          language: "en",
          status: "APPROVED",
          components: replyButtons("Basic"),
        },
      ] satisfies ScenarioWhatsAppTemplate[],
      saveScenarioSettings,
      t: key => key,
    })
  );

  await act(async () => {
    await result.current.saveScenarioSettingsWithActivationGuard({
      scenarioId: "scenario-1",
      status: "active",
      priority: 0,
    });
  });

  const impact = result.current.pendingActivationImpact?.impact;
  expect(impact?.pendingChecks).toBeUndefined();
  expect(impact?.issues).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      title: "activationImpactTemplateButtonsTitle",
      description: "whatsappTemplateButtonDriftRemoved",
    })
  );
  expect(fetchMock).not.toHaveBeenCalled();

  // Warnings never block: confirming still activates.
  act(() => {
    result.current.confirmActivationImpact();
  });
  expect(saveScenarioSettings).toHaveBeenCalledTimes(1);
});

it("finishes the check without warnings when Meta can't be reached", async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
  const { result } = renderGuard("ws-activation-offline");

  await act(async () => {
    await result.current.saveScenarioSettingsWithActivationGuard({
      scenarioId: "scenario-1",
      status: "active",
      priority: 0,
    });
  });

  await waitFor(() => {
    expect(result.current.pendingActivationImpact?.impact.pendingChecks).toBe(
      false
    );
  });
  expect(
    result.current.pendingActivationImpact?.impact.issues.filter(
      issue => issue.severity === "warning"
    )
  ).toEqual([]);
});

it("confirms success and refreshes the setup checklist only after the save lands", async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
  mockToastSuccess.mockClear();
  mockSwrMutate.mockClear();
  let finishSave: (saved: boolean) => void = () => undefined;
  const saveScenarioSettings = jest.fn(
    () =>
      new Promise<boolean>(resolve => {
        finishSave = resolve;
      })
  );
  const { result } = renderGuard("ws-activation-success", saveScenarioSettings);

  await act(async () => {
    await result.current.saveScenarioSettingsWithActivationGuard({
      scenarioId: "scenario-1",
      status: "active",
      priority: 0,
    });
  });
  let confirmed: Promise<void> | undefined;
  act(() => {
    confirmed = result.current.confirmActivationImpact();
  });
  expect(mockToastSuccess).not.toHaveBeenCalled();

  await act(async () => {
    finishSave(true);
    await confirmed;
  });
  expect(mockToastSuccess).toHaveBeenCalledWith("scenarioActivatedToast");
  expect(mockSwrMutate).toHaveBeenCalledWith(
    "/api/workspaces/ws-activation-success/onboarding"
  );
});

it("says nothing when the server refuses the activation", async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
  mockToastSuccess.mockClear();
  mockSwrMutate.mockClear();
  const { result } = renderGuard(
    "ws-activation-refused",
    jest.fn(() => false)
  );

  await act(async () => {
    await result.current.saveScenarioSettingsWithActivationGuard({
      scenarioId: "scenario-1",
      status: "active",
      priority: 0,
    });
  });
  await act(async () => {
    await result.current.confirmActivationImpact();
  });
  expect(mockToastSuccess).not.toHaveBeenCalled();
  expect(mockSwrMutate).not.toHaveBeenCalled();
});
