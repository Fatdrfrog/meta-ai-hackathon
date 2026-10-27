import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "./scenario-branch-handles.ts";
import {
  buildScenarioFormAnswerSourcesByNodeId,
  buildScenarioPickedOptionSourcesByNodeId,
  buildScenarioPromptInputsByNodeId,
} from "./scenario-prompt-input-scope.ts";
import { PROMPT_INPUTS_UNMET_HANDLE } from "./scenario-prompt-inputs.ts";

const image = (name: string, overrides: Record<string, unknown> = {}) => ({
  url: `gcs://media/workspaces/ws/creative-assets/image/${name}`,
  mediaType: "image",
  mimeType: "image/jpeg",
  fileSize: 2048,
  bucket: "media",
  path: `workspaces/ws/creative-assets/image/${name}`,
  ...overrides,
});

function carousel(id: string, media = [image("a.jpg"), image("b.jpg")]) {
  return {
    id,
    data: {
      kind: "action",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "media_carousel",
          body: { mode: "fixed", text: "Pick one" },
          cards: media.map((cardMedia, index) => ({
            id: `card-${index}`,
            media: cardMedia,
            bodyText: `Card ${index}`,
            interaction: {
              kind: "quick_replies",
              options: [{ id: `wsc:${id}:${index}`, label: "Buy" }],
            },
          })),
        },
      },
    },
  };
}

function buttons(id: string) {
  return {
    id,
    data: {
      kind: "action",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Ready?" },
          options: [{ id: `wsc:${id}:yes`, label: "Yes" }],
        },
      },
    },
  };
}

const node = (id: string, kind = "action") => ({ id, data: { kind } });
const edge = (source: string, target: string, sourceHandle?: string) => ({
  source,
  target,
  sourceHandle,
});

it("keeps conditional graph answers optional after a guaranteed form submission", () => {
  const config = {
    templateId: "custom",
    ctaText: "Open",
    answersKey: "medals",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Choose",
        fields: [
          {
            id: "choice",
            fieldType: "NavigationList",
            label: "Sport",
            navigationItems: [
              {
                id: "known",
                title: "Known",
                action: { name: "navigate", nextScreenId: "KNOWN" },
              },
              {
                id: "other",
                title: "Other",
                action: { name: "navigate", nextScreenId: "OTHER" },
              },
            ],
          },
        ],
      },
      {
        id: "KNOWN",
        title: "Known",
        terminal: true,
        fields: [
          { id: "name", label: "Name", fieldType: "TextInput", required: true },
        ],
        footer: {
          label: "Send",
          action: { name: "complete", payload: { name: "${form.name}" } },
        },
      },
      {
        id: "OTHER",
        title: "Other",
        terminal: true,
        fields: [
          { id: "name", label: "Name", fieldType: "TextInput", required: true },
          {
            id: "sport",
            label: "Sport",
            fieldType: "TextInput",
            required: true,
          },
        ],
        footer: {
          label: "Send",
          action: {
            name: "complete",
            payload: { name: "${form.name}", sport: "${form.sport}" },
          },
        },
      },
    ],
  };
  const sources = buildScenarioFormAnswerSourcesByNodeId({
    nodes: [
      node("trigger", "trigger"),
      {
        id: "medals",
        data: {
          kind: "action",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "flow", flowConfig: config },
          },
        },
      },
      node("ai"),
    ],
    edges: [edge("trigger", "medals"), edge("medals", "ai")],
  });
  assert.deepEqual(
    sources
      .get("ai")?.[0]
      ?.fields.map((field) => [field.key, field.mayBeEmpty]),
    [
      ["name", false],
      ["sport", true],
    ],
  );
});

