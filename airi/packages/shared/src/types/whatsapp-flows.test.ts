import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeWhatsAppFlowActionData,
  normalizeWhatsAppFlowCategories,
  pickWhatsAppInteractiveFlowIdentity,
  pickWhatsAppTemplateFlowIdentifier,
  WHATSAPP_FLOW_DEFAULT_CATEGORY,
  WHATSAPP_FLOW_MESSAGE_VERSION,
} from "./whatsapp-flows";

describe("normalizeWhatsAppFlowCategories", () => {
  it("keeps known categories and falls back to OTHER", () => {
    assert.deepEqual(normalizeWhatsAppFlowCategories(["LEAD_GENERATION"]), [
      "LEAD_GENERATION",
    ]);
    assert.deepEqual(normalizeWhatsAppFlowCategories(["nope"]), [
      WHATSAPP_FLOW_DEFAULT_CATEGORY,
    ]);
    assert.deepEqual(normalizeWhatsAppFlowCategories(undefined), [
      WHATSAPP_FLOW_DEFAULT_CATEGORY,
    ]);
  });
});

describe("pickWhatsAppTemplateFlowIdentifier", () => {
  it("requires exactly one of flow_id, flow_name, or flow_json", () => {
    assert.deepEqual(
      pickWhatsAppTemplateFlowIdentifier({ flow_id: "123" }),
      { kind: "flow_id", flow_id: "123" },
    );
    assert.deepEqual(
      pickWhatsAppTemplateFlowIdentifier({ flow_name: "booking" }),
      { kind: "flow_name", flow_name: "booking" },
    );
    assert.deepEqual(
      pickWhatsAppTemplateFlowIdentifier({
        flow_json: '{"version":"5.0","screens":[]}',
      }),
      { kind: "flow_json", flow_json: '{"version":"5.0","screens":[]}' },
    );
    assert.equal(
      pickWhatsAppTemplateFlowIdentifier({
        flow_id: "123",
        flow_name: "booking",
      }),
      null,
    );
    assert.equal(pickWhatsAppTemplateFlowIdentifier({}), null);
  });
});

describe("pickWhatsAppInteractiveFlowIdentity", () => {
  it("accepts flow_id or flow_name, not both", () => {
    assert.deepEqual(
      pickWhatsAppInteractiveFlowIdentity({ flow_id: 99 }),
      { kind: "flow_id", flow_id: "99" },
    );
    assert.deepEqual(
      pickWhatsAppInteractiveFlowIdentity({ flow_name: "booking" }),
      { kind: "flow_name", flow_name: "booking" },
    );
    assert.equal(
      pickWhatsAppInteractiveFlowIdentity({
        flow_id: "1",
        flow_name: "booking",
      }),
      null,
    );
    assert.equal(WHATSAPP_FLOW_MESSAGE_VERSION, "3");
  });
});

describe("normalizeWhatsAppFlowActionData", () => {
  it("parses JSON strings and drops empty objects", () => {
    assert.deepEqual(
      normalizeWhatsAppFlowActionData(
        '{"product_name":"name","product_price":100}',
      ),
      { product_name: "name", product_price: 100 },
    );
    assert.deepEqual(normalizeWhatsAppFlowActionData({ sku: "1" }), {
      sku: "1",
    });
    assert.equal(normalizeWhatsAppFlowActionData("{}"), undefined);
    assert.equal(normalizeWhatsAppFlowActionData("not-json"), undefined);
  });
});
