import {
  assertProviderIdentity,
  operatorErrorMessage,
  reconciliationEntry,
  hasTemplateCreationFence,
  verifiedReceiptEntry,
  validateReviewedBatch,
  getTemplateReconciliationAction,
  hasTemplateUpdateFence,
  hasDemoMutationBudget,
  hasFlowMutationFence,
  requiresRecoveredTemplateMirror,
  assertTemplateMirrorResult,
  requireTemplateUpdateSnapshot,
  assertDeferredCreatedStatusOptions,
  verifyTemplateBatchSnapshots,
  assertReviewedDemoFlow,
  auditProviderTemplateSnapshot,
  indexProviderTemplates,
  providerTemplateKey,
  assertAuditReportOutputPath,
  assertNoDuplicateProviderContent,
} from "./submit-public-template-demos";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("read-only audit output protection", () => {
  it("rejects reserved review and recovery output paths before provider access", async () => {
    for (const path of [
      "review.json",
      "receipt.json",
      "receipt.bindings.json",
      "receipt.flows.json",
    ]) {
      await expect(assertAuditReportOutputPath(path, [path])).rejects.toThrow(
        "reserved"
      );
    }
  });
  it("preserves an existing artifact instead of overwriting its recovery evidence", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "airi-template-audit-test-")
    );
    const target = join(directory, "receipt.json");
    try {
      await writeFile(target, "immutable recovery evidence");
      await expect(assertAuditReportOutputPath(target, [])).rejects.toThrow(
        "already exists"
      );
      expect(await readFile(target, "utf8")).toBe(
        "immutable recovery evidence"
      );
      await expect(
        assertAuditReportOutputPath(join(directory, "new.json"), [])
      ).resolves.toBeUndefined();
    } finally {
      await unlink(target);
      await rmdir(directory);
    }
  });
});

