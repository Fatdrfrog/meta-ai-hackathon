import { SERVICE_MESSAGE_EDITOR_ACTIONS } from "./service-message-editor-model";
import {
  WHATSAPP_SERVICE_MESSAGE_CENTRALIZED_LABEL_KEYS,
  WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS,
} from "./service-message-labels";

describe("service-message labels", () => {
  it.each(["appointment", "contacts", "location", "commerce"] as const)(
    "names the %s card the way the add menu names it",
    kind => {
      const menuItem = SERVICE_MESSAGE_EDITOR_ACTIONS.find(
        item => item.action === kind
      );
      expect(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS[kind]).toBe(
        menuItem?.labelKey
      );
    }
  );

  it("keeps sending your own contact apart from asking for the customer's", () => {
    expect(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.contacts).toBe(
      "whatsappServiceActionShareContact"
    );
    expect(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.request_contact_info).toBe(
      "whatsappServiceFormatContactRequest"
    );
  });

  it("lists every kind key for the locale parity check", () => {
    for (const key of Object.values(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS)) {
      expect(WHATSAPP_SERVICE_MESSAGE_CENTRALIZED_LABEL_KEYS).toContain(key);
    }
  });
});
