const mockFindById = jest.fn();
const mockCreate = jest.fn();
const mockUpdateOne = jest.fn();
const mockSource = jest.fn();
const mockSend = jest.fn();
const mockCollectEdge = jest.fn();
const mockRate = jest.fn();
const mockCacheGet = jest.fn();
const mockConsent = jest.fn();
const mockFlowFacts = jest.fn();
const mockCacheSet = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => value,
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTemplate: (...args: unknown[]) => mockSend(...args),
}));
jest.mock("@/lib/whatsapp/flows/template-flow-facts", () => ({
  readTemplateFlowFacts: (...args: unknown[]) => mockFlowFacts(...args),
}));
jest.mock("@/lib/whatsapp/marketing-consent", () => ({
  upsertWhatsAppMarketingConsent: (...args: unknown[]) => mockConsent(...args),
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
  buildCacheKey: (prefix: string, keys: string[]) =>
    `${prefix}:${keys.join(":")}`,
}));
jest.mock("@/models/public-template-request", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => ({ lean: () => mockFindById(...args) }),
    create: (...args: unknown[]) => mockCreate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({}),
  collectMetaGraphEdge: (...args: unknown[]) => mockCollectEdge(...args),
  MetaGraphRequestError: class MetaGraphRequestError extends Error {
    status: number;
    constructor(status: number) {
      super("provider error");
      this.status = status;
    }
  },
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: jest.fn(() => ({})),
  checkCriticalRateLimit: (...args: unknown[]) => mockRate(...args),
}));

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { createRateLimiter } from "@icecore/shared/lib/rate-limiter";
import { WHATSAPP_MARKETING_CONSENT_SOURCES } from "@icecore/whatsapp/marketingConsent";
import bundledBindings from "./delivery-bindings-186.json";
import { createHash } from "node:crypto";
import {
  assertPublicTemplateSubmissionRequestAllowed,
  getPublicTemplateReadiness,
  requestPublicTemplate,
} from "./template-delivery.server";
import {
  PUBLIC_TEMPLATE_CONSENT_VERSION,
  publicTemplateLocaleSchema,
  publicTemplateRequestBodySchema,
} from "./template-request";
import {
  PUBLIC_TEMPLATES,
  isPublicTemplateAvailableInLocale,
} from "./public-template-catalog";

const getReadyPublicTemplateIds = async (
  locale: Parameters<typeof getPublicTemplateReadiness>[0]
) => (await getPublicTemplateReadiness(locale)).readyTemplateIds;

const body = publicTemplateRequestBodySchema.parse({
  templateId: "welcome",
  locale: "en",
  name: "Sam",
  email: "sam@company.com",
  phone: "+77001234567",
  consent: true,
  consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
  website: "",
  requestId: "35f5218c-5d38-4d2a-87d0-f2ac0206a1fd",
  source: "marketplace",
});
const binding = {
  catalogId: "welcome",
  locale: "en",
  templateId: "1001",
  templateName: "airi_welcome_demo",
  language: "en",
};
const approved = {
  id: "1001",
  name: "airi_welcome_demo",
  language: "en",
  status: "APPROVED",
  category: "MARKETING",
  components: [{ type: "BODY", text: "Welcome to airi.chat" }],
};
const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  (createRateLimiter as jest.Mock).mockImplementation(config => config);
  process.env.PUBLIC_WHATSAPP_TEMPLATE_WORKSPACE_ID = "workspace-own";
  process.env.PUBLIC_WHATSAPP_TEMPLATE_SOURCE_ID = "source-own";
  process.env.PUBLIC_WHATSAPP_TEMPLATE_RATE_LIMIT_SECRET =
    "test-secret-at-least-32-characters-long";
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([binding]);
  delete process.env.PUBLIC_WHATSAPP_TEMPLATE_MANIFEST;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";
  mockFindById.mockResolvedValue(null);
  mockCacheGet.mockResolvedValue(null);
  mockCacheSet.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue([]);
  mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockConsent.mockResolvedValue({
    matchedConversations: 0,
    modifiedConversations: 0,
  });
  mockFlowFacts.mockResolvedValue([]);
  mockSource.mockResolvedValue({
    ok: true,
    source: {
      id: "source-own",
      workspace_id: "workspace-own",
      type: "whatsapp",
      credentials: {
        accessToken: "private-token",
        phoneNumberId: "2001",
        wabaId: "3001",
      },
    },
  });
  mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("phone_numbers") ? [{ id: "2001" }] : [approved]
  );
  mockRate.mockResolvedValue({
    status: "granted",
    limit: 5,
    remaining: 4,
    reset: Date.now() + 30_000,
  });
  mockSend.mockImplementation(async (...args: unknown[]) => {
    await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
    return { messageId: "wamid.provider", date: 1791060000 };
  });
});
afterAll(() => {
  process.env = savedEnv;
});

