/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import type {
  ScenarioInstagramConfig,
  ScenarioReplyMode,
} from "@/components/scenarios/types";
import { INSTAGRAM_QUICK_REPLY_MAX_COUNT } from "@/lib/scenarios/instagram-reply-config";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { InstagramReplyBuilder } from "./index";

// Default content goes into the scenario, so it gets short stand-in values.
const mockDefaultContent: Record<string, string> = {
  instagramDefaultOption: "Opt",
  instagramDefaultButton: "Btn",
  instagramDefaultCard: "Card",
  instagramDefaultCardButton: "Choose",
};

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      mockDefaultContent[key] !== undefined
        ? `${mockDefaultContent[key]}${values?.n ?? ""}`
        : key,
}));

const initialConfig: ScenarioInstagramConfig = {
  kind: "quick_replies",
  quickReplies: [{ title: "Sales", payload: "sales" }],
};

function renderBuilder({
  config = initialConfig,
  onConfigChange = jest.fn(),
  onBranchOptionsChanged = jest.fn(),
  onInsertToken,
  replyMode = "fixed",
  disabled = false,
}: {
  config?: ScenarioInstagramConfig;
  onConfigChange?: jest.Mock;
  onBranchOptionsChanged?: jest.Mock;
  onInsertToken?: jest.Mock;
  replyMode?: ScenarioReplyMode;
  disabled?: boolean;
} = {}) {
  function Harness() {
    const [currentConfig, setCurrentConfig] = useState(config);

    return (
      <InstagramReplyBuilder
        config={currentConfig}
        disabled={disabled}
        replyMode={replyMode}
        messageText="Pick a team"
        instructionText=""
        onMessageTextChange={() => {}}
        onInstructionTextChange={() => {}}
        onInsertToken={onInsertToken}
        onConfigChange={next => {
          setCurrentConfig(next);
          onConfigChange(next);
        }}
        onBranchOptionsChanged={onBranchOptionsChanged}
      />
    );
  }

  render(<Harness />);

  return { onConfigChange, onBranchOptionsChanged };
}

