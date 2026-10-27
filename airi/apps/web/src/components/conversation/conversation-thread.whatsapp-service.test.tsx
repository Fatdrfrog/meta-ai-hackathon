/**
 * @jest-environment jsdom
 */

import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";
import { render, screen } from "@testing-library/react";
import {
  resolveWhatsAppServiceMessageCardPreview,
  WhatsAppServiceMessageCard as ResolvedWhatsAppServiceMessageCard,
} from "./whatsapp-service-message-card";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

function WhatsAppServiceMessageCard({
  preview,
  workspaceId,
}: {
  preview: StoredWhatsAppServiceMessagePreview;
  workspaceId?: string | null;
}) {
  const resolved = resolveWhatsAppServiceMessageCardPreview(preview);
  if (!resolved) throw new Error("expected a card preview");
  return (
    <ResolvedWhatsAppServiceMessageCard
      preview={resolved}
      workspaceId={workspaceId}
    />
  );
}

describe("WhatsAppServiceMessageCard", () => {
  it("renders canonical reply buttons from one stored command", () => {
    const preview: StoredWhatsAppServiceMessagePreview = {
      version: 1,
      kind: "reply_buttons",
      bodyText: "Choose a team",
      command: {
        kind: "reply_buttons",
        body: "Choose a team",
        options: [
          { id: "wsc:action-1:sales", label: "Sales" },
          { id: "wsc:action-1:support", label: "Support" },
        ],
      },
    };

    render(<WhatsAppServiceMessageCard preview={preview} />);

    expect(screen.getAllByText("Choose a team")).toHaveLength(1);
    expect(screen.getByText("Sales")).toBeTruthy();
    expect(screen.getByText("Support")).toBeTruthy();
  });

  it("renders list descriptions and structured contact/location summaries", () => {
    const { rerender } = render(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "list",
          command: {
            kind: "list",
            body: "Products",
            buttonLabel: "Open",
            sections: [
              {
                title: "Popular",
                rows: [
                  {
                    id: "wsc:action-1:notebook",
                    title: "Notebook",
                    description: "A5, dotted",
                  },
                ],
              },
            ],
          },
        }}
      />
    );
    expect(screen.getByText("A5, dotted")).toBeTruthy();

    rerender(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "contacts",
          command: {
            kind: "contacts",
            contacts: [{ version: 1, formattedName: "Admissions" }],
          },
        }}
      />
    );
    expect(screen.getByText("Admissions")).toBeTruthy();

    rerender(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "location",
          command: {
            kind: "location",
            location: {
              version: 1,
              latitude: 43.238949,
              longitude: 76.889709,
              name: "Campus",
            },
          },
        }}
      />
    );
    expect(screen.getByText("Campus")).toBeTruthy();
  });

  it("labels a location request from the conversation catalog", () => {
    render(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "location_request",
          bodyText: "Airi: Hello!",
          command: {
            kind: "location_request",
            body: "Airi: Hello!",
          },
        }}
      />
    );

    // The requests page loads the conversation catalog, not Scenarios.
    expect(
      screen.getByText("whatsappServiceCard.locationRequest")
    ).toBeTruthy();
  });

  it("summarizes commerce without exposing provider IDs", () => {
    render(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "commerce",
          command: {
            kind: "commerce",
            commerce: {
              mode: "product_carousel",
              catalogId: "catalog-secret",
              bodyText: "New arrivals",
              productRetailerIds: ["sku-secret-1", "sku-secret-2"],
            },
          },
        }}
      />
    );

    expect(screen.getByText("New arrivals")).toBeTruthy();
    expect(
      screen.getByText(`whatsappServiceCard.productCount {"count":2}`)
    ).toBeTruthy();
    expect(screen.queryByText("catalog-secret")).toBeNull();
    expect(screen.queryByText("sku-secret-1")).toBeNull();
  });

  it("renders media carousel as a horizontal scroll strip", () => {
    render(
      <WhatsAppServiceMessageCard
        preview={{
          version: 1,
          kind: "media_carousel",
          bodyText: "Haya from Airi.chat!",
          command: {
            kind: "media_carousel",
            body: "Haya from Airi.chat!",
            cards: [
              {
                id: "card-1",
                bodyText: "CTO's birthday! Want to talk?",
                media: {
                  url: "https://cdn.example/card-1.jpg",
                  mediaType: "image",
                },
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: "opt-1", label: "Lets talk!" }],
                },
              },
              {
                id: "card-2",
                bodyText: "Why not to order a choco-flowers?",
                media: {
                  url: "https://cdn.example/card-2.jpg",
                  mediaType: "image",
                },
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: "opt-2", label: "Why not?" }],
                },
              },
            ],
          },
        }}
      />
    );

    const carousel = screen.getByTestId("whatsapp-service-carousel");
    expect(carousel.className).toContain("overflow-x-auto");
    expect(carousel.className).toContain("flex");
    expect(carousel.className).not.toContain("grid-cols-2");
    expect(screen.getByText("CTO's birthday! Want to talk?")).toBeTruthy();
    expect(screen.getByText("Lets talk!")).toBeTruthy();
    expect(
      carousel.querySelector('img[src="https://cdn.example/card-1.jpg"]')
    ).toBeTruthy();
  });

  it("does not feed durable gcs:// carousel media into img tags", () => {
    const { container } = render(
      <WhatsAppServiceMessageCard
        workspaceId="workspace-1"
        preview={{
          version: 1,
          kind: "media_carousel",
          bodyText: "Carousel",
          command: {
            kind: "media_carousel",
            body: "Carousel",
            cards: [
              {
                id: "card-1",
                bodyText: "Card",
                media: {
                  url: "gcs://bucket/workspaces/workspace-1/creative-assets/image/a/image.jpg",
                  mediaType: "image",
                  fileName: "image.jpg",
                  bucket: "bucket",
                  path: "workspaces/workspace-1/creative-assets/image/a/image.jpg",
                },
                interaction: {
                  kind: "url",
                  buttonLabel: "Open",
                  url: "https://example.com",
                },
              },
              {
                id: "card-2",
                bodyText: "Card 2",
                media: {
                  url: "gcs://bucket/workspaces/workspace-1/creative-assets/image/b/image-2.jpg",
                  mediaType: "image",
                },
                interaction: {
                  kind: "url",
                  buttonLabel: "Shop",
                  url: "https://example.com/shop",
                },
              },
            ],
          },
        }}
      />
    );

    expect(container.querySelector('img[src^="gcs://"]')).toBeNull();
    expect(
      container.querySelector(
        'img[src*="/api/workspaces/workspace-1/creative-assets/object"]'
      )
    ).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Shop")).toBeTruthy();
  });

  it("leaves plain text and media to the existing message renderer", () => {
    expect(
      resolveWhatsAppServiceMessageCardPreview({
        version: 1,
        kind: "text",
        command: { kind: "text", body: "Hello", previewUrl: true },
      })
    ).toBeNull();
    expect(
      resolveWhatsAppServiceMessageCardPreview({
        version: 1,
        kind: "media",
        command: {
          kind: "media",
          attachment: {
            url: "https://cdn.example/image.png",
            mediaType: "image",
          },
        },
      })
    ).toBeNull();
  });

  it("falls back to the stored top-level kind when a legacy command kind is blank", () => {
    expect(
      resolveWhatsAppServiceMessageCardPreview({
        version: 1,
        kind: "commerce",
        command: {
          kind: " ",
          commerce: {
            mode: "catalog",
            catalogId: "catalog-1",
          },
        },
      })?.kind
    ).toBe("commerce");
  });
});
