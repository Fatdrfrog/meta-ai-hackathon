const mockConnectDB = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockCustomerCreate = jest.fn();
const mockCustomerFind = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockCustomerFindOne(...args),
    create: (...args: unknown[]) => mockCustomerCreate(...args),
    find: (...args: unknown[]) => mockCustomerFind(...args),
  },
}));

import {
  getRegisteredBusinessPhoneAudienceSummary,
  normalizeRegistrationPhone,
  resolveRegisteredBusinessPhoneAudience,
  upsertRegisteredBusinessPhoneContact,
} from "./registration-contact";

describe("registration contact phone helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  it("normalizes optional signup phone values and rejects non-phone identifiers", () => {
    expect(normalizeRegistrationPhone("+7 (701) 234-56-78")).toBe(
      "77012345678"
    );
    expect(normalizeRegistrationPhone("wa_77012345678")).toBe("77012345678");
    expect(normalizeRegistrationPhone("wa_bsuid_123")).toBeNull();
    expect(normalizeRegistrationPhone("not a phone")).toBeNull();
    expect(normalizeRegistrationPhone("")).toBeNull();
  });

  it("creates a hidden Airi workspace customer contact for a signup phone", async () => {
    mockCustomerFindOne.mockResolvedValue(null);
    mockCustomerCreate.mockResolvedValue({ _id: "customer-1" });

    const result = await upsertRegisteredBusinessPhoneContact({
      senderWorkspaceId: "airi-workspace",
      registeredCompanyId: "company-1",
      registeredWorkspaceId: "workspace-1",
      registeredWorkspaceName: "Acme Support",
      userId: "user-1",
      userEmail: "Founder@Example.com",
      userName: "Founder",
      phone: "+7 (701) 234-56-78",
    });

    expect(result).toEqual({
      status: "created",
      customerId: "customer-1",
      phone: "77012345678",
    });
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockCustomerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "airi-workspace",
        status: "active",
        displayName: "Founder",
        primaryConversationId: null,
        conversationIds: [],
        seedKeys: ["airi_signup:user-1:workspace-1"],
        currentFunnelStage: "registered_business",
        profileSummary: expect.objectContaining({
          channels: ["whatsapp", "email"],
          tags: expect.arrayContaining([
            "registered_business",
            "registration_follow_up",
          ]),
          contactPoints: expect.objectContaining({
            phones: ["77012345678"],
            emails: ["founder@example.com"],
          }),
          conversationCount: 0,
        }),
      })
    );
    const created = mockCustomerCreate.mock.calls[0][0];
    expect(created.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "phone",
          channel: "whatsapp",
          value: "77012345678",
          normalizedValue: "77012345678",
          label: "Registration phone",
          linkMethod: "system",
          linkConfidence: 1,
        }),
        expect.objectContaining({
          type: "email",
          channel: "email",
          value: "founder@example.com",
          normalizedValue: "founder@example.com",
          label: "Registered account email",
        }),
      ])
    );
  });

  it("resolves registered business phone contacts as WhatsApp bulk recipients", async () => {
    mockCustomerFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          displayName: "Founder",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              normalizedValue: "77012345678",
            },
            {
              type: "email",
              channel: "email",
              normalizedValue: "founder@example.com",
            },
          ],
          profileSummary: {
            contactPoints: {
              phones: ["77012345678"],
              emails: ["founder@example.com"],
            },
          },
          seedKeys: ["airi_signup:user-1:workspace-1"],
        },
      ]),
    });

    const audience = await resolveRegisteredBusinessPhoneAudience({
      workspaceId: "airi-workspace",
      selectedPhones: ["+7 (701) 234-56-78"],
    });

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(audience).toMatchObject({
      total: 1,
      recipients: [
        {
          phone: "77012345678",
          name: "Founder",
          variables: expect.objectContaining({
            recipientName: "Founder",
            name: "Founder",
            phone: "77012345678",
            email: "founder@example.com",
          }),
        },
      ],
    });
  });

  it("reads cap plus one and reports incomplete registered-phone audiences in stable order", async () => {
    const select = jest.fn().mockReturnThis();
    const sort = jest.fn().mockReturnThis();
    const limit = jest.fn().mockReturnThis();
    const customers = ["77000000003", "77000000002", "77000000001"].map(
      (phone, index) => ({
        _id: `customer-${3 - index}`,
        displayName: `Customer ${3 - index}`,
        identities: [
          {
            type: "phone",
            channel: "whatsapp",
            normalizedValue: phone,
          },
        ],
      })
    );
    mockCustomerFind.mockReturnValue({
      select,
      sort,
      limit,
      lean: jest.fn().mockResolvedValue(customers),
    });

    const audience = await resolveRegisteredBusinessPhoneAudience({
      workspaceId: "airi-workspace",
      limit: 2,
    });

    expect(sort).toHaveBeenCalledWith({
      lastInteractionAt: -1,
      createdAt: -1,
      _id: -1,
    });
    expect(limit).toHaveBeenCalledWith(3);
    expect(audience).toMatchObject({
      total: 2,
      complete: false,
      truncated: true,
      recipients: [{ phone: "77000000003" }, { phone: "77000000002" }],
    });
  });

  it("counts only sendable unique phones in the registered audience summary", async () => {
    const select = jest.fn().mockReturnThis();
    const sort = jest.fn().mockReturnThis();
    const limit = jest.fn().mockReturnThis();
    mockCustomerFind.mockReturnValue({
      select,
      sort,
      limit,
      lean: jest.fn().mockResolvedValue([
        {
          _id: "customer-1",
          displayName: "Valid",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              normalizedValue: "77012345678",
            },
          ],
        },
        {
          _id: "customer-2",
          displayName: "Missing phone",
          identities: [{ type: "phone", channel: "whatsapp", value: "" }],
        },
        {
          _id: "customer-3",
          displayName: "Duplicate",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              normalizedValue: "77012345678",
            },
          ],
        },
      ]),
    });

    await expect(
      getRegisteredBusinessPhoneAudienceSummary({
        workspaceId: "airi-workspace",
        previewLimit: 50,
      })
    ).resolves.toMatchObject({
      enabled: true,
      total: 1,
      preview: [{ phone: "77012345678", name: "Valid" }],
    });
  });
});