it("keeps transported optional answers optional after a guaranteed graph submission", () => {
  const config = {
    templateId: "custom",
    ctaText: "Open",
    answersKey: "order",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "FIRST",
        title: "First",
        fields: [
          {
            id: "name",
            label: "Name",
            fieldType: "TextInput",
            required: false,
          },
        ],
        footer: {
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${form.name}" },
          },
        },
      },
      {
        id: "SECOND",
        title: "Second",
        fields: [
          { id: "name", label: "Name", fieldType: "TextInput", required: true },
        ],
        footer: {
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${form.name}" },
          },
        },
      },
      {
        id: "END",
        title: "End",
        terminal: true,
        fields: [],
        footer: {
          action: { name: "complete", payload: { name: "${data.carried}" } },
        },
      },
    ],
  };
  const sources = buildScenarioFormAnswerSourcesByNodeId({
    nodes: [
      node("trigger", "trigger"),
      {
        id: "order",
        data: {
          kind: "action",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "flow", flowConfig: config },
          },
        },
      },
      node("ai"),
    ],
    edges: [edge("trigger", "order"), edge("order", "ai")],
  });
  assert.equal(sources.get("ai")?.[0]?.fields[0]?.mayBeEmpty, true);
});

describe("picked-option sources", () => {
  it("offers the choice messages every path passes, with card image readiness", () => {
    const sources = buildScenarioPickedOptionSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        carousel("carousel"),
        buttons("confirm"),
        node("generate"),
      ],
      edges: [
        edge("trigger", "carousel"),
        edge(
          "carousel",
          "confirm",
          "right-source-whatsapp-session-choice-branch::a",
        ),
        edge("confirm", "generate"),
      ],
    });
    assert.deepEqual(sources.get("generate"), [
      { nodeId: "carousel", kind: "media_carousel", cardImagesUsable: true },
      { nodeId: "confirm", kind: "reply_buttons", cardImagesUsable: false },
    ]);
    assert.deepEqual(sources.get("carousel"), []);
    assert.deepEqual(sources.get("confirm"), [
      { nodeId: "carousel", kind: "media_carousel", cardImagesUsable: true },
    ]);
  });

  it("skips a message another entry path goes around", () => {
    const sources = buildScenarioPickedOptionSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        node("second-trigger", "trigger"),
        carousel("carousel"),
        node("generate"),
      ],
      edges: [
        edge("trigger", "carousel"),
        edge("carousel", "generate"),
        edge("second-trigger", "generate"),
      ],
    });
    assert.deepEqual(sources.get("generate"), []);
  });

  it("keeps the source on its unmet route, where the tap already happened", () => {
    const sources = buildScenarioPickedOptionSourcesByNodeId({
      nodes: [node("trigger", "trigger"), carousel("carousel"), node("again")],
      edges: [
        edge("trigger", "carousel"),
        edge("carousel", "again", PROMPT_INPUTS_UNMET_HANDLE),
      ],
    });
    assert.deepEqual(
      sources.get("again")?.map((source) => source.nodeId),
      ["carousel"],
    );
  });

  it("marks carousel card images unusable when any card cannot be a reference", () => {
    for (const unusable of [
      image("c.webp", { mimeType: "image/webp" }),
      image("c.jpg", { fileSize: undefined }),
      image("c.jpg", { bucket: undefined }),
      image("c.jpg", { fileSize: 6 * 1024 * 1024 }),
      { url: "gcs://media/c.mp4", mediaType: "video", mimeType: "video/mp4" },
    ]) {
      const sources = buildScenarioPickedOptionSourcesByNodeId({
        nodes: [
          node("trigger", "trigger"),
          carousel("carousel", [image("a.jpg"), unusable]),
          node("generate"),
        ],
        edges: [edge("trigger", "carousel"), edge("carousel", "generate")],
      });
      assert.deepEqual(sources.get("generate"), [
        { nodeId: "carousel", kind: "media_carousel", cardImagesUsable: false },
      ]);
    }
  });
});

function form(
  id: string,
  options: {
    sender?: "service_message" | "template";
    fields?: Array<Record<string, unknown>>;
    screens?: Array<Record<string, unknown>>;
    extra?: Record<string, unknown>;
  } = {},
) {
  const flowConfig = {
    templateId: id,
    ctaText: "Open",
    screens: options.screens ?? [
      {
        id: "DETAILS",
        title: `${id} details`,
        fields: options.fields ?? [
          { id: "size", label: "Size", fieldType: "TextInput", required: true },
        ],
      },
    ],
    answersKey: id,
    ...options.extra,
  };
  return options.sender === "template"
    ? {
        id,
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionFlowConfig: flowConfig,
        },
      }
    : {
        id,
        data: {
          kind: "action",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Fill in" },
              flowConfig,
            },
          },
        },
      };
}

