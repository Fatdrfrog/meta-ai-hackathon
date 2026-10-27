import {
  buildNormalizedWhatsAppContact,
  buildWhatsAppCanonicalId,
  listWhatsAppPhoneIdentityVariants,
  normalizeWhatsAppPhone,
  parseWhatsAppRecipientTarget,
  resolveStoredWhatsAppRecipientTarget,
  resolveWhatsAppRecipientTarget,
  sameWhatsAppPhone,
  sameWhatsAppIdentifier,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { buildWhatsAppIdentitySnapshotUpdate } from "@icecore/shared/lib/whatsapp/identity-snapshot";

describe("whatsapp contact identity helpers", () => {
  it("accepts the E.164 maximum of fifteen phone digits", () => {
    expect(normalizeWhatsAppPhone("+123456789012345")).toBe("123456789012345");
    expect(normalizeWhatsAppPhone("wa_123456789012345")).toBe(
      "123456789012345"
    );
    expect(normalizeWhatsAppPhone("'+123456789012345")).toBe("123456789012345");
    expect(normalizeWhatsAppPhone("001234567890123")).toBe("001234567890123");
  });

  it.each([
    "+1234567890123456",
    "wa_1234567890123456",
    "'+1234567890123456",
    "0012345678901234",
  ])("rejects overlong phone input %s without truncating it", value => {
    expect(normalizeWhatsAppPhone(value)).toBeUndefined();
  });

  it.each([
    ["'+77001234567", "77001234567"],
    ["'77001234567", "77001234567"],
    ["'87001234567", "77001234567"],
    ["  '+7 (700) 123-45-67  ", "77001234567"],
  ])("normalizes a spreadsheet phone text prefix in %s", (input, phone) => {
    expect(normalizeWhatsAppPhone(input)).toBe(phone);
    expect(parseWhatsAppRecipientTarget(input)).toEqual({
      kind: "phone",
      value: phone,
    });
  });

  it.each([
    "'KZ.1387452760252254",
    "'US.ENT.11815799212886844830",
    "'=77001234567",
    "'+SUM(77001234567)",
    "'@77001234567",
    "''+77001234567",
    "'+77001234567'",
    "call +77001234567",
    "7.7001234567E+10",
    "++77001234567",
    "7700+1234567",
    "+7700+1234567",
    "77001234567+",
  ])("does not turn non-phone text %s into a phone", input => {
    expect(normalizeWhatsAppPhone(input)).toBeUndefined();
    expect(parseWhatsAppRecipientTarget(input)?.kind).not.toBe("phone");
  });

  it.each(["phone", "bsuid", "parent_bsuid"] as const)(
    "preserves explicitly typed %s targets",
    kind => {
      const target = { kind, value: "'+77001234567" };
      expect(parseWhatsAppRecipientTarget(target)).toEqual(target);
    }
  );

  it.each(["KZ.1387452760252254", "US.ENT.11815799212886844830"])(
    "keeps the complete business-scoped identifier %s out of phone normalization",
    id => {
      expect(normalizeWhatsAppPhone(id)).toBeUndefined();
      expect(listWhatsAppPhoneIdentityVariants(id)).toEqual([]);
      expect(
        buildNormalizedWhatsAppContact({ fallbackFrom: id })
      ).toMatchObject({
        userId: id,
        primaryIdType: "message_from",
      });
      expect(parseWhatsAppRecipientTarget(id)).toEqual({
        kind: "bsuid",
        value: id,
      });
      expect(sameWhatsAppIdentifier(id, id.replace(/\D/g, ""))).toBe(false);
    }
  );

  it("does not conflate BSUIDs from different countries with the same numeric suffix", () => {
    expect(sameWhatsAppIdentifier("US.123456789012", "KZ.123456789012")).toBe(
      false
    );
  });

  it("preserves known phone and BSUID associations when a webhook omits them", () => {
    const patch = buildWhatsAppIdentitySnapshotUpdate({
      userId: "KZ.1387452760252254",
      profile: { name: "Customer" },
      primaryIdType: "user_id",
    });
    expect(patch.set["whatsapp.userId"]).toBe("KZ.1387452760252254");
    expect(Object.keys(patch.unset)).not.toContain("whatsapp.waId");
    expect(Object.keys(patch.unset)).not.toContain("whatsapp.parentUserId");
    const phoneOnly = buildWhatsAppIdentitySnapshotUpdate({
      waId: "77012345678",
      profile: { name: "Customer" },
      primaryIdType: "wa_id",
    });
    expect(Object.keys(phoneOnly.unset)).not.toContain("whatsapp.userId");
  });

  it("canonicalizes Kazakhstan/Russia national 8-prefix phones to international 7", () => {
    expect(normalizeWhatsAppPhone("87082102445")).toBe("77082102445");
    expect(normalizeWhatsAppPhone("+7 708 210 2445")).toBe("77082102445");
    expect(normalizeWhatsAppPhone("77082102445")).toBe("77082102445");
  });

  it("treats 8-prefix and 7-prefix as the same WhatsApp phone identity", () => {
    expect(sameWhatsAppPhone("87082102445", "77082102445")).toBe(true);
    expect(sameWhatsAppPhone("wa_87089098017", "77089098017")).toBe(true);
  });

  it("lists both international and national trunk variants for lookup", () => {
    expect(listWhatsAppPhoneIdentityVariants("87082102445")).toEqual([
      "77082102445",
      "87082102445",
    ]);
    expect(listWhatsAppPhoneIdentityVariants("77082102445")).toEqual([
      "77082102445",
      "87082102445",
    ]);
  });

  it("builds a phone-first normalized contact when wa_id is present", () => {
    expect(
      buildNormalizedWhatsAppContact({
        waId: "+7 (701) 234-56-78",
        userId: "US.1349",
        profileName: "Ada Lovelace",
        username: "adal",
      })
    ).toEqual({
      waId: "77012345678",
      userId: "US.1349",
      profile: {
        name: "Ada Lovelace",
        username: "adal",
      },
      primaryIdType: "wa_id",
    });
  });

  it("infers a BSUID from message.from when no contact IDs are present", () => {
    expect(
      buildNormalizedWhatsAppContact({
        fallbackFrom: "US.1349.abc",
        profileName: "Customer",
      })
    ).toEqual({
      userId: "US.1349.abc",
      profile: {
        name: "Customer",
      },
      primaryIdType: "message_from",
    });
  });

  it("prefers a stored phone number over a BSUID-style canonical id", () => {
    expect(
      resolveStoredWhatsAppRecipientTarget(
        {
          _id: "wa_bsuid_US.1349",
          whatsapp: {
            waId: "77012345678",
            userId: "US.1349",
          },
        },
        "wa_bsuid_US.1349"
      )
    ).toEqual({
      kind: "phone",
      value: "77012345678",
    });
  });

  it("parses parent BSUID prefixes without stripping characters", () => {
    expect(parseWhatsAppRecipientTarget("parent_bsuid:US.1349.alpha")).toEqual({
      kind: "parent_bsuid",
      value: "US.1349.alpha",
    });
  });

  it("creates a BSUID-keyed canonical ID when only user_id is present (no wa_id)", () => {
    const contact = buildNormalizedWhatsAppContact({
      userId: "US.1349.xyz",
      profileName: "BSUID Customer",
    });
    expect(contact).toMatchObject({
      userId: "US.1349.xyz",
      primaryIdType: "user_id",
    });
    expect(contact?.waId).toBeUndefined();
    expect(buildWhatsAppCanonicalId(contact)).toBe("wa_bsuid_US.1349.xyz");
  });

  it("keeps phone as canonical when both wa_id and user_id are present", () => {
    const contact = buildNormalizedWhatsAppContact({
      waId: "77012345678",
      userId: "US.1349.xyz",
      profileName: "Dual ID Customer",
    });
    expect(contact).toMatchObject({
      waId: "77012345678",
      userId: "US.1349.xyz",
      primaryIdType: "wa_id",
    });
    // Canonical ID uses phone, not BSUID
    expect(buildWhatsAppCanonicalId(contact)).toBe("wa_77012345678");
  });

  it("recipient target resolution prefers phone over BSUID over parent BSUID", () => {
    const phoneAndBsuid = buildNormalizedWhatsAppContact({
      waId: "77012345678",
      userId: "US.1349",
      parentUserId: "US.parent.1",
      profileName: "Full ID",
    });
    expect(resolveWhatsAppRecipientTarget(phoneAndBsuid)).toEqual({
      kind: "phone",
      value: "77012345678",
    });

    const bsuidOnly = buildNormalizedWhatsAppContact({
      userId: "US.1349",
      parentUserId: "US.parent.1",
      profileName: "BSUID+Parent",
    });
    expect(resolveWhatsAppRecipientTarget(bsuidOnly)).toEqual({
      kind: "bsuid",
      value: "US.1349",
    });

    const parentOnly = buildNormalizedWhatsAppContact({
      parentUserId: "US.parent.1",
      profileName: "Parent Only",
    });
    expect(resolveWhatsAppRecipientTarget(parentOnly)).toEqual({
      kind: "parent_bsuid",
      value: "US.parent.1",
    });
  });

  it("preserves BSUID values with dots and mixed case (no digit stripping)", () => {
    const contact = buildNormalizedWhatsAppContact({
      userId: "US.1349.AbCdEf",
      profileName: "Test",
    });
    expect(contact?.userId).toBe("US.1349.AbCdEf");
    expect(buildWhatsAppCanonicalId(contact)).toBe("wa_bsuid_US.1349.AbCdEf");

    expect(parseWhatsAppRecipientTarget("bsuid:US.1349.AbCdEf")).toEqual({
      kind: "bsuid",
      value: "US.1349.AbCdEf",
    });
  });
});