it("persists explicit marketing consent and reserves before sending through the canonical owner", async () => {
  await expect(requestPublicTemplate(body, "198.51.100.8")).resolves.toEqual({
    status: "accepted",
  });
  expect(mockSource).toHaveBeenCalledWith("source-own", "whatsapp", {
    workspace_id: "workspace-own",
  });
  expect(mockCollectEdge).toHaveBeenCalledWith(
    expect.objectContaining({ path: "3001/message_templates" })
  );
  expect(mockCreate).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        name: "Sam",
        email: "sam@company.com",
        phone: "+77001234567",
        consentVersion: "public-template-demo-marketing-v2",
        marketingConsent: true,
        consentedAt: expect.any(Date),
        state: "reserved",
        source: "marketplace",
      }),
    ],
    expect.objectContaining({ writeConcern: { w: "majority", wtimeout: 5000 } })
  );
  expect(mockConsent).toHaveBeenCalledTimes(1);
  expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(
    mockConsent.mock.invocationCallOrder[0]
  );
  expect(mockConsent).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-own",
      sourceId: "source-own",
      waId: "77001234567",
      wabaId: "3001",
      phoneNumberId: "2001",
      status: true,
      source: "public_template_checkbox",
      eventAt: mockCreate.mock.calls[0][0][0].consentedAt,
      eventKey: `public-template:${mockCreate.mock.calls[0][0][0]._id}:marketing-consent:${body.consentVersion}`,
      payload: expect.objectContaining({
        consentVersion: body.consentVersion,
        locale: "en",
      }),
    })
  );
  expect(mockConsent.mock.invocationCallOrder[0]).toBeLessThan(
    mockSend.mock.invocationCallOrder[0]
  );
  expect(mockSend).toHaveBeenCalledWith(
    "2001",
    "private-token",
    { kind: "phone", value: "77001234567" },
    "airi_welcome_demo",
    "en",
    undefined,
    expect.objectContaining({
      requirePhoneRecipient: true,
      redactTemplatePayloadInLogs: true,
    })
  );
  expect(mockUpdateOne).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      $set: expect.objectContaining({
        state: "accepted",
        providerMessageId: "wamid.provider",
      }),
    }),
    expect.anything()
  );
  const keys = mockRate.mock.calls.map(call => call[1]);
  expect(keys).not.toContain("198.51.100.8");
  expect(keys).not.toContain("77001234567");
});

it.each(["unavailable", "limited"])(
  "fails closed for rate limit %s before collecting a lead",
  async status => {
    mockRate.mockResolvedValue({ status, reset: Date.now() + 1000 });
    await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
      code: status === "limited" ? "rate_limited" : "unavailable",
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  }
);

