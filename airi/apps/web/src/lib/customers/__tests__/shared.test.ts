import {
  buildConversationSeedKey,
  getConversationDisplayName,
  getManualConversationStage,
  getCrmPipelineStageFromConversation,
  getConversationStage,
  mixedIdLookupValues,
  normalizePhone,
  scoreCustomerSuggestion,
  toStringId,
} from "@/lib/customers/shared";

describe("mixedIdLookupValues", () => {
  it("keeps numeric and string ids typed and de-duplicated", () => {
    expect(
      mixedIdLookupValues([123, "123", " wa_7701 ", "wa_7701", 123, null, NaN])
    ).toEqual([123, "123", "wa_7701"]);
  });
});

function buildCurrentClassification(category: string) {
  return {
    is_classified: true,
    classification_revision: 4,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 4,
      appliedRevision: 4,
    },
    classification_meta: {
      source_revision: 4,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-4",
    },
    classification: { category },
  };
}

describe("customer shared helpers", () => {
  it("builds a safe seed key from widget visitor ids first", () => {
    expect(
      buildConversationSeedKey({
        _id: "conv-1",
        channel: "web_widget",
        visitor_id: "visitor-123",
        user: "wa_70123456789",
      })
    ).toBe("web_widget:visitor-123");
  });

  it("falls back to user or chat identifiers when visitor id is absent", () => {
    expect(
      buildConversationSeedKey({
        _id: "conv-2",
        channel: "whatsapp",
        user: "wa_70123456789",
      })
    ).toBe("whatsapp:wa_70123456789");

    expect(
      buildConversationSeedKey({
        _id: "conv-3",
        channel: "telegram",
        chat: 999001,
      })
    ).toBe("telegram:999001");
  });

  it("resolves only customer-owned stage and segment labels for materialization", () => {
    expect(
      getManualConversationStage({
        internal_labels: ["seg:lead_generation", "stage:qualified"],
        classification: { category: "Complaint" },
      })
    ).toBe("qualified");

    expect(
      getManualConversationStage({
        internal_labels: ["seg:retention"],
        classification: { category: "Complaint" },
      })
    ).toBe("retention");

    expect(
      getManualConversationStage({
        ...buildCurrentClassification("Onboarding"),
      })
    ).toBeNull();
  });

  it("persists CRM funnel stage from stage: labels only", () => {
    expect(
      getCrmPipelineStageFromConversation({
        internal_labels: ["seg:retention", "stage:qualified"],
        classification: { category: "Sales" },
      })
    ).toBe("qualified");

    expect(
      getCrmPipelineStageFromConversation({
        internal_labels: ["seg:retention"],
        classification: { category: "Sales" },
      })
    ).toBeNull();
  });

  it("uses classification as a direct fallback only when the contract is current", () => {
    expect(getConversationStage(buildCurrentClassification("Onboarding"))).toBe(
      "Onboarding"
    );

    expect(
      getConversationStage({
        ...buildCurrentClassification("Complaint"),
        classification_state: {
          contractVersion: 2,
          status: "ready",
          requestedRevision: 5,
          appliedRevision: 4,
        },
      })
    ).toBeNull();

    expect(
      getConversationStage({
        ...buildCurrentClassification("Complaint"),
        classification_meta: {
          source_revision: 4,
          provenance_kind: "legacy_unknown",
          analysis_revision_id: "analysis-4",
        },
      })
    ).toBeNull();
  });

  it("keeps manual stage precedence independent of classification freshness", () => {
    expect(
      getConversationStage({
        ...buildCurrentClassification("Complaint"),
        internal_labels: ["seg:retention", "stage:qualified"],
      })
    ).toBe("qualified");

    expect(
      getConversationStage({
        ...buildCurrentClassification("Complaint"),
        classification_revision: 5,
        internal_labels: ["seg:retention"],
      })
    ).toBe("retention");
  });

  it("normalizes whatsapp-style phone identifiers", () => {
    expect(normalizePhone("wa_+7 (701) 234-56-78")).toBe("77012345678");
    expect(normalizePhone("wa_bsuid_US.1349.abc")).toBeNull();
    expect(normalizePhone("not-a-phone")).toBeNull();
  });

  it("toStringId returns null instead of recursing forever on circular _id chains", () => {
    const cyclic: { _id?: unknown } = {};
    cyclic._id = cyclic;
    expect(toStringId(cyclic)).toBeNull();

    const a: { _id?: unknown } = {};
    const b: { _id?: unknown } = { _id: a };
    a._id = b;
    expect(toStringId(a)).toBeNull();
  });

  it("toStringId unwraps nested _id and prefers hex string for ObjectId-like values", () => {
    expect(toStringId({ _id: { _id: "nested-doc" } })).toBe("nested-doc");
    expect(
      toStringId({
        toHexString: () => "507f1f77bcf86cd799439011",
      })
    ).toBe("507f1f77bcf86cd799439011");
  });

  it("scores exact and high-confidence identity matches above soft name matches", () => {
    const strong = scoreCustomerSuggestion({
      sameVisitorId: false,
      sameChannelUser: false,
      sameChannelChat: false,
      matchingPhones: ["77012345678"],
      matchingEmails: [],
      matchingUsernames: [],
      sameDisplayName: false,
      sameSourceId: false,
      sourceLastActivity: new Date("2026-03-10T10:00:00.000Z"),
      candidateLastActivity: new Date("2026-03-11T10:00:00.000Z"),
    });

    const soft = scoreCustomerSuggestion({
      sameVisitorId: false,
      sameChannelUser: false,
      sameChannelChat: false,
      matchingPhones: [],
      matchingEmails: [],
      matchingUsernames: [],
      sameDisplayName: true,
      sameSourceId: false,
      sourceLastActivity: new Date("2026-03-10T10:00:00.000Z"),
      candidateLastActivity: new Date("2026-03-11T10:00:00.000Z"),
    });

    expect(strong.score).toBeGreaterThan(soft.score);
    expect(strong.reasons[0]?.code).toBe("phone");
    expect(soft.reasons[0]?.code).toBe("same_name_recent");
  });

  describe("getConversationDisplayName", () => {
    const conversation = {
      _id: "69b16a2c8f1e4d0012345678",
      channel: "whatsapp",
    };

    it("uses the WhatsApp profile name when the user has no first name", () => {
      expect(
        getConversationDisplayName({
          conversation,
          user: { whatsapp: { profileName: " Айгерим " } },
        })
      ).toBe("Айгерим");
      expect(
        getConversationDisplayName({
          conversation,
          chat: { whatsapp: { profileName: "Dana" } },
        })
      ).toBe("Dana");
    });

    it("keeps a manual rename and a real first name ahead of the profile name", () => {
      const user = {
        firstName: "Aigerim",
        lastName: "N.",
        whatsapp: { profileName: "Айгерим" },
      };
      expect(getConversationDisplayName({ conversation, user })).toBe(
        "Aigerim N."
      );
      expect(
        getConversationDisplayName({
          conversation: { ...conversation, rename: "VIP buyer" },
          user,
        })
      ).toBe("VIP buyer");
    });

    it("skips the Instagram placeholder first name for the username", () => {
      expect(
        getConversationDisplayName({
          conversation: { ...conversation, channel: "instagram" },
          user: { firstName: "Instagram User", username: "acme.store" },
        })
      ).toBe("acme.store");
    });

    it("returns null instead of a synthetic channel:id label", () => {
      // Stored as the lead name, `whatsapp:<conversation id>` showed in the
      // CRM and blocked real names that only fill an empty name.
      expect(getConversationDisplayName({ conversation })).toBeNull();
      expect(
        getConversationDisplayName({
          conversation,
          user: { firstName: "Instagram User" },
        })
      ).toBeNull();
    });
  });
});
