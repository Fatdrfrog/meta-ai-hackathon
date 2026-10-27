import CrossStoreOutbox, {
  CROSS_STORE_OUTBOX_COMPLETED_RETENTION_SECONDS,
} from "./cross-store-outbox";

describe("CrossStoreOutbox", () => {
  it("owns one logical outbox row independent of mutable delivery status", () => {
    const uniqueIndex = CrossStoreOutbox.schema
      .indexes()
      .find(
        ([, options]) => options.name === "target_1_operation_1_dedupeKey_1"
      );

    expect(uniqueIndex).toEqual([
      { target: 1, operation: 1, dedupeKey: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(
      new CrossStoreOutbox({
        dedupeKey: "prompt-1",
        operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
        payload: {},
        status: "delivery_unknown",
        target: "whatsapp_cloud_api",
      }).validateSync()
    ).toBeUndefined();
  });

  it("expires only completed dedupe tombstones after the bounded replay window", () => {
    const ttlIndex = CrossStoreOutbox.schema
      .indexes()
      .find(([, options]) => options.name === "completedAt_1_completed_ttl");

    expect(CROSS_STORE_OUTBOX_COMPLETED_RETENTION_SECONDS).toBe(2_592_000);
    expect(ttlIndex).toEqual([
      { completedAt: 1 },
      expect.objectContaining({
        expireAfterSeconds: 2_592_000,
        name: "completedAt_1_completed_ttl",
        partialFilterExpression: { status: "completed" },
      }),
    ]);
  });
});