it("uses a separate HMAC ingress budget before parsing or collecting a lead", async () => {
  await expect(
    assertPublicTemplateSubmissionRequestAllowed("198.51.100.8")
  ).resolves.toBeUndefined();
  expect(createRateLimiter).toHaveBeenCalledWith({
    requests: 20,
    window: "1 m",
    prefix: "landing:template:submission-ip",
    analytics: false,
  });
  expect(mockRate).toHaveBeenCalledWith(
    expect.anything(),
    expect.stringMatching(/^[a-f0-9]{64}$/)
  );
  expect(mockFindById).not.toHaveBeenCalled();
  expect(mockSource).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it.each(["unavailable", "limited"])(
  "fails closed when the ingress limiter is %s",
  async status => {
    mockRate.mockResolvedValue({ status, reset: Date.now() + 60_000 });
    await expect(
      assertPublicTemplateSubmissionRequestAllowed("unknown")
    ).rejects.toMatchObject({
      code: status === "limited" ? "rate_limited" : "unavailable",
      ...(status === "limited" ? { retryAfter: 60 } : {}),
    });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSource).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  }
);

it.each(["limited", "unavailable"])(
  "withholds new sends when the recipient daily limiter is %s",
  async status => {
    mockRate.mockImplementation(async ({ prefix }: { prefix: string }) => ({
      status: prefix === "landing:template:phone-daily" ? status : "granted",
      reset: Date.now() + 86_400_000,
    }));
    await expect(
      requestPublicTemplate(body, "198.51.100.8")
    ).rejects.toMatchObject({
      code: status === "limited" ? "rate_limited" : "unavailable",
      ...(status === "limited" ? { retryAfter: 86_400 } : {}),
    });
    expect(createRateLimiter).toHaveBeenCalledWith({
      requests: 10,
      window: "1 d",
      prefix: "landing:template:phone-daily",
      analytics: false,
    });
    expect(mockSource).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockConsent).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  }
);

it("shares the daily recipient budget across normalized phones, IPs, templates and locales", async () => {
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
    binding,
    {
      ...binding,
      catalogId: "repeat-purchase",
      locale: "ru",
      templateId: "1002",
      language: "ru",
    },
  ]);
  mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("phone_numbers")
      ? [{ id: "2001" }]
      : [approved, { ...approved, id: "1002", language: "ru" }]
  );
  await requestPublicTemplate(body, "198.51.100.8");
  await requestPublicTemplate(
    publicTemplateRequestBodySchema.parse({
      ...body,
      templateId: "repeat-purchase",
      locale: "ru",
      phone: "+7 (700) 123-45-67",
      requestId: "7e4e8c36-38d4-45f4-a6da-8b9d852e559e",
    }),
    "203.0.113.1"
  );
  const dailyKeys = mockRate.mock.calls
    .filter(([config]) => config.prefix === "landing:template:phone-daily")
    .map(([, key]) => key);
  expect(dailyKeys).toHaveLength(2);
  expect(dailyKeys[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(dailyKeys[1]).toBe(dailyKeys[0]);
  expect(dailyKeys[0]).not.toContain("77001234567");
});

it.each([
  { ...approved, components: [{ type: "BODY", text: "Hi {{1}}" }] },
  {
    ...approved,
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Welcome" },
    ],
  },
])(
  "does not send demos with missing samples or header media",
  async template => {
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers") ? [{ id: "2001" }] : [template]
    );
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      { ...binding, components: [] },
    ]);
    await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  }
);

it("accepts complete fixed body parameters without duplicating a values map", async () => {
  const template = {
    ...approved,
    components: [{ type: "BODY", text: "Hi {{1}}" }],
  };
  mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("phone_numbers") ? [{ id: "2001" }] : [template]
  );
  const components = [
    { type: "body", parameters: [{ type: "text", text: "Alex" }] },
  ];
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
    { ...binding, components },
  ]);
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "accepted",
  });
  expect(mockSend.mock.calls[0][5]).toEqual(components);
});

it.each([
  { type: "text", text: " " },
  { type: "text", text: "Alex" },
  { type: "text", text: "Alex", parameter_name: "wrong_name" },
])("rejects blank or mismatched named fixed parameters", async parameter => {
  const template = {
    ...approved,
    components: [{ type: "BODY", text: "Hi {{customer_name}}" }],
  };
  mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("phone_numbers") ? [{ id: "2001" }] : [template]
  );
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
    { ...binding, components: [{ type: "body", parameters: [parameter] }] },
  ]);
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});

