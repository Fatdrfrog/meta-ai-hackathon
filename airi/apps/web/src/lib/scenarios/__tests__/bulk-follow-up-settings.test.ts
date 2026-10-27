import { normalizeBulkFollowUpSettings } from "@/lib/scenarios/bulk-follow-up-settings";

describe("bulk-follow-up-settings", () => {
  it("normalizes template routes and ignores the legacy projection flag", () => {
    const s = normalizeBulkFollowUpSettings({
      templateRoutes: [
        {
          taxonomyLabel: " Support ",
          whatsappTemplateName: "hello",
          whatsappTemplateLanguage: "en",
          campaignNodeId: "n1",
        },
        { taxonomyLabel: "", whatsappTemplateName: "x" },
      ],
      preferFollowUpProjection: true,
    });
    expect(s).not.toHaveProperty("preferFollowUpProjection");
    expect(s?.templateRoutes).toHaveLength(1);
    expect(s?.templateRoutes[0]?.taxonomyLabel).toBe("Support");
  });
});