const NO_REPLY = "right-source-action-outcome::no-reply";
const ANY_REPLY = "right-source-action-outcome::any-reply";
const FLOW_BRANCH = "right-source-flow-branch::size::m";
const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
const QUICK_REPLY = buildWhatsAppTemplateButtonSourceHandleId(0);

function availability(
  sources: ReturnType<typeof buildScenarioFormAnswerSourcesByNodeId>,
  nodeId: string,
) {
  return (sources.get(nodeId) ?? []).map((source) => [
    source.formKey,
    source.availability,
  ]);
}

describe("form answer sources", () => {
  it("reads a new edge list afresh even when the nodes are the same array", () => {
    const nodes = [node("trigger", "trigger"), form("order"), node("ai")];
    const edges = [edge("trigger", "order"), edge("order", "ai")];
    assert.deepEqual(
      availability(
        buildScenarioFormAnswerSourcesByNodeId({ nodes, edges }),
        "ai",
      ),
      [["order", "always"]],
    );
    // The same arrays again give the same answer.
    assert.deepEqual(
      availability(
        buildScenarioPromptInputsByNodeId({ nodes, edges }) &&
          buildScenarioFormAnswerSourcesByNodeId({ nodes, edges }),
        "ai",
      ),
      [["order", "always"]],
    );

    // A route around the form, in a new edge array, changes the scope.
    const aroundEdges = [...edges, edge("trigger", "ai")];
    assert.deepEqual(
      availability(
        buildScenarioFormAnswerSourcesByNodeId({ nodes, edges: aroundEdges }),
        "ai",
      ),
      [["order", "some_paths"]],
    );
  });

  it("compounds a chain of forms, each always passed", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("contact"),
        form("order"),
        node("ai"),
      ],
      edges: [
        edge("trigger", "contact"),
        edge("contact", "order", "right-source"),
        edge("order", "ai"),
      ],
    });
    assert.deepEqual(availability(sources, "ai"), [
      ["contact", "always"],
      ["order", "always"],
    ]);
    assert.deepEqual(availability(sources, "order"), [["contact", "always"]]);
    assert.deepEqual(availability(sources, "contact"), []);
    const [contact] = sources.get("ai") ?? [];
    assert.deepEqual(contact && { ...contact, fields: undefined }, {
      nodeId: "contact",
      formKey: "contact",
      formLabel: "contact details",
      availability: "always",
      schema: "known",
      fields: undefined,
    });
    assert.deepEqual(
      contact?.fields.map((field) => [field.key, field.mayBeEmpty]),
      [["size", false]],
    );
  });

  it("offers both forms of a diamond as some_paths, every field may be empty", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        node("split"),
        form("contact"),
        form("order"),
        node("ai"),
      ],
      edges: [
        edge("trigger", "split"),
        edge("split", "contact"),
        edge("split", "order"),
        edge("contact", "ai"),
        edge("order", "ai"),
      ],
    });
    assert.deepEqual(availability(sources, "ai"), [
      ["contact", "some_paths"],
      ["order", "some_paths"],
    ]);
    assert.equal(
      sources
        .get("ai")
        ?.every((source) => source.fields.every((field) => field.mayBeEmpty)),
      true,
    );
  });

  it("offers nothing on routes that go around the form", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("order"),
        node("reminder"),
        node("typed"),
        node("after"),
      ],
      edges: [
        edge("trigger", "order"),
        edge("order", "reminder", NO_REPLY),
        edge("order", "typed", ANY_REPLY),
        edge("order", "after", "right-source"),
      ],
    });
    assert.deepEqual(availability(sources, "reminder"), []);
    assert.deepEqual(availability(sources, "typed"), []);
    assert.deepEqual(availability(sources, "after"), [["order", "always"]]);
  });

  it("marks a join the No reply route also reaches as some_paths", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("order"),
        node("reminder"),
        node("ai"),
      ],
      edges: [
        edge("trigger", "order"),
        edge("order", "ai"),
        edge("order", "reminder", NO_REPLY),
        edge("reminder", "ai"),
      ],
    });
    assert.deepEqual(availability(sources, "ai"), [["order", "some_paths"]]);
    assert.deepEqual(availability(sources, "reminder"), []);
  });

  it("treats a template's default route as some_paths and its Flow branch as always", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("order", { sender: "template" }),
        node("other"),
        node("branch"),
      ],
      edges: [
        edge("trigger", "order"),
        edge("order", "other"),
        edge("order", "branch", FLOW_BRANCH),
      ],
    });
    assert.deepEqual(availability(sources, "other"), [["order", "some_paths"]]);
    assert.deepEqual(availability(sources, "branch"), [["order", "always"]]);
  });

  it("passes a template's form only on its Form submitted route", () => {
    const template = form("order", { sender: "template" });
    const order = {
      ...template,
      data: {
        ...template.data,
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Later" },
              { type: "FLOW", text: "Fill in", flow_id: 2244981489363579 },
            ],
          },
        ],
      },
    };
    const sourcesVia = (sourceHandle: string) =>
      buildScenarioFormAnswerSourcesByNodeId({
        nodes: [
          node("trigger", "trigger"),
          order,
          carousel("carousel"),
          node("ai"),
        ],
        edges: [
          edge("trigger", "order"),
          edge("order", "carousel", sourceHandle),
          edge("carousel", "ai"),
        ],
      });

    const submitted = sourcesVia(FORM_SUBMITTED);
    assert.deepEqual(availability(submitted, "carousel"), [
      ["order", "always"],
    ]);
    assert.deepEqual(availability(submitted, "ai"), [["order", "always"]]);
    assert.deepEqual(
      submitted.get("ai")?.[0]?.fields.map((field) => field.mayBeEmpty),
      [false],
    );
    assert.deepEqual(availability(sourcesVia("right-source"), "ai"), [
      ["order", "some_paths"],
    ]);
    assert.deepEqual(availability(sourcesVia(QUICK_REPLY), "ai"), []);
  });

  it("offers a template's saved form fields after its Form submitted route", () => {
    const field = (
      responseKey: string,
      extra: Record<string, unknown> = {},
    ) => ({
      responseKey,
      label: responseKey,
      description: "",
      fieldType: "TextInput",
      required: true,
      screenIndex: 1,
      options: [],
      ...extra,
    });
    const medal = {
      id: "medal",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Choose", flow_id: 2244981489363579 },
            ],
          },
        ],
        actionWhatsAppTemplateForm: {
          version: 1,
          flowId: "2244981489363579",
          flowName: "demoshop_ai_case",
          answersKey: "demoshop_ai_case",
          digest: null,
          coverage: "complete",
          endpoint: false,
          readAt: "",
          fields: [
            field("_68d224"),
            field("other_sport", { screenIndex: 2, conditional: true }),
          ],
        },
      },
    };
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        medal,
        carousel("carousel"),
        node("ai"),
      ],
      edges: [
        edge("trigger", "medal"),
        edge("medal", "carousel", FORM_SUBMITTED),
        edge("carousel", "ai"),
      ],
    });
    const [source] = sources.get("ai") ?? [];
    assert.equal(source?.formKey, "demoshop_ai_case");
    assert.equal(source?.formLabel, "demoshop_ai_case");
    assert.equal(source?.schema, "known");
    assert.equal(source?.availability, "always");
    assert.deepEqual(
      source?.fields.map((item) => [item.key, item.mayBeEmpty]),
      [
        ["f_68d224", false],
        ["other_sport", true],
      ],
    );
  });

  it("flags a template's saved form that leaves answers out", () => {
    const medal = (coverage: string, fields: unknown[]) => ({
      id: "medal",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Choose", flow_id: 2244981489363579 },
            ],
          },
        ],
        actionWhatsAppTemplateForm: {
          version: 1,
          flowId: "2244981489363579",
          flowName: "demoshop_ai_case",
          answersKey: "demoshop_ai_case",
          digest: null,
          coverage,
          endpoint: false,
          readAt: "",
          fields,
        },
      },
    });
    const sourceAfter = (step: ReturnType<typeof medal>) =>
      buildScenarioFormAnswerSourcesByNodeId({
        nodes: [node("trigger", "trigger"), step, node("ai")],
        edges: [edge("trigger", "medal"), edge("medal", "ai", FORM_SUBMITTED)],
      }).get("ai")?.[0];

    // It lists no answer, so only the flag says the form is there.
    const partial = sourceAfter(medal("partial", []));
    assert.equal(partial?.formKey, "demoshop_ai_case");
    assert.equal(partial?.schema, "known");
    assert.equal(partial?.partial, true);
    assert.deepEqual(partial?.fields, []);

    const complete = sourceAfter(
      medal("complete", [
        {
          responseKey: "_68d224",
          label: "Athlete's name",
          fieldType: "TextInput",
          required: true,
        },
      ]),
    );
    assert.deepEqual(
      complete?.fields.map((field) => field.key),
      ["f_68d224"],
    );
    assert.equal(complete && Object.hasOwn(complete, "partial"), false);
  });

  it("marks optional fields and later data-endpoint screens as may be empty", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("order", {
          extra: { flowNavigationMode: "data_endpoint" },
          screens: [
            {
              id: "FIRST",
              title: "First",
              fields: [
                {
                  id: "name",
                  label: "Name",
                  fieldType: "TextInput",
                  required: true,
                },
                { id: "notes", label: "Notes", fieldType: "TextArea" },
              ],
            },
            {
              id: "SECOND",
              title: "Second",
              fields: [
                {
                  id: "size",
                  label: "Size",
                  fieldType: "Dropdown",
                  required: true,
                },
              ],
            },
          ],
        }),
        node("ai"),
      ],
      edges: [edge("trigger", "order"), edge("order", "ai")],
    });
    assert.deepEqual(
      sources
        .get("ai")?.[0]
        ?.fields.map((field) => [field.key, field.mayBeEmpty]),
      [
        ["name", false],
        ["notes", true],
        ["size", true],
      ],
    );
  });

  it("offers a loop body always and the steps before the form some_paths", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        node("intro"),
        form("order"),
        node("check"),
      ],
      edges: [
        edge("trigger", "intro"),
        edge("intro", "order"),
        edge("order", "check"),
        edge("check", "intro"),
      ],
    });
    assert.deepEqual(availability(sources, "check"), [["order", "always"]]);
    assert.deepEqual(availability(sources, "intro"), [["order", "some_paths"]]);
    assert.deepEqual(availability(sources, "order"), []);
  });

  it("skips unreachable forms and marks a linked Meta form's fields unknown", () => {
    const sources = buildScenarioFormAnswerSourcesByNodeId({
      nodes: [
        node("trigger", "trigger"),
        form("linked", {
          screens: [{ id: "START", title: "START", fields: [] }],
          extra: {
            providerReference: {
              flowId: "flow-1",
              sourceId: "source-1",
              wabaId: "waba-1",
              flowName: "Medal pick",
              providerStatus: "PUBLISHED",
            },
          },
        }),
        node("ai"),
        form("island"),
        node("island-next"),
      ],
      edges: [
        edge("trigger", "linked"),
        edge("linked", "ai"),
        edge("island", "island-next"),
        edge("island-next", "island"),
      ],
    });
    assert.deepEqual(
      sources
        .get("ai")
        ?.map((source) => [source.formKey, source.schema, source.formLabel]),
      [["linked", "unknown", "Medal pick"]],
    );
    assert.deepEqual(availability(sources, "island-next"), []);
  });

  it("keeps ask scope as before: the unmet route never promises the answers", () => {
    const ask = {
      id: "ask",
      data: {
        kind: "action",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Your name?" },
          },
          promptInputs: [{ key: "name", label: "Name", prompt: "Name" }],
        },
      },
    };
    const inputs = buildScenarioPromptInputsByNodeId({
      nodes: [
        node("trigger", "trigger"),
        ask,
        node("met"),
        node("unmet"),
        node("join"),
      ],
      edges: [
        edge("trigger", "ask"),
        edge("ask", "met"),
        edge("ask", "unmet", PROMPT_INPUTS_UNMET_HANDLE),
        edge("met", "join"),
        edge("unmet", "join"),
      ],
    });
    assert.deepEqual(
      inputs.get("met")?.map((field) => field.key),
      ["name"],
    );
    assert.deepEqual(inputs.get("unmet"), []);
    assert.deepEqual(inputs.get("join"), []);
  });
});