it("rejects unbound templates without collecting leads", async () => {
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = "[]";
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(mockFindById).not.toHaveBeenCalled();
  expect(mockSource).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it.each([
  { ...approved, status: "PENDING" },
  { ...approved, category: "UTILITY" },
  { ...approved, category: "AUTHENTICATION" },
  { ...approved, category: "UNKNOWN" },
  { ...approved, id: "other-waba-template" },
  { ...approved, language: "ru" },
  { ...approved, name: "other_name" },
])("rejects mismatched or unapproved live Meta templates", async template => {
  mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
    path.endsWith("phone_numbers") ? [{ id: "2001" }] : [template]
  );
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});

it("rejects a sender outside the configured WABA", async () => {
  mockCollectEdge.mockResolvedValue([{ id: "wrong-phone" }]);
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});

it("replays accepted requests without a second provider dispatch", async () => {
  await requestPublicTemplate(body, "ip");
  const record = mockCreate.mock.calls[0][0][0];
  mockFindById.mockResolvedValue({ ...record, state: "accepted" });
  mockRate.mockImplementation(async ({ prefix }: { prefix: string }) => ({
    status: prefix === "landing:template:phone-daily" ? "limited" : "granted",
    reset: Date.now() + 86_400_000,
  }));
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "accepted",
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockConsent).toHaveBeenCalledTimes(1);
  const configuredLimiters = (createRateLimiter as jest.Mock).mock.calls;
  expect(
    configuredLimiters.filter(
      ([config]) => config.prefix === "landing:template:ip"
    )
  ).toHaveLength(2);
  expect(
    configuredLimiters.filter(
      ([config]) => config.prefix === "landing:template:phone-daily"
    )
  ).toHaveLength(1);
});

it("withholds dispatch if canonical consent persistence fails", async () => {
  mockConsent.mockRejectedValue(new Error("consent unavailable"));
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "send_failed",
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockUpdateOne).toHaveBeenLastCalledWith(
    expect.anything(),
    { $set: { state: "failed" } },
    expect.anything()
  );
});

it("keeps receipt-time consent older than withdrawals during slow provider preflight", async () => {
  const receivedAt = new Date("2026-10-05T14:00:00.000Z");
  jest.useFakeTimers();
  jest.setSystemTime(receivedAt);
  try {
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) => {
      // A withdrawal at 14:00:01 must remain newer than this checkbox event,
      // even though the account/approval checks finish at 14:00:10.
      jest.setSystemTime(new Date("2026-10-05T14:00:10.000Z"));
      return path.endsWith("phone_numbers") ? [{ id: "2001" }] : [approved];
    });
    await requestPublicTemplate(body, "ip");
    expect(mockCreate.mock.calls[0][0][0].consentedAt).toEqual(receivedAt);
    expect(mockConsent.mock.calls[0][0].eventAt).toEqual(receivedAt);
  } finally {
    jest.useRealTimers();
  }
});

it("recognizes public template checkbox evidence through the canonical consent allowlist", () => {
  expect(WHATSAPP_MARKETING_CONSENT_SOURCES).toContain(
    "public_template_checkbox"
  );
});

describe("server-owned manifest activation", () => {
  it("uses the reviewed bundled manifest without putting its JSON in an environment variable", async () => {
    delete process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS;
    process.env.PUBLIC_WHATSAPP_TEMPLATE_MANIFEST = "airi-demo-186-v1";
    const welcome = bundledBindings.find(
      item => item.catalogId === "welcome" && item.locale === "en"
    )!;
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : [
            {
              ...approved,
              id: welcome.templateId,
              name: welcome.templateName,
              components: [{ type: "BODY", text: "Hi {{1}}" }],
            },
          ]
    );
    await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
      status: "accepted",
    });
    expect(mockSend.mock.calls[0][3]).toBe(welcome.templateName);
    expect(mockCreate.mock.calls[0][0][0].metaTemplateId).toBe(
      welcome.templateId
    );
  });

  it.each(["unknown", "../../private", ""])(
    "fails closed for unknown manifest %p",
    async selector => {
      delete process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS;
      process.env.PUBLIC_WHATSAPP_TEMPLATE_MANIFEST = selector;
      await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(mockSource).not.toHaveBeenCalled();
    }
  );

  it("rejects an ambiguous manifest plus inline binding configuration", async () => {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_MANIFEST = "airi-demo-186-v1";
    await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(mockSource).not.toHaveBeenCalled();
  });
});

