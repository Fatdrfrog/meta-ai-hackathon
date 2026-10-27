import { validateBehaviorTriggers } from "./behavior-graph";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { projectActiveClientMessageFilters } from "./client-message-trigger-criteria";
import {
  matchesIncomingMessageTrigger,
  projectScenarioIngressContext,
} from "./incoming-message-trigger-matcher";
test("behavior entry cannot match a message, even with empty filters", () => {
  expect(
    matchesIncomingMessageTrigger(
      projectActiveClientMessageFilters({
        entryPointType: "customer_behavior",
        behavior: { preset: "win_back", delayMinutes: 100 },
      }),
      projectScenarioIngressContext({
        eventKind: "inbound_message",
        channel: "whatsapp",
        messageText: "hello",
      })
    )
  ).toBe(false);
});
test("activation requires a configured behavior event and an initial template", () => {
  const trigger: ScenarioNodeData = {
    kind: "trigger",
    triggerConfig: {
      entryPointType: "customer_behavior",
      behavior: { preset: "replenishment", delayMinutes: 43200 },
    },
  };
  const reply: ScenarioNodeData = {
    kind: "action",
    actionType: "reply",
    actionReplyText: "hello",
  };
  const nodes = [
    { id: "t", data: trigger },
    { id: "a", data: reply },
  ];
  expect(validateBehaviorTriggers(nodes, [{ source: "t", target: "a" }])).toBe(
    "behaviorTemplateRequired"
  );
  nodes[1]!.data = {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "repeat",
    actionWhatsAppTemplateLanguage: "ru",
  };
  expect(
    validateBehaviorTriggers(nodes, [{ source: "t", target: "a" }])
  ).toBeNull();
  trigger.triggerConfig!.behavior!.delayMinutes = -1;
  expect(validateBehaviorTriggers(nodes, [{ source: "t", target: "a" }])).toBe(
    "behaviorConfigInvalid"
  );
});
