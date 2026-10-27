import {
  applySignedScenarioMedia,
  collectPendingScenarioMedia,
  takeSignedScenarioMedia,
} from "./scenario-media-display";

function card(url: string, path = "cards/1.png") {
  return { url, bucket: "media", path, mediaType: "image" };
}

function carouselNode(id: string, media: unknown[]) {
  return {
    id,
    data: {
      kind: "action",
      actionWhatsAppServiceMessage: {
        message: {
          type: "carousel",
          cards: media.map(item => ({ media: item, body: "Card" })),
        },
      },
    },
  };
}

function cardMedia(node: { data: unknown }, index: number) {
  return (
    node.data as {
      actionWhatsAppServiceMessage: {
        message: { cards: Array<{ media: { url: string } }> };
      };
    }
  ).actionWhatsAppServiceMessage.message.cards[index]?.media;
}

describe("scenario media display", () => {
  it("collects only durable media refs", () => {
    const pending = collectPendingScenarioMedia(
      [
        carouselNode("a", [
          card("gcs://media/cards/1.png"),
          card("https://cdn.example/2.png", "cards/2.png"),
        ]),
        {
          id: "b",
          data: { kind: "action", actionImageUrls: ["gs://m/x.png"] },
        },
        { id: "c", data: { kind: "trigger" } },
      ],
      "2026-01-01T00:00:00.000Z"
    );
    expect([...pending.byNodeId.keys()]).toEqual(["a", "b"]);
    expect(pending.byNodeId.get("a")?.size).toBe(1);
  });

  it("signs only the same object, and replaces only the url on the canvas", () => {
    const durable = card("gcs://media/cards/1.png");
    const loaded = [carouselNode("a", [durable])];
    const pending = collectPendingScenarioMedia(
      loaded,
      "2026-01-01T00:00:00.000Z"
    );
    const signed = takeSignedScenarioMedia(
      pending,
      [carouselNode("a", [card("https://signed.example/1.png?sig=1")])],
      "2026-01-01T00:00:00.000Z"
    );
    expect(pending.byNodeId.size).toBe(0);

    const canvas = [
      { ...loaded[0], position: { x: 10, y: 20 } },
      { id: "other", data: { kind: "trigger" } },
    ];
    const next = applySignedScenarioMedia(canvas, signed);
    expect(cardMedia(next[0], 0)).toEqual({
      ...durable,
      url: "https://signed.example/1.png?sig=1",
    });
    expect(next[0]).toMatchObject({ position: { x: 10, y: 20 } });
    expect(next[1]).toBe(canvas[1]);
  });

  it("signs the same media whose other fields changed since the load", () => {
    const durable = card("gcs://media/cards/1.png");
    const pending = collectPendingScenarioMedia(
      [carouselNode("a", [durable])],
      "r1"
    );
    const signed = takeSignedScenarioMedia(
      pending,
      [carouselNode("a", [card("https://signed.example/1.png")])],
      "r2"
    );
    const renamed = { ...durable, fileName: "renamed.png" };

    const next = applySignedScenarioMedia(
      [carouselNode("a", [renamed])],
      signed
    );

    expect(cardMedia(next[0], 0)).toEqual({
      ...renamed,
      url: "https://signed.example/1.png",
    });
  });

  it("leaves media the user changed since the load", () => {
    const loaded = [carouselNode("a", [card("gcs://media/cards/1.png")])];
    const pending = collectPendingScenarioMedia(loaded, "r1");
    const signed = takeSignedScenarioMedia(
      pending,
      [carouselNode("a", [card("https://signed.example/1.png")])],
      "r1"
    );
    const edited = [
      carouselNode("a", [card("gcs://media/cards/new.png", "cards/new.png")]),
    ];
    expect(applySignedScenarioMedia(edited, signed)).toBe(edited);
  });

  it("does not pair a different object at the same place", () => {
    const pending = collectPendingScenarioMedia(
      [carouselNode("a", [card("gcs://media/cards/1.png")])],
      "r1"
    );
    const signed = takeSignedScenarioMedia(
      pending,
      [
        carouselNode("a", [
          card("https://signed.example/2.png", "cards/2.png"),
        ]),
      ],
      "r2"
    );
    expect(signed.size).toBe(0);
    expect(pending.byNodeId.size).toBe(1);
  });

  it("pairs legacy URL strings only within the same revision", () => {
    const loaded = [
      { id: "b", data: { kind: "action", actionImageUrls: ["gcs://m/x.png"] } },
    ];
    const latest = [
      {
        id: "b",
        data: { kind: "action", actionImageUrls: ["https://s/x.png"] },
      },
    ];
    const newer = collectPendingScenarioMedia(loaded, "r1");
    expect(takeSignedScenarioMedia(newer, latest, "r2").size).toBe(0);

    const same = collectPendingScenarioMedia(loaded, "r1");
    const signed = takeSignedScenarioMedia(same, latest, "r1");
    const next = applySignedScenarioMedia(loaded, signed);
    expect(next[0]?.data).toEqual({
      kind: "action",
      actionImageUrls: ["https://s/x.png"],
    });
  });

  it("keeps waiting for media a newer read still left durable", () => {
    const pending = collectPendingScenarioMedia(
      [
        carouselNode("a", [
          card("gcs://media/cards/1.png"),
          card("gcs://media/cards/2.png", "cards/2.png"),
        ]),
      ],
      "r1"
    );
    takeSignedScenarioMedia(
      pending,
      [
        carouselNode("a", [
          card("https://signed.example/1.png"),
          card("gcs://media/cards/2.png", "cards/2.png"),
        ]),
      ],
      "r1"
    );
    expect(pending.byNodeId.get("a")?.size).toBe(1);
  });
});