it("does not promote an earlier demo-only reservation to marketing consent", async () => {
  const consentVersion = "public-template-demo-v1";
  const legacyRecord = {
    _id: createHash("sha256")
      .update(`public-template:${body.requestId}`)
      .digest("hex"),
    payloadDigest: createHash("sha256")
      .update(
        JSON.stringify([
          body.templateId,
          body.locale,
          body.name,
          body.email,
          body.phone,
          body.source,
          consentVersion,
        ])
      )
      .digest("hex"),
    consentVersion,
    state: "accepted",
  };
  mockFindById.mockResolvedValue(legacyRecord);

  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(legacyRecord.consentVersion).toBe("public-template-demo-v1");
  expect(legacyRecord).not.toHaveProperty("marketingConsent");
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdateOne).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it("never resends after a provider timeout or unknown duplicate", async () => {
  mockSend.mockImplementation(async (...args: unknown[]) => {
    await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
    throw new Error("timeout containing customer data");
  });
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "processing",
  });
  const record = mockCreate.mock.calls[0][0][0];
  mockFindById.mockResolvedValue({ ...record, state: "unknown" });
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "processing",
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it("rejects request ID reuse with different visitor details", async () => {
  await requestPublicTemplate(body, "ip");
  mockFindById.mockResolvedValue(mockCreate.mock.calls[0][0][0]);
  await expect(
    requestPublicTemplate({ ...body, email: "different@company.com" }, "ip")
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it("handles a concurrent duplicate through the existing reservation", async () => {
  await requestPublicTemplate(body, "ip");
  const record = mockCreate.mock.calls[0][0][0];
  mockFindById
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...record, state: "dispatching" });
  mockCreate.mockRejectedValue({ code: 11000 });
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "processing",
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it("keeps provider acceptance fenced when the completion write fails", async () => {
  mockUpdateOne
    .mockResolvedValueOnce({ matchedCount: 1 })
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValueOnce({ matchedCount: 1 });
  await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
    status: "processing",
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it("returns send_failed for an explicit provider rejection", async () => {
  mockSend.mockImplementation(async (...args: unknown[]) => {
    await (args[6] as { beforeSend: () => Promise<void> }).beforeSend();
    throw new (MetaGraphRequestError as unknown as new (
      status: number
    ) => Error)(400);
  });
  await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
    code: "send_failed",
  });
  expect(mockUpdateOne).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      $set: expect.objectContaining({ state: "failed" }),
    }),
    expect.anything()
  );
});

it("readiness exposes only catalog IDs for a matching approved locale", async () => {
  await expect(getReadyPublicTemplateIds("en")).resolves.toEqual(["welcome"]);
  await expect(getReadyPublicTemplateIds("ru")).resolves.toEqual([]);
});

it.each(["UTILITY", "AUTHENTICATION", "UNKNOWN"])(
  "does not advertise a public demo reclassified as %s",
  async category => {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_RATE_LIMIT_SECRET += category;
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : [{ ...approved, category }]
    );
    await expect(getReadyPublicTemplateIds("en")).resolves.toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  }
);

it("distinguishes configured readiness outages from unprepared templates", async () => {
  process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
    { ...binding, templateName: "airi_outage_demo" },
  ]);
  mockCollectEdge.mockRejectedValue(new Error("provider unavailable"));
  await expect(getReadyPublicTemplateIds("en")).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("performs no persistence or provider reads for unconfigured readiness", async () => {
  delete process.env.PUBLIC_WHATSAPP_TEMPLATE_SOURCE_ID;
  await expect(getReadyPublicTemplateIds("en")).resolves.toEqual([]);
  expect(mockSource).not.toHaveBeenCalled();
  expect(mockCollectEdge).not.toHaveBeenCalled();
  expect(mockFindById).not.toHaveBeenCalled();
});

