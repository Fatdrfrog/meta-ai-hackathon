import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "./service-message-preview";

describe("resolveStoredWhatsAppServiceMessagePreview", () => {
  it("treats any stored canonical value as ownership, including future or malformed previews", () => {
    assert.equal(hasStoredWhatsAppServiceMessage(undefined), false);
    assert.equal(hasStoredWhatsAppServiceMessage(null), false);
    assert.equal(hasStoredWhatsAppServiceMessage({}), true);
    assert.equal(
      hasStoredWhatsAppServiceMessage({ version: 999, kind: "future_kind" }),
      true,
    );
  });

  it("extracts interactive labels without repeating duplicate body text", () => {
    const resolved = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "list",
      bodyText: "Choose a plan",
      command: {
        kind: "list",
        body: "Choose a plan",
        headerText: "Available plans",
        footerText: "Cancel anytime",
        buttonLabel: "View plans",
        sections: [
          {
            title: "Monthly",
            rows: [
              {
                id: "starter",
                title: "Starter",
                description: "For small teams",
              },
            ],
          },
        ],
      },
    });

    assert.deepEqual(resolved.textParts, [
      "Choose a plan",
      "Available plans",
      "Cancel anytime",
      "View plans",
      "Monthly",
      "Starter",
      "For small teams",
    ]);
  });

  it("extracts Flow screen and field labels from the stored command", () => {
    const resolved = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "flow",
      command: {
        kind: "flow",
        body: "Complete your application",
        flowConfig: {
          templateId: "flow-template",
          metaFlowName: "Course application",
          ctaText: "Apply now",
          headerText: "Application",
          footerText: "Takes two minutes",
          screens: [
            {
              id: "profile",
              title: "Your profile",
              fields: [
                {
                  id: "program",
                  label: "Preferred program",
                  helperText: "Choose one",
                  options: [{ id: "data", title: "Data analytics" }],
                },
              ],
            },
          ],
        },
      },
    });

    assert.deepEqual(resolved.textParts, [
      "Complete your application",
      "Course application",
      "Apply now",
      "Application",
      "Takes two minutes",
      "Your profile",
      "Preferred program",
      "Choose one",
      "Data analytics",
    ]);
  });

  it("extracts carousel, contact, location, and commerce semantics", () => {
    const carousel = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "media_carousel",
      command: {
        kind: "media_carousel",
        body: "Browse courses",
        cards: [
          {
            id: "starter",
            bodyText: "Starter course",
            interaction: {
              kind: "quick_replies",
              options: [{ id: "details", label: "See details" }],
            },
          },
        ],
      },
    });
    const contacts = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "contacts",
      command: {
        kind: "contacts",
        contacts: [
          {
            formattedName: "Aida Support",
            company: "airi.chat",
            phone: "+77000000000",
            email: "support@example.com",
          },
        ],
      },
    });
    const location = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "location",
      command: {
        kind: "location",
        location: {
          name: "Main office",
          address: "12 Main Street",
          latitude: 43.2,
          longitude: 76.9,
        },
      },
    });
    const commerce = resolveStoredWhatsAppServiceMessagePreview({
      version: 1,
      kind: "commerce",
      command: {
        kind: "commerce",
        commerce: {
          mode: "multi_product",
          catalogId: "catalog-1",
          headerText: "Course catalog",
          bodyText: "Choose your course",
          footerText: "Secure checkout",
          sections: [
            {
              id: "popular",
              title: "Popular",
              productRetailerIds: ["course-1", "course-2"],
            },
          ],
        },
      },
    });

    assert.deepEqual(carousel.textParts, [
      "Browse courses",
      "Starter course",
      "See details",
    ]);
    assert.deepEqual(contacts.textParts, ["Aida Support", "airi.chat"]);
    assert.deepEqual(location.textParts, ["Main office", "12 Main Street"]);
    assert.deepEqual(commerce.textParts, [
      "Choose your course",
      "Course catalog",
      "Secure checkout",
      "Popular",
    ]);
  });
});
