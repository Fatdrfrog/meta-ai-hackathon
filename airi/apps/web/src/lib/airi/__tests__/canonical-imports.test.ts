jest.mock("@icecore/airi-runtime/mongoose", () => {
  const connectDB = jest
    .fn()
    .mockRejectedValue(new Error("Unexpected database access"));
  return { __esModule: true, default: connectDB, connectDB };
});

describe("airi canonical subtree imports", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  });

  it("loads the canonical reply subtree", async () => {
    const [entrypoint, intent, ragRuntime, dispatch, generation] =
      await Promise.all([
        import("@icecore/airi-runtime/auto-reply"),
        import("@/lib/airi/reply/runtime/intent"),
        import("@/lib/airi/reply/runtime/rag"),
        import("@/lib/airi/reply/runtime/dispatch"),
        import("@/lib/airi/reply/generation/reply-generation"),
      ]);

    expect(entrypoint.default).toBeDefined();
    expect(intent.runIntentFastPath).toBeInstanceOf(Function);
    expect(ragRuntime.runRagReplyFlow).toBeInstanceOf(Function);
    expect(dispatch.appendKbArticleLinksToReply).toBeInstanceOf(Function);
    expect(generation.generateAssistantReply).toBeInstanceOf(Function);
  });

  it("loads the canonical rag subtree", async () => {
    const [ragService, kbRetrieval, retrieval, decisionEngine] =
      await Promise.all([
        import("@/lib/airi/rag/response/rag-response-service"),
        import("@/lib/airi/rag/kb/kb-retrieval"),
        import("@/lib/airi/rag/pipeline/retrieval"),
        import("@/lib/airi/rag/decision/decision-engine"),
      ]);

    expect(ragService.RagResponseService).toBeDefined();
    expect(kbRetrieval.retrieveRelevantKBArticles).toBeInstanceOf(Function);
    expect(retrieval.retrieveBestAnswer).toBeInstanceOf(Function);
    expect(decisionEngine.selectBestContext).toBeInstanceOf(Function);
  });

  it("loads the canonical scenario subtree", async () => {
    const [runtime, channelUtils] = await Promise.all([
      import("@/lib/airi/scenario/scenario-runtime"),
      import("@/lib/airi/scenario/scenario-channel-utils"),
    ]);

    expect(runtime.resolveActiveScenarioRuntime).toBeInstanceOf(Function);
    expect(channelUtils.buildChannelSpecificParams).toBeInstanceOf(Function);
  });

  it("loads the canonical coach subtree", async () => {
    const [coachEngine, coachUtils, coachUtilsServer] = await Promise.all([
      import("@/lib/airi/coach/engine"),
      import("@/lib/airi/coach/coach-utils"),
      import("@/lib/airi/coach/coach-utils-server"),
    ]);

    expect(coachEngine.SimpleCoachEngine).toBeDefined();
    expect(coachUtils.analyzeConversationContext).toBeInstanceOf(Function);
    expect(coachUtilsServer.detectAndUpdateConversationLanguage).toBeInstanceOf(
      Function
    );
  });
});