describe("read-only provider inventory validation", () => {
  const variant = {
    key: "welcome:en",
    catalogId: "welcome",
    locale: "en" as const,
    language: "en" as const,
    payload: {
      name: "airi_demo_welcome_en_v1",
      language: "en",
      category: "MARKETING" as const,
      components: [{ type: "BODY", text: "*Welcome*, {{first_name}}" }],
    },
    bindingDraft: {},
    expectedTemplateId: "12345",
  };
  const template = {
    id: "12345",
    name: variant.payload.name,
    language: "en",
    category: "MARKETING",
    status: "APPROVED",
    components: variant.payload.components,
  };
  it("keeps language variants distinct instead of overwriting by name", () => {
    const ru = { ...template, id: "23456", language: "ru" };
    const indexed = indexProviderTemplates([template, ru]);
    expect(indexed.get(providerTemplateKey(template.name, "en"))).toEqual(
      template
    );
    expect(indexed.get(providerTemplateKey(template.name, "ru"))).toEqual(ru);
    expect(indexed.size).toBe(2);
  });
  it("fails closed on ambiguous provider identity", () => {
    expect(() =>
      indexProviderTemplates([template, { ...template, id: "23456" }])
    ).toThrow("Duplicate provider identity");
  });
  it("reports same-language duplicate content without treating translations as duplicates", () => {
    const duplicate = {
      ...template,
      id: "23456",
      name: "other_example",
      components: [
        {
          text: "*Welcome*, {{first_name}}",
          type: "BODY",
          example: { body_text: [["Alex"]] },
        },
      ],
    };
    const ru = { ...duplicate, id: "34567", language: "ru" };
    const result = auditProviderTemplateSnapshot(
      [template, duplicate, ru],
      [variant]
    );
    expect(result.duplicateContent).toEqual([["12345", "23456"]]);
    expect(result.matched).toBe(1);
    expect(result.unbound.map(item => item.id)).toEqual(["23456", "34567"]);
  });
  it("reports component/category/ID drift separately from review status", () => {
    const pending = { ...template, status: "PENDING" };
    expect(auditProviderTemplateSnapshot([pending], [variant])).toMatchObject({
      matched: 1,
      mismatched: [],
      missing: [],
    });
    for (const changed of [
      { ...template, id: "23456" },
      { ...template, category: "UTILITY" },
      {
        ...template,
        components: [{ type: "BODY", text: "Different content" }],
      },
    ]) {
      expect(auditProviderTemplateSnapshot([changed], [variant])).toMatchObject(
        { matched: 0, mismatched: [variant.key] }
      );
    }
    expect(auditProviderTemplateSnapshot([], [variant]).missing).toEqual([
      variant.key,
    ]);
  });
  it("rejects a recreated provider identity that no longer matches its frozen binding", () => {
    const withoutExpectedId = { ...variant, expectedTemplateId: undefined };
    const frozen = {
      ...withoutExpectedId,
      bindingDraft: {
        templateId: "12345",
        templateName: template.name,
        language: "en",
      },
    };
    expect(
      auditProviderTemplateSnapshot([{ ...template, id: "23456" }], [frozen])
    ).toMatchObject({ matched: 0, mismatched: [variant.key] });
    expect(
      auditProviderTemplateSnapshot(
        [template],
        [
          {
            ...frozen,
            bindingDraft: {
              ...frozen.bindingDraft,
              templateName: "another_name",
            },
          },
        ]
      )
    ).toMatchObject({ matched: 0, mismatched: [variant.key] });
    expect(
      auditProviderTemplateSnapshot(
        [template],
        [
          {
            ...frozen,
            bindingDraft: { ...frozen.bindingDraft, language: "ru" },
          },
        ]
      )
    ).toMatchObject({ matched: 0, mismatched: [variant.key] });
    expect(
      auditProviderTemplateSnapshot(
        [template],
        [
          {
            ...withoutExpectedId,
            bindingDraft: { templateId: "__REAL_TEMPLATE_ID__" },
          },
        ]
      ).matched
    ).toBe(1);
  });
  it("rejects duplicate reviewed content before provider submissions", () => {
    expect(() =>
      validateReviewedBatch({
        expectedVariantCount: 2,
        variants: [
          variant,
          {
            ...variant,
            key: "other:en",
            catalogId: "other",
            payload: { ...variant.payload, name: "airi_demo_other_en_v1" },
          },
        ],
      })
    ).toThrow("Duplicate reviewed content");
  });
  it("blocks duplicate provider content under a new name before creating another template", () => {
    const renamed = {
      ...variant,
      payload: { ...variant.payload, name: "airi_demo_another_en_v1" },
    };
    expect(() => assertNoDuplicateProviderContent([template], renamed)).toThrow(
      "Existing provider content"
    );
    expect(() =>
      assertNoDuplicateProviderContent([template], variant)
    ).not.toThrow();
    expect(() =>
      assertNoDuplicateProviderContent(
        [{ ...template, language: "ru" }],
        renamed
      )
    ).not.toThrow();
    expect(() =>
      assertNoDuplicateProviderContent(
        [{ ...template, category: "UTILITY" }],
        renamed
      )
    ).not.toThrow();
  });
  it("reports cross-category overlap for review without treating it as a duplicate definition", () => {
    const utility = {
      ...template,
      id: "23456",
      name: "real_transaction",
      category: "UTILITY",
    };
    const result = auditProviderTemplateSnapshot(
      [template, utility],
      [variant]
    );
    expect(result.duplicateContent).toEqual([]);
    expect(result.crossCategoryOverlap).toEqual([["12345", "23456"]]);
  });
});