describe("InstagramReplyBuilder", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: unknown;
    releasePointerCapture?: unknown;
  };
  const originalPointerCapture = {
    hasPointerCapture: elementPrototype.hasPointerCapture,
    releasePointerCapture: elementPrototype.releasePointerCapture,
  };
  beforeAll(() => {
    // Radix Select uses pointer capture, which jsdom omits.
    HTMLElement.prototype.scrollIntoView = jest.fn();
    elementPrototype.hasPointerCapture = () => false;
    elementPrototype.releasePointerCapture = () => {};
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.assign(elementPrototype, originalPointerCapture);
  });

  it("does not repeat the Instagram label above the message preview", () => {
    renderBuilder();

    expect(screen.queryByText("Instagram")).toBeNull();
  });

  it("shows no fake chat header, customer bubble or repeated option chips", () => {
    renderBuilder();

    expect(screen.queryByText("Airi")).toBeNull();
    expect(screen.queryByText("active now")).toBeNull();
    expect(screen.queryByText("Hi, I need details")).toBeNull();
    // The option shows once in the preview and once as its input.
    expect(screen.getAllByText("Sales")).toHaveLength(1);
    expect(screen.getByDisplayValue("Sales")).toBeTruthy();
  });

  it("renders preview chips as text, not buttons", () => {
    renderBuilder();

    const chip = screen.getByText("Sales");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.closest("button")).toBeNull();
    expect(
      within(chip).getByRole("img", { name: "sourceHandleStatusUnlinked" })
    ).toBeTruthy();
  });

  it("defers branch sync while a quick reply label is being typed", () => {
    const { onConfigChange, onBranchOptionsChanged } = renderBuilder();

    fireEvent.change(screen.getByDisplayValue("Sales"), {
      target: { value: "Support" },
    });

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quickReplies: [expect.objectContaining({ title: "Support" })],
      })
    );
    expect(onBranchOptionsChanged).not.toHaveBeenCalled();

    fireEvent.blur(screen.getByDisplayValue("Support"));

    expect(onBranchOptionsChanged).toHaveBeenCalledTimes(1);
    expect(onBranchOptionsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quickReplies: [expect.objectContaining({ title: "Support" })],
      })
    );
  });

  it("keeps a typed space until the field loses focus", () => {
    const { onConfigChange } = renderBuilder();
    const input = screen.getByRole("textbox", {
      name: "instagramInputLabelOption",
    });

    fireEvent.change(input, { target: { value: "Sales " } });
    expect(input).toHaveProperty("value", "Sales ");
    // The stored title is already trimmed, so nothing new is saved.
    expect(onConfigChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Sales team" } });
    expect(input).toHaveProperty("value", "Sales team");
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quickReplies: [{ title: "Sales team", payload: "sales" }],
      })
    );

    fireEvent.change(input, { target: { value: "Sales team " } });
    fireEvent.blur(input);
    expect(input).toHaveProperty("value", "Sales team");
  });

  it("keeps a cleared option on screen while its new title is typed", () => {
    const { onConfigChange, onBranchOptionsChanged } = renderBuilder();
    const input = screen.getByRole("textbox", {
      name: "instagramInputLabelOption",
    });

    fireEvent.change(input, { target: { value: "" } });
    expect(
      screen.getByRole("textbox", { name: "instagramInputLabelOption" })
    ).toBe(input);

    fireEvent.change(input, { target: { value: "Support" } });
    fireEvent.blur(input);

    // The option keeps its payload, so its route survives the rename.
    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "quick_replies",
      quickReplies: [{ title: "Support", payload: "sales" }],
    });
    expect(onBranchOptionsChanged).toHaveBeenLastCalledWith({
      kind: "quick_replies",
      quickReplies: [{ title: "Support", payload: "sales" }],
    });
  });

  it("drops an option left empty once the field loses focus", () => {
    const { onConfigChange } = renderBuilder();
    const input = screen.getByRole("textbox", {
      name: "instagramInputLabelOption",
    });

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "quick_replies",
      quickReplies: [],
    });
    expect(
      screen.queryByRole("textbox", { name: "instagramInputLabelOption" })
    ).toBeNull();
  });

  it("hides internal ids for quick replies and reply buttons", () => {
    renderBuilder();
    expect(screen.queryByDisplayValue("sales")).toBeNull();
  });

  async function switchFirstButtonToLink(
    user: ReturnType<typeof userEvent.setup>
  ) {
    await user.click(
      screen.getByRole("combobox", { name: "instagramInputLabelButtonType" })
    );
    await user.click(
      screen.getByRole("option", { name: "whatsappServiceActionWebsite" })
    );
    return screen.getByRole("textbox", { name: "instagramInputLabelLink" });
  }

  const pricingButtonConfig: ScenarioInstagramConfig = {
    kind: "button_template",
    buttons: [{ type: "postback", title: "Pricing", payload: "pricing" }],
  };

  it("keeps a button switched to Link while its text and link are typed", async () => {
    const user = userEvent.setup();
    const { onConfigChange } = renderBuilder({ config: pricingButtonConfig });
    expect(screen.queryByDisplayValue("pricing")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "instagramInputLabelLink" })
    ).toBeNull();

    const link = await switchFirstButtonToLink(user);
    expect(link).toHaveProperty("placeholder", "instagramPlaceholderLink");
    await waitFor(() => expect(link).toHaveFocus());
    expect(screen.queryByText("instagramLinkInvalid")).toBeNull();

    // Regression: leaving the text field for the link field kept only what
    // was stored, and a Link button without its link isn't stored.
    const title = screen.getByRole("textbox", { name: "buttonText" });
    await user.click(title);
    await user.type(title, " plan");
    await user.click(link);
    await user.type(link, "https://shop.example");

    expect(screen.getByDisplayValue("Pricing plan")).toBeTruthy();
    expect(screen.getByDisplayValue("https://shop.example")).toBeTruthy();
    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "button_template",
      buttons: [
        {
          type: "web_url",
          title: "Pricing plan",
          url: "https://shop.example/",
        },
      ],
    });
    // Typing both fields key by key outlasts the default under a full run.
  }, 15_000);

  it("keeps a Link button without a valid link and says why", async () => {
    const user = userEvent.setup();
    const { onConfigChange } = renderBuilder({ config: pricingButtonConfig });

    const link = await switchFirstButtonToLink(user);
    await waitFor(() => expect(link).toHaveFocus());
    fireEvent.change(link, { target: { value: "shop.example.com" } });
    fireEvent.blur(link);

    // Storage can't hold it, so the button stays on screen with the fix.
    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "button_template",
      buttons: [],
    });
    expect(screen.getByDisplayValue("Pricing")).toBeTruthy();
    expect(link).toHaveProperty("value", "shop.example.com");
    expect(link.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("instagramLinkInvalid");
    expect(link.getAttribute("aria-describedby")).toBe(error.id);

    fireEvent.focus(link);
    fireEvent.change(link, { target: { value: "https://shop.example.com" } });
    fireEvent.blur(link);

    expect(screen.queryByText("instagramLinkInvalid")).toBeNull();
    expect(link.getAttribute("aria-invalid")).toBeNull();
    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "button_template",
      buttons: [
        { type: "web_url", title: "Pricing", url: "https://shop.example.com/" },
      ],
    });
  });

  it("says a Link button needs its link when focus leaves it empty", async () => {
    const user = userEvent.setup();
    renderBuilder({ config: pricingButtonConfig });

    const link = await switchFirstButtonToLink(user);
    await waitFor(() => expect(link).toHaveFocus());
    fireEvent.blur(link);

    expect(screen.getByDisplayValue("Pricing")).toBeTruthy();
    expect(screen.getByText("instagramLinkInvalid")).toBeTruthy();
  });

  it("keeps an emptied option while focus moves to another option", async () => {
    const user = userEvent.setup();
    const { onConfigChange } = renderBuilder({
      config: {
        kind: "quick_replies",
        quickReplies: [
          { title: "Sales", payload: "sales" },
          { title: "Support", payload: "support" },
        ],
      },
    });
    const [first, second] = screen.getAllByRole("textbox", {
      name: "instagramInputLabelOption",
    });

    await user.clear(first);
    await user.click(second);

    expect(
      screen.getAllByRole("textbox", { name: "instagramInputLabelOption" })
    ).toHaveLength(2);
    expect(second).toHaveFocus();

    fireEvent.blur(second);

    expect(
      screen.getAllByRole("textbox", { name: "instagramInputLabelOption" })
    ).toHaveLength(1);
    expect(onConfigChange).toHaveBeenLastCalledWith({
      kind: "quick_replies",
      quickReplies: [{ title: "Support", payload: "support" }],
    });
  });

  it("keeps the next option's field when an earlier option is removed", () => {
    renderBuilder({
      config: {
        kind: "quick_replies",
        quickReplies: [
          { title: "Sales", payload: "sales" },
          { title: "Support", payload: "support" },
        ],
      },
    });
    const support = screen.getByDisplayValue("Support");

    fireEvent.click(
      screen.getAllByRole("button", { name: "instagramRemoveOption" })[0]
    );

    // The row keeps its input instead of reusing the removed row's one.
    expect(support).toBeInTheDocument();
    expect(support).toHaveValue("Support");
    expect(screen.queryByDisplayValue("Sales")).toBeNull();
  });

  it("keeps the next button's fields when an earlier button is removed", () => {
    renderBuilder({
      config: {
        kind: "button_template",
        buttons: [
          { type: "postback", title: "Pricing", payload: "pricing" },
          { type: "web_url", title: "Shop", url: "https://shop.example/" },
        ],
      },
    });
    const shop = screen.getByDisplayValue("Shop");
    const link = screen.getByRole("textbox", {
      name: "instagramInputLabelLink",
    });

    fireEvent.click(
      screen.getAllByRole("button", { name: "instagramRemoveButton" })[0]
    );

    expect(shop).toBeInTheDocument();
    expect(link).toBeInTheDocument();
    expect(link).toHaveValue("https://shop.example/");
    expect(screen.queryByDisplayValue("Pricing")).toBeNull();
  });

  it("writes localized default content", () => {
    const { onConfigChange } = renderBuilder();

    fireEvent.click(screen.getByRole("button", { name: "instagramAddOption" }));
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quickReplies: [
          { title: "Sales", payload: "sales" },
          expect.objectContaining({ title: "Opt2" }),
        ],
      })
    );

    fireEvent.click(screen.getByRole("radio", { name: "instagramTypeCards" }));
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "generic_template",
        cards: [
          expect.objectContaining({
            title: "Card1",
            buttons: [expect.objectContaining({ title: "Choose" })],
          }),
        ],
      })
    );
  });

  it("chooses the message type from a single-choice group", () => {
    renderBuilder();

    const group = screen.getByRole("group", { name: "instagramTypeLabel" });
    const quickReplies = within(group).getByRole("radio", {
      name: "instagramTypeQuickReplies",
    });
    expect(quickReplies.getAttribute("aria-checked")).toBe("true");
    expect(
      within(group)
        .getByRole("radio", { name: "instagramTypeMedia" })
        .getAttribute("aria-checked")
    ).toBe("false");

    fireEvent.click(
      within(group).getByRole("radio", { name: "instagramTypeMedia" })
    );
    expect(
      screen.getByRole("combobox", { name: "instagramInputLabelMediaType" })
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "instagramInputLabelMediaLink" })
    ).toBeTruthy();
  });

  it("disables adding options at the limit and says why", () => {
    renderBuilder({
      config: {
        kind: "quick_replies",
        quickReplies: Array.from(
          { length: INSTAGRAM_QUICK_REPLY_MAX_COUNT },
          (_, index) => ({ title: `Option ${index}`, payload: `o${index}` })
        ),
      },
    });

    const add = screen.getByRole("button", { name: "instagramAddOption" });
    expect(add).toHaveProperty("disabled", true);
    const limit = screen.getByText("instagramLimitOptions");
    expect(add.getAttribute("aria-describedby")).toBe(limit.id);
    expect(
      screen.getAllByRole("button", { name: "instagramRemoveOption" })
    ).toHaveLength(INSTAGRAM_QUICK_REPLY_MAX_COUNT);
  });

  it("chooses who writes the message with the shared toggle", () => {
    const onInsertToken = jest.fn();
    renderBuilder({ onInsertToken });

    expect(
      screen
        .getByRole("radio", { name: "replyModeFixed" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toBeTruthy();
    // Regression: fixed Instagram text still offers Variables.
    expect(
      screen.getByTestId("whatsapp-service-message-variables")
    ).toBeTruthy();
  });

  it("shows what AI writes instead of a draft bubble", () => {
    renderBuilder({ replyMode: "ai", onInsertToken: jest.fn() });

    expect(screen.getByText("whatsappServiceAiPreview")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "whatsappServiceAiInstructions" })
    ).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-service-message-variables")).toBe(
      null
    );
  });

  it("locks every control when a bulk send disables the step", () => {
    renderBuilder({ disabled: true });

    expect(screen.getByRole("radio", { name: "replyModeAi" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "instagramInputLabelOption" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "instagramAddOption" })
    ).toBeDisabled();
    expect(screen.queryByTestId("whatsapp-service-message-variables")).toBe(
      null
    );
  });
});