describe("temporary Flow verification failures", () => {
  function configureFlowFact(
    fact: Record<string, unknown>,
    templateStatus = "APPROVED"
  ) {
    const flowBinding = {
      ...binding,
      catalogId: "appointment-booking",
      templateId: "1002",
      templateName:
        `airi_temporary_${String(fact.state)}_${String(fact.status || "none")}_${templateStatus}_${fact.screenIds === null ? "no_screens" : "screen_facts"}`.toLowerCase(),
    };
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      binding,
      flowBinding,
    ]);
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : [
            approved,
            {
              ...approved,
              id: flowBinding.templateId,
              name: flowBinding.templateName,
              status: templateStatus,
              components: [
                { type: "BODY", text: "Booking example" },
                {
                  type: "BUTTONS",
                  buttons: [
                    {
                      type: "FLOW",
                      text: "Open",
                      flow_id: "9001",
                      flow_action: "navigate",
                      navigate_screen: "START",
                    },
                  ],
                },
              ],
            },
          ]
    );
    mockFlowFacts.mockResolvedValue([
      { flowId: "9001", checkedAt: new Date().toISOString(), ...fact },
    ]);
  }

  it("does not hide working approved text demos when one referenced Flow is unavailable", async () => {
    configureFlowFact({ state: "unavailable" });
    await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
      readyTemplateIds: ["welcome"],
      unavailableTemplateIds: ["appointment-booking"],
    });
    await expect(getReadyPublicTemplateIds("en")).resolves.toEqual(["welcome"]);
    const saved = mockCacheSet.mock.calls[0][1];
    expect(saved.readiness.en).toEqual({
      readyTemplateIds: ["welcome"],
      unavailableTemplateIds: ["appointment-booking"],
    });
  });

  it.each(["PUBLISHED", "THROTTLED"])(
    "reports unresolved screen facts for an openable %s Flow as temporarily unavailable",
    async status => {
      configureFlowFact({
        state: "found",
        name: "Demo",
        status,
        screenIds: null,
      });
      await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
        readyTemplateIds: ["welcome"],
        unavailableTemplateIds: ["appointment-booking"],
      });
    }
  );

  it.each([
    { state: "missing" },
    { state: "found", name: "Demo", status: "PENDING", screenIds: null },
    { state: "found", name: "Demo", status: "DRAFT", screenIds: ["START"] },
    { state: "found", name: "Demo", status: "PUBLISHED", screenIds: ["OTHER"] },
  ])("leaves definitively unready Flows unready: %j", async fact => {
    configureFlowFact(fact);
    await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
      readyTemplateIds: ["welcome"],
      unavailableTemplateIds: [],
    });
  });

  it("does not report a pending template as a temporary Flow failure", async () => {
    configureFlowFact({ state: "unavailable" }, "PENDING");
    await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
      readyTemplateIds: ["welcome"],
      unavailableTemplateIds: [],
    });
  });

  it("preserves exact temporary IDs from the shared cache without provider reads", async () => {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      {
        ...binding,
        templateName: "airi_temporary_cache",
        catalogId: "appointment-booking",
      },
    ]);
    mockCacheGet.mockResolvedValue({
      readiness: {
        en: {
          readyTemplateIds: [],
          unavailableTemplateIds: ["appointment-booking"],
        },
        ru: { readyTemplateIds: [], unavailableTemplateIds: [] },
        kz: { readyTemplateIds: [], unavailableTemplateIds: [] },
      },
      expiresAt: Date.now() + 300_000,
    });
    await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
      readyTemplateIds: [],
      unavailableTemplateIds: ["appointment-booking"],
    });
    expect(mockCollectEdge).not.toHaveBeenCalled();
    expect(mockRate).not.toHaveBeenCalled();
  });

  it("rejects cached temporary IDs not bound to their reported locale", async () => {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      { ...binding, templateName: "airi_cache_locale_guard" },
    ]);
    mockCacheGet.mockResolvedValue({
      readiness: {
        en: { readyTemplateIds: ["welcome"], unavailableTemplateIds: [] },
        ru: { readyTemplateIds: [], unavailableTemplateIds: ["welcome"] },
        kz: { readyTemplateIds: [], unavailableTemplateIds: [] },
      },
      expiresAt: Date.now() + 300_000,
    });
    await expect(getPublicTemplateReadiness("en")).resolves.toEqual({
      readyTemplateIds: [],
      unavailableTemplateIds: [],
    });
    expect(mockCollectEdge).toHaveBeenCalledTimes(2);
  });
});

