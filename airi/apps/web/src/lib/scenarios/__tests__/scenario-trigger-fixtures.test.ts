import {
  makeClientMessageTriggerNode,
  makeLegacyPersistedTrigger,
} from "./scenario-trigger-fixtures";

describe("makeClientMessageTriggerNode", () => {
  it("keeps canonical defaults when an optional override is undefined", () => {
    const first = makeClientMessageTriggerNode({
      triggerConfig: { enabled: undefined },
    });
    const second = makeClientMessageTriggerNode();
    const legacy = makeLegacyPersistedTrigger("customer_message_contains", {
      enabled: undefined,
    });

    expect(first.triggerConfig!.enabled).toBe(true);
    expect(legacy.triggerConfig).toEqual({ enabled: true });

    first.triggerConfig!.enabled = false;

    expect(first).not.toHaveProperty("triggerType");
    expect(second.triggerConfig).toEqual({
      enabled: true,
      messageMatchMode: "any",
      keywordMatchMode: "contains",
    });
  });
});
