/**
 * @jest-environment node
 */

import {
  WhatsAppFlowSourceBindingFence,
  WHATSAPP_FLOW_SOURCE_BINDING_FENCE_INDEXES,
} from "./whatsapp-flow-source-binding-fence";

describe("WhatsAppFlowSourceBindingFence", () => {
  it("uses one durable source-scoped record with a monotonic fence", () => {
    expect(WhatsAppFlowSourceBindingFence.collection.collectionName).toBe(
      "whatsapp_flow_source_binding_fences"
    );
    expect(WhatsAppFlowSourceBindingFence.schema.get("strict")).toBe("throw");
    expect(WhatsAppFlowSourceBindingFence.schema.get("versionKey")).toBe(false);
    expect(
      WhatsAppFlowSourceBindingFence.schema.path("fence")?.options.validate
    ).toBe(Number.isSafeInteger);
    expect(
      WhatsAppFlowSourceBindingFence.schema.path("kind")?.options.enum
    ).toEqual(["PROVISIONING", "REBIND"]);
  });

  it("declares every production index exactly once", () => {
    expect(WhatsAppFlowSourceBindingFence.schema.indexes()).toEqual(
      WHATSAPP_FLOW_SOURCE_BINDING_FENCE_INDEXES.map(index => [
        index.key,
        index.options,
      ])
    );
  });
});