describe("expanded catalog capacity and locale availability", () => {
  function catalogBindings() {
    return publicTemplateLocaleSchema.options.flatMap(locale =>
      PUBLIC_TEMPLATES.filter(template =>
        isPublicTemplateAvailableInLocale(template, locale)
      ).map((template, index) => ({
        ...binding,
        catalogId: template.id,
        locale,
        templateId: String(
          5000 +
            index +
            publicTemplateLocaleSchema.options.indexOf(locale) * 1000
        ),
        templateName: `airi_expanded_${template.id.replaceAll("-", "_")}_${locale}`,
        language: locale === "kz" ? "kk" : locale,
      }))
    );
  }
  it("accepts the whole reviewed catalog and shares one bounded provider snapshot", async () => {
    const bindings = catalogBindings();
    expect(bindings).toHaveLength(186);
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify(bindings);
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : bindings.map(item => ({
            ...approved,
            id: item.templateId,
            name: item.templateName,
            language: item.language,
          }))
    );
    await expect(getReadyPublicTemplateIds("en")).resolves.toEqual(
      PUBLIC_TEMPLATES.filter(template =>
        isPublicTemplateAvailableInLocale(template, "en")
      ).map(template => template.id)
    );
    for (const locale of ["ru", "kz"] as const) {
      await expect(getReadyPublicTemplateIds(locale)).resolves.toEqual(
        PUBLIC_TEMPLATES.filter(template =>
          isPublicTemplateAvailableInLocale(template, locale)
        ).map(template => template.id)
      );
    }
    expect(mockCollectEdge).toHaveBeenCalledTimes(2);
    expect(mockCollectEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "3001/message_templates",
        maxItems: expect.any(Number),
      })
    );
    const templateRead = mockCollectEdge.mock.calls.find(([options]) =>
      options.path.endsWith("message_templates")
    )![0];
    expect(templateRead.maxItems).toBeGreaterThanOrEqual(600);
    expect(templateRead.maxPages * 100).toBeGreaterThanOrEqual(
      templateRead.maxItems
    );
  });
  it("reuses cached readiness for more than twelve English demos without provider calls", async () => {
    const bindings = catalogBindings()
      .filter(item => item.locale === "en")
      .map(item => ({ ...item, templateName: `${item.templateName}_cached` }));
    const ids = bindings.map(item => item.catalogId);
    expect(ids.length).toBeGreaterThan(12);
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify(bindings);
    mockCacheGet.mockResolvedValue({
      readiness: {
        en: { readyTemplateIds: ids, unavailableTemplateIds: [] },
        ru: { readyTemplateIds: [], unavailableTemplateIds: [] },
        kz: { readyTemplateIds: [], unavailableTemplateIds: [] },
      },
      expiresAt: Date.now() + 300_000,
    });
    await expect(getReadyPublicTemplateIds("en")).resolves.toEqual(ids);
    expect(mockSource).not.toHaveBeenCalled();
    expect(mockCollectEdge).not.toHaveBeenCalled();
    expect(mockRate).not.toHaveBeenCalled();
  });
  it("does not extend an aging shared snapshot by another local cache lifetime", async () => {
    jest.useFakeTimers();
    const now = Date.UTC(2026, 9, 5, 15);
    jest.setSystemTime(now);
    try {
      process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
        { ...binding, templateName: `${binding.templateName}_cache_expiry` },
      ]);
      mockCacheGet.mockResolvedValue({
        readiness: {
          en: { readyTemplateIds: ["welcome"], unavailableTemplateIds: [] },
          ru: { readyTemplateIds: [], unavailableTemplateIds: [] },
          kz: { readyTemplateIds: [], unavailableTemplateIds: [] },
        },
        expiresAt: now + 1000,
      });
      await expect(getReadyPublicTemplateIds("en")).resolves.toEqual([
        "welcome",
      ]);
      expect(mockCollectEdge).not.toHaveBeenCalled();
      jest.setSystemTime(now + 1001);
      mockCacheGet.mockResolvedValue(null);
      await getReadyPublicTemplateIds("en");
      expect(mockCollectEdge).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
  it("shares the provider refresh budget across configuration revisions", async () => {
    const keys: unknown[] = [];
    for (const suffix of ["budget_a", "budget_b"]) {
      process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
        { ...binding, templateName: `${binding.templateName}_${suffix}` },
      ]);
      await getReadyPublicTemplateIds("en");
      keys.push(mockRate.mock.calls.at(-1)![1]);
    }
    expect(keys[0]).toBe(keys[1]);
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "landing:template:readiness-refresh",
        requests: 1,
        window: "5 m",
      })
    );
  });
  it("checks every unique Flow once, including more than one canonical reader batch", async () => {
    const bindings = catalogBindings()
      .slice(0, 40)
      .map(item => ({ ...item, templateName: `${item.templateName}_flow` }));
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify(bindings);
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : bindings.map((item, index) => ({
            ...approved,
            id: item.templateId,
            name: item.templateName,
            language: item.language,
            components: [
              { type: "BODY", text: "Flow example" },
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "FLOW",
                    text: "Open",
                    flow_id: String(9000 + Math.min(index, 38)),
                    flow_action: "navigate",
                    navigate_screen: "START",
                  },
                ],
              },
            ],
          }))
    );
    mockFlowFacts.mockImplementation(
      async ({ flowIds }: { flowIds: string[] }) =>
        flowIds.map(flowId => ({
          flowId,
          state: "found",
          name: "Demo",
          status: "PUBLISHED",
          screenIds: ["START"],
          checkedAt: new Date().toISOString(),
        }))
    );
    await expect(getReadyPublicTemplateIds("en")).resolves.toHaveLength(40);
    expect(mockFlowFacts).toHaveBeenCalledTimes(2);
    const ids = mockFlowFacts.mock.calls.flatMap(([params]) => params.flowIds);
    expect(ids).toHaveLength(39);
    expect(new Set(ids).size).toBe(39);
    expect(
      mockFlowFacts.mock.calls.every(
        ([params]) => params.flowIds.length <= 25 && params.refresh === false
      )
    ).toBe(true);
  });
  it("rejects an unsupported configured locale before collecting a lead", async () => {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      {
        ...binding,
        catalogId: "appointment-booking",
        locale: "uz",
        language: "uz",
      },
    ]);
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers")
        ? [{ id: "2001" }]
        : [{ ...approved, language: "ru" }]
    );
    await expect(
      requestPublicTemplate(
        { ...body, templateId: "appointment-booking", locale: "ru" },
        "ip"
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(mockSource).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("native location template demos", () => {
  const location = {
    latitude: 43.238949,
    longitude: 76.889709,
    name: "Sample pickup",
    address: "Fictional public-landmark demo",
  };
  const template = {
    ...approved,
    components: [
      { type: "HEADER", format: "LOCATION" },
      ...approved.components,
    ],
  };
  function configure(components: unknown[]) {
    process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS = JSON.stringify([
      { ...binding, components },
    ]);
    mockCollectEdge.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("phone_numbers") ? [{ id: "2001" }] : [template]
    );
  }
  it("makes a fixed native pin ready and sends it unchanged", async () => {
    const components = [
      { type: "header", parameters: [{ type: "location", location }] },
    ];
    configure(components);
    await expect(getReadyPublicTemplateIds("en")).resolves.toEqual(["welcome"]);
    await expect(requestPublicTemplate(body, "ip")).resolves.toEqual({
      status: "accepted",
    });
    expect(mockSend).toHaveBeenCalledWith(
      "2001",
      "private-token",
      expect.anything(),
      "airi_welcome_demo",
      "en",
      components,
      expect.anything()
    );
  });
  it.each(
    [
      [],
      [
        {
          type: "header",
          parameters: [{ type: "text", text: "Not a map pin" }],
        },
      ],
      [
        {
          type: "header",
          parameters: [
            { type: "location", location: { ...location, latitude: 100 } },
          ],
        },
      ],
    ].map(components => ({ components }))
  )(
    "rejects a missing or malformed native pin before collecting the lead",
    async ({ components }) => {
      configure(components);
      await expect(requestPublicTemplate(body, "ip")).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});
