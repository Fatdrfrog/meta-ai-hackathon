describe("airi public facades", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  });

  it("keeps the engine facade bound to the canonical coach and reply entrypoints", async () => {
    const [publicEngine, canonicalCoachEngine, canonicalReplyGeneration] =
      await Promise.all([
        import("@/lib/airi/engine"),
        import("@/lib/airi/coach/engine"),
        import("@/lib/airi/reply/generation/reply-generation"),
      ]);

    expect(publicEngine.SimpleCoachEngine).toBe(
      canonicalCoachEngine.SimpleCoachEngine
    );
    expect(publicEngine.simpleCoachEngine).toBe(
      canonicalCoachEngine.simpleCoachEngine
    );
    expect(publicEngine.generateAssistantReply).toBe(
      canonicalReplyGeneration.generateAssistantReply
    );
    expect(canonicalCoachEngine).not.toHaveProperty("generateAssistantReply");
  });
});
