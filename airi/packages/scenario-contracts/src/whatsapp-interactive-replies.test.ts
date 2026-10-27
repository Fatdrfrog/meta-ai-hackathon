import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  listWhatsAppTemplateQuickReplyButtons,
  normalizeWhatsAppTemplateFlowId,
  parseWhatsAppTemplateButtonSourceHandleId,
  readSingleWhatsAppTemplateFlowButton,
  readSingleWhatsAppTemplateFlowButtonFlowId,
  whatsAppTemplateOffersFormSubmittedRoute,
} from "./index.ts";

/** medal_pick_1's Flow; the saved template holds it as a BSON double. */
const MEDAL_FLOW_ID = 2244981489363579;

function template(...buttons: Array<Record<string, unknown>>) {
  return [
    { type: "BODY", text: "Tell us about your sport" },
    { type: "BUTTONS", buttons },
  ];
}

function flowButton(flowId: unknown): Record<string, unknown> {
  return { type: "FLOW", text: "Fill in", flow_id: flowId };
}

function quickReply(text: string): Record<string, unknown> {
  return { type: "QUICK_REPLY", text };
}

describe("a template's single FLOW button", () => {
  it("reads a Flow id saved as a number as its whole digits", () => {
    assert.equal(
      readSingleWhatsAppTemplateFlowButtonFlowId(
        template(flowButton(MEDAL_FLOW_ID)),
      ),
      "2244981489363579",
    );
  });

  it("trims a Flow id saved as text, next to quick replies", () => {
    assert.equal(
      readSingleWhatsAppTemplateFlowButtonFlowId(
        template(quickReply("Ask a manager"), flowButton(" 123 ")),
      ),
      "123",
    );
  });

  it("reads nothing unless exactly one FLOW button names its Flow by id", () => {
    const cases: Array<[string, unknown]> = [
      ["no buttons", [{ type: "BODY", text: "Hello" }]],
      ["no FLOW button", template(quickReply("Yes"), quickReply("No"))],
      ["two FLOW buttons", template(flowButton("1"), flowButton("2"))],
      [
        "two FLOW buttons, one Flow",
        template(flowButton("1"), flowButton("1")),
      ],
      [
        "FLOW buttons in two BUTTONS components",
        [...template(flowButton("1")), ...template(flowButton("2"))],
      ],
      [
        "a FLOW button with only a Flow name",
        template({
          type: "FLOW",
          text: "Fill in",
          flow_name: "demoshop_ai_case",
        }),
      ],
      ["a FLOW button with a blank Flow id", template(flowButton("  "))],
      ["no components", undefined],
      ["components that are not a list", { type: "BUTTONS" }],
    ];
    for (const [name, components] of cases) {
      assert.equal(
        readSingleWhatsAppTemplateFlowButtonFlowId(components),
        null,
        name,
      );
    }
  });

  it("reads the button's label with its Flow", () => {
    assert.deepEqual(
      readSingleWhatsAppTemplateFlowButton(
        template(quickReply("Ask a manager"), flowButton(MEDAL_FLOW_ID)),
      ),
      { flowId: "2244981489363579", text: "Fill in" },
    );
    assert.deepEqual(
      readSingleWhatsAppTemplateFlowButton(
        template({ type: "FLOW", text: 7, flow_id: "123" }),
      ),
      { flowId: "123", text: "" },
    );
    assert.equal(
      readSingleWhatsAppTemplateFlowButton(
        template(flowButton("1"), flowButton("2")),
      ),
      null,
    );
  });

  it("keeps the editor's Flow id text", () => {
    assert.equal(normalizeWhatsAppTemplateFlowId(12345.9), "12345");
    assert.equal(normalizeWhatsAppTemplateFlowId(" flow-1 "), "flow-1");
    assert.equal(normalizeWhatsAppTemplateFlowId(true), "");
    assert.equal(normalizeWhatsAppTemplateFlowId(null), "");
  });
});

describe("the Form submitted route", () => {
  it("has its own handle, which is no template button's", () => {
    assert.equal(
      ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
      "right-source-whatsapp-template-form-submitted",
    );
    assert.equal(
      isWhatsAppTemplateFormSubmittedSourceHandleId(
        ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
      ),
      true,
    );
    for (const handle of [
      `${ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID}::0`,
      buildWhatsAppTemplateButtonSourceHandleId(0),
      "right-source",
      "",
      null,
      undefined,
    ]) {
      assert.equal(
        isWhatsAppTemplateFormSubmittedSourceHandleId(handle),
        false,
        String(handle),
      );
    }
    assert.equal(
      parseWhatsAppTemplateButtonSourceHandleId(
        ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
      ),
      null,
    );
  });

  it("is offered on a template step whose one FLOW button opens a Flow", () => {
    const step = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: template(
        quickReply("Ask a manager"),
        flowButton(MEDAL_FLOW_ID),
      ),
    };
    assert.equal(whatsAppTemplateOffersFormSubmittedRoute(step), true);
    // The builder's type change leaves the message key, set to undefined.
    assert.equal(
      whatsAppTemplateOffersFormSubmittedRoute({
        ...step,
        actionWhatsAppServiceMessage: undefined,
      }),
      true,
    );
    // The FLOW button gets no quick-reply route of its own.
    assert.deepEqual(
      listWhatsAppTemplateQuickReplyButtons(
        step.actionWhatsAppTemplateComponents,
      ).map((button) => button.label),
      ["Ask a manager"],
    );

    const cases: Array<[string, unknown]> = [
      [
        "quick replies only",
        {
          ...step,
          actionWhatsAppTemplateComponents: template(quickReply("Yes")),
        },
      ],
      [
        "two FLOW buttons",
        {
          ...step,
          actionWhatsAppTemplateComponents: template(
            flowButton("1"),
            flowButton("2"),
          ),
        },
      ],
      [
        "a service message",
        {
          ...step,
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Hi" },
              previewUrl: false,
            },
          },
        },
      ],
      [
        "a saved null service message",
        { ...step, actionWhatsAppServiceMessage: null },
      ],
      ["another action", { ...step, actionType: "reply" }],
      ["not an action", { ...step, kind: "condition" }],
      ["no data", null],
    ];
    for (const [name, data] of cases) {
      assert.equal(whatsAppTemplateOffersFormSubmittedRoute(data), false, name);
    }
  });
});
