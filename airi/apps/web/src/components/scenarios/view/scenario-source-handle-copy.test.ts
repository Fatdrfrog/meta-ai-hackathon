import {
  getLocationRouteSourceHandleCopy,
  resolveAnyReplyLabel,
  resolveScenarioSourceHandleCopy,
} from "./scenario-source-handle-copy";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
  ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
  buildScenarioActionLocationRouteOutcomeHandleId,
  DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  GENERATIVE_AI_FAILURE_HANDLE,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import type { TranslateFn } from "../types";

const t: TranslateFn = (key, values) =>
  values?.label === undefined ? key : `${key}:${String(values.label)}`;

function copyFor(data: ScenarioNodeData, sourceHandleId: string) {
  return resolveScenarioSourceHandleCopy({
    sourceNode: {
      id: "action-1",
      type: "action",
      position: { x: 0, y: 0 },
      data,
    },
    sourceHandleId,
    t,
  });
}

const sameCopy = (label: string) => ({ label, tooltip: label });

describe("resolveScenarioSourceHandleCopy", () => {
  it("uses the canonical service-message transition option label", () => {
    const payload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "service-1",
      choiceId: "pricing",
    });

    expect(
      resolveScenarioSourceHandleCopy({
        sourceNode: {
          id: "service-1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "list",
                body: { mode: "fixed", text: "Choose" },
                buttonLabel: "View",
                sections: [
                  {
                    id: "plans",
                    rows: [{ id: payload, title: "Pricing" }],
                  },
                ],
              },
            },
          },
        },
        sourceHandleId: buildWhatsAppSessionChoiceSourceHandleId(payload),
        t: (key, values) => `${key}:${String(values?.label ?? "")}`,
      })
    ).toEqual(sameCopy("sourceHandleWhatsAppChoice:Pricing"));
  });

  it("uses the exact WhatsApp Flow option label", () => {
    expect(
      resolveScenarioSourceHandleCopy({
        sourceNode: {
          id: "flow-action",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Choose a plan" },
                flowConfig: {
                  templateId: "flow-1",
                  ctaText: "Open",
                  screens: [
                    {
                      id: "plans",
                      title: "Plans",
                      fields: [
                        {
                          id: "plan",
                          label: "Choose a plan",
                          fieldType: "RadioButtonsGroup",
                          options: [{ id: "pro", title: "Professional" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        sourceHandleId: buildFlowBranchSourceHandleId("plan", "pro"),
        t: (key, values) => `${key}:${String(values?.label ?? "")}`,
      })
    ).toEqual(sameCopy("sourceHandleFlowOption:Professional"));
  });

  it("does not describe stale Flow branch data owned by an unsupported action", () => {
    expect(
      resolveScenarioSourceHandleCopy({
        sourceNode: {
          id: "unsupported-flow-action",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 99,
              message: { kind: "future" },
            } as never,
            actionFlowConfig: {
              templateId: "stale-flow",
              ctaText: "Open",
              screens: [
                {
                  id: "plans",
                  title: "Plans",
                  fields: [
                    {
                      id: "plan",
                      label: "Choose a plan",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "pro", title: "Professional" }],
                    },
                  ],
                },
              ],
            },
          },
        },
        sourceHandleId: buildFlowBranchSourceHandleId("plan", "pro"),
        t: (key, values) => `${key}:${String(values?.label ?? "")}`,
      })
    ).toBeNull();
  });

  it("does not describe stale template branch data owned by a reply action", () => {
    expect(
      resolveScenarioSourceHandleCopy({
        sourceNode: {
          id: "reply-action",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppTemplateComponents: [
              { type: "BODY", text: "Choose" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Pricing" }],
              },
            ],
          },
        },
        sourceHandleId: buildWhatsAppTemplateButtonSourceHandleId(0),
        t: (key, values) => `${key}:${String(values?.label ?? "")}`,
      })
    ).toBeNull();
  });

  describe("shares the route wording of the canvas", () => {
    const replyButtons: ScenarioNodeData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [
            { id: "wsc:action-1:yes", label: "Yes" },
            { id: "wsc:action-1:draft", label: "" },
          ],
        },
      },
    };

    it("says the customer taps a reply button, and names an unnamed one without its id", () => {
      expect(
        copyFor(
          replyButtons,
          buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:yes")
        )
      ).toEqual(sameCopy("sourceHandleWhatsAppButton:Yes"));
      expect(
        copyFor(
          replyButtons,
          buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:draft")
        )
      ).toEqual(sameCopy("sourceHandleWhatsAppButton:untitledButton"));
    });

    it("says the customer taps a Telegram button", () => {
      expect(
        copyFor(
          {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
          },
          buildTelegramBranchSourceHandleId("yes")
        )
      ).toEqual(sameCopy("sourceHandleTelegramButton:Yes"));
    });

    it("names reply outcomes Any reply or Other reply", () => {
      expect(
        copyFor(
          {
            kind: "action",
            actionType: "reply",
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          },
          ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
        )
      ).toEqual(sameCopy("actionOutcomeAnyReply"));
      expect(
        copyFor(
          {
            ...replyButtons,
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          },
          ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
        )
      ).toEqual(sameCopy("actionOutcomeOtherReply"));
    });

    it("says whether an answer rule matches words or meaning", () => {
      const data: ScenarioNodeData = {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          answerMatches: [
            { id: "yes", text: "yes", mode: "exact" },
            { id: "price", text: "", mode: "intent" },
          ],
        },
      };
      expect(
        copyFor(data, buildScenarioActionAnswerOutcomeHandleId("yes"))
      ).toEqual(sameCopy("sourceHandleConditionAnswerMatch:yes"));
      expect(
        copyFor(data, buildScenarioActionAnswerOutcomeHandleId("price"))
      ).toEqual(
        sameCopy(
          "sourceHandleConditionAnswerMeaning:sourceHandleConditionAnswerMatchAny"
        )
      );
    });

    it("names the default output as its route row does", () => {
      expect(
        copyFor({ kind: "action", actionType: "reply" }, "right-source")
      ).toEqual(sameCopy("actionPortNextStep"));
      const serviceText: ScenarioNodeData = {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
        },
      };
      expect(copyFor(serviceText, "right-source")).toEqual(
        sameCopy("serviceRouteNextMessage")
      );
      expect(
        copyFor(
          {
            ...serviceText,
            actionOutcomes: { version: 1, anyReply: { enabled: true } },
          },
          "right-source"
        )
      ).toEqual(sameCopy("actionPortNextStep"));
      expect(
        copyFor(
          {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateComponents: [
              { type: "BODY", text: "Choose" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Track" }],
              },
            ],
          },
          "right-source"
        )
      ).toEqual(sameCopy("sourceHandleAnyUserReply"));
    });

    it("names a template's Form submitted route as its row does", () => {
      expect(
        copyFor(
          {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "FLOW",
                    text: "Open form",
                    flow_id: 1571793974235171,
                  },
                ],
              },
            ],
          },
          ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
        )
      ).toEqual(sameCopy("serviceRouteFlowSubmitted"));
    });

    it("names the card of a template carousel's quick reply", () => {
      const card = (text: string) => ({
        components: [
          { type: "HEADER" as const, format: "IMAGE" as const },
          { type: "BODY" as const, text },
          {
            type: "BUTTONS" as const,
            buttons: [{ type: "QUICK_REPLY" as const, text: "Interested" }],
          },
        ],
      });
      const copy = copyFor(
        {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Fall 2026" },
            { type: "CAROUSEL", cards: [card("Blazer"), card("Coat")] },
          ],
        },
        buildWhatsAppTemplateButtonSourceHandleId(110)
      );

      expect(copy?.label).toContain("whatsappTemplateBindingCard · Interested");
    });

    it("names the AI step results", () => {
      expect(
        copyFor(
          {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "text_to_image",
              prompt: "Poster",
            },
          },
          GENERATIVE_AI_FAILURE_HANDLE
        )
      ).toEqual(sameCopy("generativeAIFailure"));
    });

    describe("names location routes", () => {
      const tJson: TranslateFn = (key, values) =>
        values ? `${key}${JSON.stringify(values)}` : key;
      const locationStep = (
        locationRoutes: NonNullable<
          ScenarioNodeData["actionOutcomes"]
        >["locationRoutes"]
      ): ScenarioNodeData => ({
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 2,
          anyReply: { enabled: true },
          locationRoutes,
        },
      });
      const locationCopy = (data: ScenarioNodeData, sourceHandleId: string) =>
        resolveScenarioSourceHandleCopy({
          sourceNode: {
            id: "action-1",
            type: "action",
            position: { x: 0, y: 0 },
            data,
          },
          sourceHandleId,
          t: tJson,
        });
      const route = (routeId: string) =>
        buildScenarioActionLocationRouteOutcomeHandleId(routeId);
      const grouped = locationStep({
        routes: [
          {
            id: "kz",
            label: "Kazakhstan",
            match: { by: "country", values: ["KZ"] },
          },
          {
            id: "cities",
            match: { by: "city", values: ["KZ:almaty", "UZ:tashkent"] },
          },
          { id: "draft", match: { by: "tag", values: [] } },
        ],
        outside: { maxDistanceKm: 250 },
      });

      it("names a group by its label, else by its values", () => {
        expect(locationCopy(grouped, route("kz"))).toEqual(
          sameCopy('actionOutcomeLocationRoute{"label":"Kazakhstan"}')
        );
        expect(locationCopy(grouped, route("cities"))).toEqual(
          sameCopy('actionOutcomeLocationRoute{"label":"almaty, tashkent"}')
        );
        expect(locationCopy(grouped, route("draft"))).toEqual(
          sameCopy("actionOutcomeLocationRouteEmpty")
        );
        expect(locationCopy(grouped, route("deleted"))).toEqual(
          sameCopy("actionOutcomeLocationRouteEmpty")
        );
      });

      it("says Any other office next to groups and Office found without them", () => {
        expect(
          locationCopy(grouped, ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID)
        ).toEqual(sameCopy("actionOutcomeLocationAnyOffice"));
        expect(
          locationCopy(
            locationStep({ routes: [] }),
            ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID
          )
        ).toEqual(sameCopy("actionOutcomeLocationOfficeFound"));
      });

      it("names the cutoff with its distance", () => {
        expect(
          locationCopy(grouped, ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID)
        ).toEqual(sameCopy('actionOutcomeLocationOutside{"km":250}'));
        expect(
          locationCopy(
            locationStep({ routes: [], outside: { maxDistanceKm: 0.2 } }),
            ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID
          )
        ).toEqual(sameCopy('actionOutcomeLocationOutside{"km":1}'));
      });

      it("shares the names with the drawer's helper", () => {
        expect(
          getLocationRouteSourceHandleCopy(tJson, undefined, {
            type: "location_outside",
          })
        ).toEqual(
          sameCopy(
            `actionOutcomeLocationOutside{"km":${DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM}}`
          )
        );
        expect(
          getLocationRouteSourceHandleCopy(tJson, undefined, {
            type: "location_any_office",
          })
        ).toEqual(sameCopy("actionOutcomeLocationOfficeFound"));
      });

      it("calls the reply route Other reply beside location routes", () => {
        expect(resolveAnyReplyLabel(locationStep({ routes: [] }), tJson)).toBe(
          "actionOutcomeOtherReply"
        );
        expect(
          locationCopy(
            locationStep({ routes: [] }),
            ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
          )
        ).toEqual(sameCopy("actionOutcomeOtherReply"));
        expect(
          resolveAnyReplyLabel(
            {
              kind: "action",
              actionType: "reply",
              actionOutcomes: { version: 1, anyReply: { enabled: true } },
            },
            tJson
          )
        ).toBe("actionOutcomeAnyReply");
      });
    });

    it("names legacy reply checks with the same words", () => {
      const condition: ScenarioNodeData = {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [
          {
            id: "no-reply",
            type: "no_reply_timeout",
            answerMatchRules: [{ id: "later", text: "later", mode: "intent" }],
          },
        ],
      } as ScenarioNodeData;
      expect(
        copyFor(condition, getPostActionConditionHandleId("user_replied"))
      ).toEqual(sameCopy("sourceHandleConditionUserReplied"));
      expect(
        copyFor(condition, getPostActionAnswerMatchHandleId("later"))
      ).toEqual(sameCopy("sourceHandleConditionAnswerMeaning:later"));
    });
  });
});
