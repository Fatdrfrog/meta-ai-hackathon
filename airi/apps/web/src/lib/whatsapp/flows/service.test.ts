const mockInvalidateTemplateFlowFacts = jest.fn();

jest.mock("@/lib/whatsapp/flows/template-flow-facts-cache", () => ({
  invalidateTemplateFlowFacts: (flowId: string) =>
    mockInvalidateTemplateFlowFacts(flowId),
}));

import {
  MetaGraphRequestError,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import crypto from "crypto";
import {
  createMetaWhatsAppFlow,
  deleteMetaWhatsAppFlow,
  findMetaWhatsAppFlowByExactName,
  findMetaWhatsAppFlowByIdOnWaba,
  getWhatsAppBusinessEncryptionStatus,
  getMetaWhatsAppFlow,
  isMetaWhatsAppFlowOwnedByWaba,
  listMetaWhatsAppFlows,
  updateMetaWhatsAppFlow,
  uploadWhatsAppBusinessEncryptionPublicKey,
  WhatsAppBusinessEncryptionProviderError,
} from "./service";

const BUSINESS_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2/dy8E38WwT+hinXn02K
2kTJiTfM5ru5DncgxiSVoZ4XZhlSXFhBxrmWBRaT9lfyjlhVx9IH1aFgBOsFQXoq
a4SLOv1LjGUKoHxDRttJHlT+8pP4svb/xI7+jp03SObdu33qmhB+tPWrnlA3QAdq
iTmfP/Q8cAL9tIedi536de+CF7x9RVobuVXWZ4nk8rfHY55W5/AIEIj8xeSak++h
kRIABhQmYh2Cz9KIRVbJnrg5dkmaevc8jNtpKUHJPINj6BwA9YYaqXMONFEzwSDA
m1fsu9y3UNOkU0zmWu9q3rgxsrYSNq5MMpOmIjnssdL5Msqs/0hoKk4dtTvLz3Kt
3wIDAQAB
-----END PUBLIC KEY-----`;
const NON_2048_RSA_PUBLIC_KEY = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;

function createClient() {
  return {
    getJson: jest.fn(),
    postJson: jest.fn(),
    request: jest.fn(),
  };
}

describe("WhatsApp Flow Graph service", () => {
  beforeEach(() => {
    mockInvalidateTemplateFlowFacts.mockClear();
  });

  it("uploads a 2048-bit business public key as form-encoded Graph data", async () => {
    const client = createClient();
    const signal = new AbortController().signal;
    client.postJson.mockResolvedValue({ success: true });

    await expect(
      uploadWhatsAppBusinessEncryptionPublicKey({
        phoneNumberId: "phone-1",
        businessPublicKey: BUSINESS_PUBLIC_KEY,
        accessToken: "access-token",
        signal,
        client: client as unknown as WhatsAppGraphClient,
      })
    ).resolves.toBeUndefined();

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const [path, options] = client.postJson.mock.calls[0]!;
    expect(path).toBe("phone-1/whatsapp_business_encryption");
    expect(options.token).toBe("access-token");
    expect(options.signal).toBe(signal);
    expect(options.body).toBeInstanceOf(URLSearchParams);
    expect(Array.from((options.body as URLSearchParams).entries())).toEqual([
      ["business_public_key", BUSINESS_PUBLIC_KEY],
    ]);
  });

  it.each([
    ["a missing acknowledgement", {}],
    ["a false acknowledgement", { success: false }],
    ["an ambiguous acknowledgement", { success: true, id: "unexpected" }],
    [
      "an HTTP-200 error envelope",
      {
        success: true,
        error: {
          message: `Rejected ${BUSINESS_PUBLIC_KEY} access-token`,
          code: 100,
        },
      },
    ],
  ])("rejects upload response with %s", async (_label, response) => {
    const client = createClient();
    client.postJson.mockResolvedValue(response);

    let failure: Error | undefined;
    try {
      await uploadWhatsAppBusinessEncryptionPublicKey({
        phoneNumberId: "phone-1",
        businessPublicKey: BUSINESS_PUBLIC_KEY,
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(WhatsAppBusinessEncryptionProviderError);
    expect(failure).toMatchObject({
      code: "WHATSAPP_BUSINESS_ENCRYPTION_PROVIDER_ERROR",
      message: "WhatsApp business encryption provider request failed",
    });
    expect(String(failure)).not.toContain("access-token");
    expect(String(failure)).not.toContain("BEGIN PUBLIC KEY");
  });

  it("redacts a rejected Graph upload before exposing the typed provider error", async () => {
    const client = createClient();
    client.postJson.mockRejectedValue(
      new Error(`transport exposed access-token ${BUSINESS_PUBLIC_KEY}`)
    );

    await expect(
      uploadWhatsAppBusinessEncryptionPublicKey({
        phoneNumberId: "phone-1",
        businessPublicKey: BUSINESS_PUBLIC_KEY,
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "WhatsAppBusinessEncryptionProviderError",
        code: "WHATSAPP_BUSINESS_ENCRYPTION_PROVIDER_ERROR",
        message: "WhatsApp business encryption provider request failed",
      })
    );
  });

  it.each([
    ["blank", " "],
    [
      "malformed",
      "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----",
    ],
    ["non-2048 RSA", NON_2048_RSA_PUBLIC_KEY],
  ])("rejects a %s upload key before Graph I/O", async (_label, key) => {
    const client = createClient();

    await expect(
      uploadWhatsAppBusinessEncryptionPublicKey({
        phoneNumberId: "phone-1",
        businessPublicKey: key,
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).rejects.toBeInstanceOf(WhatsAppBusinessEncryptionProviderError);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it("normalizes the current flat encryption status shape", async () => {
    const client = createClient();
    const signal = new AbortController().signal;
    client.getJson.mockResolvedValue({
      business_public_key: BUSINESS_PUBLIC_KEY,
      business_public_key_signature_status: "VALID",
    });

    await expect(
      getWhatsAppBusinessEncryptionStatus({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        signal,
        client: client as unknown as WhatsAppGraphClient,
      })
    ).resolves.toEqual({
      configured: true,
      businessPublicKey: BUSINESS_PUBLIC_KEY,
      signatureStatus: "VALID",
    });
    expect(client.getJson).toHaveBeenCalledWith(
      "phone-1/whatsapp_business_encryption",
      { token: "access-token", signal }
    );
  });

  it("normalizes the legacy one-item envelope and MISMATCH state", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [
        {
          business_public_key: BUSINESS_PUBLIC_KEY,
          business_public_key_signature_status: "MISMATCH",
        },
      ],
    });

    await expect(
      getWhatsAppBusinessEncryptionStatus({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).resolves.toEqual({
      configured: true,
      businessPublicKey: BUSINESS_PUBLIC_KEY,
      signatureStatus: "INVALID",
    });
  });

  it("treats an empty legacy envelope as unconfigured", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [] });

    await expect(
      getWhatsAppBusinessEncryptionStatus({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).resolves.toEqual({ configured: false });
  });

  it.each([
    ["an empty object", {}],
    [
      "a dual flat and envelope shape",
      {
        business_public_key: BUSINESS_PUBLIC_KEY,
        business_public_key_signature_status: "VALID",
        data: [],
      },
    ],
    [
      "more than one legacy item",
      {
        data: [
          {
            business_public_key: BUSINESS_PUBLIC_KEY,
            business_public_key_signature_status: "VALID",
          },
          {
            business_public_key: BUSINESS_PUBLIC_KEY,
            business_public_key_signature_status: "MISMATCH",
          },
        ],
      },
    ],
    ["a non-array legacy data field", { data: {} }],
    [
      "an extra flat field",
      {
        business_public_key: BUSINESS_PUBLIC_KEY,
        business_public_key_signature_status: "VALID",
        id: "phone-1",
      },
    ],
    [
      "an extra envelope field",
      {
        data: [
          {
            business_public_key: BUSINESS_PUBLIC_KEY,
            business_public_key_signature_status: "VALID",
          },
        ],
        paging: {},
      },
    ],
    [
      "an extra legacy item field",
      {
        data: [
          {
            business_public_key: BUSINESS_PUBLIC_KEY,
            business_public_key_signature_status: "VALID",
            id: "phone-1",
          },
        ],
      },
    ],
    ["a missing public key", { business_public_key_signature_status: "VALID" }],
    ["a missing signature state", { business_public_key: BUSINESS_PUBLIC_KEY }],
    [
      "a blank public key",
      {
        business_public_key: " ",
        business_public_key_signature_status: "VALID",
      },
    ],
    [
      "a malformed public key",
      {
        business_public_key:
          "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----",
        business_public_key_signature_status: "VALID",
      },
    ],
    [
      "a non-2048 RSA public key",
      {
        business_public_key: NON_2048_RSA_PUBLIC_KEY,
        business_public_key_signature_status: "VALID",
      },
    ],
    [
      "the undocumented raw INVALID state",
      {
        business_public_key: BUSINESS_PUBLIC_KEY,
        business_public_key_signature_status: "INVALID",
      },
    ],
    [
      "an unknown signature state",
      {
        business_public_key: BUSINESS_PUBLIC_KEY,
        business_public_key_signature_status: "UNKNOWN",
      },
    ],
    [
      "an HTTP-200 provider error envelope",
      {
        error: {
          message: `Rejected access-token ${BUSINESS_PUBLIC_KEY}`,
          code: 100,
        },
      },
    ],
  ])("rejects encryption status with %s", async (_label, response) => {
    const client = createClient();
    client.getJson.mockResolvedValue(response);

    let failure: Error | undefined;
    try {
      await getWhatsAppBusinessEncryptionStatus({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeInstanceOf(WhatsAppBusinessEncryptionProviderError);
    expect(failure).toMatchObject({
      code: "WHATSAPP_BUSINESS_ENCRYPTION_PROVIDER_ERROR",
      message: "WhatsApp business encryption provider request failed",
    });
    expect(String(failure)).not.toContain("access-token");
    expect(String(failure)).not.toContain("BEGIN PUBLIC KEY");
  });

  it("redacts a rejected Graph status read before exposing the typed provider error", async () => {
    const client = createClient();
    client.getJson.mockRejectedValue(
      new Error(`transport exposed access-token ${BUSINESS_PUBLIC_KEY}`)
    );

    await expect(
      getWhatsAppBusinessEncryptionStatus({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "WhatsAppBusinessEncryptionProviderError",
        code: "WHATSAPP_BUSINESS_ENCRYPTION_PROVIDER_ERROR",
        message: "WhatsApp business encryption provider request failed",
      })
    );
  });

  it("lists provider Flows with the official field set", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [{ id: "flow-1", name: "Lead Flow" }],
      paging: {
        next: "https://graph.facebook.com/v25.0/waba-1/flows?after=next&access_token=query-secret",
      },
    });

    const result = await listMetaWhatsAppFlows({
      accessToken: "access-token",
      wabaId: "waba-1",
      limit: 5,
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      flows: [{ id: "flow-1", name: "Lead Flow" }],
      paging: {
        next: "https://graph.facebook.com/v25.0/waba-1/flows?after=next",
      },
    });
    expect(client.getJson).toHaveBeenCalledWith("waba-1/flows", {
      token: "access-token",
      query: {
        fields: expect.stringContaining(
          "id,name,categories,preview,status,validation_errors"
        ),
        limit: 5,
      },
    });
  });

  it("rejects a Flow list with a hostile provider next URL", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [{ id: "flow-1", name: "Lead Flow" }],
      paging: {
        next: "https://attacker.example/v25.0/waba-1/flows?after=host-secret",
      },
    });

    const result = await listMetaWhatsAppFlows({
      accessToken: "access-token",
      wabaId: "waba-1",
      limit: 5,
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Invalid Meta Graph paging response");
    expect(JSON.stringify(result)).not.toContain("host-secret");
  });

  it("finds an exact provider Flow name across every bounded Graph page", async () => {
    const client = createClient();
    client.getJson
      .mockResolvedValueOnce({
        data: [{ id: "flow-other", name: "Similar [marker-1-extra]" }],
        paging: {
          next: "https://graph.facebook.com/v25.0/waba-1/flows?after=page-2&access_token=query-secret",
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "flow-match",
            name: "Appointment [marker-1]",
            status: "DRAFT",
          },
        ],
      });

    const result = await findMetaWhatsAppFlowByExactName({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Appointment [marker-1]",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: {
        id: "flow-match",
        name: "Appointment [marker-1]",
        status: "DRAFT",
      },
    });
    expect(client.getJson).toHaveBeenNthCalledWith(1, "waba-1/flows", {
      token: "access-token",
      query: {
        fields: expect.stringContaining("id,name"),
        limit: 100,
      },
    });
    expect(client.getJson).toHaveBeenNthCalledWith(
      2,
      "https://graph.facebook.com/v25.0/waba-1/flows?after=page-2",
      { token: "access-token" }
    );
  });

  it("returns a successful empty exact-name lookup only after exhausting pages", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [{ id: "flow-other", name: "Appointment [marker-other]" }],
    });

    await expect(
      findMetaWhatsAppFlowByExactName({
        accessToken: "access-token",
        wabaId: "waba-1",
        name: "Appointment [marker-1]",
        client: client as unknown as WhatsAppGraphClient,
      })
    ).resolves.toEqual({ ok: true, status: 200, flow: null });
  });

  it("hard-stops exact-name reconciliation when the provider has duplicate matches", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [
        { id: "flow-1", name: "Appointment [marker-1]" },
        { id: "flow-2", name: "Appointment [marker-1]" },
      ],
    });

    const result = await findMetaWhatsAppFlowByExactName({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Appointment [marker-1]",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Multiple provider Flows use the exact reconciliation name",
      validation_errors: [],
      flow: null,
    });
  });

  it.each([
    [
      "page bound",
      Array.from({ length: 100 }, (_, index) => ({
        data: [{ id: `flow-${index + 1}`, name: `Other ${index + 1}` }],
        paging: {
          next: `https://graph.facebook.com/v25.0/waba-1/flows?after=page-${index + 2}`,
        },
      })),
    ],
    [
      "item bound",
      [
        {
          data: Array.from({ length: 10_001 }, (_, index) => ({
            id: `flow-${index + 1}`,
            name: `Other ${index + 1}`,
          })),
        },
      ],
    ],
    [
      "paging cycle",
      [
        {
          data: [{ id: "flow-1", name: "Other 1" }],
          paging: {
            next: "https://graph.facebook.com/v25.0/waba-1/flows?after=cycle",
          },
        },
        {
          data: [{ id: "flow-2", name: "Other 2" }],
          paging: {
            next: "https://graph.facebook.com/v25.0/waba-1/flows?after=cycle",
          },
        },
      ],
    ],
  ] as const)(
    "fails closed when exact-name reconciliation reaches its %s",
    async (_label, pages) => {
      const client = createClient();
      for (const page of pages) client.getJson.mockResolvedValueOnce(page);

      const result = await findMetaWhatsAppFlowByExactName({
        accessToken: "access-token",
        wabaId: "waba-1",
        name: "Appointment [marker-1]",
        client: client as unknown as WhatsAppGraphClient,
      });

      expect(result).toEqual({
        ok: false,
        status: 502,
        error: "Provider Flow reconciliation exceeded safe pagination bounds",
        validation_errors: [],
        flow: null,
      });
    }
  );

  it.each([
    ["publish", "DRAFT", "PUBLISHED"],
    ["deprecate", "PUBLISHED", "DEPRECATED"],
  ] as const)(
    "fails %s when provider readback remains %s instead of %s",
    async (operation, readbackStatus, expectedStatus) => {
      const client = createClient();
      client.postJson.mockResolvedValue({ success: true });
      client.getJson.mockResolvedValue({
        id: "flow-1",
        status: readbackStatus,
        whatsapp_business_account: { id: "waba-1" },
      });

      const result = await updateMetaWhatsAppFlow({
        accessToken: "access-token",
        flowId: "flow-1",
        operation,
        client: client as unknown as WhatsAppGraphClient,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 409,
        error: `Meta did not confirm the Flow as ${expectedStatus}`,
        flow: { id: "flow-1", status: readbackStatus },
      });
    }
  );

  it("reads details and the latest Flow JSON asset through the injected client", async () => {
    const client = createClient();
    client.getJson.mockImplementation((path: string) => {
      if (path === "flow-1") {
        return Promise.resolve({
          id: "flow-1",
          name: "Lead Flow",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "waba-1" },
        });
      }
      if (path === "flow-1/assets") {
        return Promise.resolve({
          data: [
            {
              id: "asset-old",
              name: "old.json",
              asset_type: "FLOW_JSON",
              download_url: "https://lookaside.facebook.com/old",
              updated_time: "2026-07-29T00:00:00.000Z",
            },
            {
              id: "asset-image",
              name: "preview.png",
              asset_type: "IMAGE",
              download_url: "https://lookaside.facebook.com/image",
              updated_time: "2026-07-30T00:00:00.000Z",
            },
            {
              id: "asset-new",
              name: "flow.json",
              asset_type: "FLOW_JSON",
              download_url: "https://lookaside.facebook.com/new",
              updated_time: "2026-07-30T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    client.request.mockResolvedValue(
      new Response('{"version":"7.3","screens":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await getMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      phoneNumberId: "phone-1",
      includeJson: true,
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: expect.objectContaining({
        id: "flow-1",
        whatsapp_business_account: { id: "waba-1" },
      }),
      flowJson: { version: "7.3", screens: [] },
      flowJsonError: null,
    });
    expect(client.getJson).toHaveBeenNthCalledWith(1, "flow-1", {
      token: "access-token",
      query: {
        fields: expect.stringContaining("health_status.phone_number(phone-1)"),
      },
    });
    expect(client.getJson).toHaveBeenNthCalledWith(2, "flow-1/assets", {
      token: "access-token",
      query: {
        fields: "asset_type,download_url,created_at,updated_time",
      },
    });
    expect(client.request).toHaveBeenCalledWith(
      "https://lookaside.facebook.com/new",
      {
        method: "GET",
        token: "access-token",
      }
    );
    expect(isMetaWhatsAppFlowOwnedByWaba(result.flow, "waba-1")).toBe(true);
    expect(isMetaWhatsAppFlowOwnedByWaba(result.flow, "waba-other")).toBe(
      false
    );
    expect(
      isMetaWhatsAppFlowOwnedByWaba(
        { whatsapp_business_account: { id: 940525742304249 } },
        "940525742304249"
      )
    ).toBe(true);
  });

  it("rejects a foreign Flow before enumerating assets for includeJson", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      id: "flow-foreign",
      name: "Foreign Flow",
      status: "PUBLISHED",
      whatsapp_business_account: { id: "waba-other" },
    });

    const result = await getMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-foreign",
      phoneNumberId: "phone-1",
      includeJson: true,
      expectedWabaId: "waba-1",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Flow not found for this WhatsApp Business Account",
      validation_errors: [],
      flow: null,
    });
    expect(client.getJson).toHaveBeenCalledTimes(1);
    expect(client.getJson).toHaveBeenCalledWith(
      "flow-foreign",
      expect.any(Object)
    );
    expect(client.request).not.toHaveBeenCalled();
  });

  it("creates with an internal endpoint_uri and returns provider-confirmed readback", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ id: "flow-1" });
    client.getJson.mockResolvedValue({
      id: "flow-1",
      name: "Lead Flow",
      status: "DRAFT",
      endpoint_uri: "https://internal.example/flow",
      whatsapp_business_account: { id: "waba-1" },
    });

    const result = await createMetaWhatsAppFlow({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Lead Flow",
      categories: ["LEAD_GENERATION"],
      endpointUri: "https://internal.example/flow",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(client.postJson).toHaveBeenCalledWith("waba-1/flows", {
      token: "access-token",
      body: {
        name: "Lead Flow",
        categories: ["LEAD_GENERATION"],
        endpoint_uri: "https://internal.example/flow",
      },
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: expect.objectContaining({
        id: "flow-1",
        status: "DRAFT",
        endpoint_uri: "https://internal.example/flow",
      }),
    });
    expect(client.getJson).toHaveBeenCalledWith("flow-1", {
      token: "access-token",
      query: {
        fields: expect.stringContaining("whatsapp_business_account"),
      },
    });
  });

  it("preserves an acknowledged create id when provider readback fails", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ id: "flow-created" });
    client.getJson.mockRejectedValue(new Error("readback unavailable"));

    const result = await createMetaWhatsAppFlow({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Lead Flow",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toMatchObject({
      ok: false,
      providerFlowId: "flow-created",
      flow: null,
    });
  });

  it("fails draft creation when readback is not DRAFT", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ id: "flow-created" });
    client.getJson.mockResolvedValue({
      id: "flow-created",
      status: "PUBLISHED",
      whatsapp_business_account: { id: "waba-1" },
    });

    const result = await createMetaWhatsAppFlow({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Lead Flow",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      providerFlowId: "flow-created",
      error: "Meta did not confirm the Flow as DRAFT",
      flow: { id: "flow-created", status: "PUBLISHED" },
    });
  });

  it("preserves an acknowledged create id when readback returns a Graph error", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ id: "flow-created" });
    client.getJson.mockResolvedValue({
      error: { message: "Flow readback is temporarily unavailable" },
    });

    const result = await createMetaWhatsAppFlow({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Lead Flow",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toMatchObject({
      ok: false,
      providerFlowId: "flow-created",
      error: expect.stringContaining("temporarily unavailable"),
    });
  });

  it("updates metadata with an internal application_id and reads the Flow back", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ success: true });
    client.getJson.mockResolvedValue({
      id: "flow-1",
      status: "DRAFT",
      application: { id: "app-1" },
      whatsapp_business_account: { id: "waba-1" },
    });

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update",
      applicationId: "app-1",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(client.postJson).toHaveBeenCalledWith("flow-1", {
      token: "access-token",
      body: { application_id: "app-1" },
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: expect.objectContaining({
        id: "flow-1",
        application: { id: "app-1" },
      }),
    });
  });

  it("does not report an update id as a newly acknowledged provider Flow", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ id: "flow-1", success: true });
    client.getJson.mockRejectedValue(new Error("readback unavailable"));

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update",
      applicationId: "app-1",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toMatchObject({
      ok: false,
      flow: null,
    });
    expect(result).not.toHaveProperty("providerFlowId");
  });

  it("uploads Flow JSON as multipart data and returns provider-confirmed readback", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ success: true });
    client.getJson.mockResolvedValue({
      id: "flow-1",
      status: "DRAFT",
      validation_errors: [],
      whatsapp_business_account: { id: "waba-1" },
    });

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[]}',
      client: client as unknown as WhatsAppGraphClient,
    });

    const call = client.postJson.mock.calls[0];
    expect(call[0]).toBe("flow-1/assets");
    expect(call[1].token).toBe("access-token");
    expect(call[1].body).toBeInstanceOf(FormData);
    const formData = call[1].body as FormData;
    expect(formData.get("name")).toBe("flow.json");
    expect(formData.get("asset_type")).toBe("FLOW_JSON");
    expect(await (formData.get("file") as Blob).text()).toBe(
      '{"version":"7.3","screens":[]}'
    );
    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: expect.objectContaining({ id: "flow-1", status: "DRAFT" }),
    });
  });

  it("preserves provider validation pointers from successful Graph responses", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({
      id: "flow-1",
      success: true,
      validation_errors: [
        {
          error: "PATTERN_MISMATCH",
          error_type: "FLOW_JSON_ERROR",
          message: "Screen id is invalid",
          path: "screens[1].id",
        },
      ],
    });

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update_json",
      flowJson: "{}",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Flow JSON validation failed",
      validation_errors: [
        {
          error: "PATTERN_MISMATCH",
          error_type: "FLOW_JSON_ERROR",
          message: "Screen id is invalid",
          path: "screens[1].id",
        },
      ],
      flow: expect.objectContaining({ id: "flow-1", success: true }),
    });
    expect(client.getJson).not.toHaveBeenCalled();
  });

  it("rejects validation errors discovered only in the JSON upload readback", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ success: true });
    client.getJson.mockResolvedValue({
      id: "flow-1",
      status: "DRAFT",
      validation_errors: [
        {
          message: "Missing Footer",
          pointers: [{ path: "screens[0].layout.children" }],
        },
      ],
      whatsapp_business_account: { id: "waba-1" },
    });
    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      client: client as unknown as WhatsAppGraphClient,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      validation_errors: [
        {
          message: "Missing Footer",
          pointers: [{ path: "screens[0].layout.children" }],
        },
      ],
    });
  });

  it("rejects a JSON upload when readback no longer confirms a draft", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue({ success: true });
    client.getJson.mockResolvedValue({
      id: "flow-1",
      status: "PUBLISHED",
      validation_errors: [],
    });
    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      client: client as unknown as WhatsAppGraphClient,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining("DRAFT"),
    });
  });

  it.each([
    ["publish", "flow-1/publish", "PUBLISHED"],
    ["deprecate", "flow-1/deprecate", "DEPRECATED"],
  ] as const)(
    "%s uses its provider operation edge and reads the resulting status",
    async (operation, path, status) => {
      const client = createClient();
      client.postJson.mockResolvedValue({ success: true });
      client.getJson.mockResolvedValue({
        id: "flow-1",
        status,
        whatsapp_business_account: { id: "waba-1" },
      });

      const result = await updateMetaWhatsAppFlow({
        accessToken: "access-token",
        flowId: "flow-1",
        operation,
        client: client as unknown as WhatsAppGraphClient,
      });

      expect(client.postJson).toHaveBeenCalledWith(path, {
        token: "access-token",
      });
      expect(result).toEqual({
        ok: true,
        status: 200,
        flow: expect.objectContaining({ id: "flow-1", status }),
      });
      expect(mockInvalidateTemplateFlowFacts).toHaveBeenCalledWith("flow-1");
    }
  );

  it("clears cached template Flow checks even when a publish fails", async () => {
    const client = createClient();
    client.postJson.mockRejectedValue(new Error("network down"));

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "publish",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result.ok).toBe(false);
    expect(mockInvalidateTemplateFlowFacts).toHaveBeenCalledWith("flow-1");
  });

  it("forwards an abort signal to every Graph request of a details read", async () => {
    const client = createClient();
    client.getJson.mockImplementation((path: string) =>
      Promise.resolve(
        path === "flow-1/assets"
          ? {
              data: [
                {
                  asset_type: "FLOW_JSON",
                  download_url: "https://lookaside.facebook.com/new",
                },
              ],
            }
          : {
              id: "flow-1",
              status: "PUBLISHED",
              whatsapp_business_account: { id: "waba-1" },
            }
      )
    );
    client.request.mockResolvedValue(
      new Response('{"version":"6.3","screens":[{"id":"START"}]}')
    );
    const signal = new AbortController().signal;

    await getMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      includeJson: true,
      expectedWabaId: "waba-1",
      signal,
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(client.getJson).toHaveBeenNthCalledWith(
      1,
      "flow-1",
      expect.objectContaining({ signal })
    );
    expect(client.getJson).toHaveBeenNthCalledWith(
      2,
      "flow-1/assets",
      expect.objectContaining({ signal })
    );
    expect(client.request).toHaveBeenCalledWith(
      "https://lookaside.facebook.com/new",
      expect.objectContaining({ signal })
    );
  });

  it("deletes a Flow through the shared request transport", async () => {
    const client = createClient();
    client.request.mockResolvedValue(Response.json({ success: true }));

    const result = await deleteMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(client.request).toHaveBeenCalledWith("flow-1", {
      method: "DELETE",
      token: "access-token",
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: { success: true },
    });
    expect(mockInvalidateTemplateFlowFacts).toHaveBeenCalledWith("flow-1");
  });

  it("maps a DELETE 200 provider error envelope to a typed 502 failure", async () => {
    const client = createClient();
    client.request.mockResolvedValue(
      Response.json({
        error: {
          message: "Only draft Flows can be deleted",
          type: "OAuthException",
          code: 100,
        },
      })
    );

    const result = await deleteMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Only draft Flows can be deleted");
  });

  it("normalizes typed Graph failures without losing provider diagnostics", async () => {
    const client = createClient();
    client.postJson.mockRejectedValue(
      new MetaGraphRequestError({
        message: "OAuthException (139000): Blocked By Integrity",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/flow-1/publish",
        details: {
          error: {
            message: "Blocked By Integrity",
            type: "OAuthException",
            code: 139000,
            error_user_msg: "Integrity requirements not met",
            fbtrace_id: "trace-1",
          },
        },
        metaError: {
          message: "Blocked By Integrity",
          type: "OAuthException",
          code: 139000,
          error_user_msg: "Integrity requirements not met",
          fbtrace_id: "trace-1",
        },
      })
    );

    const result = await updateMetaWhatsAppFlow({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "publish",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("139000");
    expect(result.error).toContain("Integrity requirements not met");
    expect(result.error).toContain("trace-1");
  });

  it("treats a 200 transport response containing a provider error as a typed failure", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        error: {
          message:
            "Application is not connected: https://graph.facebook.com/v25.0/flow-1?access_token=message-secret",
          type: "OAuthException",
          code: 100,
          error_user_msg:
            "Connect first: https://graph.facebook.com/v25.0/flow-1?after=user-secret",
        },
      })
    );

    try {
      const result = await updateMetaWhatsAppFlow({
        accessToken: "access-token",
        flowId: "flow-1",
        operation: "publish",
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toContain("Application is not connected");
      expect(result.error).toContain("Connect first");
      expect(JSON.stringify(result)).not.toContain("message-secret");
      expect(JSON.stringify(result)).not.toContain("user-secret");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("finds a Flow by Graph id on a WABA, including numeric ids", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [
        { id: 1502809548249689, name: "try", status: "PUBLISHED" },
        { id: "flow-other", name: "other" },
      ],
    });

    const result = await findMetaWhatsAppFlowByIdOnWaba({
      accessToken: "access-token",
      wabaId: "940525742304249",
      flowId: "1502809548249689",
      client: client as unknown as WhatsAppGraphClient,
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      flow: {
        id: 1502809548249689,
        name: "try",
        status: "PUBLISHED",
      },
    });
  });
});
