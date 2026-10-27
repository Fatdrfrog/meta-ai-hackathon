jest.mock("@icecore/scenario-contracts", () => {
  const actual = jest.requireActual("@icecore/scenario-contracts");
  return {
    ...actual,
    buildScenarioTemplateSampleContext: jest.fn(
      actual.buildScenarioTemplateSampleContext
    ),
  };
});

import { buildScenarioTemplateSampleContext } from "@icecore/scenario-contracts";
import {
  buildDraftActionPreviewText,
  buildScenarioPreviewContext,
  readScenarioPreviewSamples,
} from "./utils";

const buildSamples = buildScenarioTemplateSampleContext as jest.Mock;

describe("scenario preview samples", () => {
  beforeEach(() => buildSamples.mockClear());

  it("builds the labelled samples once per translator", () => {
    const translate = (key: string) => `label:${key}`;
    const contexts = ["a", "b", "c"].map(reply =>
      buildScenarioPreviewContext({
        reply,
        links: [],
        images: [],
        translate,
      })
    );

    expect(buildSamples).toHaveBeenCalledTimes(1);
    expect(new Set(contexts).size).toBe(3);
    expect(contexts.map(context => context.reply)).toEqual(["a", "b", "c"]);

    buildScenarioPreviewContext({
      reply: "d",
      links: [],
      images: [],
      translate: key => key,
    });
    expect(buildSamples).toHaveBeenCalledTimes(2);
  });

  it("shares frozen samples that no context changes", () => {
    const translate = (key: string) => key;
    const samples = readScenarioPreviewSamples(translate);
    const context = buildScenarioPreviewContext({
      reply: "Hi",
      links: [],
      images: [],
      translate,
      profile: { customerName: "Ada Lovelace", waId: "77" },
    });

    expect(Object.isFrozen(samples)).toBe(true);
    expect(Object.isFrozen(samples.whatsappclient)).toBe(true);
    expect(context.whatsappclient).toMatchObject({
      name: "Ada Lovelace",
      wa_id: "77",
    });
    expect(context.whatsappclient).not.toBe(samples.whatsappclient);
    expect(samples.whatsappclient).toEqual(
      readScenarioPreviewSamples(translate).whatsappclient
    );
    expect(readScenarioPreviewSamples(translate)).toBe(samples);
  });

  it("previews the same text with shared samples", () => {
    const translate = (key: string) =>
      key === "variableFieldCountdown" ? "Time left" : key;
    const render = () =>
      buildDraftActionPreviewText({
        reply: "Hi {{first_name}} {{countdown}}",
        context: buildScenarioPreviewContext({
          reply: "Hi {{first_name}} {{countdown}}",
          links: [],
          images: [],
          translate,
          profile: { customerName: "Ada Lovelace" },
        }),
      });

    expect(render()).toBe("Hi Ada [Time left]");
    expect(render()).toBe("Hi Ada [Time left]");
  });
});
