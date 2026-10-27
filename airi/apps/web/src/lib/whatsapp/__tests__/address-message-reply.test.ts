jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

import { extractPhoneFromAddressMessageReply } from "@icecore/airi-runtime/whatsapp-message-processor";

describe("extractPhoneFromAddressMessageReply", () => {
  it("extracts phone from direct phone_number field", () => {
    const json = JSON.stringify({ phone_number: "+77012345678" });
    expect(extractPhoneFromAddressMessageReply(json)).toBe("77012345678");
  });

  it("extracts phone from nested values.phone_number field", () => {
    const json = JSON.stringify({
      values: { phone_number: "+1 555 123 4567" },
    });
    expect(extractPhoneFromAddressMessageReply(json)).toBe("15551234567");
  });

  it("extracts phone from saved_addresses array", () => {
    const json = JSON.stringify({
      saved_addresses: [{ phone_number: "77012345678" }],
    });
    expect(extractPhoneFromAddressMessageReply(json)).toBe("77012345678");
  });

  it("returns null when no phone is found", () => {
    expect(extractPhoneFromAddressMessageReply(JSON.stringify({}))).toBeNull();
    expect(extractPhoneFromAddressMessageReply(null)).toBeNull();
    expect(extractPhoneFromAddressMessageReply(undefined)).toBeNull();
    expect(extractPhoneFromAddressMessageReply("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractPhoneFromAddressMessageReply("not-valid-json")).toBeNull();
  });

  it("normalizes phone by stripping non-digits", () => {
    const json = JSON.stringify({ phone_number: "+7 (701) 234-56-78" });
    expect(extractPhoneFromAddressMessageReply(json)).toBe("77012345678");
  });
});
