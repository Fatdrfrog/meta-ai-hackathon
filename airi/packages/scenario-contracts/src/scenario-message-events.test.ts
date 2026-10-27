import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isScenarioInboundTriggerEventKind,
  isScenarioInteractiveReplyEventKind,
  isScenarioMessageIngressEventKind,
  isScenarioPostActionEventKind,
  isScenarioQuickReplyEventKind,
} from "./scenario-message-events.ts";

describe("scenario message event predicates", () => {
  it("recognizes quick replies without treating flow replies as quick replies", () => {
    assert.equal(isScenarioQuickReplyEventKind("telegram_quick_reply"), true);
    assert.equal(isScenarioQuickReplyEventKind("instagram_quick_reply"), true);
    assert.equal(isScenarioQuickReplyEventKind("whatsapp_button_reply"), true);
    assert.equal(isScenarioQuickReplyEventKind("whatsapp_flow_reply"), false);
  });

  it("recognizes every interactive reply kind", () => {
    assert.equal(
      isScenarioInteractiveReplyEventKind("telegram_quick_reply"),
      true,
    );
    assert.equal(
      isScenarioInteractiveReplyEventKind("instagram_quick_reply"),
      true,
    );
    assert.equal(
      isScenarioInteractiveReplyEventKind("whatsapp_button_reply"),
      true,
    );
    assert.equal(
      isScenarioInteractiveReplyEventKind("whatsapp_flow_reply"),
      true,
    );
  });

  it("accepts only message ingress kinds at the ingress boundary", () => {
    assert.equal(isScenarioMessageIngressEventKind("inbound_message"), true);
    assert.equal(
      isScenarioMessageIngressEventKind(" whatsapp_flow_reply "),
      true,
    );
    assert.equal(isScenarioMessageIngressEventKind("payment_detected"), false);
    assert.equal(
      isScenarioMessageIngressEventKind("no_human_reply_timeout"),
      false,
    );
    assert.equal(
      isScenarioMessageIngressEventKind("post_action_user_reply"),
      false,
    );
    assert.equal(isScenarioMessageIngressEventKind(null), false);
    assert.equal(isScenarioInboundTriggerEventKind("inbound_message"), true);
  });

  it("accepts only continuation events at the post-action boundary", () => {
    assert.equal(isScenarioPostActionEventKind("payment_detected"), true);
    assert.equal(isScenarioPostActionEventKind("no_human_reply_timeout"), true);
    assert.equal(isScenarioPostActionEventKind("post_action_user_reply"), true);
    assert.equal(isScenarioPostActionEventKind("inbound_message"), false);
    assert.equal(isScenarioPostActionEventKind("whatsapp_flow_reply"), false);
    assert.equal(isScenarioPostActionEventKind(null), false);
  });
});
