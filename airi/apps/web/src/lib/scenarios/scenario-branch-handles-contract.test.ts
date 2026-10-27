import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  POST_ACTION_ANSWER_MATCH_HANDLE_PREFIX,
  POST_ACTION_CONDITION_HANDLE_PREFIX,
  SCENARIO_POST_ACTION_CONDITION_TYPES,
  buildFlowBranchSourceHandleId,
  buildPostActionAnswerMatchHandleId,
  buildPostActionConditionHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  isTelegramBranchSourceHandleId,
  isWhatsAppSessionChoiceSourceHandleId,
  parseFlowBranchSourceHandleId,
  parsePostActionAnswerMatchHandleId,
  parsePostActionConditionHandleId,
  parseTelegramBranchSourceHandleId,
  parseWhatsAppSessionChoiceSourceHandleId,
  parseWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";

describe("shared scenario branch handle contracts", () => {
  it("keeps stable persisted handle identifiers", () => {
    expect(ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID).toBe(
      "right-source-flow-branch"
    );
    expect(ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID).toBe(
      "right-source-telegram-branch"
    );
    expect(ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID).toBe(
      "right-source-whatsapp-session-choice-branch"
    );
    expect(ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID).toBe(
      "right-source-whatsapp-template-button-branch"
    );
    expect(ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID).toBe(
      "right-source-interactive-no-reply"
    );
    expect(BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID).toBe(
      "top-source-bulk-action"
    );
    expect(BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID).toBe("right-source");
  });

  it("round-trips encoded branch handles without importing UI modules", () => {
    const telegramPayload = "yes::kazakh & русский";
    const telegramHandle = buildTelegramBranchSourceHandleId(telegramPayload);
    expect(parseTelegramBranchSourceHandleId(telegramHandle)).toEqual({
      payload: telegramPayload,
    });
    expect(isTelegramBranchSourceHandleId(telegramHandle)).toBe(true);
    expect(
      isTelegramBranchSourceHandleId(ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID)
    ).toBe(true);

    const sessionPayload = "wa choice::premium";
    const sessionHandle =
      buildWhatsAppSessionChoiceSourceHandleId(sessionPayload);
    expect(parseWhatsAppSessionChoiceSourceHandleId(sessionHandle)).toEqual({
      payload: sessionPayload,
    });
    expect(isWhatsAppSessionChoiceSourceHandleId(sessionHandle)).toBe(true);
    expect(
      isWhatsAppSessionChoiceSourceHandleId(
        ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID
      )
    ).toBe(true);

    const flowHandle = buildFlowBranchSourceHandleId(
      "screen::field",
      "option/1"
    );
    expect(parseFlowBranchSourceHandleId(flowHandle)).toEqual({
      fieldId: "screen::field",
      optionId: "option/1",
    });

    const templateHandle = buildWhatsAppTemplateButtonSourceHandleId(2.9);
    expect(parseWhatsAppTemplateButtonSourceHandleId(templateHandle)).toEqual({
      buttonId: 2,
    });
  });

  it("keeps stable post-action condition handle identifiers", () => {
    expect(POST_ACTION_CONDITION_HANDLE_PREFIX).toBe("right-source-condition");
    expect(POST_ACTION_ANSWER_MATCH_HANDLE_PREFIX).toBe(
      "right-source-condition-answer"
    );
    expect(buildPostActionConditionHandleId("user_replied")).toBe(
      "right-source-condition-user_replied"
    );
    expect(buildPostActionConditionHandleId("payment_detected")).toBe(
      "right-source-condition-payment_detected"
    );
    expect(buildPostActionConditionHandleId("no_reply_timeout")).toBe(
      "right-source-condition-no_reply_timeout"
    );
    expect(
      parsePostActionConditionHandleId("right-source-condition-user_replied")
    ).toBe("user_replied");
    expect(
      parsePostActionConditionHandleId("right-source-condition-payment_detected")
    ).toBe("payment_detected");
    expect(
      parsePostActionConditionHandleId(
        "right-source-condition-no_reply_timeout"
      )
    ).toBe("no_reply_timeout");
    expect(parsePostActionConditionHandleId("right-source-condition-other")).toBe(
      null
    );

    expect(buildPostActionAnswerMatchHandleId("yes::pricing")).toBe(
      "right-source-condition-answer-yes_pricing"
    );
    expect(
      parsePostActionAnswerMatchHandleId(
        "right-source-condition-answer-yes_pricing"
      )
    ).toBe("yes_pricing");
    expect(parsePostActionAnswerMatchHandleId("right-source-condition-user_replied")).toBe(
      null
    );
    expect([...SCENARIO_POST_ACTION_CONDITION_TYPES]).toEqual([
      "user_replied",
      "payment_detected",
      "no_reply_timeout",
    ]);
  });
});
