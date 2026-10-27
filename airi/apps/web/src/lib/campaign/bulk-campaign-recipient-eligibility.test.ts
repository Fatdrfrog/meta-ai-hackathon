jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: jest.fn(),
  },
}));

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { BulkRecipientPolicyError } from "./bulk-recipient-policy";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

import {
  WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogMetadata,
} from "@/lib/whatsapp/templates/catalog-contracts";

import {
  routeVerifiedBulkCampaignProvenance,
  verifyBulkCampaignProvenanceCapability,
} from "./bulk-campaign-provenance";
import {
  BulkCampaignEligibilityError,
  bulkCampaignEligibilityRetryAfterSeconds,
  bulkCampaignTemplateLookupError,
  isTransientBulkCampaignTemplateLookupFailure,
  preflightBulkCampaignWhatsAppTemplate,
  type BulkCampaignEligibilityResolvedCandidate,
  resolveBulkCampaignRecipientEligibility,
  resolveMinimumBulkCampaignPlan,
} from "./bulk-campaign-recipient-eligibility";

const mockResolveApprovedWhatsAppTemplateForSend = jest.fn();
const mockReadApprovedWhatsAppTemplatesForSend = jest.fn();

jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  resolveApprovedWhatsAppTemplateForSend: (...args: unknown[]) =>
    mockResolveApprovedWhatsAppTemplateForSend(...args),
  readApprovedWhatsAppTemplatesForSend: (...args: unknown[]) =>
    mockReadApprovedWhatsAppTemplatesForSend(...args),
}));

function metaThrottleError() {
  return new MetaGraphRequestError({
    message:
      "(#80008) There have been too many calls to this WhatsApp Business account.",
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v23.0/waba-1/message_templates",
    details: {},
    metaError: {
      message:
        "(#80008) There have been too many calls to this WhatsApp Business account.",
      type: "OAuthException",
      code: 80008,
    },
  });
}

const plan = {
  readiness: {
    state: "ready" as const,
    checkedAt: "2026-08-21T10:00:00.000Z",
    remainingCapacity: null,
    reasons: [],
  },
  channel: "whatsapp" as const,
  batchPlan: {
    batchSize: 20,
    delayMs: 250,
    ratePerSecond: 80,
    rateSource: "meta_default_throughput",
    throughputLevel: "STANDARD",
  },
  recipientLimit: {
    maxRecipients: 2,
    rawLimit: "TIER_2",
    source: "live_meta" as const,
  },
};

const recipients = [
  { phone: "77000000001", name: "One" },
  { phone: "77000000002", name: "Two" },
  { phone: "77000000003", name: "Three" },
  { phone: "77000000004", name: "Four" },
];

