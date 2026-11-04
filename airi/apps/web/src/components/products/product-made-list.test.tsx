/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type {
  ProductAdRecord,
  ProductKitRecord,
  ProductsMadeResponse,
} from "@/lib/products/types";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { MadeList, outOnMeta } from "./product-made-list";

// "Out on Meta": one row of receipts for what actually exists at Meta: live
// Instagram posts, the WhatsApp ad once it's made (paused or running), and
// a WhatsApp carousel and form once they reached Meta. Nothing else.

const WS = "workspace-1";
const MADE = `/api/workspaces/${WS}/products/made`;
const AD = "751f1f77bcf86cd799439031";
const OTHER = "751f1f77bcf86cd799439032";

const ad = (id: string, meta: ProductAdRecord["meta"]) =>
  ({
    id,
    status: "ready",
    createdAt: "2026-11-03T09:00:00.000Z",
    requestedAt: "2026-11-03T09:00:00.000Z",
    products: [
      {
        productId: "p1",
        name: "Кукла",
        englishName: null,
        priceText: "5 000 ₸",
        imageUrl: "https://signed.test/doll.webp",
      },
    ],
    video: {
      url: "https://signed.test/ad.mp4",
      bytes: 1,
      seconds: 12,
      posterUrl: "https://signed.test/poster.jpg",
    },
    stills: { statusUrl: null, feedUrl: null },
    ...(meta ? { meta } : {}),
  }) as unknown as ProductAdRecord;

const kit = (overrides: Partial<ProductKitRecord> = {}): ProductKitRecord => ({
  id: "kit-1",
  createdAt: "2026-11-03T11:00:00.000Z",
  language: "kk",
  productIds: ["p1", "p2"],
  importId: null,
  parts: {
    carousel: {
      state: "submitted",
      templateId: "t1",
      templateName: "airi_products_1",
      cardCount: 2,
      metaStatus: "APPROVED",
      metaReason: null,
      approvedAt: "2026-11-03T11:05:00.000Z",
      error: null,
      edited: false,
      earlier: [],
    },
  },
  status: "ready",
  pricesChanged: false,
  ...overrides,
});

const made = (): ProductsMadeResponse => ({
  ads: [
    ad(AD, {
      posts: [
        {
          id: "post-1",
          destination: "reel",
          still: null,
          slides: [],
          renderNo: 1,
          motion: "shelf",
          state: "published",
          permalink: "https://www.instagram.com/reel/abc/",
          errorCode: null,
          errorMessage: null,
          requestedAt: "2026-11-03T10:00:00.000Z",
          publishedAt: "2026-11-03T10:01:00.000Z",
        },
        {
          id: "post-2",
          destination: "story",
          still: null,
          slides: [],
          renderNo: 1,
          motion: "shelf",
          state: "failed",
          permalink: null,
          errorCode: "post_failed",
          errorMessage: "Refused",
          requestedAt: "2026-11-03T10:05:00.000Z",
          publishedAt: null,
        },
      ],
      ctwa: {
        attempt: 1,
        asset: "video",
        state: "running",
        effectiveStatus: "PENDING_REVIEW",
        adsManagerUrl: "https://adsmanager.facebook.com/x",
        dailyBudgetCents: 100,
        endsAt: null,
        errorCode: null,
        errorMessage: null,
      },
    }),
    // Made, never sent out: not listed.
    ad(OTHER, undefined),
  ],
  kits: [
    kit(),
    // Not at Meta yet: not listed.
    kit({
      id: "kit-2",
      parts: {
        carousel: {
          state: "making",
          templateId: null,
          templateName: null,
          cardCount: 2,
          metaStatus: null,
          metaReason: null,
          approvedAt: null,
          error: null,
          edited: false,
          earlier: [],
        },
      },
      status: "making",
    }),
  ],
  whatsapp: { connected: true, displayPhone: null },
});

beforeEach(() => {
  global.fetch = jest.fn(async (url: string) => {
    if (url !== MADE) throw new Error(`Unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => made() };
  }) as unknown as typeof fetch;
});

const renderRow = (props: Partial<Parameters<typeof MadeList>[0]> = {}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MadeList workspaceId={WS} onOpenAd={jest.fn()} {...props} />
    </SWRConfig>
  );

describe("Out on Meta", () => {
  it("uses the posted product picture instead of the video poster", () => {
    const data = made();
    const record = data.ads[0]!;
    const original = record.meta!.posts[0]!;
    record.meta!.posts = [
      {
        ...original,
        destination: "post",
        still: { kind: "studio", productId: "p1", colourway: "white" },
      },
    ];
    // The lightweight made-list response omits full still templates.
    expect(
      outOnMeta(WS, data).find(receipt => receipt.key.startsWith("post-"))
        ?.thumb
    ).toBe("https://signed.test/doll.webp");
    record.stills.templates = [
      {
        kind: "studio",
        productId: "p1",
        colourway: "white",
        format: "feed",
        url: "https://signed.test/studio.jpg",
      },
    ];
    expect(
      outOnMeta(WS, data).find(receipt => receipt.key.startsWith("post-"))
        ?.thumb
    ).toBe("https://signed.test/studio.jpg");
  });

  it("labels an unconfirmed Run as checking instead of paused or in review", () => {
    const data = made();
    data.ads[0]!.meta!.ctwa!.effectiveStatus = null;
    const receipt = outOnMeta(WS, data).find(item =>
      item.key.startsWith("ctwa-")
    );
    expect(receipt?.statusLabel).toBe("Checking Meta");
  });

  it("shows a WhatsApp symbol when a kit receipt has no photo", async () => {
    renderRow({ onOpenKit: jest.fn() });
    const receipt = await screen.findByRole("button", {
      name: "Open Carousel + form · WhatsApp",
    });
    expect(receipt.querySelector("svg.lucide-message-circle")).not.toBeNull();
  });
  it("lists only what exists at Meta, newest first", () => {
    const receipts = outOnMeta(WS, made());
    expect(
      receipts.map(receipt => [receipt.what, receipt.where, receipt.stamp])
    ).toEqual([
      ["Carousel + form", "WhatsApp", "approved"],
      ["Reel", "Instagram", "live"],
      ["WhatsApp ad", "Facebook", "in_review"],
    ]);
    expect(receipts.map(receipt => receipt.templateId)).toEqual([
      "chat_kit",
      "reel_shelf",
      "ctwa_video",
    ]);
  });

  it("shows each receipt with its stamp and link, and opens its ad", async () => {
    const onOpenAd = jest.fn();
    renderRow({ onOpenAd });
    const row = await screen.findByRole("region", { name: "Out on Meta" });
    const items = within(row).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[1]!).getByText("Live")).toBeVisible();
    expect(
      within(items[1]!).getByRole("link", { name: "Reel · Instagram at Meta" })
    ).toHaveAttribute("href", "https://www.instagram.com/reel/abc/");
    expect(within(items[2]!).getByText("In review")).toBeVisible();
    fireEvent.click(
      within(items[1]!).getByRole("button", { name: "Open Reel · Instagram" })
    );
    // On the tile it went out from.
    expect(onOpenAd).toHaveBeenCalledWith(AD, "reel_shelf");
  });

  it("shows nothing while nothing is out on Meta", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ads: [ad(OTHER, undefined)],
        kits: [],
        whatsapp: { connected: true, displayPhone: null },
      }),
    })) as unknown as typeof fetch;
    const { container } = renderRow();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("says when it couldn't be loaded, with Retry", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ code: "failed" }),
    })) as unknown as typeof fetch;
    renderRow();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "What went out on Meta couldn't be loaded."
    );
  });
});
