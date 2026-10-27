import {
  KNOWLEDGE_CHUNK_VISIBILITY,
  resolveMatchAllowedVisibilities,
  visibilityCacheKeySegment,
} from "./knowledge-search-permissions";

describe("knowledge-search-permissions", () => {
  it("defaults to workspace+public for rag_auto_reply", () => {
    expect(
      resolveMatchAllowedVisibilities({
        knowledgeSearchPrincipal: "rag_auto_reply",
      })
    ).toEqual([
      KNOWLEDGE_CHUNK_VISIBILITY.WORKSPACE,
      KNOWLEDGE_CHUNK_VISIBILITY.PUBLIC,
    ]);
  });

  it("includes internal for workspace_member_tool", () => {
    expect(
      resolveMatchAllowedVisibilities({
        knowledgeSearchPrincipal: "workspace_member_tool",
      })
    ).toEqual([
      KNOWLEDGE_CHUNK_VISIBILITY.WORKSPACE,
      KNOWLEDGE_CHUNK_VISIBILITY.PUBLIC,
      KNOWLEDGE_CHUNK_VISIBILITY.INTERNAL,
    ]);
  });

  it("returns null for system_unrestricted", () => {
    expect(
      resolveMatchAllowedVisibilities({
        knowledgeSearchPrincipal: "system_unrestricted",
      })
    ).toBeNull();
  });

  it("honors explicit matchAllowedVisibilities including null and empty", () => {
    expect(
      resolveMatchAllowedVisibilities({
        knowledgeSearchPrincipal: "rag_auto_reply",
        matchAllowedVisibilities: null,
      })
    ).toBeNull();
    expect(
      resolveMatchAllowedVisibilities({
        matchAllowedVisibilities: ["internal"],
      })
    ).toEqual(["internal"]);
    expect(
      resolveMatchAllowedVisibilities({ matchAllowedVisibilities: [] })
    ).toEqual([]);
  });

  it("visibilityCacheKeySegment is stable", () => {
    expect(visibilityCacheKeySegment(null)).toBe("vis:all");
    expect(visibilityCacheKeySegment([])).toBe("vis:none");
    expect(visibilityCacheKeySegment(["b", "a"])).toBe("vis:a|b");
  });
});