describe("localized endpointless demo Flow contract", () => {
  const flow = {
    catalogId: "appointment-booking",
    name: "airi_demo_appointment_booking_en_v1",
    language: "en" as const,
    publicLocale: "en" as const,
    entryScreen: "FIRST_ENTRY_SCREEN",
    categories: ["APPOINTMENT_BOOKING"],
    endpointRequired: false,
    personalFields: [],
    flowJson: {
      version: "7.3",
      screens: [{ id: "FIRST_ENTRY_SCREEN", terminal: true }],
    },
  };

  it.each([
    ["en", "en"],
    ["ru", "ru"],
    ["kz", "kk"],
  ] as const)("accepts public %s with Meta language %s", (locale, language) => {
    expect(() =>
      assertReviewedDemoFlow({
        ...flow,
        name: `airi_demo_appointment_booking_${language}_v1`,
        publicLocale: locale,
        language,
      })
    ).not.toThrow();
  });

  it.each([
    { publicLocale: "kz" as const, language: "ru" as const },
    { name: "airi_demo_appointment_booking_kz_v1" },
    { endpointRequired: true },
    { personalFields: ["email"] },
    { entryScreen: "MISSING" },
    { flowJson: { screens: [{ id: "FIRST_ENTRY_SCREEN" }] } },
    { flowJson: { ...flow.flowJson, data_api_version: "3.0" } },
    { flowJson: { ...flow.flowJson, action: "data_exchange" } },
  ])("rejects an unsafe or inconsistent localized definition: %j", override => {
    expect(() => assertReviewedDemoFlow({ ...flow, ...override })).toThrow(
      "Unexpected endpointless demo Flow"
    );
  });
});

describe("operator-only deferred creation readback", () => {
  const options = {
    deferCreatedStatusReadback: true,
    apply: true,
    refreshReceipt: false,
    editExisting: false,
    publishFlows: false,
  };
  it.each([
    { apply: true },
    { refreshReceipt: true },
    { editExisting: true },
    { publishFlows: true },
    { deferCreatedStatusReadback: true },
  ])("rejects mutation/receipt mode in an inventory audit: %j", override => {
    expect(() =>
      assertDeferredCreatedStatusOptions({
        apply: false,
        refreshReceipt: false,
        editExisting: false,
        publishFlows: false,
        deferCreatedStatusReadback: false,
        auditReport: true,
        ...override,
      })
    ).toThrow("Inventory audit is read-only");
  });
  it("accepts a standalone read-only inventory audit", () => {
    expect(() =>
      assertDeferredCreatedStatusOptions({
        apply: false,
        refreshReceipt: false,
        editExisting: false,
        publishFlows: false,
        deferCreatedStatusReadback: false,
        auditReport: true,
      })
    ).not.toThrow();
  });
  it("permits only an explicit apply creation phase", () => {
    expect(() => assertDeferredCreatedStatusOptions(options)).not.toThrow();
  });
  it.each([
    { apply: false },
    { refreshReceipt: true },
    { editExisting: true },
    { publishFlows: true },
  ])("rejects deferred status in other operator modes", override => {
    expect(() =>
      assertDeferredCreatedStatusOptions({ ...options, ...override })
    ).toThrow("Deferred created status");
  });
  it("leaves existing modes available when the flag is absent", () => {
    expect(() =>
      assertDeferredCreatedStatusOptions({
        ...options,
        deferCreatedStatusReadback: false,
        apply: false,
        refreshReceipt: true,
      })
    ).not.toThrow();
  });
});

