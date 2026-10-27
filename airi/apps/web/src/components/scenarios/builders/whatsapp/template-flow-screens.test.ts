import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import type { EditableWhatsAppTemplateButton } from "./template-editor-utils";
import {
  getTemplateButtonScreens,
  getTemplateButtonUnsetScreenFlowId,
  listTemplateScreenFlowIds,
  resolveTemplateFlowScreenChoice,
  resolveTemplateFlowScreens,
  templateButtonNeedsFirstScreen,
  type TemplateFlowScreenLookup,
} from "./template-flow-screens";

const FORM_ID = "1234567890";
const checkedAt = "2026-09-29T10:00:00.000Z";

function formButton(
  overrides: Partial<EditableWhatsAppTemplateButton> = {}
): EditableWhatsAppTemplateButton {
  return {
    index: 0,
    type: "flow",
    label: "Book",
    flowId: FORM_ID,
    flowAction: "navigate",
    ...overrides,
  };
}

function found(screenIds: string[] | null): TemplateFlowFacts {
  return {
    flowId: FORM_ID,
    state: "found",
    name: "Booking",
    status: "PUBLISHED",
    screenIds,
    checkedAt,
  };
}

describe("templateButtonNeedsFirstScreen", () => {
  it.each([
    ["a navigate form button", true, formButton()],
    [
      "a form button without an action",
      true,
      formButton({ flowAction: undefined }),
    ],
    [
      "a form named by its name",
      true,
      formButton({ flowId: "", flowName: "booking" }),
    ],
    [
      "a data_exchange form button",
      false,
      formButton({ flowAction: "data_exchange" }),
    ],
    ["a form button without a form", false, formButton({ flowId: "" })],
    ["a reply button", false, { index: 0, type: "quick_reply", label: "Yes" }],
  ] as const)("%s needs a first screen: %s", (_, expected, button) => {
    expect(templateButtonNeedsFirstScreen(button)).toBe(expected);
  });
});

describe("listTemplateScreenFlowIds", () => {
  it("lists each WhatsApp form id that navigate buttons open, once", () => {
    expect(
      listTemplateScreenFlowIds([
        formButton(),
        formButton({ index: 1 }),
        formButton({ index: 2, flowId: "555", flowAction: "data_exchange" }),
        formButton({ index: 3, flowId: "draft-form" }),
        { index: 4, type: "quick_reply", label: "Yes" },
      ])
    ).toEqual([FORM_ID]);
  });
});

describe("getTemplateButtonUnsetScreenFlowId", () => {
  it("names the form only while the button has no first screen", () => {
    expect(getTemplateButtonUnsetScreenFlowId(formButton())).toBe(FORM_ID);
    expect(
      getTemplateButtonUnsetScreenFlowId(formButton({ navigateScreen: " " }))
    ).toBe(FORM_ID);
    expect(
      getTemplateButtonUnsetScreenFlowId(
        formButton({ navigateScreen: "WELCOME" })
      )
    ).toBeNull();
    expect(
      getTemplateButtonUnsetScreenFlowId(
        formButton({ flowAction: "data_exchange" })
      )
    ).toBeNull();
    expect(getTemplateButtonUnsetScreenFlowId(undefined)).toBeNull();
  });
});

describe("resolveTemplateFlowScreens", () => {
  const resolve = (
    facts: TemplateFlowFacts | undefined,
    loading = false,
    flowId = FORM_ID
  ) => resolveTemplateFlowScreens({ flowId, facts, loading });

  it("lists the form's screens once WhatsApp returned them", () => {
    expect(resolve(found(["WELCOME", "DETAILS"]), true)).toEqual({
      status: "ready",
      screenIds: ["WELCOME", "DETAILS"],
    });
  });

  it("waits while the screens load", () => {
    expect(resolve(undefined, true)).toEqual({ status: "loading" });
    expect(
      resolve({ flowId: FORM_ID, state: "unavailable", checkedAt }, true)
    ).toEqual({ status: "loading" });
  });

  it.each([
    ["the form JSON couldn't be read", found(null)],
    ["the form is gone", { flowId: FORM_ID, state: "missing", checkedAt }],
    [
      "WhatsApp didn't answer",
      { flowId: FORM_ID, state: "unavailable", checkedAt },
    ],
    ["no answer arrived", undefined],
  ] as const)("fails when %s", (_, facts) => {
    expect(resolve(facts)).toEqual({ status: "failed" });
  });

  it("has nothing to look up for ids WhatsApp doesn't use", () => {
    expect(resolve(undefined, true, "draft-form")).toEqual({
      status: "manual",
    });
  });
});

describe("resolveTemplateFlowScreenChoice", () => {
  const ready = { status: "ready", screenIds: ["WELCOME", "DETAILS"] } as const;

  it("lists the form's screens, and nothing extra for a listed screen", () => {
    expect(resolveTemplateFlowScreenChoice("DETAILS", ready)).toEqual({
      screenIds: ["WELCOME", "DETAILS"],
      unlisted: "",
      missing: false,
    });
    expect(resolveTemplateFlowScreenChoice("", ready).unlisted).toBe("");
  });

  it("marks a chosen screen the loaded form lacks as missing", () => {
    expect(resolveTemplateFlowScreenChoice("OLD", ready)).toEqual({
      screenIds: ["WELCOME", "DETAILS"],
      unlisted: "OLD",
      missing: true,
    });
  });

  it("shows the chosen screen, not yet missing, while the screens load", () => {
    expect(
      resolveTemplateFlowScreenChoice("OLD", { status: "loading" })
    ).toEqual({ screenIds: [], unlisted: "OLD", missing: false });
  });
});

describe("getTemplateButtonScreens", () => {
  it("asks the lookup by the trimmed form id, and is manual without one", () => {
    const lookup: TemplateFlowScreenLookup = {
      screensFor: jest.fn(() => ({ status: "loading" }) as const),
      isRefreshing: jest.fn(() => false),
      refresh: jest.fn(),
    };
    expect(
      getTemplateButtonScreens(formButton({ flowId: ` ${FORM_ID} ` }), lookup)
    ).toEqual({ status: "loading" });
    expect(lookup.screensFor).toHaveBeenCalledWith(FORM_ID);
    expect(getTemplateButtonScreens(formButton(), undefined)).toEqual({
      status: "manual",
    });
  });
});
