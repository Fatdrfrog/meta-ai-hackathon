jest.mock("next/server", () => ({ after: jest.fn() }));
jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: jest.fn(),
}));
jest.mock("@/lib/scenarios/scenario-asset-resolve", () => ({
  resolveScenarioActionAttachmentHttpsUrl: jest.fn(
    async ({ attachment, workspaceId }) => ({
      ...attachment,
      url: `https://signed.example/${workspaceId}/preview`,
    })
  ),
  resolveScenarioAssetHttpsUrl: jest.fn(
    async ({ url }: { url?: string | null }) =>
      url ? `https://signed.example/asset/${url.split("/").pop()}` : null
  ),
}));
import { after } from "next/server";
import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import { isCreativeAssetDisplayReadUrlCacheEnabled } from "@/lib/google/creative-asset-read-url-cache";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import { resolveScenarioActionAttachmentHttpsUrl } from "@/lib/scenarios/scenario-asset-resolve";
import {
  enrichScenarioNodesMediaDisplayUrls,
  enrichScenarioNodesMediaDisplayUrlsWithinBudget,
  enrichStoredWhatsAppServiceMessagePreviewMedia,
  resolveStoredWhatsAppServiceMessagePrimaryMediaUrl,
} from "./scenario-asset-media-enrichment";

it("refreshes an opted-in voice preview's primary audio from durable storage", async () => {
  const preview = {
    version: 1,
    kind: "media",
    command: {
      kind: "media",
      attachment: {
        ...durable("voice.ogg"),
        mediaType: "audio",
        mimeType: "audio/ogg",
      },
      deliverAsVoice: true,
    },
  };
  await expect(
    enrichStoredWhatsAppServiceMessagePreviewMedia({
      workspaceId: "w1",
      preview,
      includePrimaryAttachment: true,
    })
  ).resolves.toMatchObject({ command: { attachment: { url: SIGNED } } });
});

it("projects a fresh audio URL over the expired stored signature without mutating storage", async () => {
  const original = {
    version: 1,
    kind: "media",
    command: {
      kind: "media",
      attachment: {
        ...durable("voice.ogg"),
        mediaType: "audio",
        mimeType: "audio/ogg",
      },
    },
  };
  const preview = await enrichStoredWhatsAppServiceMessagePreviewMedia({
    workspaceId: "w1",
    preview: original,
    includePrimaryAttachment: true,
  });
  expect(
    resolveStoredWhatsAppServiceMessagePrimaryMediaUrl({
      preview,
      imageUrl: "https://expired.example/voice.ogg",
    })
  ).toBe(SIGNED);
  expect(original.command.attachment.url).toMatch(/^gcs:\/\//);
  expect(
    resolveStoredWhatsAppServiceMessagePrimaryMediaUrl({
      preview: original,
      imageUrl: "https://old.example/voice.ogg",
    })
  ).toBe("https://old.example/voice.ogg");
  expect(
    resolveStoredWhatsAppServiceMessagePrimaryMediaUrl({
      preview: null,
      imageUrl: "/original",
    })
  ).toBe("/original");
});
import { canonicalizeScenarioNodeMediaForPersistence } from "./scenario-asset-refs";

const SIGNED = "https://signed.example/w1/preview";

function durable(name: string) {
  return {
    url: `gcs://media/workspaces/w1/creative-assets/image/${name}`,
    mediaType: "image",
    bucket: "media",
    path: `workspaces/w1/creative-assets/image/${name}`,
  };
}

it("signs every service-message and legacy media field for the editor", async () => {
  const data = {
    actionAttachments: [durable("attachment.png")],
    actionImageUrls: ["gcs://media/legacy.png", 7],
    actionMediaAssets: [{ id: "asset", url: "gcs://media/asset.png" }, "x"],
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "cta_url",
        header: { kind: "media", attachment: durable("header.png") },
        cards: [{ id: "card", media: durable("card.png") }],
      },
    },
  };
  const [node] = (await enrichScenarioNodesMediaDisplayUrls({
    workspaceId: "w1",
    nodes: [{ id: "service", data }],
  })) as Array<{ data: typeof data }>;
  expect(node.data).toEqual({
    actionAttachments: [{ ...durable("attachment.png"), url: SIGNED }],
    actionImageUrls: ["https://signed.example/asset/legacy.png", 7],
    actionMediaAssets: [
      { id: "asset", url: "https://signed.example/asset/asset.png" },
      "x",
    ],
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "cta_url",
        header: {
          kind: "media",
          attachment: { ...durable("header.png"), url: SIGNED },
        },
        cards: [{ id: "card", media: { ...durable("card.png"), url: SIGNED } }],
      },
    },
  });
});