describe("final provider batch readback and local proof", () => {
  const variant = {
    key: "welcome:en",
    catalogId: "welcome",
    locale: "en" as const,
    language: "en" as const,
    payload: {
      name: "airi_demo_welcome_en_v1",
      language: "en",
      category: "MARKETING" as const,
      components: [{ type: "BODY", text: "*Welcome*, {{first_name}}" }],
    },
    bindingDraft: { values: { first_name: "Alex" } },
  };
  const template = {
    id: "12345",
    name: variant.payload.name,
    language: "en",
    category: "MARKETING",
    status: "APPROVED",
    components: variant.payload.components,
  };
  const entries = {
    [variant.key]: {
      name: template.name,
      language: "en",
      state: "accepted",
      templateId: template.id,
      recordId: "local-id",
      status: "PENDING",
      startedAt: "2026-10-05T00:00:00Z",
    },
  };
  const options = {
    variants: [variant],
    templates: indexProviderTemplates([template]),
    entries,
    apply: true,
    editExisting: false,
    requireComplete: true,
  };
  it("mirrors and proves the final exact snapshot before returning bindings and truthful verified status", async () => {
    const mirrorAndVerify = jest.fn().mockResolvedValue(undefined);
    const result = await verifyTemplateBatchSnapshots({
      ...options,
      mirrorAndVerify,
    });
    expect(mirrorAndVerify).toHaveBeenCalledWith(template, "local-id", variant);
    expect(result.entries[variant.key]).toMatchObject({
      recordId: "local-id",
      templateId: "12345",
      status: "APPROVED",
      state: "verified",
      startedAt: entries[variant.key].startedAt,
    });
    expect(result.bindings).toEqual([
      {
        ...variant.bindingDraft,
        templateId: "12345",
        templateName: template.name,
        language: "en",
      },
    ]);
    expect(entries[variant.key].status).toBe("PENDING");
  });
  it("keeps a receipt refresh read-only even if a mirror callback is available", async () => {
    const mirrorAndVerify = jest.fn();
    await verifyTemplateBatchSnapshots({
      ...options,
      apply: false,
      mirrorAndVerify,
    });
    expect(mirrorAndVerify).not.toHaveBeenCalled();
  });
  it("rejects partial deferred batches before local writes or binding output", async () => {
    const mirrorAndVerify = jest.fn();
    await expect(
      verifyTemplateBatchSnapshots({
        ...options,
        templates: new Map(),
        mirrorAndVerify,
      })
    ).rejects.toThrow("complete reviewed batch");
    expect(mirrorAndVerify).not.toHaveBeenCalled();
  });
  it("requires the canonical mirror and proof on every apply finalization", async () => {
    await expect(verifyTemplateBatchSnapshots(options)).rejects.toThrow(
      "local mirror proof"
    );
  });
  it("never returns bindings after a local mirror or proof failure and retains the acknowledged receipt", async () => {
    const mirrorAndVerify = jest
      .fn()
      .mockRejectedValue(new Error("Local mirror proof mismatch"));
    await expect(
      verifyTemplateBatchSnapshots({ ...options, mirrorAndVerify })
    ).rejects.toThrow("Local mirror proof mismatch");
    expect(entries[variant.key]).toMatchObject({
      state: "accepted",
      templateId: "12345",
      status: "PENDING",
    });
  });
  it("rejects missing local record ownership before mirroring", async () => {
    const mirrorAndVerify = jest.fn();
    await expect(
      verifyTemplateBatchSnapshots({
        ...options,
        entries: {
          [variant.key]: { ...entries[variant.key], recordId: undefined },
        },
        mirrorAndVerify,
      })
    ).rejects.toThrow("Local record ownership");
    expect(mirrorAndVerify).not.toHaveBeenCalled();
  });
  it("rejects a provider id different from the acknowledged id before mirroring", async () => {
    const mirrorAndVerify = jest.fn();
    await expect(
      verifyTemplateBatchSnapshots({
        ...options,
        entries: {
          [variant.key]: { ...entries[variant.key], templateId: "99999" },
        },
        mirrorAndVerify,
      })
    ).rejects.toThrow("Acknowledged template ID mismatch");
    expect(mirrorAndVerify).not.toHaveBeenCalled();
  });
  it("rejects a changed body before mirroring or binding output", async () => {
    const mirrorAndVerify = jest.fn();
    await expect(
      verifyTemplateBatchSnapshots({
        ...options,
        templates: new Map([
          [
            providerTemplateKey(template.name, template.language),
            {
              ...template,
              components: [{ type: "BODY", text: "Another body" }],
            },
          ],
        ]),
        mirrorAndVerify,
      })
    ).rejects.toThrow("Provider identity/content mismatch");
    expect(mirrorAndVerify).not.toHaveBeenCalled();
  });
});

