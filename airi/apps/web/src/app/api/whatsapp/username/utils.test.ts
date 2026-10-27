jest.mock("@/lib/whatsapp/phone/number-username", () => ({
  handlePhoneNumberUsernameUpdate: jest.fn(),
}));

import {
  hasStoredWhatsAppBusinessUsername,
  readStoredWhatsAppBusinessUsernameState,
} from "./utils";

describe("stored WhatsApp business username state", () => {
  it("does not treat a pending requested username as the current username", () => {
    const state = readStoredWhatsAppBusinessUsernameState({
      business_username: {
        requested_username: "pending_airi_support",
        status: "pending",
      },
    });

    expect(state).toEqual({
      username: undefined,
      status: "pending",
    });
    expect(hasStoredWhatsAppBusinessUsername(state)).toBe(false);
  });
});