describe("read-URL cache scope", () => {
  function recordCacheScope() {
    const scopes: boolean[] = [];
    jest
      .mocked(resolveScenarioActionAttachmentHttpsUrl)
      .mockImplementation(async ({ attachment }) => {
        scopes.push(isCreativeAssetDisplayReadUrlCacheEnabled());
        return { ...attachment, url: SIGNED };
      });
    return scopes;
  }

  afterEach(() => {
    jest.mocked(resolveScenarioActionAttachmentHttpsUrl).mockReset();
    jest
      .mocked(resolveScenarioActionAttachmentHttpsUrl)
      .mockImplementation(async ({ attachment, workspaceId }) => ({
        ...attachment,
        url: `https://signed.example/${workspaceId}/preview`,
      }));
  });

  it("signs a scenario's editor media through the read-URL cache", async () => {
    const scopes = recordCacheScope();
    const nodes = [
      { id: "cards", data: { actionAttachments: [durable("a.png")] } },
    ];

    await enrichScenarioNodesMediaDisplayUrls({ workspaceId: "w1", nodes });
    await enrichScenarioNodesMediaDisplayUrlsWithinBudget({
      workspaceId: "w1",
      nodes,
      budgetMs: 1_500,
    });

    expect(scopes).toEqual([true, true]);
    expect(isCreativeAssetDisplayReadUrlCacheEnabled()).toBe(false);
  });

  it("signs conversation previews fresh, outside the cache", async () => {
    const scopes = recordCacheScope();

    await enrichStoredWhatsAppServiceMessagePreviewMedia({
      workspaceId: "w1",
      preview: {
        version: 1,
        kind: "media_carousel",
        command: {
          kind: "media_carousel",
          cards: [{ id: "card", media: durable("card.png") }],
        },
      },
    });

    expect(scopes).toEqual([false]);
  });
});

it("signs a stored preview's header and card media but not a media message's own attachment", async () => {
  const carousel = {
    version: 1,
    kind: "media_carousel",
    command: {
      kind: "media_carousel",
      cards: [{ id: "card", media: durable("card.png") }],
    },
  };
  await expect(
    enrichStoredWhatsAppServiceMessagePreviewMedia({
      workspaceId: "w1",
      preview: carousel,
    })
  ).resolves.toEqual({
    ...carousel,
    command: {
      kind: "media_carousel",
      cards: [{ id: "card", media: { ...durable("card.png"), url: SIGNED } }],
    },
  });

  jest.mocked(ensureMediaApiCreativeAssetReadUrlPort).mockClear();
  const media = {
    version: 1,
    kind: "media",
    command: { kind: "media", attachment: durable("photo.png") },
  };
  await expect(
    enrichStoredWhatsAppServiceMessagePreviewMedia({
      workspaceId: "w1",
      preview: media,
    })
  ).resolves.toBe(media);
  expect(ensureMediaApiCreativeAssetReadUrlPort).not.toHaveBeenCalled();
});