describe("reviewed demo batch size", () => {
  function plan(count: number) {
    return {
      variants: Array.from({ length: count }, (_, index) => ({
        key: `example-${index}:en`,
        catalogId: `example-${index}`,
        locale: "en" as const,
        language: "en" as const,
        payload: {
          name: `airi_demo_example_${index}_en_v1`,
          language: "en",
          category: "MARKETING" as const,
          components: [{ type: "BODY", text: `Distinct example ${index}` }],
        },
        bindingDraft: {},
      })),
    };
  }
  it("preserves the original 36-variant manifest", () => {
    expect(validateReviewedBatch(plan(36))).toBe(36);
  });
  it("accepts a declared 50-example single-language expansion", () => {
    expect(
      validateReviewedBatch({ ...plan(50), expectedVariantCount: 50 })
    ).toBe(50);
  });
  it.each([0, -1, 251, 1.5])(
    "rejects an invalid declared size %s",
    expectedVariantCount => {
      expect(() =>
        validateReviewedBatch({ ...plan(1), expectedVariantCount })
      ).toThrow("reviewed");
    }
  );
  it("rejects a partial batch", () => {
    expect(() =>
      validateReviewedBatch({ ...plan(49), expectedVariantCount: 50 })
    ).toThrow("reviewed");
  });
  it("rejects duplicate IDs and names", () => {
    const duplicate = plan(50);
    duplicate.variants[1] = duplicate.variants[0];
    expect(() =>
      validateReviewedBatch({ ...duplicate, expectedVariantCount: 50 })
    ).toThrow("reviewed");
  });
});

