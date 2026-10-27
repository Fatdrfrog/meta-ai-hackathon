import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapScenarioNodeMedia,
  mapScenarioNodeMediaAsync,
  mapScenarioServiceMessageMedia,
  mapScenarioServiceMessageMediaAsync,
  type ScenarioMediaLocation,
} from "./scenario-media-locations.ts";
import type { WhatsAppServiceSendCommand } from "./whatsapp-service-message-compiler.ts";

function media(name: string) {
  return { url: `gcs://bucket/${name}`, mediaType: "image", path: name };
}

function nodeData() {
  return {
    actionGenerativeAIConfig: {
      version: 1,
      mode: "text_to_image",
      image: { referenceImages: [media("reference.png")] },
    },
    actionAttachments: [media("attachment.png")],
    actionImageUrls: ["gcs://bucket/legacy.png"],
    actionMediaAssets: [{ id: "asset", url: "gcs://bucket/asset.png" }],
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "media_carousel",
        attachment: media("stale.png"),
        header: { kind: "media", attachment: media("header.png") },
        cards: [
          { id: "one", media: media("one.png") },
          { id: "no-media" },
          { id: "two", media: media("two.png") },
        ],
      },
    },
  };
}

describe("scenario media locations", () => {
  it("visits every place node data keeps media, in a fixed order", () => {
    const visited: Array<[ScenarioMediaLocation, unknown]> = [];
    mapScenarioNodeMedia(nodeData(), (value, location) => {
      visited.push([location, value]);
      return value;
    });
    assert.deepEqual(visited, [
      [{ kind: "generative_reference", index: 0 }, media("reference.png")],
      [{ kind: "action_attachment", index: 0 }, media("attachment.png")],
      [{ kind: "action_image_url", index: 0 }, "gcs://bucket/legacy.png"],
      [
        { kind: "action_media_asset", index: 0 },
        { id: "asset", url: "gcs://bucket/asset.png" },
      ],
      [{ kind: "service_attachment" }, media("stale.png")],
      [{ kind: "service_header" }, media("header.png")],
      [{ kind: "service_carousel_card", cardIndex: 0 }, media("one.png")],
      [{ kind: "service_carousel_card", cardIndex: 2 }, media("two.png")],
    ]);
  });

  it("copies only the containers above a changed location", () => {
    const data = nodeData();
    assert.equal(
      mapScenarioNodeMedia(data, (value) => value),
      data,
    );
    const next = mapScenarioNodeMedia(data, (value, location) =>
      location.kind === "service_carousel_card" && location.cardIndex === 2
        ? { ...(value as object), url: "https://signed/two.png" }
        : value,
    );
    assert.notEqual(next, data);
    const message = next.actionWhatsAppServiceMessage.message;
    const original = data.actionWhatsAppServiceMessage.message;
    assert.equal(next.actionGenerativeAIConfig, data.actionGenerativeAIConfig);
    assert.equal(next.actionAttachments, data.actionAttachments);
    assert.equal(message.header, original.header);
    assert.equal(message.cards[0], original.cards[0]);
    assert.equal(message.cards[1], original.cards[1]);
    assert.deepEqual(message.cards[2], {
      id: "two",
      media: { ...media("two.png"), url: "https://signed/two.png" },
    });
    assert.equal(original.cards[2]!.media!.url, "gcs://bucket/two.png");
  });

  it("does not add a media key a payload did not have", () => {
    const payload = { kind: "reply_buttons", header: { kind: "media" } };
    assert.equal(
      mapScenarioServiceMessageMedia(payload, () => media("new.png")),
      payload,
    );
  });

  it("gives a typed send command's visitor typed attachments", () => {
    const command: WhatsAppServiceSendCommand = {
      kind: "media",
      attachment: { url: "gcs://bucket/file.png", mediaType: "image" },
    };
    const next = mapScenarioServiceMessageMedia(command, (attachment) => ({
      ...attachment,
      url: attachment.url.replace("gcs://bucket", "https://signed"),
    }));
    assert.deepEqual(next, {
      kind: "media",
      attachment: { url: "https://signed/file.png", mediaType: "image" },
    });
  });

  it("resolves async visits concurrently and rebuilds in visit order", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const pending = mapScenarioServiceMessageMediaAsync(
      nodeData().actionWhatsAppServiceMessage.message,
      async (value, location) => {
        started.push(location.kind);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { ...(value as object), url: `https://signed/${location.kind}` };
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [
      "service_attachment",
      "service_header",
      "service_carousel_card",
      "service_carousel_card",
    ]);
    releases.reverse().forEach((release) => release());
    const next = await pending;
    assert.equal(next.attachment.url, "https://signed/service_attachment");
    assert.equal(next.header.attachment.url, "https://signed/service_header");
    assert.equal(
      next.cards[2]!.media!.url,
      "https://signed/service_carousel_card",
    );
    assert.deepEqual(next.cards[1], { id: "no-media" });
  });

  it("returns node data without media as given", async () => {
    const data = { actionReplyText: "Hello" };
    assert.equal(
      await mapScenarioNodeMediaAsync(data, async () => "unused"),
      data,
    );
  });
});
