import type { ScenarioNodeData } from "../types";
import { collectActivationBlockedNodes } from "./scenario-activation-impact";
import { buildGuidedScenarioSeed } from "./scenario-guided-create";

const t = (key: string) => key;

function findActionData(seed: ReturnType<typeof buildGuidedScenarioSeed>) {
  return seed.initialFlow.nodes.find(node => node.data?.kind === "action")
    ?.data as ScenarioNodeData;
}

describe("scenario-guided-create", () => {
  it.each(["entry", "keyword", "fallback", "blank"] as const)(
    "creates a %s starter that passes the activation checks as created",
    kind => {
      const seed = buildGuidedScenarioSeed({ kind, t });
      expect(
        collectActivationBlockedNodes(
          seed.initialFlow.nodes as Array<{
            id: string;
            data: ScenarioNodeData;
          }>
        )
      ).toEqual([]);
    }
  );

  it("writes the starter reply into the WhatsApp message body", () => {
    const action = findActionData(
      buildGuidedScenarioSeed({ kind: "entry", t })
    );

    expect(action.actionWhatsAppServiceMessage?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "guidedStarterReplyEntry" },
    });
    // Save clears fields a WhatsApp message does not own; none are set here.
    expect(action.actionReplyMode).toBeUndefined();
    expect(action.actionReplyText).toBeUndefined();
  });

  it("replies on the workspace's channel when WhatsApp is not connected", () => {
    const action = findActionData(
      buildGuidedScenarioSeed({
        kind: "fallback",
        t,
        connectedActionSources: ["telegram"],
      })
    );

    expect(action.actionWhatsAppServiceMessage).toBeUndefined();
    expect(action).toMatchObject({
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyChannel: "telegram",
      actionReplyText: "guidedStarterReplyFallback",
    });
  });

  it("builds an entry scenario with a new-customer any-message trigger", () => {
    const seed = buildGuidedScenarioSeed({
      kind: "entry",
      t,
    });

    const triggerNode = seed.initialFlow.nodes.find(
      node => node.data?.kind === "trigger"
    );

    expect(seed.name).toBe("createTypeEntryTitle");
    expect(triggerNode?.data).not.toHaveProperty("triggerType");
    expect(triggerNode?.data?.triggerConfig?.onlyNewCustomers).toBe(true);
  });

  it("builds a fallback scenario with fallback matching role", () => {
    const seed = buildGuidedScenarioSeed({
      kind: "fallback",
      t,
    });

    const triggerNode = seed.initialFlow.nodes.find(
      node => node.data?.kind === "trigger"
    );

    expect(seed.matchingRole).toBe("fallback");
    expect(triggerNode?.data).not.toHaveProperty("triggerType");
  });

  it("builds a keyword scenario as an incoming-message match mode", () => {
    const seed = buildGuidedScenarioSeed({
      kind: "keyword",
      t,
    });

    const triggerNode = seed.initialFlow.nodes.find(
      node => node.data?.kind === "trigger"
    );

    expect(triggerNode?.data).toMatchObject({
      triggerConfig: {
        enabled: true,
        messageMatchMode: "contains",
        keywordMatchMode: "contains",
        keywordPattern: "guidedStarterKeyword",
      },
    });
    expect(triggerNode?.data).not.toHaveProperty("triggerType");
  });
});