describe("public demo provider reconciliation", () => {
  const variant = {
    key: "seasonal-offer:ru",
    catalogId: "seasonal-offer",
    locale: "ru" as const,
    language: "ru" as const,
    payload: {
      name: "airi_demo_seasonal_offer_ru_v1",
      language: "ru",
      category: "MARKETING" as const,
      components: [
        {
          type: "BODY",
          text: "Р’Р°Р·Р° Terra СЃРЅРѕРІР° РІ\u00a0РЅР°Р»РёС‡РёРё.\nРџРѕРєР°Р·Р°С‚СЊ РёРЅС‚РµСЂСЊРµСЂ?",
        },
      ],
    },
    bindingDraft: {},
  };
  const template = {
    id: "1069669322718759",
    name: variant.payload.name,
    language: "ru",
    category: "MARKETING",
    status: "PENDING",
    components: [
      {
        type: "BODY",
        text: "Р’Р°Р·Р° Terra СЃРЅРѕРІР° РІ РЅР°Р»РёС‡РёРё.\nРџРѕРєР°Р·Р°С‚СЊ РёРЅС‚РµСЂСЊРµСЂ?",
      },
    ],
  };

  it("accepts Meta's observed conversion of nonbreaking typography spaces", () => {
    expect(() => assertProviderIdentity(template, variant)).not.toThrow();
  });
  const enhanced = {
    ...variant,
    expectedTemplateId: template.id,
    previousComponents: variant.payload.components,
    payload: {
      ...variant.payload,
      components: [
        {
          type: "BODY",
          text: "*airi.chat demo*\nHi {{customer_name}}, would you like to explore this product?",
        },
      ],
    },
  };
  it("requires explicit edit mode to change an existing approved template", () => {
    expect(() =>
      getTemplateReconciliationAction(template, enhanced, false)
    ).toThrow("mismatch");
  });
  it("permits an edit only when the exact reviewed original still matches", () => {
    expect(getTemplateReconciliationAction(template, enhanced, true)).toBe(
      "edit"
    );
  });
  it("rejects concurrent content changes instead of overwriting them", () => {
    expect(() =>
      getTemplateReconciliationAction(
        {
          ...template,
          components: [{ type: "BODY", text: "Someone else's edit" }],
        },
        enhanced,
        true
      )
    ).toThrow("mismatch");
  });
  it("rejects a different existing ID even if the content matches", () => {
    expect(() =>
      getTemplateReconciliationAction(
        { ...template, id: "1234", components: enhanced.payload.components },
        enhanced,
        true
      )
    ).toThrow("ID");
  });
  it("reuses a previously completed edit without sending it again", () => {
    expect(
      getTemplateReconciliationAction(
        { ...template, components: enhanced.payload.components },
        enhanced,
        true
      )
    ).toBe("reuse");
  });
  it("rejects an edit without the original ID and content proof", () => {
    expect(() =>
      getTemplateReconciliationAction(
        template,
        { ...enhanced, expectedTemplateId: undefined },
        true
      )
    ).toThrow("original");
  });
  it.each([
    { id: "wrong" },
    { name: "another" },
    { language: "en" },
    { category: "UTILITY" },
    { components: [{ type: "BODY", text: "A different offer" }] },
  ])("rejects altered provider identity or wording: %j", change => {
    expect(() =>
      assertProviderIdentity({ ...template, ...change }, variant)
    ).toThrow("mismatch");
  });

  const imageComponents = [
    {
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: ["review-handle"] },
    },
    { type: "BODY", text: "An airi.chat demo" },
    { type: "FOOTER", text: "Unsubscribe: samat@airi.chat" },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: "View demo",
          url: "https://airi.chat/whatsapp-templates?q=seasonal-offer",
        },
      ],
    },
  ];
  const flowComponents = [
    { type: "BODY", text: "A static course demo" },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "FLOW",
          text: "Open demo form",
          flow_id: "1405476187830423",
          flow_action: "navigate",
          navigate_screen: "COURSE_DEMO",
        },
      ],
    },
  ];
  const carouselComponents = [
    { type: "BODY", text: "Three fictional products" },
    {
      type: "CAROUSEL",
      cards: ["Sneakers", "Backpack", "Jacket"].map(text => ({
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: [text] },
          },
          { type: "BODY", text },
          {
            type: "BUTTONS",
            buttons: [
              {
                type: "URL",
                text: "View demo",
                url: "https://airi.chat/whatsapp-templates?q=back-in-stock",
              },
            ],
          },
        ],
      })),
    },
  ];
  type Components = Parameters<typeof assertProviderIdentity>[0]["components"];
  const reconcile = (actual: Components, expected = actual) =>
    assertProviderIdentity(
      { ...template, components: actual },
      { ...variant, payload: { ...variant.payload, components: expected } }
    );

  it("accepts provider CDN samples while checking the image template", () => {
    const actual = JSON.parse(JSON.stringify(imageComponents));
    actual[0].example.header_handle = ["https://provider.example/image"];
    expect(() => reconcile(actual, imageComponents)).not.toThrow();
  });

  it.each([
    "header format",
    "footer",
    "CTA URL",
    "CTA text",
    "component order",
  ])("rejects changed %s", change => {
    const actual = JSON.parse(JSON.stringify(imageComponents));
    if (change === "header format") actual[0].format = "VIDEO";
    if (change === "footer") actual[2].text = "Another unsubscribe address";
    if (change === "CTA URL")
      actual[3].buttons[0].url = "https://other.example/";
    if (change === "CTA text") actual[3].buttons[0].text = "Buy now";
    if (change === "component order") actual.reverse();
    expect(() => reconcile(actual, imageComponents)).toThrow("mismatch");
  });

  it("accepts observed numeric Flow IDs and uppercase actions", () => {
    const actual = JSON.parse(JSON.stringify(flowComponents));
    actual[1].buttons[0].flow_id = 1405476187830423;
    actual[1].buttons[0].flow_action = "NAVIGATE";
    expect(() => reconcile(actual, flowComponents)).not.toThrow();
  });

  it.each(["flow_id", "flow_action", "navigate_screen"])(
    "rejects a changed Flow %s",
    field => {
      const actual = JSON.parse(JSON.stringify(flowComponents));
      actual[1].buttons[0][field] = "another";
      expect(() => reconcile(actual, flowComponents)).toThrow("mismatch");
    }
  );

  it.each(["body", "count", "order", "CTA"])(
    "rejects changed carousel %s",
    change => {
      const actual = JSON.parse(JSON.stringify(carouselComponents));
      const cards = actual[1].cards;
      if (change === "body")
        cards[1].components[1].text = "A different product";
      if (change === "count") cards.pop();
      if (change === "order") cards.reverse();
      if (change === "CTA")
        cards[2].components[2].buttons[0].url = "https://other.example/";
      expect(() => reconcile(actual, carouselComponents)).toThrow("mismatch");
    }
  );
});

