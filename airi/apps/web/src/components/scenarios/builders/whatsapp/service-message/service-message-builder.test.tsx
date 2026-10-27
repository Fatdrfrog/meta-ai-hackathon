/**
 * @jest-environment jsdom
 */

import type { ScenarioWhatsAppServiceMessage } from "@icecore/scenario-contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState, type ComponentProps, type ReactNode } from "react";
import { TextEncoder } from "util";
import { ScenarioGraphUndoContext } from "../../../view/graph/undo-context";
import { WhatsAppServiceMessageBuilder } from "./index";

global.TextEncoder = TextEncoder as unknown as typeof global.TextEncoder;

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  useTranslations: () => (key: string) => key,
}));

const mockToast = jest.fn();
jest.mock("sonner", () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/components/ui/popover", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  // Content always renders; a trigger click still reports "open" to its owner.
  const OpenContext = React.createContext<(open: boolean) => void>(() => {});
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <OpenContext.Provider value={next => onOpenChange?.(next)}>
        <div data-open={open ? "true" : "false"}>{children}</div>
      </OpenContext.Provider>
    ),
    PopoverTrigger: function MockPopoverTrigger({
      children,
      asChild,
    }: {
      children?: React.ReactNode;
      asChild?: boolean;
    }) {
      const setOpen = React.useContext(OpenContext);
      if (
        asChild &&
        React.isValidElement<{ onClick?: (event: unknown) => void }>(children)
      ) {
        return React.cloneElement(children, {
          onClick: (event: unknown) => {
            children.props.onClick?.(event);
            setOpen(true);
          },
        });
      }
      return (
        <button type="button" onClick={() => setOpen(true)}>
          {children}
        </button>
      );
    },
    PopoverContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="service-message-variables-menu">{children}</div>
    ),
  };
});

jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const SelectContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children?: ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange }}>
        <select
          data-testid="service-message-select"
          value={value}
          onChange={event => onValueChange?.(event.target.value)}
        >
          {children}
        </select>
      </SelectContext.Provider>
    ),
    SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
    SelectItem: ({
      value,
      children,
      disabled,
    }: {
      value: string;
      children?: ReactNode;
      disabled?: boolean;
    }) => (
      <option value={value} disabled={disabled}>
        {children}
      </option>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

// The picker has its own tests; these check what the builder inserts.
jest.mock("@/components/scenarios/view/scenario-variable-inserter", () => ({
  ...jest.requireActual(
    "@/components/scenarios/view/scenario-variable-inserter"
  ),
  ScenarioVariableInserter: ({
    t,
    extraFields = [],
    onInsertToken,
  }: {
    t: (key: string) => string;
    extraFields?: Array<{ token: string }>;
    onInsertToken: (token: string) => void;
  }) => (
    <div>
      <button type="button" data-testid="whatsapp-service-message-variables">
        {t("variables")}
      </button>
      {["customer_name", ...extraFields.map(field => field.token)].map(
        token => (
          <button
            key={token}
            type="button"
            data-testid={`service-message-variable-${token}`}
            onClick={() => onInsertToken(token)}
          >
            {token}
          </button>
        )
      )}
    </div>
  ),
}));

jest.mock("../action-renderer", () => ({
  WhatsAppActionRenderer: ({
    bodyText,
    onBodyTextChange,
    bodyError,
    buttons = [],
    bodyTopAction,
    headerMediaEditor,
    headerText,
    headerPlaceholder,
    onHeaderTextChange,
    buttonEditor,
    bubbleTrailingContent,
    editorTray,
    statusBarAction,
    footerText,
    onFooterTextChange,
    footerPlaceholder,
  }: {
    bodyText?: string;
    onBodyTextChange?: (value: string) => void;
    bodyError?: string;
    buttons?: Array<{
      key?: string;
      label: string;
      onLabelChange?: (value: string) => void;
      rowActions?: ReactNode;
    }>;
    bodyTopAction?: ReactNode;
    headerMediaEditor?: ReactNode;
    headerText?: string;
    headerPlaceholder?: string;
    onHeaderTextChange?: (value: string) => void;
    buttonEditor?: ReactNode;
    bubbleTrailingContent?: ReactNode;
    editorTray?: ReactNode;
    statusBarAction?: ReactNode;
    footerText?: string;
    onFooterTextChange?: (value: string) => void;
    footerPlaceholder?: string;
  }) => (
    <div data-testid="service-message-preview">
      {statusBarAction}
      {bodyTopAction}
      {headerMediaEditor}
      {onHeaderTextChange ? (
        <input
          aria-label="service-message-header"
          value={headerText || ""}
          placeholder={headerPlaceholder}
          onChange={event => onHeaderTextChange(event.target.value)}
        />
      ) : null}
      <textarea
        aria-label="service-message-body"
        value={bodyText || ""}
        onChange={event => onBodyTextChange?.(event.target.value)}
      />
      {bodyError ? <p>{bodyError}</p> : null}
      {onFooterTextChange ? (
        <input
          aria-label="service-message-footer"
          value={footerText || ""}
          placeholder={footerPlaceholder}
          onChange={event => onFooterTextChange(event.target.value)}
        />
      ) : null}
      {buttons.map((button, index) => (
        <div key={button.key || index}>
          <input
            aria-label={`choice-${index + 1}`}
            value={button.label}
            onChange={event => button.onLabelChange?.(event.target.value)}
          />
          {button.rowActions}
        </div>
      ))}
      {buttonEditor}
      {bubbleTrailingContent}
      {editorTray ? (
        <div data-testid="whatsapp-action-editor-tray">{editorTray}</div>
      ) : null}
    </div>
  ),
}));

const mockResources = {
  loading: false,
  failed: false,
  failedResources: { signupLinks: false, calling: false, catalog: false },
  retry: jest.fn(),
  signupLinks: [] as Array<{
    id: string;
    metaSignupId: string;
    deepLinkUrl: string;
    displayName?: string;
    status: string;
  }>,
  callingReady: true,
  catalogs: [{ id: "catalog-secret", name: "Summer catalog" }],
  products: [
    { retailer_id: "product-secret-1", name: "Notebook" },
    { retailer_id: "product-secret-2", name: "Backpack" },
  ],
};

jest.mock("./service-message-resources", () => ({
  ...jest.requireActual("./service-message-resources"),
  useWhatsAppServiceMessageResources: () => mockResources,
}));

function renderBuilder(
  initialValue: ScenarioWhatsAppServiceMessage,
  options: {
    history?: () => boolean;
    upload?: jest.Mock;
    renderOptionBranchHandle?: (
      option: {
        id: string;
        label: string;
      },
      layout?: { local?: boolean }
    ) => ReactNode;
    onOpenFlowEditor?: () => void;
    onBranchHandleViewportChange?: () => void;
    hasWhatsAppCoexistence?: boolean;
    validationMode?: "draft" | "runnable";
    promptInputFields?: Array<{
      token: string;
      label: string;
      description: string;
    }>;
    formAnswerSources?: ComponentProps<
      typeof WhatsAppServiceMessageBuilder
    >["formAnswerSources"];
  } = {}
) {
  const changes: ScenarioWhatsAppServiceMessage[] = [];

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <WhatsAppServiceMessageBuilder
        actionNodeId="action-1"
        value={value}
        workspaceId="workspace-1"
        promptInputFields={options.promptInputFields}
        formAnswerSources={options.formAnswerSources}
        upload={options.upload}
        renderOptionBranchHandle={options.renderOptionBranchHandle}
        onOpenFlowEditor={options.onOpenFlowEditor}
        onBranchHandleViewportChange={options.onBranchHandleViewportChange}
        hasWhatsAppCoexistence={options.hasWhatsAppCoexistence}
        validationMode={options.validationMode}
        onChange={next => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }

  render(
    <ScenarioGraphUndoContext.Provider value={options.history}>
      <Harness />
    </ScenarioGraphUndoContext.Provider>
  );
  return { changes };
}

/** Confirms a pending type change ("continue") or button removal ("delete"). */
function confirmActionChange() {
  const confirm =
    screen.queryByRole("button", { name: "continue" }) ??
    screen.queryByRole("button", { name: "delete" });
  if (confirm) fireEvent.click(confirm);
}

describe("WhatsAppServiceMessageBuilder", () => {
  // The Variables menu is a cmdk list inside a Radix popover.
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    HTMLElement.prototype.scrollIntoView ??= jest.fn();
  });

  it("keeps AI instructions separate and restores both mode drafts", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Customer text" } },
    });
    fireEvent.click(screen.getByRole("radio", { name: "replyModeAi" }));
    expect(changes.at(-1)?.message).toMatchObject({
      body: { mode: "ai", instruction: "" },
    });
    fireEvent.change(screen.getByLabelText(/whatsappServiceAiInstructions/), {
      target: { value: "Ask for an address" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "replyModeFixed" }));
    expect(changes.at(-1)?.message).toMatchObject({
      body: { mode: "fixed", text: "Customer text" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "replyModeAi" }));
    expect(changes.at(-1)?.message).toMatchObject({
      body: { mode: "ai", instruction: "Ask for an address" },
    });
  });

  it("leaves a reply action intact when a type change is cancelled", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "back", label: "Back" }],
      },
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    expect(changes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(changes).toHaveLength(0);
    expect(screen.getByLabelText("choice-1")).toHaveValue("Back");
  });

  it("renders exactly one editor and routing control per list choice", () => {
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "list",
          body: { mode: "fixed", text: "Choose" },
          buttonLabel: "Options",
          sections: [
            {
              id: "section",
              rows: [
                { id: "back", title: "Back" },
                { id: "next", title: "Next" },
              ],
            },
          ],
        },
      },
      {
        renderOptionBranchHandle: option => (
          <button data-testid={"route-" + option.id}>{option.label}</button>
        ),
      }
    );
    expect(screen.getAllByTestId("route-back")).toHaveLength(1);
    expect(screen.getAllByTestId("route-next")).toHaveLength(1);
    expect(screen.getAllByDisplayValue("Back")).toHaveLength(1);
  });

  it("labels invalid coordinates and focuses the first field", () => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    renderBuilder({
      version: 1,
      message: {
        kind: "location",
        location: { version: 1, latitude: "999", longitude: "999" },
      },
    });
    const latitude = screen.getByLabelText("whatsappLocationLatitudeLabel");
    expect(latitude).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(latitude).toHaveFocus();
  });
  const uploadedImage = {
    url: "https://cdn.example/new.png",
    mediaType: "image" as const,
  };

  it("preserves edits made while an attachment is uploading", async () => {
    let finish!: (value: typeof uploadedImage) => void;
    const upload = jest.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Before" },
          options: [{ id: "one", label: "Choice" }],
        },
      },
      { upload }
    );
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["image"], "new.png", { type: "image/png" })],
      },
    });
    fireEvent.change(screen.getByLabelText("service-message-body"), {
      target: { value: "Latest text" },
    });
    fireEvent.change(screen.getByLabelText("choice-1"), {
      target: { value: "Latest choice" },
    });
    await act(async () => {
      finish(uploadedImage);
    });
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      body: { text: "Latest text" },
      options: [{ label: "Latest choice" }],
      header: { attachment: uploadedImage },
    });
  });

  it("discards a pending attachment after switching the action type", async () => {
    let finish!: (value: typeof uploadedImage) => void;
    const upload = jest.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Before" },
          options: [{ id: "one", label: "Choice" }],
        },
      },
      { upload }
    );
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["image"], "new.png", { type: "image/png" })],
      },
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    confirmActionChange();
    await act(async () => {
      finish(uploadedImage);
    });
    expect(changes.at(-1)?.message.kind).toBe("cta_url");
    expect(changes.at(-1)?.message).not.toHaveProperty("header.attachment");
  });

  it("offers voice-note delivery only once an audio file is attached", async () => {
    const upload = jest.fn().mockResolvedValue({
      url: "https://cdn.example/voice.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    });
    const { changes } = renderBuilder(
      {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
      { upload }
    );
    expect(
      screen.queryByRole("radio", {
        name: "whatsappServiceMediaVoiceNoteBadge",
      })
    ).toBeNull();
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["audio"], "voice.ogg", { type: "audio/ogg" })],
      },
    });
    await waitFor(() =>
      expect(changes.at(-1)?.message).toMatchObject({ kind: "media" })
    );
    expect(
      screen.getByText("whatsappServiceMediaAudioDeliveryLabel")
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("radio", { name: "whatsappServiceMediaVoiceNoteBadge" })
    );
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "media",
      deliverAsVoice: true,
    });
  });

  it("puts Your text / AI writes and Variables in one toolbar above the bubble", () => {
    renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
    });
    const group = screen.getByRole("group", { name: "actionReplyModeLabel" });
    expect(
      within(group).getByRole("radio", { name: "replyModeFixed" })
    ).toHaveAttribute("aria-checked", "true");
    const variables = screen.getByRole("button", { name: "variables" });
    expect(group.parentElement).toContainElement(variables);
    expect(screen.getByTestId("service-message-preview")).not.toContainElement(
      variables
    );
  });

  it("shows only supported fields on a text draft", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "" },
      },
    });

    expect(screen.getByTestId("whatsapp-service-media-add-zone")).toBeTruthy();
    expect(screen.queryByLabelText("service-message-header")).toBeNull();
    expect(screen.queryByLabelText("service-message-footer")).toBeNull();
  });

  it("lets authors insert scenario variables into fixed body text", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Hello" },
      },
    });

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
    fireEvent.click(
      screen.getByTestId("service-message-variable-customer_name")
    );

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "Hello {{customer_name}}" },
    });
  });

  it("offers no form answers to a fixed body", () => {
    renderBuilder(
      {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
      {
        promptInputFields: [
          { token: "input.name", label: "Name", description: "Your name" },
        ],
        formAnswerSources: [
          {
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
          },
        ],
      }
    );

    // The mocked picker lists every field it is given.
    expect(
      screen.queryByTestId("service-message-variable-form.order.size")
    ).toBeNull();
    expect(
      screen.getByTestId("service-message-variable-input.name")
    ).toBeTruthy();
  });

  it("offers answers collected earlier in the body variables", () => {
    const { changes } = renderBuilder(
      {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
      {
        promptInputFields: [
          {
            token: "input.name",
            label: "Name",
            description: "Name on the holder",
          },
        ],
      }
    );

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
    fireEvent.click(screen.getByTestId("service-message-variable-input.name"));

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "Hello {{input.name}}" },
    });
  });

  it("hides media and bubble actions in carousel mode and keeps type switcher", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Pick a card" },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceMediaCarousel" })
    );
    confirmActionChange();

    expect(changes.at(-1)?.message.kind).toBe("media_carousel");
    expect(changes).toHaveLength(1);
    expect(
      screen.getAllByTestId("whatsapp-service-media-add-zone")
    ).toHaveLength(2);
    expect(screen.queryByLabelText("service-message-header")).toBeNull();
    expect(screen.queryByLabelText("service-message-footer")).toBeNull();
    expect(screen.getByTestId("whatsapp-service-button-editor")).toBeTruthy();
  });

  it("switches bottom action type from the shared action menu", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "wsc:action-1:one", label: "One" }],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceChangeButtonType" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    confirmActionChange();

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "cta_url",
      buttonLabel: "One",
    });
  });

  it("keeps Contact and Location share/request in the action switcher menu", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "wsc:action-1:one", label: "One" }],
      },
    });

    expect(
      screen.getByRole("menuitem", {
        name: "whatsappServiceActionShareContact",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "whatsappServiceActionRequestContact",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "whatsappServiceActionShareLocation",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "whatsappServiceActionRequestLocation",
      })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "whatsappServiceActionShareContact",
      })
    );
    confirmActionChange();
    expect(changes.at(-1)?.message.kind).toBe("contacts");
  });

  it("seeds a reply draft when picking reply buttons from text", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Choose" },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionReplyButton" })
    );
    confirmActionChange();

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      options: [{ id: expect.stringMatching(/^wsc:action-1:/), label: "" }],
    });
    expect(screen.getByLabelText("choice-1")).toBeTruthy();
  });

  it("restores a reply draft after carousel and after website", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Choose" },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceMediaCarousel" })
    );
    confirmActionChange();
    expect(changes.at(-1)?.message.kind).toBe("media_carousel");

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceChangeButtonType" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionReplyButton" })
    );
    confirmActionChange();
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      options: [{ label: "" }],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceChangeButtonType" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    confirmActionChange();
    fireEvent.change(screen.getByLabelText("buttonText"), {
      target: { value: "Shop" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceChangeButtonType" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionReplyButton" })
    );
    confirmActionChange();

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      options: [{ label: "" }],
    });
  });

  it("keeps a single website trash and nests URL fields in the action grid", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: "Go" },
        buttonLabel: "Open",
        urlSource: { kind: "fixed", url: "https://example.com" },
      },
    });

    expect(
      screen.getAllByRole("button", { name: "whatsappServiceRemoveAction" })
    ).toHaveLength(1);
    expect(screen.getByTestId("whatsapp-service-cta-url-fields")).toBeTruthy();
    expect(
      screen.getByLabelText("whatsappServiceWebsiteLinkLabel")
    ).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-action-editor-tray")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "whatsappServiceAddReplyButton" })
    ).toBeNull();
  });

  it("surfaces website validation when the URL is incomplete", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: "Go" },
        buttonLabel: "Open",
        urlSource: { kind: "fixed", url: "" },
      },
    });

    expect(
      screen.getByTestId("whatsapp-service-message-validation")
    ).toBeTruthy();
    expect(
      screen.getByTestId("whatsapp-service-message-validation").textContent
    ).toContain("whatsappServiceValidationIssueCount");
    // The error shows once, under its field; there is no second list.
    expect(
      screen.getAllByText("whatsappServiceValidationUrlInvalid")
    ).toHaveLength(1);
  });

  it("keeps incomplete draft fields editable without runnable diagnostics", () => {
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "cta_url",
          body: { mode: "fixed", text: "" },
          buttonLabel: "",
          urlSource: { kind: "fixed", url: "" },
        },
      },
      { validationMode: "draft" }
    );

    expect(
      screen.queryByTestId("whatsapp-service-message-validation")
    ).toBeNull();
    expect(
      screen.queryByText("whatsappServiceValidationUrlInvalid")
    ).toBeNull();
    const input = screen.getByLabelText("whatsappServiceWebsiteLinkLabel");
    fireEvent.change(input, { target: { value: "https://" } });
    expect(changes.at(-1)?.message).toMatchObject({
      urlSource: { kind: "fixed", url: "https://" },
    });
    expect(
      screen.queryByTestId("whatsapp-service-message-validation")
    ).toBeNull();
  });

  it("reveals required text only after publication is attempted and clears it after correction", () => {
    const empty: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "" } },
    };
    const onChange = jest.fn();
    const view = render(
      <WhatsAppServiceMessageBuilder
        actionNodeId="action-1"
        value={empty}
        workspaceId="workspace-1"
        validationMode="draft"
        onChange={onChange}
      />
    );
    expect(
      screen.queryByTestId("whatsapp-service-message-validation")
    ).toBeNull();
    view.rerender(
      <WhatsAppServiceMessageBuilder
        actionNodeId="action-1"
        value={empty}
        workspaceId="workspace-1"
        validationMode="runnable"
        onChange={onChange}
      />
    );
    expect(
      screen.getByTestId("whatsapp-service-message-validation")
    ).toBeTruthy();
    expect(
      screen.getAllByText("whatsappServiceValidationBodyRequired").length
    ).toBeGreaterThan(0);
    view.rerender(
      <WhatsAppServiceMessageBuilder
        actionNodeId="action-1"
        value={{
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
        }}
        workspaceId="workspace-1"
        validationMode="runnable"
        onChange={onChange}
      />
    );
    expect(
      screen.queryByTestId("whatsapp-service-message-validation")
    ).toBeNull();
  });

  it("keeps flow editing out of the bubble tray and opens via CTA row", () => {
    const onOpenFlowEditor = jest.fn();
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Start" },
          flowConfig: {
            templateId: "lead_generation",
            screens: [],
            ctaText: "Get Started",
          },
        },
      },
      { onOpenFlowEditor }
    );

    expect(screen.queryByTestId("whatsapp-action-editor-tray")).toBeNull();
    // Form answers already appear in Variables; no permanent hint repeats it.
    expect(screen.queryByTestId("whatsapp-flow-prompt-inputs-hint")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "whatsappServiceRemoveAction" })
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );
    expect(onOpenFlowEditor).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("choice-1"), {
      target: { value: "Continue" },
    });
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "flow",
      flowConfig: { ctaText: "Continue" },
    });
  });

  it("opens the flow editor when Flow is selected", () => {
    const onOpenFlowEditor = jest.fn();
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Hi" },
        },
      },
      { onOpenFlowEditor }
    );

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionFlow" })
    );
    confirmActionChange();
    expect(onOpenFlowEditor).toHaveBeenCalled();
  });

  it("does not render an empty grey editor tray for reply buttons", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "wsc:action-1:one", label: "One" }],
      },
    });

    expect(screen.queryByTestId("whatsapp-action-editor-tray")).toBeNull();
    expect(
      screen.getByRole("button", { name: "whatsappServiceAddReplyButton" })
    ).toBeVisible();
  });

  it("edits the body in the WhatsApp surface and uses compact fixed/AI controls", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Choose one" },
      },
    });

    expect(screen.queryByLabelText("whatsappServiceFormatLabel")).toBeNull();
    fireEvent.change(screen.getByLabelText("service-message-body"), {
      target: { value: "Updated" },
    });
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "Updated" },
    });

    fireEvent.click(screen.getByRole("radio", { name: "replyModeAi" }));
    expect(changes.at(-1)?.message).toMatchObject({
      body: { mode: "ai", instruction: "" },
    });
  });

  it("stops delete pointer events from reaching the graph parent", () => {
    const onParentPointerDown = jest.fn();
    render(
      <div onPointerDown={onParentPointerDown}>
        <WhatsAppServiceMessageBuilder
          actionNodeId="action-1"
          value={{
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "wsc:action-1:one", label: "One" }],
            },
          }}
          workspaceId="workspace-1"
          onChange={() => undefined}
        />
      </div>
    );

    fireEvent.pointerDown(
      screen.getAllByRole("button", { name: "whatsappServiceRemoveAction" })[0]!
    );
    expect(onParentPointerDown).not.toHaveBeenCalled();
  });

  it("does not offer a header that would create an unexpected reply button", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Hello" },
      },
    });

    expect(screen.queryByLabelText("service-message-header")).toBeNull();
    expect(changes).toEqual([]);
  });

  it("creates a text header on new reply-button messages", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "wsc:action-1:one", label: "One" }],
      },
    });

    fireEvent.change(screen.getByLabelText("service-message-header"), {
      target: { value: "Promo " },
    });

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      header: { kind: "text", text: "Promo " },
    });
    expect(
      (screen.getByLabelText("service-message-header") as HTMLInputElement)
        .value
    ).toBe("Promo ");
  });

  it("renders reply-button branch handles on preview rows", () => {
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "wsc:action-1:one", label: "One" }],
        },
      },
      {
        renderOptionBranchHandle: (option, layout) => (
          <span data-testid={`option-branch-${option.id}`}>
            {layout?.local ? "local" : "node"}:{option.id}
          </span>
        ),
      }
    );

    expect(
      screen.getByTestId("option-branch-wsc:action-1:one").textContent
    ).toBe("local:wsc:action-1:one");
  });

  it("lets users remove native contact and commerce messages", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "contacts",
        contacts: [{ formattedName: "Ada", phone: "+15551212" }],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceRemoveAction" })
    );
    confirmActionChange();
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "" },
    });
  });

  it("adds reply actions through the plus menu and preserves branch ids when converting to a list", () => {
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Choose one" },
        },
      },
      {
        renderOptionBranchHandle: option => (
          <span data-testid={`option-branch-${option.id}`}>{option.id}</span>
        ),
      }
    );

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionReplyButton" })
    );
    confirmActionChange();
    // Selecting reply seeds one draft row; three more pushes into a list.
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(
        screen.getByRole("button", { name: "whatsappServiceAddReplyButton" })
      );
      confirmActionChange();
    }

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "list",
      sections: [
        {
          rows: [
            { id: expect.stringMatching(/^wsc:action-1:/) },
            { id: expect.stringMatching(/^wsc:action-1:/) },
            { id: expect.stringMatching(/^wsc:action-1:/) },
            { id: expect.stringMatching(/^wsc:action-1:/) },
          ],
        },
      ],
    });
  });

  it("uploads only the first selected file into the canonical message", async () => {
    const upload = jest.fn().mockResolvedValue({
      url: "https://cdn.example/first.png",
      fileName: "first.png",
      mediaType: "image",
    });
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "media",
          attachment: { url: "", mediaType: "image" },
          body: { mode: "fixed", text: "Caption" },
        },
      },
      { upload }
    );
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [first, second] },
    });

    await waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith(first, { persist: false });
    });
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "media",
      attachment: { url: "https://cdn.example/first.png" },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "whatsappServiceRemoveMedia" })
    );
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "Caption" },
    });
  });

  it("removes the caption field for audio and sticker messages", async () => {
    const upload = jest.fn().mockResolvedValue({
      url: "https://cdn.example/voice.ogg",
      fileName: "voice.ogg",
      mediaType: "audio",
    });
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "media",
          attachment: { url: "", mediaType: "image" },
          body: { mode: "fixed", text: "Unsupported caption" },
        },
      },
      { upload }
    );
    const audio = new File(["audio"], "voice.ogg", { type: "audio/ogg" });

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [audio] },
    });

    await waitFor(() => {
      expect(changes.at(-1)?.message).toEqual({
        kind: "media",
        attachment: expect.objectContaining({ mediaType: "audio" }),
        body: undefined,
      });
    });
  });

  it("toggles deliverAsVoice on eligible audio media", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "media",
        attachment: {
          url: "https://cdn.example/voice.ogg",
          mediaType: "audio",
          mimeType: "audio/ogg",
          fileName: "voice.ogg",
        },
      },
    });

    expect(screen.getByTestId("whatsapp-service-voice-controls")).toBeTruthy();
    expect(
      screen.queryByTestId("whatsapp-service-audio-mode-badge")
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("radio", {
        name: /whatsappServiceMediaVoiceNoteBadge/i,
      })
    );

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "media",
      deliverAsVoice: true,
    });
  });

  it("keeps audio preview visible in the bubble media slot", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "media",
        attachment: {
          url: "https://cdn.example/voice.ogg",
          mediaType: "audio",
          mimeType: "audio/ogg",
          fileName: "voice.ogg",
        },
      },
    });

    expect(screen.getByTestId("whatsapp-service-media-dropzone")).toBeTruthy();
    expect(
      screen.getByRole("radio", {
        name: /whatsappServiceMediaBasicAudioBadge/i,
      })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("hides reply/CTA actions while audio media is attached", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "media",
        attachment: {
          url: "https://cdn.example/voice.ogg",
          mediaType: "audio",
          mimeType: "audio/ogg",
          fileName: "voice.ogg",
        },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /whatsappServiceAddAction/i })
    );
    expect(
      screen.queryByRole("menuitem", {
        name: /whatsappServiceActionReplyButton/i,
      })
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", {
        name: /whatsappServiceActionWebsite/i,
      })
    ).toBeNull();
  });

  it("rejects audio uploads on reply button headers", async () => {
    const upload = jest.fn().mockResolvedValue({
      url: "https://cdn.example/voice.ogg",
      fileName: "voice.ogg",
      mediaType: "audio",
      mimeType: "audio/ogg",
    });
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick" },
          options: [{ id: "choice-1", label: "One" }],
        },
      },
      { upload }
    );

    const audio = new File(["audio"], "voice.ogg", { type: "audio/ogg" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [audio] },
    });

    await waitFor(() => {
      expect(upload).toHaveBeenCalled();
      expect(
        screen.getByText("whatsappServiceMediaAudioNotAllowedHere")
      ).toBeTruthy();
    });
    expect(changes).toHaveLength(0);
  });

  it("keeps list row descriptions editable", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Pick a product" },
        buttonLabel: "Products",
        sections: [
          {
            id: "section-1",
            title: "Popular",
            rows: [
              {
                id: "wsc:action-1:notebook",
                title: "Notebook",
                description: "A5, dotted",
              },
            ],
          },
        ],
      },
    });

    fireEvent.change(screen.getByDisplayValue("A5, dotted"), {
      target: { value: "A4, lined" },
    });

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "list",
      sections: [
        {
          rows: [
            {
              id: "wsc:action-1:notebook",
              title: "Notebook",
              description: "A4, lined",
            },
          ],
        },
      ],
    });
  });

  it("removes a final list section without leaving a zero-row list draft", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Pick a product" },
        buttonLabel: "Products",
        sections: [
          {
            id: "section-1",
            title: "Popular",
            rows: [{ id: "choice-1", title: "Notebook" }],
          },
        ],
      },
    });

    fireEvent.click(
      within(screen.getByTestId("whatsapp-action-editor-tray")).getByRole(
        "button",
        { name: "whatsappServiceDeleteSection" }
      )
    );

    expect(changes.at(-1)?.message).toEqual({
      kind: "text",
      body: { mode: "fixed", text: "Pick a product" },
      previewUrl: true,
    });
  });

  it("seeds a two-card draft only when the carousel action is selected", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Browse" } },
    });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceMediaCarousel" })
    );
    confirmActionChange();

    const next = changes.at(-1)?.message;
    expect(next).toMatchObject({
      kind: "media_carousel",
      body: { mode: "fixed", text: "Browse" },
    });
    if (next?.kind !== "media_carousel") throw new Error("expected carousel");
    expect(next.cards).toHaveLength(2);
    for (const card of next.cards) {
      expect(card.interaction).toMatchObject({ kind: "quick_replies" });
    }
  });

  it("requests branch handle geometry refresh while the carousel viewport scrolls", () => {
    const onBranchHandleViewportChange = jest.fn();
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "media_carousel",
          body: { mode: "fixed", text: "Browse" },
          cards: [
            {
              id: "card-1",
              media: { url: "https://cdn.example/1.png", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [{ id: "wsc:action-1:one", label: "One" }],
              },
            },
            {
              id: "card-2",
              media: { url: "https://cdn.example/2.png", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [{ id: "wsc:action-1:two", label: "Two" }],
              },
            },
          ],
        },
      },
      { onBranchHandleViewportChange }
    );

    const firstCardBody = screen.getAllByLabelText(
      "whatsappServiceCarouselCardTextLabel"
    )[0]!;
    const carouselViewport = firstCardBody.closest(
      "[data-testid='carousel-cards-viewport']"
    );
    expect(carouselViewport).not.toBeNull();

    onBranchHandleViewportChange.mockClear();
    fireEvent.scroll(carouselViewport!);

    expect(onBranchHandleViewportChange).toHaveBeenCalledTimes(1);
  });

  it("renders local choice handles on carousel cards", () => {
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "media_carousel",
          body: { mode: "fixed", text: "Browse" },
          cards: [
            {
              id: "card-1",
              media: { url: "https://cdn.example/1.png", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [{ id: "wsc:action-1:one", label: "One" }],
              },
            },
            {
              id: "card-2",
              media: { url: "https://cdn.example/2.png", mediaType: "image" },
              interaction: {
                kind: "quick_replies",
                options: [{ id: "wsc:action-1:two", label: "Two" }],
              },
            },
          ],
        },
      },
      {
        renderOptionBranchHandle: (option, layout) => (
          <span data-testid={`option-branch-${option.id}`}>
            {layout?.local ? "local" : "node"}
          </span>
        ),
      }
    );

    expect(
      screen.getByTestId("option-branch-wsc:action-1:one").textContent
    ).toBe("local");
    expect(screen.queryByTestId("option-branch-wsc:action-1:two")).toBeNull();
  });

  it("changes every carousel card to one interaction family", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "media_carousel",
        body: { mode: "fixed", text: "Browse" },
        cards: [
          {
            id: "card-1",
            media: { url: "https://cdn.example/1.png", mediaType: "image" },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:action-1:one", label: "" }],
            },
          },
          {
            id: "card-2",
            media: { url: "https://cdn.example/2.png", mediaType: "image" },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:action-1:two", label: "" }],
            },
          },
        ],
      },
    });

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "whatsappServiceCarouselWebsite",
      })
    );
    confirmActionChange();

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "media_carousel",
      cards: [
        { interaction: { kind: "url" } },
        { interaction: { kind: "url" } },
      ],
    });
  });

  it("asks before replacing populated interactions on every carousel card", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "media_carousel",
        body: { mode: "fixed", text: "Browse" },
        cards: [
          {
            id: "card-1",
            media: { url: "https://cdn.example/1.png", mediaType: "image" },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:action-1:one", label: "One" }],
            },
          },
          {
            id: "card-2",
            media: { url: "https://cdn.example/2.png", mediaType: "image" },
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:action-1:two", label: "Two" }],
            },
          },
        ],
      },
    });

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "whatsappServiceCarouselWebsite",
      })
    );
    confirmActionChange();

    expect(changes).toHaveLength(0);
    expect(
      screen.getByText("whatsappServiceCarouselInteractionChangeTitle")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServiceCarouselInteractionChangeConfirm",
      })
    );

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "media_carousel",
      cards: [
        { interaction: { kind: "url" } },
        { interaction: { kind: "url" } },
      ],
    });
  });

  it("selects named products for a product carousel without exposing IDs", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "commerce",
        commerce: {
          mode: "product_carousel",
          catalogId: "catalog-secret",
          bodyText: "New arrivals",
          productRetailerIds: [],
        },
      },
    });

    expect(screen.queryByText("product-secret-1")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Notebook" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Backpack" }));

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "commerce",
      commerce: {
        mode: "product_carousel",
        productRetailerIds: ["product-secret-1", "product-secret-2"],
      },
    });
  });

  it("edits the header text of a list message", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Pick" },
        buttonLabel: "Open",
        sections: [],
      },
    });

    fireEvent.change(screen.getByLabelText("service-message-header"), {
      target: { value: "List Header" },
    });

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "list",
      headerText: "List Header",
    });
  });

  it("edits the footer text of a reply_buttons message", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick" },
        options: [],
      },
    });

    fireEvent.change(screen.getByLabelText("service-message-footer"), {
      target: { value: "Custom Footer " },
    });

    expect(changes.at(-1)?.message).toMatchObject({
      kind: "reply_buttons",
      footerText: "Custom Footer ",
    });
    expect(
      (screen.getByLabelText("service-message-footer") as HTMLInputElement)
        .value
    ).toBe("Custom Footer ");
  });

  it.each(["audio", "sticker"] as const)(
    "hides footer editing for %s media",
    mediaType => {
      renderBuilder({
        version: 1,
        message: {
          kind: "media",
          attachment: {
            url: `https://cdn.example/${mediaType}`,
            mediaType,
            fileName: mediaType,
          },
        },
      });

      expect(screen.queryByLabelText("service-message-footer")).toBeNull();
    }
  );

  it("keeps image messages free of unsupported footer controls", () => {
    const attachment = {
      url: "https://cdn.example/hero.png",
      mediaType: "image" as const,
      fileName: "hero.png",
    };
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "media",
        attachment,
        body: { mode: "fixed", text: "Caption" },
      },
    });

    expect(screen.queryByLabelText("service-message-footer")).toBeNull();
    expect(changes).toEqual([]);
  });

  it("keeps an unavailable saved action editable and shows a persistent warning", () => {
    mockResources.callingReady = false;
    try {
      renderBuilder({
        version: 1,
        message: {
          kind: "voice_call",
          body: { mode: "fixed", text: "Call us" },
          buttonLabel: "Call",
          ttlMinutes: 60,
          payload: "call-us",
        },
      });

      expect(
        screen.getByTestId("whatsapp-service-current-action-unavailable")
      ).toHaveTextContent("whatsappServiceCallingUnavailable");
      expect(screen.getAllByDisplayValue("Call")).toHaveLength(2);
    } finally {
      mockResources.callingReady = true;
    }
  });

  it("explains why saved commerce is unavailable in coexistence mode", () => {
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "commerce",
          commerce: { mode: "catalog", catalogId: "catalog-secret" },
        },
      },
      { hasWhatsAppCoexistence: true }
    );

    expect(
      screen.getByTestId("whatsapp-service-current-action-unavailable")
    ).toHaveTextContent("whatsappServiceCurrentActionCoexistenceUnavailable");
  });

  it("keeps asked details when the text body changes", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "We can design a medal." },
        previewUrl: true,
      },
    });

    expect(screen.queryByText("whatsappServicePromptInputsTitle")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsAddFirst",
      })
    );
    expect(screen.getByText("whatsappServicePromptInputsTitle")).toBeVisible();
    expect(screen.getByText("whatsappServicePromptInputsAsk")).toBeVisible();
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "whatsappServicePromptInputsKey 1",
      }),
      { target: { value: "name" } }
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "whatsappServicePromptInputsQuestion 1",
      }),
      { target: { value: "What name should we print?" } }
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "service-message-body" }),
      {
        target: { value: "We can design a medal for you." },
      }
    );

    expect(changes.at(-1)).toMatchObject({
      message: {
        kind: "text",
        body: { mode: "fixed", text: "We can design a medal for you." },
      },
      promptInputs: [
        {
          key: "name",
          label: "",
          prompt: "What name should we print?",
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "whatsappServicePromptInputsRename" })
    ).toHaveTextContent("name");
    expect(
      screen.getByText("What name should we print?", { selector: "p" })
    ).toBeVisible();
  });

  it("asks for details on a buttons message and keeps them across its options", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick a frame, then send the name." },
        options: [{ id: "wsc:action-1:gold", label: "Gold" }],
      },
      promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
    });

    expect(screen.getByTestId("whatsapp-service-prompt-inputs")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        description: "whatsappServicePromptInputsChoiceHint",
      })
    ).toBeTruthy();
    expect(screen.queryByText("whatsappServicePromptInputsHint")).toBeNull();

    fireEvent.change(
      screen.getByRole("textbox", { name: "service-message-body" }),
      { target: { value: "Pick a frame and send the name to engrave." } }
    );
    expect(changes.at(-1)).toMatchObject({
      message: { kind: "reply_buttons" },
      promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
    });
  });

  /** The native select the Select mock renders for the option named `text`. */
  const selectOffering = (text: string) =>
    screen.getByRole("option", { name: text }).closest("select")!;

  it("keeps a detail's answer rules and drops those of another type", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Send the name and sport." },
        previewUrl: false,
      },
      promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
    });

    fireEvent.change(selectOffering("whatsappServicePromptInputsFormatName"), {
      target: { value: "name" },
    });
    // Max length is an optional rule behind "More".
    expect(
      screen.queryByRole("spinbutton", {
        name: "whatsappServicePromptInputsMaxLength 1",
      })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceMore" })
    );
    const maxLength = screen.getByRole("spinbutton", {
      name: "whatsappServicePromptInputsMaxLength 1",
    });
    expect(maxLength).toHaveAttribute("placeholder", "40");
    fireEvent.change(maxLength, { target: { value: "30" } });
    expect(changes.at(-1)?.promptInputs).toEqual([
      {
        key: "name",
        label: "",
        prompt: "Name to engrave",
        format: "name",
        maxLength: 30,
      },
    ]);

    fireEvent.change(
      selectOffering("whatsappServicePromptInputsFormatChoice"),
      { target: { value: "choice" } }
    );
    expect(
      screen.queryByRole("spinbutton", {
        name: "whatsappServicePromptInputsMaxLength 1",
      })
    ).toBeNull();
    const choices = screen.getByRole("textbox", {
      name: "whatsappServicePromptInputsChoices 1",
    });
    // Enter adds an answer; leaving the field keeps what was typed.
    fireEvent.change(choices, { target: { value: "Judo" } });
    fireEvent.keyDown(choices, { key: "Enter" });
    expect(choices).toHaveValue("");
    expect(changes.at(-1)?.promptInputs?.[0]).toEqual({
      key: "name",
      label: "",
      prompt: "Name to engrave",
      format: "choice",
      choices: ["Judo"],
    });
    fireEvent.change(choices, { target: { value: "Boxing" } });
    fireEvent.blur(choices);
    expect(changes.at(-1)?.promptInputs?.[0]?.choices).toEqual([
      "Judo",
      "Boxing",
    ]);
    expect(
      screen.getByRole("button", {
        description: "whatsappServicePromptInputsRulesHint",
      })
    ).toBeTruthy();
  });

  it("sets how long a choice ask waits and how it reads written replies", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick a frame, then send the name." },
        options: [{ id: "wsc:action-1:gold", label: "Gold" }],
      },
      promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
    });

    // Closed by default; the summary keeps the paid reminder in sight.
    expect(
      screen.getByText("whatsappServicePromptInputsReplyRulesSummary")
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsReplyRules",
      })
    );
    expect(screen.getByText("whatsappServiceExtraCost")).toBeVisible();
    const wait = selectOffering("whatsappServicePromptInputsWaitWeek");
    // A day by default.
    expect(wait).toHaveValue("24");
    fireEvent.change(wait, { target: { value: "168" } });
    expect(changes.at(-1)?.promptInputBehavior).toEqual({ waitHours: 168 });

    const typed = screen.getByRole("checkbox", {
      name: "whatsappServicePromptInputsTypedChoice",
    });
    const nudge = screen.getByRole("checkbox", {
      name: "whatsappServicePromptInputsNudge",
    });
    expect(typed).toBeChecked();
    expect(nudge).toBeChecked();
    fireEvent.click(typed);
    fireEvent.click(nudge);
    expect(changes.at(-1)?.promptInputBehavior).toEqual({
      waitHours: 168,
      typedChoice: false,
      nudgeOnce: false,
    });
  });

  it("offers only the wait period on a text ask and forgets the rules with its details", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Send the name." },
        previewUrl: false,
      },
      promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
      promptInputBehavior: { waitHours: 1 },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsReplyRules",
      })
    );
    expect(selectOffering("whatsappServicePromptInputsWaitHour")).toHaveValue(
      "1"
    );
    expect(
      screen.queryByRole("checkbox", {
        name: "whatsappServicePromptInputsTypedChoice",
      })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsRemove 1",
      })
    );
    expect(changes.at(-1)).not.toHaveProperty("promptInputs");
    expect(changes.at(-1)).not.toHaveProperty("promptInputBehavior");
    expect(
      screen.queryByTestId("whatsapp-service-prompt-input-settings")
    ).toBeNull();
  });

  it("labels contact fields and reports a missing name once for the card", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "contacts",
        contacts: [{ version: 1, phone: "+77001234567" }],
      },
    });

    // The phone example is a placeholder, never the field's label.
    expect(
      screen.queryByLabelText("whatsappContactPhonePlaceholder")
    ).toBeNull();
    expect(screen.getByLabelText("whatsappContactPhoneLabel")).toHaveAttribute(
      "placeholder",
      "whatsappContactPhonePlaceholder"
    );
    expect(
      screen.getAllByText("whatsappServiceValidationContactInvalid")
    ).toHaveLength(1);
    expect(screen.getByLabelText("whatsappContactNameLabel")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(
      screen.getByLabelText("whatsappContactPhoneLabel")
    ).not.toHaveAttribute("aria-invalid");
    // Optional card details stay behind "More details" until they have values.
    expect(
      screen.queryByRole("textbox", { name: "whatsappContactEmailLabel" })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappContactMoreDetails" })
    );
    expect(
      screen.getByRole("textbox", { name: "whatsappContactEmailLabel" })
    ).toBeVisible();
  });

  it("names the trash on each contact once there are several", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "contacts",
        contacts: [
          { version: 1, formattedName: "Ada" },
          { version: 1, formattedName: "Grace" },
        ],
      },
    });
    const remove = screen.getAllByRole("button", {
      name: "whatsappServiceDeleteContact",
    });
    expect(remove).toHaveLength(2);
    fireEvent.click(remove[0]!);
    expect(changes.at(-1)?.message).toMatchObject({
      kind: "contacts",
      contacts: [{ formattedName: "Grace" }],
    });
  });

  it("opens a closed section to show the first issue", () => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    renderBuilder({
      version: 1,
      message: {
        kind: "voice_call",
        body: { mode: "fixed", text: "Call us" },
        buttonLabel: "Call",
        ttlMinutes: 60,
        payload: "x".repeat(600),
      },
    });

    const advanced = screen.getByRole("button", {
      name: /whatsappServiceAdvanced/,
    });
    // A section opens by itself when it holds an error.
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("textbox", { name: "whatsappServicePayloadPlaceholder" })
    ).toHaveFocus();
  });

  it("opens the form editor when the first issue is in the form", () => {
    const onOpenFlowEditor = jest.fn();
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Start" },
          flowConfig: null,
        },
      },
      { onOpenFlowEditor }
    );

    // Nothing on the closed card shows the form error, so the summary names it.
    expect(
      screen.getByTestId("whatsapp-service-message-validation")
    ).toHaveTextContent("whatsappServiceValidationFlowInvalid");
    expect(
      screen.getByTestId("whatsapp-service-message-validation")
    ).not.toHaveTextContent("whatsappServiceValidationIssueCount");
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(onOpenFlowEditor).toHaveBeenCalledTimes(1);
  });

  it("names the first issue and counts the rest when nothing shows it", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick one" },
        options: [
          { id: "", label: "Yes" },
          { id: "no", label: "" },
        ],
      },
    });

    // A missing button id has no field; the summary names it and the count.
    const summary = screen.getByTestId("whatsapp-service-message-validation");
    expect(summary).toHaveTextContent(
      "whatsappServiceMessageInvalid · whatsappServiceValidationIssueCount"
    );
    // Nothing on the step can take focus for it, so there is no Show.
    expect(
      screen.queryByRole("button", {
        name: "whatsappServiceValidationShowFirst",
      })
    ).toBeNull();
  });

  it("offers Undo in a toast after the button type changes", () => {
    mockToast.mockClear();
    const undo = jest.fn(() => true);
    renderBuilder(
      {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "wsc:action-1:one", label: "One" }],
        },
      },
      { history: undo }
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    expect(screen.getByText("whatsappServiceChangeActionTitle")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "continue" }));

    expect(mockToast).toHaveBeenCalledTimes(1);
    const [title, options] = mockToast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("whatsappServiceUndoHint");
    expect(options.action.label).toBe("whatsappServiceUndo");
    options.action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);
    // No permanent undo text stays in the editor.
    expect(screen.queryByText("whatsappServiceUndoHint")).toBeNull();
  });

  it("skips the undo toast without canvas history", () => {
    mockToast.mockClear();
    renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "wsc:action-1:one", label: "One" }],
      },
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "whatsappServiceActionWebsite" })
    );
    confirmActionChange();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("asks before deleting buttons with its own title and action", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [
          { id: "wsc:action-1:one", label: "One" },
          { id: "wsc:action-1:two", label: "Two" },
        ],
      },
    });

    // Each reply button's trash names what it deletes.
    expect(
      screen.getAllByRole("button", { name: "whatsappServiceDeleteButton" })
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceRemoveAction" })
    );
    expect(screen.getByText("whatsappServiceRemoveActionTitle")).toBeVisible();
    expect(screen.getByText("whatsappServiceChangeActionHint")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(changes.at(-1)?.message.kind).toBe("text");
  });

  it("names the add control by what it adds", () => {
    renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
    });
    expect(
      screen.getByRole("button", { name: "whatsappServiceAddAction" })
    ).toHaveTextContent("whatsappServiceAddAction");
  });

  it("reports failed WhatsApp data only on message types that use it", () => {
    mockResources.failed = true;
    mockResources.failedResources = {
      signupLinks: false,
      calling: true,
      catalog: false,
    };
    try {
      renderBuilder({
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
      });
      expect(
        screen.queryByTestId("whatsapp-service-resources-failed")
      ).toBeNull();
      cleanup();

      renderBuilder({
        version: 1,
        message: {
          kind: "voice_call",
          body: { mode: "fixed", text: "Call us" },
          buttonLabel: "Call",
          ttlMinutes: 60,
          payload: "",
        },
      });
      const notice = screen.getByTestId("whatsapp-service-resources-failed");
      expect(notice).toHaveTextContent("whatsappServiceResourcesFailed");
      fireEvent.click(within(notice).getByRole("button", { name: "retry" }));
      expect(mockResources.retry).toHaveBeenCalled();
    } finally {
      mockResources.failed = false;
      mockResources.failedResources = {
        signupLinks: false,
        calling: false,
        catalog: false,
      };
    }
  });

  it("keeps WhatsApp call in the menu with a spinner while calls load", () => {
    mockResources.loading = true;
    mockResources.callingReady = false;
    try {
      renderBuilder({
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
      });
      expect(screen.queryByText("loading")).toBeNull();
      const call = screen.getByRole("menuitem", {
        name: /whatsappServiceActionVoiceCall/,
      });
      expect(call).toBeDisabled();
      expect(call).toHaveTextContent("loadingItems");
    } finally {
      mockResources.loading = false;
      mockResources.callingReady = true;
    }
  });

  it("gives AI instructions an example and a note that customers never see them", () => {
    renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "ai", instruction: "" } },
    });
    const instructions = screen.getByLabelText("whatsappServiceAiInstructions");
    expect(instructions).toHaveAttribute(
      "placeholder",
      "actionReplyInstructionPlaceholder"
    );
    expect(instructions).toHaveAccessibleDescription(
      "whatsappServiceAiInstructionsHint"
    );
    expect(screen.getByLabelText("service-message-body")).toHaveValue(
      "whatsappServiceAiPreview"
    );
  });

  it("inserts an earlier form's answer at the AI instructions' caret", () => {
    const { changes } = renderBuilder(
      {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "ai", instruction: "Thank them. Be brief." },
        },
      },
      {
        promptInputFields: [
          { token: "input.name", label: "Name", description: "Your name" },
        ],
        formAnswerSources: [
          {
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
          },
        ],
      }
    );
    const instructions = screen.getByLabelText(
      "whatsappServiceAiInstructions"
    ) as HTMLTextAreaElement;
    const caret = "Thank them".length;
    instructions.setSelectionRange(caret, caret);
    fireEvent.blur(instructions);

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
    // AI instructions fill in only answers, so the catalog stays out.
    expect(screen.queryByText("variableGroupContact")).toBeNull();
    fireEvent.click(
      screen.getByTestId("service-message-variable-form.order.size")
    );

    expect(changes.at(-1)?.message).toMatchObject({
      body: {
        mode: "ai",
        instruction: "Thank them {{form.order.size}}. Be brief.",
      },
    });
    const mayBeEmpty = screen.getByTestId("form-answers-may-be-empty");
    expect(mayBeEmpty).toHaveTextContent("formAnswersMayBeEmptyReply");
    // The field keeps its hint and names the note too.
    const describedBy = instructions.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toContain(mayBeEmpty.id);
    expect(describedBy.split(" ")).toHaveLength(2);
    expect(instructions).not.toHaveAttribute("aria-invalid");
  });

  it("shows the button text customers see on a location request", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "location_request",
        body: { mode: "fixed", text: "Where are you?" },
      },
    });
    expect(screen.getByLabelText("choice-1")).toHaveValue(
      "whatsappServiceLocationRequestButton"
    );
  });

  it("keeps a single list section compact until it needs a title or description", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [{ id: "section", rows: [{ id: "back", title: "Back" }] }],
      },
    });

    expect(screen.getByLabelText("whatsappServiceListButtonLabel")).toHaveValue(
      "Options"
    );
    expect(
      screen.queryByRole("textbox", {
        name: "whatsappServiceListSectionPlaceholder",
      })
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "whatsappServiceListOptionLabel" })
    ).toHaveValue("Back");
    expect(
      screen.queryByRole("textbox", {
        name: "whatsappServiceListDescriptionPlaceholder",
      })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceListAddDescription" })
    );
    expect(
      screen.getByRole("textbox", {
        name: "whatsappServiceListDescriptionPlaceholder",
      })
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "whatsappServiceDeleteOption" })
    ).toBeVisible();
  });

  it("explains an empty signup-link list inside the picker", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: "Join" },
        buttonLabel: "Join",
        urlSource: { kind: "signup_link", signupLinkId: "" },
      },
    });
    expect(
      screen.getByRole("option", { name: "whatsappSignupLinkEmpty" })
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "whatsappServiceFixedUrl" })
    ).toBeInTheDocument();
  });

  it("offers link preview only when the text can contain a link", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Hello" },
        previewUrl: true,
      },
    });
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.change(screen.getByLabelText("service-message-body"), {
      target: { value: "Menu: https://example.com" },
    });
    const preview = screen.getByRole("switch", {
      name: "whatsappServiceLinkPreview",
    });
    expect(preview).toBeChecked();
    fireEvent.click(preview);
    expect(changes.at(-1)?.message).toMatchObject({ previewUrl: false });
  });

  it("orders location fields and shows a coordinates error once", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "location",
        location: { version: 1, latitude: "999", longitude: "10" },
      },
    });
    expect(
      screen
        .getAllByRole("textbox")
        .map(input => input.getAttribute("aria-label"))
    ).toEqual([
      "whatsappLocationNameLabel",
      "whatsappLocationAddressLabel",
      "whatsappLocationLatitudeLabel",
      "whatsappLocationLongitudeLabel",
    ]);
    expect(
      screen.getAllByText("whatsappServiceValidationLocationInvalid")
    ).toHaveLength(1);
    expect(
      screen.getByLabelText("whatsappLocationLongitudeLabel")
    ).toHaveAttribute("aria-invalid", "true");
  });

  it("labels the call button and keeps the internal note under Advanced", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "voice_call",
        body: { mode: "fixed", text: "Call us" },
        buttonLabel: "Call",
        ttlMinutes: 60,
        payload: "",
      },
    });
    expect(screen.getByRole("textbox", { name: "buttonText" })).toHaveValue(
      "Call"
    );
    expect(
      screen.getByRole("spinbutton", { name: "whatsappServiceCallTtl" })
    ).toHaveValue(60);
    expect(
      screen.queryByRole("textbox", {
        name: "whatsappServicePayloadPlaceholder",
      })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAdvanced" })
    );
    expect(
      screen.getByRole("textbox", {
        name: "whatsappServicePayloadPlaceholder",
      })
    ).toBeVisible();
  });

  it("names a new detail from what it collects and never renames it", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Your name?" } },
      promptInputs: [
        { key: "name", label: "", prompt: "Name" },
        { key: "", label: "", prompt: "" },
      ],
    });

    // A detail without text is titled by its position.
    expect(
      screen.getByText("whatsappServicePromptInputsRowTitle", { selector: "p" })
    ).toBeVisible();
    const question = screen.getByRole("textbox", {
      name: "whatsappServicePromptInputsQuestion 2",
    });
    fireEvent.change(question, { target: { value: "Имя клиента" } });
    fireEvent.blur(question);
    expect(changes.at(-1)?.promptInputs?.[1]).toMatchObject({
      key: "imya_klienta",
      prompt: "Имя клиента",
    });

    fireEvent.change(question, { target: { value: "Name" } });
    fireEvent.blur(question);
    expect(changes.at(-1)?.promptInputs?.[1]?.key).toBe("imya_klienta");
  });

  it("gives a suggested name a suffix when another detail uses it", () => {
    const { changes } = renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Your name?" } },
      promptInputs: [
        { key: "name", label: "", prompt: "Name" },
        { key: "", label: "", prompt: "" },
      ],
    });
    const question = screen.getByRole("textbox", {
      name: "whatsappServicePromptInputsQuestion 2",
    });
    fireEvent.change(question, { target: { value: "Name" } });
    fireEvent.blur(question);
    expect(changes.at(-1)?.promptInputs?.[1]?.key).toBe("name_2");
  });

  it("shows a variable name error next to its badge", () => {
    renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Your name?" } },
      promptInputs: [{ key: "Name!", label: "", prompt: "Name" }],
    });
    const badge = screen.getByRole("button", {
      name: "whatsappServicePromptInputsRename",
    });
    expect(badge).toHaveAccessibleDescription(
      "whatsappServiceValidationPromptInputKey"
    );
    expect(
      screen.getByText("whatsappServiceValidationPromptInputKey")
    ).toHaveClass("text-destructive");
  });

  it("names the commerce modes and counts the products picked", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "commerce",
        commerce: {
          mode: "product_carousel",
          catalogId: "catalog-secret",
          bodyText: "New arrivals",
          productRetailerIds: ["product-secret-1"],
        },
      },
    });
    expect(
      screen.getByText("whatsappServiceProductsSelected")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "whatsappServiceFormatCatalog" })
    ).toBeInTheDocument();
  });

  it("says details need Your text and shows that error instead of a trash", () => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    renderBuilder({
      version: 1,
      message: {
        kind: "text",
        body: { mode: "ai", instruction: "Ask for the order number" },
      },
      promptInputs: [{ key: "order", label: "Order", prompt: "Order number" }],
    });

    const error = screen.getByText(
      "whatsappServiceValidationPromptInputsRequireFixedBody"
    );
    // Once, under the Details title; the summary only counts it.
    expect(
      screen.getAllByText(
        "whatsappServiceValidationPromptInputsRequireFixedBody"
      )
    ).toHaveLength(1);
    expect(
      screen.getByTestId("whatsapp-service-prompt-inputs")
    ).toContainElement(error);
    expect(
      screen.getByTestId("whatsapp-service-message-validation")
    ).toHaveTextContent("whatsappServiceValidationIssueCount");

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(error).toHaveFocus();
    expect(
      screen.getByRole("button", {
        name: "whatsappServicePromptInputsRemove 1",
      })
    ).not.toHaveFocus();
  });

  it("shows a list without options under the list and focuses Add option", () => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    renderBuilder({
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Pick one" },
        buttonLabel: "Menu",
        sections: [{ id: "section-1", title: "", rows: [] }],
      },
    });

    expect(
      screen.getAllByText("whatsappServiceValidationListRows")
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(
      screen.getByRole("button", { name: "whatsAppSessionChoiceAddOption" })
    ).toHaveFocus();
  });

  it("shows the reply button count under the buttons", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick one" },
        options: [],
      },
    });

    expect(
      screen.getAllByText("whatsappServiceValidationReplyButtonCount")
    ).toHaveLength(1);
    expect(
      screen.getByTestId("whatsapp-service-button-editor")
    ).toHaveTextContent("whatsappServiceValidationReplyButtonCount");
  });

  it("shows a product list without sections under its sections", () => {
    renderBuilder({
      version: 1,
      message: {
        kind: "commerce",
        commerce: {
          mode: "multi_product",
          catalogId: "catalog-secret",
          headerText: "Menu",
          bodyText: "Pick what you like",
          sections: [],
        },
      },
    });

    expect(
      screen.getAllByText("whatsappServiceValidationListSections")
    ).toHaveLength(1);
  });

  it("focuses the answer field, not a tag's remove button, for a choices error", () => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    renderBuilder({
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Which size?" } },
      promptInputs: [
        {
          key: "size",
          label: "Size",
          prompt: "Size",
          format: "choice",
          choices: ["Small"],
        },
      ],
    });

    expect(
      screen.getByText("whatsappServiceValidationPromptInputChoices")
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceValidationShowFirst" })
    );
    expect(
      screen.getByRole("textbox", {
        name: "whatsappServicePromptInputsChoices 1",
      })
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "removeTag" })).not.toHaveFocus();
  });
});