it("hydrates image-generation previews and restores the same durable reference on save", async () => {
  const data = {
    actionGenerativeAIConfig: {
      version: 1,
      mode: "text_to_image",
      prompt: "User instructions",
      image: {
        referenceImages: [
          {
            url: "gcs://media/workspaces/w1/creative-assets/image/a/file.png",
            mediaType: "image",
            bucket: "media",
            path: "workspaces/w1/creative-assets/image/a/file.png",
          },
        ],
      },
    },
  };
  const nodes = (await enrichScenarioNodesMediaDisplayUrls({
    workspaceId: "w1",
    nodes: [{ id: "image", data }],
  })) as Array<{ data: typeof data }>;
  expect(
    nodes[0].data.actionGenerativeAIConfig.image.referenceImages[0].url
  ).toBe("https://signed.example/w1/preview");
  expect(canonicalizeScenarioNodeMediaForPersistence(nodes[0].data)).toEqual(
    data
  );
  expect(data.actionGenerativeAIConfig.image.referenceImages[0].url).toMatch(
    /^gcs:/
  );
});

describe("enrichScenarioNodesMediaDisplayUrlsWithinBudget", () => {
  const signedFast = "https://signed.example/fast";
  const signedSlow = "https://signed.example/slow";

  function signFastThenHold() {
    let finishSlow = () => {};
    jest
      .mocked(resolveScenarioActionAttachmentHttpsUrl)
      .mockImplementationOnce(async ({ attachment }) => ({
        ...attachment,
        url: signedFast,
      }))
      .mockImplementationOnce(
        ({ attachment }) =>
          new Promise<ScenarioActionAttachment>(resolve => {
            finishSlow = () => resolve({ ...attachment, url: signedSlow });
          })
      );
    return () => finishSlow();
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.mocked(after).mockReset();
  });

  it("answers at the budget with slow media left durable and keeps signing it", async () => {
    jest.useFakeTimers();
    const finishSlow = signFastThenHold();
    const fast = durable("fast.png");
    const slow = durable("slow.png");

    const resultPromise = enrichScenarioNodesMediaDisplayUrlsWithinBudget({
      workspaceId: "w1",
      nodes: [{ id: "cards", data: { actionAttachments: [fast, slow] } }],
      budgetMs: 1_500,
    });
    let answered = false;
    void resultPromise.then(() => {
      answered = true;
    });
    await jest.advanceTimersByTimeAsync(1_499);
    expect(answered).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      nodes: [
        {
          id: "cards",
          data: { actionAttachments: [{ ...fast, url: signedFast }, slow] },
        },
      ],
      pending: true,
    });
    expect(after).toHaveBeenCalledTimes(1);
    const background = jest.mocked(after).mock.calls[0]?.[0] as Promise<
      PromiseSettledResult<unknown>[]
    >;
    finishSlow();
    await expect(background).resolves.toEqual([
      { status: "fulfilled", value: { ...slow, url: signedSlow } },
    ]);
  });

  it("returns every signed URL and leaves no timer when signing beats the budget", async () => {
    jest.useFakeTimers();
    const attachment = durable("quick.png");

    await expect(
      enrichScenarioNodesMediaDisplayUrlsWithinBudget({
        workspaceId: "w1",
        nodes: [{ id: "quick", data: { actionAttachments: [attachment] } }],
        budgetMs: 1_500,
      })
    ).resolves.toEqual({
      nodes: [
        {
          id: "quick",
          data: { actionAttachments: [{ ...attachment, url: SIGNED }] },
        },
      ],
      pending: false,
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(after).not.toHaveBeenCalled();
  });

  it("still answers outside a request scope, where after() is unavailable", async () => {
    jest.mocked(after).mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const finishSlow = signFastThenHold();
    const fast = durable("fast.png");
    const slow = durable("slow.png");

    const result = await enrichScenarioNodesMediaDisplayUrlsWithinBudget({
      workspaceId: "w1",
      nodes: [{ id: "cards", data: { actionAttachments: [fast, slow] } }],
      budgetMs: 0,
    });

    expect(result.pending).toBe(true);
    finishSlow();
  });
});
