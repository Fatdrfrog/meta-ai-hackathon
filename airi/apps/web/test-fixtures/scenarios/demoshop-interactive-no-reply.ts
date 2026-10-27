import {
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  buildFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";

import type { LegacyActionRoutingGraph } from "@/lib/scenarios/legacy-action-routing";
import {
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
} from "@icecore/scenario-contracts";

function flowAction(
  id: string,
  fieldId: string,
  optionId: string
): LegacyActionRoutingGraph["nodes"][number] {
  return {
    id,
    data: {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Choose an option" },
          flowConfig: {
            templateId: `fixture-${id}`,
            ctaText: "Open",
            screens: [
              {
                id: `screen-${id}`,
                title: "Choose",
                fields: [
                  {
                    id: fieldId,
                    label: "Choice",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: optionId, title: "Continue" }],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Anonymized shape of the two DemoShop dedicated assignments. */
export function createDemoShopInteractiveNoReplyFixture(): LegacyActionRoutingGraph {
  return {
    nodes: [
      flowAction("action-alpha", "choice-alpha", "continue-alpha"),
      {
        id: "legacy-alpha",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "whatsapp_flow",
          conditionBranches: [
            {
              id: "timeout-alpha",
              type: "no_reply_timeout",
              timeoutMinutes: 45,
              missingTextPhrases: ["cancel"],
            },
          ],
        },
      },
      flowAction("action-beta", "choice-beta", "continue-beta"),
      {
        id: "legacy-beta",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "whatsapp_flow",
          conditionBranches: [
            {
              id: "timeout-beta",
              type: "no_reply_timeout",
              timeoutMinutes: 90,
              answerMatchRules: [
                { id: "accept", mode: "exact", text: "Accept" },
                { id: "decline", mode: "exact", text: "Decline" },
              ],
            },
          ],
        },
      },
      {
        id: "flow-condition-shared",
        data: { kind: "logic", logicType: "post_action_condition" },
      },
      {
        id: "timeout-target-alpha",
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "timeout-target-beta",
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "accept-target-beta",
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "decline-target-beta",
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "flow-target-shared",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        id: "dedicated-alpha",
        source: "action-alpha",
        sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        target: "legacy-alpha",
      },
      {
        id: "timeout-alpha",
        source: "legacy-alpha",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        target: "timeout-target-alpha",
      },
      {
        id: "flow-alpha",
        source: "action-alpha",
        sourceHandle: buildFlowBranchSourceHandleId(
          "choice-alpha",
          "continue-alpha"
        ),
        target: "flow-condition-shared",
      },
      {
        id: "dedicated-beta",
        source: "action-beta",
        sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        target: "legacy-beta",
      },
      {
        id: "timeout-beta",
        source: "legacy-beta",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        target: "timeout-target-beta",
      },
      {
        id: "accept-beta",
        source: "legacy-beta",
        sourceHandle: getPostActionAnswerMatchHandleId("accept"),
        target: "accept-target-beta",
      },
      {
        id: "decline-beta",
        source: "legacy-beta",
        sourceHandle: getPostActionAnswerMatchHandleId("decline"),
        target: "decline-target-beta",
      },
      {
        id: "flow-beta",
        source: "action-beta",
        sourceHandle: buildFlowBranchSourceHandleId(
          "choice-beta",
          "continue-beta"
        ),
        target: "flow-condition-shared",
      },
      {
        id: "flow-shared-subtree",
        source: "flow-condition-shared",
        sourceHandle: getPostActionConditionHandleId("user_replied"),
        target: "flow-target-shared",
      },
    ],
  };
}
