import type { GenerativeAIActionConfig } from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../types";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
} from "../../view/node-enrichment/scenario-node-graph-index";
import type { ScenarioVariableExtraField } from "../../view/scenario-variable-groups";
import {
  pickedOptionSourceName,
  resolveGenerativeDataFlow,
} from "./action-node-generative-state";

const t: TranslateFn = (key, values) =>
  values ? `${key}(${JSON.stringify(values)})` : key;

const carousel: ScenarioPickedOptionChoice = {
  nodeId: "carousel-1",
  kind: "media_carousel",
  cardImagesUsable: true,
  label: "Pick a frame",
};
const confirm: ScenarioPickedOptionChoice = {
  nodeId: "confirm",
  kind: "reply_buttons",
  cardImagesUsable: false,
  label: "Ready?",
};
const answers: ScenarioVariableExtraField[] = [
  { token: "input.name", label: "Name", description: "What is your name?" },
  { token: "input.sport", label: "Sport", description: "Which sport?" },
];

function imageConfig(
  prompt: string,
  next: { includeCardImage?: boolean } = {}
): GenerativeAIActionConfig {
  return {
    version: 1,
    mode: "text_to_image",
    prompt,
    image: {
      provider: "google",
      sourceId: "source-1",
      modelId: "gemini-3.1-flash-image",
      aspectRatio: "16:9",
      referenceImages: [],
      includeInboundText: true,
    },
    ...(next.includeCardImage === undefined
      ? {}
      : {
          pickedOption: {
            sourceActionNodeId: "carousel-1",
            includeCardImage: next.includeCardImage,
          },
        }),
  } as GenerativeAIActionConfig;
}

function resolve(
  config: GenerativeAIActionConfig,
  pickedSource?: ScenarioPickedOptionChoice,
  promptInputFields: ScenarioVariableExtraField[] = []
) {
  return resolveGenerativeDataFlow({
    config,
    mode: config.mode,
    pickedSource,
    promptInputFields,
    t,
  });
}

describe("pickedOptionSourceName", () => {
  it("names a pick source by its canvas label, or by its message kind", () => {
    expect(pickedOptionSourceName(carousel, t)).toBe("Pick a frame");
    expect(pickedOptionSourceName({ ...carousel, label: "" }, t)).toBe(
      "generativeAIPickedOptionKindCarousel"
    );
    expect(pickedOptionSourceName({ ...confirm, label: "" }, t)).toBe(
      "generativeAIPickedOptionKindButtons"
    );
    expect(
      pickedOptionSourceName({ ...confirm, kind: "list", label: "" }, t)
    ).toBe("generativeAIPickedOptionKindList");
  });
});