describe("public demo operation recovery", () => {
  const accepted = {
    name: "airi_demo_welcome_en_v1",
    language: "en",
    state: "accepted",
    startedAt: "2026-10-05T07:00:00Z",
    templateId: "123456",
    recordId: "local-record",
    status: "PENDING",
  };

  it("keeps the creation fence after refreshing an acknowledged receipt", () => {
    const refreshed = verifiedReceiptEntry(
      accepted,
      {
        id: accepted.templateId,
        name: accepted.name,
        language: accepted.language,
        status: "APPROVED",
      },
      "local-record"
    );
    expect(refreshed).toMatchObject({
      startedAt: accepted.startedAt,
      templateId: accepted.templateId,
      recordId: accepted.recordId,
      state: "verified",
      status: "APPROVED",
    });
    expect(hasTemplateCreationFence(refreshed)).toBe(true);
  });

  it("fences an acknowledged ID even if an earlier refresh removed startedAt", () => {
    expect(
      hasTemplateCreationFence({
        name: accepted.name,
        language: accepted.language,
        state: "legacy",
        templateId: accepted.templateId,
      })
    ).toBe(true);
  });

  it.each(["submitting", "accepted", "verified", "needs_reconciliation"])(
    "requires reconciliation for prior %s state without an ID or timestamp",
    state => {
      expect(
        hasTemplateCreationFence({
          name: accepted.name,
          language: accepted.language,
          state,
        })
      ).toBe(true);
    }
  );

  it("permits a new operation when no prior submission evidence exists", () => {
    expect(hasTemplateCreationFence(undefined)).toBe(false);
    expect(
      hasTemplateCreationFence({
        name: accepted.name,
        language: accepted.language,
        state: "not_submitted",
      })
    ).toBe(false);
  });

  it("keeps startedAt as a fence for older receipt states", () => {
    expect(
      hasTemplateCreationFence({
        name: accepted.name,
        language: accepted.language,
        state: "legacy",
        startedAt: accepted.startedAt,
      })
    ).toBe(true);
  });

  it("keeps acknowledged IDs when receipt persistence fails", () => {
    expect(
      reconciliationEntry(accepted, new Error("Disk write failed"), [])
    ).toEqual({
      ...accepted,
      state: "needs_reconciliation",
      error: "Disk write failed",
    });
  });

  it("retains a provider acknowledgment after local persistence failure", () => {
    const failure = Object.assign(new Error("Insert failed"), {
      metaTemplateId: "654321",
      metaTemplateStatus: "APPROVED",
    });
    expect(
      reconciliationEntry(
        { name: accepted.name, language: "en", state: "submitting" },
        failure,
        []
      )
    ).toMatchObject({
      state: "needs_reconciliation",
      templateId: "654321",
      status: "APPROVED",
    });
  });

  it("redacts raw and encoded secrets before receipts or terminal output", () => {
    const secret = "token/with+symbols";
    const failure = new Error(
      `raw=${secret} encoded=${encodeURIComponent(secret)} access_token=unknown-token&x=1 Bearer other-token`
    );
    const message = operatorErrorMessage(failure, [secret, ""]);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(encodeURIComponent(secret));
    expect(message).not.toContain("unknown-token");
    expect(message).not.toContain("other-token");
    expect(reconciliationEntry(accepted, failure, [secret]).error).toBe(
      message
    );
  });
});

