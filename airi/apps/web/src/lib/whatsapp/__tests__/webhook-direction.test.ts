import {
  normalizeWhatsAppWebhookContact,
  resolveWhatsAppDisplayPhoneNumber,
  resolveWhatsAppMessageContext,
  resolveWhatsAppOutboundRecipientContact,
} from "@icecore/shared/lib/whatsapp/webhook-direction";

describe("whatsapp webhook direction helpers", () => {
  describe("normalizeWhatsAppWebhookContact", () => {
    it("normalizes a contact with only user_id (BSUID, no phone)", () => {
      const result = normalizeWhatsAppWebhookContact({
        user_id: "US.1349.xyz",
        profile: { name: "BSUID User" },
      });
      expect(result).toEqual({
        userId: "US.1349.xyz",
        profile: { name: "BSUID User" },
        primaryIdType: "user_id",
      });
    });

    it("normalizes a contact with wa_id plus user_id keeping phone primary", () => {
      const result = normalizeWhatsAppWebhookContact({
        wa_id: "77012345678",
        user_id: "US.1349.xyz",
        parent_user_id: "US.parent.1",
        profile: { name: "Dual ID", username: "dual_user" },
      });
      expect(result).toMatchObject({
        waId: "77012345678",
        userId: "US.1349.xyz",
        parentUserId: "US.parent.1",
        primaryIdType: "wa_id",
        profile: { name: "Dual ID", username: "dual_user" },
      });
    });

    it("falls back to message.from when contact data is empty", () => {
      const result = normalizeWhatsAppWebhookContact(null, "US.1349.abc");
      expect(result).toMatchObject({
        userId: "US.1349.abc",
        primaryIdType: "message_from",
      });
    });

    it("falls back to message.from as phone when it looks like digits", () => {
      const result = normalizeWhatsAppWebhookContact(null, "77012345678");
      expect(result).toMatchObject({
        waId: "77012345678",
        primaryIdType: "message_from",
      });
    });
  });

  describe("resolveWhatsAppDisplayPhoneNumber", () => {
    it("prefers webhook metadata over stored source credentials", () => {
      expect(
        resolveWhatsAppDisplayPhoneNumber({
          metadataDisplayPhoneNumber: "15550000001",
          sourceCredentials: {
            display_phone_number: "15550000002",
            displayPhoneNumber: "15550000003",
          },
        })
      ).toBe("15550000001");
    });

    it("falls back to both stored source credential spellings", () => {
      expect(
        resolveWhatsAppDisplayPhoneNumber({
          metadataDisplayPhoneNumber: "",
          sourceCredentials: {
            display_phone_number: "15550000002",
          },
        })
      ).toBe("15550000002");

      expect(
        resolveWhatsAppDisplayPhoneNumber({
          metadataDisplayPhoneNumber: " ",
          sourceCredentials: {
            displayPhoneNumber: "15550000003",
          },
        })
      ).toBe("15550000003");
    });
  });

  describe("resolveWhatsAppMessageContext", () => {
    it("detects inbound direction for non-business sender", () => {
      const result = resolveWhatsAppMessageContext({
        messageData: { from: "77012345678" },
        contacts: [
          {
            wa_id: "77012345678",
            profile: { name: "Customer" },
          },
        ],
        displayPhoneNumber: "15551234567",
      });
      expect(result.direction).toBe("inbound");
      expect(result.contactData?.waId).toBe("77012345678");
    });

    it("detects outbound direction when from matches business phone", () => {
      const result = resolveWhatsAppMessageContext({
        messageData: { from: "15551234567", to: "77012345678" },
        contacts: [
          {
            wa_id: "77012345678",
            profile: { name: "Customer" },
          },
        ],
        displayPhoneNumber: "15551234567",
      });
      expect(result.direction).toBe("outbound");
      expect(result.contactData?.waId).toBe("77012345678");
    });

    it("resolves BSUID-only inbound contact correctly", () => {
      const result = resolveWhatsAppMessageContext({
        messageData: { from: "US.1349.abc" },
        contacts: [
          {
            user_id: "US.1349.abc",
            profile: { name: "BSUID Customer" },
          },
        ],
        displayPhoneNumber: "15551234567",
      });
      expect(result.direction).toBe("inbound");
      expect(result.contactData?.userId).toBe("US.1349.abc");
      expect(result.contactData?.waId).toBeUndefined();
      expect(result.contactData?.primaryIdType).toBe("user_id");
    });

    it("uses from_user_id when username privacy leaves message.from empty", () => {
      const result = resolveWhatsAppMessageContext({
        messageData: { from: "", from_user_id: "US.1349.private" },
        contacts: [
          {
            wa_id: "",
            user_id: "US.1349.private",
            profile: {
              name: "Private Customer",
              username: "@private_customer",
            },
          },
        ],
        displayPhoneNumber: "15551234567",
      });

      expect(result.direction).toBe("inbound");
      expect(result.contactData?.userId).toBe("US.1349.private");
      expect(result.contactData?.waId).toBeUndefined();
      expect(result.contactData?.profile.username).toBe("@private_customer");
      expect(result.contactData?.primaryIdType).toBe("user_id");
    });
  });

  describe("resolveWhatsAppOutboundRecipientContact", () => {
    it("resolves outbound recipient from to field", () => {
      const result = resolveWhatsAppOutboundRecipientContact({
        messageData: { from: "15551234567", to: "77012345678" },
        contacts: [
          {
            wa_id: "77012345678",
            user_id: "US.1349",
            profile: { name: "Customer" },
          },
        ],
        displayPhoneNumber: "15551234567",
      });
      expect(result?.waId).toBe("77012345678");
      expect(result?.userId).toBe("US.1349");
    });

    it("resolves outbound recipient from parent BSUID when to is omitted", () => {
      const result = resolveWhatsAppOutboundRecipientContact({
        messageData: {
          from: "15551234567",
          to_parent_user_id: "US.parent.private",
        },
        contacts: [
          {
            parent_user_id: "US.parent.private",
            profile: { username: "@private_customer" },
          },
        ],
        displayPhoneNumber: "15551234567",
      });

      expect(result?.waId).toBeUndefined();
      expect(result?.parentUserId).toBe("US.parent.private");
      expect(result?.profile.username).toBe("@private_customer");
      expect(result?.primaryIdType).toBe("parent_user_id");
    });
  });
});