describe("resolveGenerativeDataFlow", () => {
  it("offers the answers collected before and marks the ones in use", () => {
    expect(resolve(imageConfig("A gold medal"), undefined, answers)).toEqual({
      tokens: [
        {
          token: "input.name",
          label: "Name",
          inPrompt: false,
          mayBeEmpty: false,
        },
        {
          token: "input.sport",
          label: "Sport",
          inPrompt: false,
          mayBeEmpty: false,
        },
      ],
      unusedPickKey: null,
    });
    const flow = resolve(
      imageConfig("{{input.sport}} medal for {{input.name}}"),
      undefined,
      answers
    );
    expect(flow.tokens.map(token => token.inPrompt)).toEqual([true, true]);
  });

  it("offers card text and label for a carousel pick, ahead of the answers", () => {
    const flow = resolve(imageConfig("A frame"), carousel, answers);
    expect(flow.tokens.map(token => [token.token, token.inPrompt])).toEqual([
      ["picked.text", false],
      ["picked.label", false],
      ["input.name", false],
      ["input.sport", false],
    ]);
    expect(flow.unusedPickKey).toBe("generativeAIUsesPickUnused");
  });

  it("counts a carousel pick as used through its text or its card image", () => {
    expect(
      resolve(imageConfig("{{picked.label}}"), carousel).unusedPickKey
    ).toBeNull();
    expect(
      resolve(imageConfig("A frame", { includeCardImage: true }), carousel)
        .unusedPickKey
    ).toBeNull();
    expect(
      resolve(
        imageConfig("{{picked.text}}", { includeCardImage: true }),
        carousel
      ).unusedPickKey
    ).toBeNull();
  });

  it("does not count a card image the cards cannot provide", () => {
    const flow = resolve(imageConfig("A frame", { includeCardImage: true }), {
      ...carousel,
      cardImagesUsable: false,
    });
    expect(flow.unusedPickKey).toBe("generativeAIUsesPickUnused");
  });

  it("does not count a card image outside image generation", () => {
    const flow = resolve(
      {
        version: 1,
        mode: "text_to_video",
        prompt: "A frame",
        pickedOption: {
          sourceActionNodeId: "carousel-1",
          includeCardImage: true,
        },
      },
      carousel
    );
    expect(flow.unusedPickKey).toBe("generativeAIUsesPickUnused");
  });

  it("offers only the tapped option for a buttons pick", () => {
    const unused = resolve(imageConfig("Medal"), confirm);
    expect(unused.tokens.map(token => token.token)).toEqual(["picked.label"]);
    expect(unused.unusedPickKey).toBe("generativeAIUsesChoiceUnused");

    const used = resolve(imageConfig("Medal {{picked.label}}"), confirm);
    expect(used.tokens).toEqual([
      {
        token: "picked.label",
        label: "Picked Option",
        inPrompt: true,
        mayBeEmpty: false,
      },
    ]);
    expect(used.unusedPickKey).toBeNull();
  });

  it("offers a form's text field read as an input answer only where the prompt uses it", () => {
    const fields: ScenarioVariableExtraField[] = [
      ...answers,
      {
        token: "input.club",
        label: "Club",
        description: "Club",
        legacy: true,
      },
    ];
    expect(
      resolve(imageConfig("A medal"), undefined, fields).tokens.map(
        token => token.token
      )
    ).toEqual(["input.name", "input.sport"]);
    expect(
      resolve(imageConfig("A medal for {{input.club}}"), undefined, fields)
        .tokens
    ).toContainEqual({
      token: "input.club",
      label: "Club",
      inPrompt: true,
      mayBeEmpty: false,
    });
  });

  it("offers earlier forms' answers after the collected ones, named with their form", () => {
    const order: ScenarioFormAnswerChoice = {
      nodeId: "order",
      formKey: "order",
      formLabel: "Order",
      label: "Order details",
      availability: "some_paths",
      schema: "known",
      fields: [
        {
          key: "size",
          responseKey: "size",
          label: "Size",
          description: "",
          fieldType: "Dropdown",
          required: true,
          screenIndex: 0,
          options: [],
          mayBeEmpty: true,
        },
      ],
    };
    const linked: ScenarioFormAnswerChoice = {
      ...order,
      nodeId: "linked",
      formKey: "survey",
      label: "Survey",
      schema: "unknown",
      fields: [],
    };
    const config = imageConfig("A {{form.order.size}} medal");
    expect(
      resolveGenerativeDataFlow({
        config,
        mode: config.mode,
        pickedSource: undefined,
        promptInputFields: answers,
        formAnswerSources: [order, linked],
        t,
      }).tokens
    ).toEqual([
      {
        token: "input.name",
        label: "Name",
        inPrompt: false,
        mayBeEmpty: false,
      },
      {
        token: "input.sport",
        label: "Sport",
        inPrompt: false,
        mayBeEmpty: false,
      },
      {
        token: "form.order.size",
        label: "Size · Order details",
        inPrompt: true,
        mayBeEmpty: true,
      },
    ]);
  });

  it("offers each token once when two forms share a key", () => {
    const order: ScenarioFormAnswerChoice = {
      nodeId: "order",
      formKey: "order",
      formLabel: "Order",
      label: "Order details",
      availability: "always",
      schema: "known",
      fields: [
        {
          key: "size",
          responseKey: "size",
          label: "Size",
          description: "",
          fieldType: "TextInput",
          required: true,
          screenIndex: 0,
          options: [],
          mayBeEmpty: false,
        },
      ],
    };
    const config = imageConfig("A medal");
    expect(
      resolveGenerativeDataFlow({
        config,
        mode: config.mode,
        pickedSource: undefined,
        promptInputFields: [],
        formAnswerSources: [order, { ...order, nodeId: "order-again" }],
        t,
      }).tokens.map(token => token.token)
    ).toEqual(["form.order.size"]);
  });

  it("offers no tokens without a pick or collected answers", () => {
    expect(resolve(imageConfig("A gold medal"))).toEqual({
      tokens: [],
      unusedPickKey: null,
    });
  });
});