describe("reviewed operator edit recovery and mutation budget", () => {
  it.each(["updating", "needs_reconciliation"])(
    "fences prior %s edit evidence without a timestamp",
    state => {
      expect(
        hasTemplateUpdateFence({
          name: "airi_demo_example_en_v1",
          language: "en",
          state,
        })
      ).toBe(true);
    }
  );
  it("fences an earlier edit timestamp even after receipt verification", () => {
    expect(
      hasTemplateUpdateFence({
        name: "airi_demo_example_en_v1",
        language: "en",
        state: "verified",
        updateStartedAt: "2026-10-05T07:00:00Z",
      })
    ).toBe(true);
  });
  it("allows an initial edit of a created receipt", () => {
    expect(hasTemplateUpdateFence(undefined)).toBe(false);
    expect(
      hasTemplateUpdateFence({
        name: "airi_demo_example_en_v1",
        language: "en",
        state: "verified",
        templateId: "123",
      })
    ).toBe(false);
  });
  it.each([
    [0, 0, 1, true],
    [1, 0, 1, false],
    [0, 1, 1, false],
    [1, 1, 2, false],
    [1, 1, 3, true],
  ])(
    "counts creates and edits together (%s creates, %s edits, limit%s)",
    (created, edited, limit, expected) => {
      expect(
        hasDemoMutationBudget(Number(created), Number(edited), Number(limit))
      ).toBe(expected);
    }
  );
});

describe("Flow mutation and recovered mirror proof", () => {
  it("reuses the acknowledged update snapshot instead of initiating a second read", () => {
    const template = {
      id: "123",
      name: "demo",
      language: "en",
      status: "PENDING",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Sample" }],
    };
    expect(requireTemplateUpdateSnapshot({ success: true, template })).toBe(
      template
    );
  });
  it.each([{ success: false }, { success: true }])(
    "fences an acknowledged update without a fresh snapshot: %j",
    result => {
      expect(() => requireTemplateUpdateSnapshot(result)).toThrow(
        "readback requires reconciliation"
      );
    }
  );
  it.each(["uploading", "publishing", "needs_reconciliation"])(
    "fences prior %s Flow mutations even without a timestamp",
    status => expect(hasFlowMutationFence({ status })).toBe(true)
  );
  it("keeps an uncertain Flow checkpoint independent of provider draft status", () => {
    expect(
      hasFlowMutationFence({ status: "DRAFT", mutationStartedAt: "now" })
    ).toBe(true);
    expect(
      hasFlowMutationFence({ status: "DRAFT", mutationOperation: "publish" })
    ).toBe(true);
    expect(hasFlowMutationFence({ status: "DRAFT" })).toBe(false);
    expect(hasFlowMutationFence(undefined)).toBe(false);
  });
  it("requires mirror reconciliation only for prior edits or uncertain outcomes", () => {
    const entry = { name: "demo", language: "en", state: "verified" };
    expect(requiresRecoveredTemplateMirror(undefined)).toBe(false);
    expect(requiresRecoveredTemplateMirror(entry)).toBe(false);
    expect(
      requiresRecoveredTemplateMirror({ ...entry, updateStartedAt: "now" })
    ).toBe(true);
    expect(
      requiresRecoveredTemplateMirror({
        ...entry,
        state: "needs_reconciliation",
      })
    ).toBe(true);
  });
  it("fails closed when the canonical mirror reports swallowed failures", () => {
    expect(() =>
      assertTemplateMirrorResult({ errors: ["local cache failure"] })
    ).toThrow("Mirror reconciliation failed");
    expect(() => assertTemplateMirrorResult({ errors: [] })).not.toThrow();
  });
});