describe("bulk campaign recipient eligibility orchestration", () => {
  beforeEach(() => {
    mockResolveApprovedWhatsAppTemplateForSend.mockReset();
    mockReadApprovedWhatsAppTemplatesForSend.mockReset();
  });

  describe("template lookup failures", () => {
    const messageIntent = {
      kind: "whatsapp_template" as const,
      sourceId: "source-1",
      templateName: "offer",
      language: "en",
    };

    async function preflight(
      candidates: BulkCampaignEligibilityResolvedCandidate<string>[],
      callerCatalog: Pick<
        Parameters<typeof preflightBulkCampaignWhatsAppTemplate>[0],
        "approvedTemplateCatalog" | "approvedTemplateCatalogMetadata"
      > = {}
    ) {
      const capability = await verifyBulkCampaignProvenanceCapability({
        workspaceId: "00000000-0000-4000-8000-000000000101",
        intent: { kind: "ad_hoc" },
        channel: "whatsapp",
        messageIntent,
      });
      return preflightBulkCampaignWhatsAppTemplate({
        workspaceId: "00000000-0000-4000-8000-000000000101",
        messageIntent,
        candidates,
        verifiedProvenance: routeVerifiedBulkCampaignProvenance(
          capability,
          candidates
        ),
        ...callerCatalog,
      });
    }

    const singleTemplate = [
      { stableId: "a", recipient: { phone: "77000000001" }, value: "a" },
    ];
    // Different languages need the whole catalog, not one template.
    const twoTemplates = [
      { stableId: "a", recipient: { phone: "77000000001" }, value: "a" },
      {
        stableId: "b",
        recipient: { phone: "77000000002", languageCode: "ru" },
        value: "b",
      },
    ];

    it.each([
      [
        "one template",
        singleTemplate,
        mockResolveApprovedWhatsAppTemplateForSend,
      ],
      ["the catalog", twoTemplates, mockReadApprovedWhatsAppTemplatesForSend],
    ])(
      "reports a Meta rate limit while looking up %s as meta_rate_limited",
      async (_label, candidates, lookup) => {
        const throttled = metaThrottleError();
        lookup.mockRejectedValueOnce(throttled);

        const error = await preflight(candidates).catch(
          (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(BulkCampaignEligibilityError);
        // A raw Graph throttle says nothing about when it ends.
        expect(error).toMatchObject({
          code: "meta_rate_limited",
          retryAfterSeconds: 60,
        });
        expect((error as Error).cause).toBe(throttled);
      }
    );

    it.each([
      [
        "one template",
        singleTemplate,
        mockResolveApprovedWhatsAppTemplateForSend,
      ],
      ["the catalog", twoTemplates, mockReadApprovedWhatsAppTemplatesForSend],
    ])(
      "reports any other failure while looking up %s as template_lookup_unavailable",
      async (_label, candidates, lookup) => {
        const failure = new Error("template catalog unavailable");
        lookup.mockRejectedValueOnce(failure);

        const error = await preflight(candidates).catch(
          (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(BulkCampaignEligibilityError);
        expect(error).toMatchObject({ code: "template_lookup_unavailable" });
        expect((error as Error).cause).toBe(failure);
      }
    );

    it.each([
      [
        "one template",
        singleTemplate,
        mockResolveApprovedWhatsAppTemplateForSend,
      ],
      ["the catalog", twoTemplates, mockReadApprovedWhatsAppTemplatesForSend],
    ])(
      "reports an active catalog cooldown while looking up %s as meta_rate_limited until it ends",
      async (_label, candidates, lookup) => {
        // What the catalog throws during a cooldown, before calling Meta.
        const cooldown = new WhatsAppTemplateCatalogError({
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          message: "Meta temporarily limited WhatsApp template requests.",
          retryAt: new Date(Date.now() + 300_000).toISOString(),
          providerCode: 80008,
        });
        lookup.mockRejectedValueOnce(cooldown);

        const error = await preflight(candidates).catch(
          (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(BulkCampaignEligibilityError);
        expect(error).toMatchObject({
          code: "meta_rate_limited",
          retryAfterSeconds: 300,
        });
        expect((error as Error).cause).toBe(cooldown);
      }
    );

    it.each([
      ["WHATSAPP_TEMPLATES_UNAVAILABLE"],
      ["WHATSAPP_TEMPLATES_INCOMPLETE"],
    ] as const)(
      "reports a %s catalog as template_lookup_unavailable without a retry time",
      async code => {
        const failure = new WhatsAppTemplateCatalogError({
          code,
          message: "WhatsApp templates are temporarily unavailable.",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        });
        mockReadApprovedWhatsAppTemplatesForSend.mockRejectedValueOnce(failure);

        const error = await preflight(twoTemplates).catch(
          (caught: unknown) => caught
        );

        expect(error).toMatchObject({
          code: "template_lookup_unavailable",
          retryAfterSeconds: null,
        });
        expect((error as Error).cause).toBe(failure);
      }
    );

    describe("a stale saved catalog", () => {
      const offer = (language: string): WhatsAppTemplate => ({
        id: `offer-${language}`,
        name: "offer",
        language,
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hi" }],
      });

      function catalog(
        overrides: Partial<WhatsAppTemplateCatalogMetadata> = {}
      ): WhatsAppTemplateCatalogMetadata {
        return {
          source: "cache",
          stale: true,
          fetchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          wabaId: "waba-1",
          refreshOutcome: "cooldown",
          retryAt: new Date(Date.now() + 300_000).toISOString(),
          providerCode: 80008,
          ...overrides,
        };
      }

      // What the shared catalog returns instead of throwing while it can't
      // refresh: the last saved templates, marked stale.
      function lookupReturns(
        path: "one-template lookup" | "catalog lookup",
        metadata: WhatsAppTemplateCatalogMetadata,
        listsTemplate: boolean
      ) {
        if (path === "one-template lookup") {
          mockResolveApprovedWhatsAppTemplateForSend.mockResolvedValueOnce({
            template: listsTemplate ? offer("en") : null,
            sameNameLanguages: listsTemplate ? ["en"] : [],
            source: listsTemplate ? "live" : "none",
            catalog: metadata,
          });
          return singleTemplate;
        }
        mockReadApprovedWhatsAppTemplatesForSend.mockResolvedValueOnce({
          templates: listsTemplate ? [offer("en"), offer("ru")] : [offer("en")],
          catalog: metadata,
        });
        return twoTemplates;
      }

      it.each([["one-template lookup"], ["catalog lookup"]] as const)(
        "%s: a template missing during a Meta cooldown is meta_rate_limited until it ends",
        async path => {
          const candidates = lookupReturns(path, catalog(), false);

          const error = await preflight(candidates).catch(
            (caught: unknown) => caught
          );

          expect(error).toBeInstanceOf(BulkCampaignEligibilityError);
          expect(error).toMatchObject({
            code: "meta_rate_limited",
            retryAfterSeconds: 300,
          });
          expect((error as Error).cause).toBeInstanceOf(
            WhatsAppTemplateCatalogError
          );
          expect((error as Error).cause).toMatchObject({
            code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
            providerCode: 80008,
          });
        }
      );

      it.each([["one-template lookup"], ["catalog lookup"]] as const)(
        "%s: a template missing after a failed refresh is template_lookup_unavailable",
        async path => {
          const candidates = lookupReturns(
            path,
            catalog({ refreshOutcome: "failed", providerCode: undefined }),
            false
          );

          const error = await preflight(candidates).catch(
            (caught: unknown) => caught
          );

          expect(error).toMatchObject({
            code: "template_lookup_unavailable",
            retryAfterSeconds: null,
          });
          expect((error as Error).cause).toMatchObject({
            code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
          });
        }
      );

      it.each([["one-template lookup"], ["catalog lookup"]] as const)(
        "%s: a template missing from a current catalog is still template_unavailable",
        async path => {
          const candidates = lookupReturns(
            path,
            catalog({
              stale: false,
              refreshOutcome: "fresh",
              retryAt: null,
              providerCode: undefined,
            }),
            false
          );

          await expect(preflight(candidates)).rejects.toMatchObject({
            code: "template_unavailable",
          });
        }
      );

      it.each([["one-template lookup"], ["catalog lookup"]] as const)(
        "%s: a template the stale catalog lists as approved passes",
        async path => {
          const candidates = lookupReturns(path, catalog(), true);

          const result = await preflight(candidates);

          expect(
            result.candidates.map(candidate => candidate.stableId)
          ).toEqual(candidates.map(candidate => candidate.stableId));
          expect(result.excluded).toEqual([]);
        }
      );

      it("reads a caller's catalog the same way", async () => {
        const error = await preflight(singleTemplate, {
          approvedTemplateCatalog: [],
          approvedTemplateCatalogMetadata: catalog(),
        }).catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          code: "meta_rate_limited",
          retryAfterSeconds: 300,
        });
        expect(
          mockResolveApprovedWhatsAppTemplateForSend
        ).not.toHaveBeenCalled();
        expect(mockReadApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
      });
    });
  });

  describe("template lookup classification", () => {
    function rateLimited(retryAt: string | null) {
      return new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message: "Meta temporarily limited WhatsApp template requests.",
        retryAt,
      });
    }

    it.each([
      ["a known cooldown end", 90_000, 90],
      ["a cooldown that already ended", -5_000, 1],
      ["a cooldown hours away", 6 * 60 * 60_000, 900],
    ])("waits until %s", (_label, offsetMs, seconds) => {
      const error = bulkCampaignTemplateLookupError(
        rateLimited(new Date(Date.now() + offsetMs).toISOString())
      );

      expect(error.code).toBe("meta_rate_limited");
      expect(error.retryAfterSeconds).toBe(seconds);
      expect(bulkCampaignEligibilityRetryAfterSeconds(error)).toBe(seconds);
    });

    it.each([
      ["a catalog rate limit without an end", rateLimited(null)],
      ["a catalog rate limit with an unreadable end", rateLimited("soon")],
      ["a raw Meta throttle", metaThrottleError()],
    ])("waits a minute after %s", (_label, cause) => {
      const error = bulkCampaignTemplateLookupError(cause);

      expect(error.code).toBe("meta_rate_limited");
      expect(error.retryAfterSeconds).toBe(60);
      expect(bulkCampaignEligibilityRetryAfterSeconds(error)).toBe(60);
    });

    it("keeps an already coded failure", () => {
      const coded = new BulkCampaignEligibilityError("template_unavailable");

      expect(bulkCampaignTemplateLookupError(coded)).toBe(coded);
    });

    function graphError(status: number, code: number) {
      return new MetaGraphRequestError({
        message: `(#${code}) Graph error`,
        status,
        statusText: "",
        url: "https://graph.facebook.com/v23.0/waba-1/message_templates",
        details: {},
        metaError: { message: "Graph error", type: "OAuthException", code },
      });
    }

    it.each([
      ["a catalog rate limit", rateLimited(null)],
      [
        "an unavailable catalog",
        new WhatsAppTemplateCatalogError({
          code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
          message: "WhatsApp templates cannot be refreshed right now.",
        }),
      ],
      ["a raw Meta throttle", metaThrottleError()],
      ["a Graph 500", graphError(500, 2)],
    ])("treats %s as a lookup that clears by itself", (_label, error) => {
      expect(isTransientBulkCampaignTemplateLookupFailure(error)).toBe(true);
    });

    it.each([
      [
        "lost WhatsApp access",
        new Error(
          "Cannot access WhatsApp message templates for this connection. Reconnect WhatsApp or grant whatsapp_business_management access to the selected WhatsApp Business Account in Meta Business Manager."
        ),
      ],
      ["a missing source", new Error("WhatsApp source ID not found")],
      ["a Graph permission error", graphError(403, 200)],
      ["a failed scenario read", new Error("connection refused")],
      ["no error at all", undefined],
    ])(
      "doesn't treat %s as a lookup that clears by itself",
      (_label, error) => {
        expect(isTransientBulkCampaignTemplateLookupFailure(error)).toBe(false);
      }
    );

    it("sets no retry time for failures that don't clear by themselves", () => {
      expect(
        bulkCampaignEligibilityRetryAfterSeconds(
          bulkCampaignTemplateLookupError(new Error("network down"))
        )
      ).toBeNull();
      expect(
        bulkCampaignEligibilityRetryAfterSeconds({
          code: "template_unavailable",
          retryAfterSeconds: 30,
        })
      ).toBeNull();
      // A rate limit coded without a time still gets the fallback.
      expect(
        bulkCampaignEligibilityRetryAfterSeconds(
          new BulkCampaignEligibilityError("meta_rate_limited")
        )
      ).toBe(60);
    });
  });

  it("preserves the approved category when dispatchability preflight excludes every recipient", async () => {
    mockResolveApprovedWhatsAppTemplateForSend.mockResolvedValue({
      template: {
        name: "offer",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "HEADER", format: "IMAGE" }],
      },
    });
    const capability = await verifyBulkCampaignProvenanceCapability({
      workspaceId: "00000000-0000-4000-8000-000000000101",
      intent: { kind: "ad_hoc" },
      channel: "whatsapp",
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "source-1",
        templateName: "offer",
        language: "en",
      },
    });
    const resolved = [
      {
        stableId: "ready",
        recipient: {
          phone: "77000000001",
          variables: { "1": "Ada" },
        },
        value: "ready",
      },
      {
        stableId: "missing",
        recipient: { phone: "77000000002" },
        value: "missing",
      },
    ];
    const resolution = await resolveBulkCampaignRecipientEligibility(
      {
        workspaceId: "00000000-0000-4000-8000-000000000101",
        channel: "whatsapp",
        messageIntent: {
          kind: "whatsapp_template",
          sourceId: "source-1",
          templateName: "offer",
          language: "en",
        },
        audience: { kind: "inline", recipients: [] },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        provenanceCapability: capability,
      },
      {
        resolveAudience: async () => ({
          candidates: resolved,
          completeness: {
            complete: true,
            uniqueRecipients: 2,
            dispatchItems: 2,
            uniqueRecipientHardCap: 50_000,
            dispatchItemHardCap: 50_000,
          },
        }),
        preflight: async input => ({
          ...(await preflightBulkCampaignWhatsAppTemplate(input)),
        }),
        resolvePlan: async () => plan,
        evaluatePolicy: async ({ candidates }) => ({
          retained: [...candidates],
          excluded: [],
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
          uniqueRecipients: {
            requested: candidates.length,
            accepted: candidates.length,
          },
        }),
      }
    );

    expect(resolution.preview).toMatchObject({
      requestedTotal: 2,
      acceptedTotal: 0,
      skippedByReason: { ineligible: 2 },
    });
    expect(resolution.approvedTemplateCategories).toEqual(["MARKETING"]);
  });

  it("returns byte-for-byte equal aggregate previews for equivalent inline and Analytics audiences", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability({
      workspaceId: "00000000-0000-4000-8000-000000000101",
      intent: { kind: "ad_hoc" },
      channel: "whatsapp",
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "source-1",
        templateName: "offer",
        language: "en",
      },
    });
    const evaluatePolicy = jest.fn(async ({ candidates }) => ({
      retained: [candidates[0]],
      excluded: [
        { candidate: candidates[1], reason: "marketing_opt_out" as const },
        { candidate: candidates[2], reason: "prior_failure" as const },
        { candidate: candidates[3], reason: "recipient_limit" as const },
      ],
      skippedByReason: {
        marketing_opt_out: 1,
        prior_failure: 1,
        recipient_limit: 1,
      },
      warnings: { missingMarketingConsent: 1 },
      uniqueRecipients: { requested: 4, accepted: 1 },
    }));
    const dependencies = {
      now: () => new Date("2026-08-21T10:00:00.000Z"),
      resolveAudience: jest.fn(async () => ({
        candidates: recipients.map((recipient, index) => ({
          stableId: `recipient-${index + 1}`,
          recipient,
          value: { recipient },
        })),
        completeness: {
          complete: true as const,
          uniqueRecipients: 4,
          dispatchItems: 4,
          uniqueRecipientHardCap: 50_000,
          dispatchItemHardCap: 50_000,
        },
      })),
      preflight: jest.fn(async ({ candidates }) => ({
        candidates: candidates.map(
          (
            candidate: BulkCampaignEligibilityResolvedCandidate<{
              recipient: (typeof recipients)[number];
            }>
          ) => ({
            ...candidate,
            templateCategory: "MARKETING" as const,
          })
        ),
        excluded: [],
      })),
      resolvePlan: jest.fn(async () => plan),
      evaluatePolicy,
    };
    const common = {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      channel: "whatsapp" as const,
      messageIntent: {
        kind: "whatsapp_template" as const,
        sourceId: "source-1",
        templateName: "offer",
        language: "en",
      },
      recipientPolicy: {
        version: 1 as const,
        excludePriorFailedBulkSends: true,
      },
      provenanceCapability: capability,
    };

    const inline = await resolveBulkCampaignRecipientEligibility(
      {
        ...common,
        audience: { kind: "inline", recipients },
      },
      dependencies
    );
    const analytics = await resolveBulkCampaignRecipientEligibility(
      {
        ...common,
        audience: {
          kind: "analytics_with_fill_up",
          analytics: { filters: { days: 30 } },
          fillUpRecipients: [],
        },
      },
      dependencies
    );

    expect(analytics.preview).toEqual(inline.preview);
    expect(inline.preview).toEqual({
      state: "ready",
      evaluatedAt: "2026-08-21T10:00:00.000Z",
      readiness: {
        state: "ready",
        checkedAt: "2026-08-21T10:00:00.000Z",
        remainingCapacity: null,
        reasons: [],
      },
      requestedTotal: 4,
      acceptedTotal: 1,
      uniqueRecipients: { requested: 4, accepted: 1 },
      skippedByReason: {
        marketing_opt_out: 1,
        recipient_limit: 1,
        prior_failure: 1,
      },
      warnings: { missingMarketingConsent: 1 },
      allExcluded: false,
    });
    expect(inline.retained.map(candidate => candidate.stableId)).toEqual([
      "recipient-1",
    ]);
    expect(analytics.retained.map(candidate => candidate.stableId)).toEqual([
      "recipient-1",
    ]);
    // The policy judges contact windows at the preview's time.
    expect(evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ now: new Date("2026-08-21T10:00:00.000Z") })
    );
    // Recently contacted recipients are an ordinary skip; the send still
    // goes to everyone else, so readiness stays the plan's.
    evaluatePolicy.mockImplementationOnce((async ({
      candidates,
    }: {
      candidates: Array<{ stableId: string }>;
    }) => ({
      retained: [candidates[0]],
      excluded: candidates
        .slice(1)
        .map(candidate => ({ candidate, reason: "recent_contact" })),
      skippedByReason: { recent_contact: 3 },
      warnings: { missingMarketingConsent: 0 },
      uniqueRecipients: { requested: 4, accepted: 1 },
    })) as never);
    const recent = await resolveBulkCampaignRecipientEligibility(
      { ...common, audience: { kind: "inline", recipients } },
      dependencies
    );
    expect(recent.retained).toEqual(inline.retained);
    expect(recent.preview).toMatchObject({
      acceptedTotal: 1,
      skippedByReason: { recent_contact: 3 },
      allExcluded: false,
      readiness: {
        state: "ready",
        checkedAt: "2026-08-21T10:00:00.000Z",
        reasons: [],
      },
    });
    dependencies.resolvePlan.mockResolvedValueOnce({
      ...plan,
      readiness: {
        state: "unavailable",
        checkedAt: "2026-08-21T09:59:00.000Z",
        remainingCapacity: null,
        reasons: [{ code: "meta_check_unavailable" }],
      },
    } as never);
    const unavailable = await resolveBulkCampaignRecipientEligibility(
      { ...common, audience: { kind: "inline", recipients } },
      dependencies
    );
    expect(unavailable.preview.readiness).toEqual({
      state: "unavailable",
      checkedAt: "2026-08-21T09:59:00.000Z",
      remainingCapacity: null,
      reasons: [{ code: "meta_check_unavailable" }],
    });
    dependencies.resolvePlan.mockResolvedValueOnce({
      ...plan,
      readiness: undefined,
    } as never);
    const missingProvider = await resolveBulkCampaignRecipientEligibility(
      { ...common, audience: { kind: "inline", recipients } },
      dependencies
    );
    expect(missingProvider.preview.readiness).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "meta_check_unavailable" }],
    });
    evaluatePolicy.mockRejectedValueOnce(
      new BulkRecipientPolicyError("contact_policy_unavailable")
    );
    await expect(
      resolveBulkCampaignRecipientEligibility(
        { ...common, audience: { kind: "inline", recipients } },
        dependencies
      )
    ).rejects.toMatchObject({ code: "contact_policy_unavailable" });
    expect(evaluatePolicy).toHaveBeenCalledTimes(6);
    expect(evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ recipientLimit: 2 })
    );
  });

  it("keeps only the first recipients that fit the plan's recipient allowance", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability({
      workspaceId: "00000000-0000-4000-8000-000000000101",
      intent: { kind: "ad_hoc" },
      channel: "whatsapp",
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "source-1",
        templateName: "update",
        language: "en",
      },
    });
    const dependencies = {
      now: () => new Date("2026-08-21T10:00:00.000Z"),
      resolveAudience: jest.fn(async () => ({
        candidates: recipients.map((recipient, index) => ({
          stableId: `recipient-${index + 1}`,
          recipient,
          value: recipient.phone,
        })),
        completeness: {
          complete: true as const,
          uniqueRecipients: 4,
          dispatchItems: 4,
          uniqueRecipientHardCap: 50_000,
          dispatchItemHardCap: 50_000,
        },
      })),
      preflight: jest.fn(async ({ candidates }) => ({
        candidates: candidates.map(
          (candidate: BulkCampaignEligibilityResolvedCandidate<string>) => ({
            ...candidate,
            templateCategory: "UTILITY" as const,
          })
        ),
        excluded: [],
      })),
      // A Meta tier far above the audience: only the allowance trims it.
      resolvePlan: jest.fn(async () => ({
        ...plan,
        recipientLimit: {
          maxRecipients: 2000,
          rawLimit: "TIER_2K",
          source: "live_meta" as const,
        },
      })),
    };
    const input = {
      workspaceId: "00000000-0000-4000-8000-000000000101",
      channel: "whatsapp" as const,
      messageIntent: {
        kind: "whatsapp_template" as const,
        sourceId: "source-1",
        templateName: "update",
        language: "en",
      },
      recipientPolicy: {
        version: 1 as const,
        excludePriorFailedBulkSends: false,
      },
      provenanceCapability: capability,
      audience: { kind: "inline" as const, recipients },
    };

    const trimmed = await resolveBulkCampaignRecipientEligibility(
      { ...input, recipientAllowance: 3 },
      dependencies
    );
    expect(trimmed.retained.map(candidate => candidate.value)).toEqual([
      "77000000001",
      "77000000002",
      "77000000003",
    ]);
    expect(trimmed.preview).toMatchObject({
      requestedTotal: 4,
      acceptedTotal: 3,
      skippedByReason: { recipient_limit: 1 },
      uniqueRecipients: { requested: 4, accepted: 3 },
    });
    // The Meta limit still applies; an unlimited plan passes no allowance.
    expect(trimmed.plan.recipientLimit.maxRecipients).toBe(2000);
    const unlimited = await resolveBulkCampaignRecipientEligibility(
      { ...input, recipientAllowance: null },
      dependencies
    );
    expect(unlimited.preview.acceptedTotal).toBe(4);
  });

  it("uses the minimum positive plan across distinct verified retained-route sources", async () => {
    const resolvePlan = jest.fn(async ({ sourceId }: { sourceId: string }) => ({
      ...plan,
      recipientLimit: {
        ...plan.recipientLimit,
        maxRecipients: sourceId === "source-a" ? 5 : 2,
        rawLimit: sourceId === "source-a" ? "TIER_5" : "TIER_2",
      },
    }));

    const result = await resolveMinimumBulkCampaignPlan({
      sourceIds: ["source-a", "source-b", "source-a"],
      resolvePlan,
    });

    expect(resolvePlan.mock.calls.map(([input]) => input.sourceId)).toEqual([
      "source-a",
      "source-b",
    ]);
    expect(result.recipientLimit.maxRecipients).toBe(2);
  });

  it.each([
    { hardCap: 4, complete: true, errorCode: null },
    { hardCap: 3, complete: true, errorCode: "hard_cap_exceeded" },
    { hardCap: 4, complete: false, errorCode: "incomplete_audience" },
  ])(
    "separates the live send limit from the audience proof (cap=$hardCap, complete=$complete)",
    async ({ hardCap, complete, errorCode }) => {
      const workspaceId = "00000000-0000-4000-8000-000000000101";
      const messageIntent = {
        kind: "whatsapp_template" as const,
        sourceId: "source-1",
        templateName: "offer",
        language: "en",
      };
      const capability = await verifyBulkCampaignProvenanceCapability({
        workspaceId,
        intent: { kind: "ad_hoc" },
        channel: "whatsapp",
        messageIntent,
      });
      const resolution = resolveBulkCampaignRecipientEligibility(
        {
          workspaceId,
          channel: "whatsapp",
          messageIntent,
          audience: { kind: "inline", recipients },
          recipientPolicy: { version: 1, excludePriorFailedBulkSends: false },
          provenanceCapability: capability,
        },
        {
          resolveAudience: async () => ({
            candidates: recipients.map((recipient, index) => ({
              stableId: `recipient-${index + 1}`,
              recipient,
              value: recipient,
            })),
            completeness: {
              complete,
              uniqueRecipients: recipients.length,
              dispatchItems: recipients.length,
              uniqueRecipientHardCap: hardCap,
              dispatchItemHardCap: recipients.length,
            },
          }),
          preflight: async ({ candidates }) => ({
            candidates: candidates.map(candidate => ({
              ...candidate,
              templateCategory: "UTILITY" as const,
            })),
            excluded: [],
          }),
          resolvePlan: async () => plan,
        }
      );

      if (errorCode) {
        await expect(resolution).rejects.toMatchObject({ code: errorCode });
        return;
      }
      const result = await resolution;
      expect(result.preview).toMatchObject({
        state: "ready",
        requestedTotal: 4,
        acceptedTotal: 2,
        uniqueRecipients: { requested: 4, accepted: 2 },
        skippedByReason: { recipient_limit: 2 },
      });
      expect(result.retained.map(candidate => candidate.recipient)).toEqual(
        recipients.slice(0, 2)
      );
      expect(result.plan.recipientLimit.maxRecipients).toBe(2);
    }
  );

  it("blocks an unavailable plan even when a compatibility limit is positive", async () => {
    await expect(
      resolveMinimumBulkCampaignPlan({
        sourceIds: ["source-a"],
        resolvePlan: async () => ({
          ...plan,
          recipientLimit: {
            maxRecipients: 2,
            rawLimit: null,
            source: "unavailable" as const,
          },
        }),
      })
    ).rejects.toMatchObject({ code: "plan_unavailable" });
  });
});
