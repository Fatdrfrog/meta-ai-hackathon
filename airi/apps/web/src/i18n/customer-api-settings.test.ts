import { loadSettingsClientMessages } from "./message-loader";
import { CUSTOMER_WEBHOOK_EVENTS } from "@/lib/customer-api/contracts";

test.each(["en", "ru", "kz"] as const)(
  "loads complete API settings messages for %s",
  async locale => {
    const messages = await loadSettingsClientMessages(locale);
    const settings = messages.CustomerApiSettings as Record<string, unknown>;
    expect(settings.title).toBeTruthy();
    expect(settings.attempt).toContain("{count}");
    const labels = settings.eventsLabels as Record<string, string>;
    for (const event of CUSTOMER_WEBHOOK_EVENTS) {
      expect(labels[event.replaceAll(".", "_")]).toBeTruthy();
    }
  }
);
