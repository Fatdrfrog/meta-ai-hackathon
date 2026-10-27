import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileWhatsAppServiceMessage,
  readScenarioPickedOption,
  type ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import {
  readTappedScenarioPick,
  withTappedScenarioPick,
} from "./scenario-picked-option-turn";

const PICKED_AT = new Date("2026-09-27T10:00:00.000Z");

const cardMedia = (name: string) => ({
  url: `gcs://media/workspaces/ws/creative-assets/image/${name}`,
  mediaType: "image" as const,
  mimeType: "image/jpeg",
  fileSize: 2048,
  bucket: "media",
  path: `workspaces/ws/creative-assets/image/${name}`,
});

const carousel: ScenarioWhatsAppServiceMessage = {
  version: 1,
  message: {
    kind: "media_carousel",
    body: { mode: "fixed", text: "Pick a frame and tell us your name" },
    cards: [
      {
        id: "card-gold",
        media: cardMedia("gold.jpg"),
        bodyText: "Gold frame",
        interaction: {
          kind: "quick_replies",
          options: [{ id: "wsc:carousel-1:gold", label: "Buy" }],
        },
      },
      {
        id: "card-silver",
        media: cardMedia("silver.jpg"),
        bodyText: "Silver frame",
        interaction: {
          kind: "quick_replies",
          options: [{ id: "wsc:carousel-1:silver", label: "Buy" }],
        },
      },
    ],
  },
};

function storedPreview(): unknown {
  const compiled = compileWhatsAppServiceMessage({
    config: carousel,
    recipientKind: "phone",
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("carousel did not compile");
  return JSON.parse(JSON.stringify(compiled.preview));
}

describe("tapped scenario picks", () => {
  it("records the card the customer tapped, as the sent message showed it", async () => {
    const lookups: unknown[] = [];
    const tapped = await readTappedScenarioPick({
      async findTappedScenarioServiceMessage(scope) {
        lookups.push(scope);
        return {
          scenarioId: "scenario-1",
          whatsappServiceMessage: storedPreview(),
        };
      },
      workspaceId: "ws",
      conversationId: "conv-1",
      quickReplyPayload: "wsc:carousel-1:silver",
      contextMessageId: " ws_wamid.123 ",
      pickedAt: PICKED_AT,
    });
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        contextMessageId: "ws_wamid.123",
        actionNodeId: "carousel-1",
      },
    ]);
    assert.deepEqual(tapped, {
      scenarioId: "scenario-1",
      pick: {
        sourceActionNodeId: "carousel-1",
        optionId: "wsc:carousel-1:silver",
        label: "Buy",
        cardIndex: 1,
        cardId: "card-silver",
        cardBodyText: "Silver frame",
        cardMedia: cardMedia("silver.jpg"),
        pickedAt: "2026-09-27T10:00:00.000Z",
      },
    });

    const state = withTappedScenarioPick(
      { lockedScenarioId: "scenario-1", currentActionNodeId: "carousel-1" },
      tapped,
    );
    assert.equal(
      readScenarioPickedOption(state, {
        scenarioId: "scenario-1",
        sourceActionNodeId: "carousel-1",
      })?.cardBodyText,
      "Silver frame",
    );
    assert.equal(
      (state as { currentActionNodeId?: string }).currentActionNodeId,
      "carousel-1",
    );
  });

  it("looks nothing up for events that are not a session choice", async () => {
    let lookups = 0;
    for (const quickReplyPayload of [
      null,
      undefined,
      "",
      "stb:node:0",
      "yes",
    ]) {
      assert.equal(
        await readTappedScenarioPick({
          async findTappedScenarioServiceMessage() {
            lookups += 1;
            return null;
          },
          workspaceId: "ws",
          conversationId: "conv-1",
          quickReplyPayload,
          contextMessageId: "ws_wamid.123",
          pickedAt: PICKED_AT,
        }),
        null,
      );
    }
    assert.equal(lookups, 0);
    assert.equal(
      await readTappedScenarioPick({
        findTappedScenarioServiceMessage: undefined,
        workspaceId: "ws",
        conversationId: "conv-1",
        quickReplyPayload: "wsc:carousel-1:gold",
        contextMessageId: null,
        pickedAt: PICKED_AT,
      }),
      null,
    );
  });

  it("records nothing when the stored message no longer offers the option", async () => {
    for (const stored of [
      null,
      { scenarioId: "scenario-1", whatsappServiceMessage: null },
      { scenarioId: "scenario-1", whatsappServiceMessage: storedPreview() },
    ]) {
      assert.equal(
        await readTappedScenarioPick({
          async findTappedScenarioServiceMessage() {
            return stored;
          },
          workspaceId: "ws",
          conversationId: "conv-1",
          quickReplyPayload: "wsc:carousel-1:bronze",
          contextMessageId: null,
          pickedAt: PICKED_AT,
        }),
        null,
      );
    }
    assert.deepEqual(withTappedScenarioPick({ a: 1 }, null), { a: 1 });
  });
});
