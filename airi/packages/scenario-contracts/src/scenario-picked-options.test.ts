import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScenarioPickedOption,
  MAX_SCENARIO_PICKED_OPTIONS,
  normalizeScenarioPickedOptions,
  readScenarioPickedOption,
  readScenarioPickedOptionTemplateValues,
  recordScenarioPickedOption,
  type ScenarioPickedOption,
} from "./scenario-picked-options.ts";

const PICKED_AT = new Date("2026-09-27T10:00:00.000Z");

const cardMedia = {
  url: "gcs://creative-assets/workspaces/ws/creative-assets/image/gold.jpg",
  mediaType: "image" as const,
  mimeType: "image/jpeg",
  fileSize: 2048,
  bucket: "creative-assets",
  path: "workspaces/ws/creative-assets/image/gold.jpg",
};

function pick(
  sourceActionNodeId: string,
  optionId: string,
  extra: Partial<ScenarioPickedOption> = {},
): ScenarioPickedOption {
  return {
    sourceActionNodeId,
    optionId,
    label: "Buy",
    pickedAt: PICKED_AT.toISOString(),
    ...extra,
  };
}

describe("picked options", () => {
  it("builds a pick from a tapped carousel option, keeping its card", () => {
    assert.deepEqual(
      buildScenarioPickedOption({
        sourceActionNodeId: " carousel-1 ",
        option: {
          id: "wsc:carousel-1:gold-buy",
          label: "Buy",
          cardIndex: 0,
          cardId: "card-gold",
          cardMedia,
          cardBodyText: "Gold frame, 30 x 40 cm",
        },
        pickedAt: PICKED_AT,
      }),
      {
        sourceActionNodeId: "carousel-1",
        optionId: "wsc:carousel-1:gold-buy",
        label: "Buy",
        cardIndex: 0,
        cardId: "card-gold",
        cardBodyText: "Gold frame, 30 x 40 cm",
        cardMedia,
        pickedAt: "2026-09-27T10:00:00.000Z",
      },
    );
  });

  it("builds a pick from a reply button without card fields", () => {
    assert.deepEqual(
      buildScenarioPickedOption({
        sourceActionNodeId: "buttons-1",
        option: { id: "wsc:buttons-1:yes", label: "Yes" },
        pickedAt: PICKED_AT,
      }),
      pick("buttons-1", "wsc:buttons-1:yes", { label: "Yes" }),
    );
  });

  it("refuses a pick without a source node or an option id", () => {
    for (const [sourceActionNodeId, id] of [
      ["", "wsc:a:b"],
      ["node", " "],
    ]) {
      assert.equal(
        buildScenarioPickedOption({
          sourceActionNodeId: sourceActionNodeId!,
          option: { id: id!, label: "Buy" },
          pickedAt: PICKED_AT,
        }),
        null,
      );
    }
  });

  it("records the latest pick per message, for one scenario at a time", () => {
    const first = recordScenarioPickedOption(
      { lockedScenarioId: "scenario-1", currentActionNodeId: "carousel-1" },
      {
        scenarioId: "scenario-1",
        pick: pick("carousel-1", "wsc:carousel-1:a"),
      },
    );
    assert.equal(first.lockedScenarioId, "scenario-1");
    assert.equal(first.currentActionNodeId, "carousel-1");
    const second = recordScenarioPickedOption(first, {
      scenarioId: "scenario-1",
      pick: pick("buttons-1", "wsc:buttons-1:yes"),
    });
    const changed = recordScenarioPickedOption(second, {
      scenarioId: "scenario-1",
      pick: pick("carousel-1", "wsc:carousel-1:b"),
    });
    assert.deepEqual(
      normalizeScenarioPickedOptions(changed.pickedOptions)?.picks.map(
        (item) => item.optionId,
      ),
      ["wsc:buttons-1:yes", "wsc:carousel-1:b"],
    );

    const otherScenario = recordScenarioPickedOption(changed, {
      scenarioId: "scenario-2",
      pick: pick("carousel-9", "wsc:carousel-9:z"),
    });
    assert.deepEqual(
      normalizeScenarioPickedOptions(otherScenario.pickedOptions),
      {
        scenarioId: "scenario-2",
        picks: [pick("carousel-9", "wsc:carousel-9:z")],
      },
    );
  });

  it("keeps a bounded number of picks, dropping the earliest", () => {
    let state: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_SCENARIO_PICKED_OPTIONS; index += 1) {
      state = recordScenarioPickedOption(state, {
        scenarioId: "scenario-1",
        pick: pick(`node-${index}`, `wsc:node-${index}:x`),
      });
    }
    const picks = normalizeScenarioPickedOptions(state.pickedOptions)?.picks;
    assert.equal(picks?.length, MAX_SCENARIO_PICKED_OPTIONS);
    assert.equal(picks?.[0]?.sourceActionNodeId, "node-1");
  });

  it("reads a pick only for the scenario that recorded it", () => {
    const state = recordScenarioPickedOption(
      recordScenarioPickedOption(
        {},
        {
          scenarioId: "scenario-1",
          pick: pick("carousel-1", "wsc:carousel-1:a", {
            cardBodyText: "Gold",
          }),
        },
      ),
      { scenarioId: "scenario-1", pick: pick("buttons-1", "wsc:buttons-1:y") },
    );
    assert.equal(
      readScenarioPickedOption(state, { scenarioId: "scenario-1" })?.optionId,
      "wsc:buttons-1:y",
    );
    assert.equal(
      readScenarioPickedOption(state, {
        scenarioId: "scenario-1",
        sourceActionNodeId: "carousel-1",
      })?.cardBodyText,
      "Gold",
    );
    assert.equal(
      readScenarioPickedOption(state, {
        scenarioId: "scenario-1",
        sourceActionNodeId: "carousel-2",
      }),
      null,
    );
    for (const scenarioId of ["scenario-2", null, undefined, ""]) {
      assert.equal(readScenarioPickedOption(state, { scenarioId }), null);
    }
  });

  it("drops malformed stored picks and bounds stored text", () => {
    assert.equal(normalizeScenarioPickedOptions(null), null);
    assert.equal(normalizeScenarioPickedOptions({ picks: [] }), null);
    const normalized = normalizeScenarioPickedOptions({
      scenarioId: " scenario-1 ",
      picks: [
        null,
        "wsc:a:b",
        { sourceActionNodeId: "node", label: "No option id" },
        {
          sourceActionNodeId: "carousel-1",
          optionId: "wsc:carousel-1:a",
          label: 42,
          cardIndex: -1,
          cardId: "",
          cardBodyText: "x".repeat(5000),
          cardMedia: { url: "", mediaType: "image" },
          pickedAt: "not a date",
        },
      ],
    });
    assert.equal(normalized?.scenarioId, "scenario-1");
    assert.equal(normalized?.picks.length, 1);
    const [only] = normalized?.picks ?? [];
    assert.equal(only?.label, "");
    assert.equal(only?.cardIndex, undefined);
    assert.equal(only?.cardId, undefined);
    assert.equal(only?.cardMedia, undefined);
    assert.equal(only?.cardBodyText?.length, 1024);
    assert.equal(only?.pickedAt, "");
  });

  it("gives templates the option label and the card text", () => {
    assert.deepEqual(readScenarioPickedOptionTemplateValues(null), {
      label: "",
      text: "",
    });
    assert.deepEqual(
      readScenarioPickedOptionTemplateValues(
        pick("carousel-1", "wsc:carousel-1:a", { cardBodyText: "Gold frame" }),
      ),
      { label: "Buy", text: "Gold frame" },
    );
  });
});
