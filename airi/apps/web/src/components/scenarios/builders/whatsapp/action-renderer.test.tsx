/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";

jest.mock("@/components/scenarios/builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    onBlur,
    ariaLabel,
    placeholder,
    multiline = true,
    className,
  }: {
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    ariaLabel?: string;
    placeholder?: string;
    multiline?: boolean;
    className?: string;
  }) =>
    multiline ? (
      <textarea
        aria-label={ariaLabel || placeholder || "editor"}
        className={className}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ) : (
      <input
        aria-label={ariaLabel || placeholder || "editor"}
        className={className}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ),
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { WhatsAppActionRenderer } from "./action-renderer";

describe("WhatsAppActionRenderer", () => {
  it("keeps destination controls on the same row as the editable customer button label", () => {
    const edit = jest.fn();
    const choose = jest.fn();
    render(
      <WhatsAppActionRenderer
        bodyText="Choose"
        buttons={[
          {
            type: "quick_reply",
            label: "Book appointment",
            onLabelChange: edit,
            rowActions: <button onClick={choose}>Appointment details</button>,
          },
        ]}
      />
    );
    const label = screen.getByDisplayValue("Book appointment");
    const destination = screen.getByRole("button", {
      name: "Appointment details",
    });
    expect(document.querySelector("[data-wa-row-actions]")).toBeNull();
    expect(destination.parentElement?.className).toContain("inline-flex");
    fireEvent.change(label, { target: { value: "Reserve appointment" } });
    expect(edit).toHaveBeenCalledWith("Reserve appointment");
    fireEvent.click(destination);
    expect(choose).toHaveBeenCalledTimes(1);
  });
  it("renders an interactive message inside a transcript without repeating phone chrome", () => {
    const reply = jest.fn();
    render(
      <WhatsAppActionRenderer
        surface="message"
        bodyText="Choose a route"
        buttons={[{ type: "quick_reply", label: "Continue", onClick: reply }]}
        fitContent
      />
    );
    expect(screen.queryByText("9:41")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(reply).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Choose a route")).toBeInTheDocument();
  });
  it("renders template content without the old separate linked-flow preview action", async () => {
    render(
      <WhatsAppActionRenderer
        headerText="Header"
        bodyText="Editable template text"
        onBodyTextChange={() => {}}
        footerText="Footer"
        buttons={[
          {
            type: "flow",
            label: "Open flow",
            flowId: "flow-1",
            flowAction: "navigate",
            onClick: () => {},
          },
          {
            type: "url",
            label: "Visit site",
            value: "https://example.com",
          },
        ]}
      />
    );

    expect(screen.queryByText("Header")).not.toBeNull();
    expect(
      await screen.findByDisplayValue("Editable template text")
    ).not.toBeNull();
    expect(screen.queryByText("Open flow")).not.toBeNull();
    expect(screen.queryByText("Visit site")).not.toBeNull();
    expect(screen.queryByText("viewLinkedFlow")).toBeNull();
    expect(screen.queryByText("1:22 PM")).toBeNull();
  });

  it("renders WhatsApp formatting markers in read-only previews", () => {
    render(
      <WhatsAppActionRenderer
        headerText="*Header*"
        bodyText="Hi *Bold* _Italic_ ~Old~ ```SKU-1```"
        footerText="_Footer_"
      />
    );

    // WhatsApp shows header text as typed, already in bold.
    const header = screen.getByTestId("whatsapp-header-text");
    expect(header).toHaveTextContent("*Header*");
    expect(header.querySelector("strong")).toBeNull();
    expect(header).toHaveClass("font-bold", "text-[13.5px]");
    expect(screen.getByTestId("whatsapp-formatted-body")).toContainElement(
      screen.getByText("Bold").closest("strong")
    );
    expect(screen.getByTestId("whatsapp-formatted-body")).toContainElement(
      screen.getByText("Italic").closest("em")
    );
    expect(screen.getByTestId("whatsapp-formatted-body")).toContainElement(
      screen.getByText("Old").closest("s")
    );
    expect(screen.getByTestId("whatsapp-formatted-body")).toContainElement(
      screen.getByText("SKU-1").closest("code")
    );
    expect(screen.getByTestId("whatsapp-formatted-footer")).toContainElement(
      screen.getByText("Footer").closest("em")
    );
  });

  it("renders externally hosted template image headers as lazy browser images", () => {
    const metaSampleUrl =
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=456&hash=sample";

    render(
      <WhatsAppActionRenderer
        headerMediaFormat="IMAGE"
        headerMediaUrl={metaSampleUrl}
        bodyText="Meta-created template body"
      />
    );

    const image = screen.getByTestId("whatsapp-template-image-preview");
    expect(image).toHaveAttribute("src", metaSampleUrl);
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
  });

  it.each([
    ["IMAGE", "whatsappTemplateHeaderImage"],
    ["VIDEO", "whatsappTemplateHeaderVideo"],
  ] as const)(
    "holds the place of a %s header whose display URL has not arrived",
    (format, label) => {
      const { container } = render(
        <WhatsAppActionRenderer
          headerMediaFormat={format}
          headerMediaUrl="gcs://bucket/workspace/header.png"
          bodyText="Template body"
        />
      );

      const pending = screen.getByTestId("whatsapp-template-media-pending");
      expect(pending).toHaveAccessibleName(label);
      // The media frame's full height, as the loaded media usually fills it.
      expect(pending).toHaveClass("h-44", "max-h-44", "w-full");
      expect(container.querySelector("img, video")).toBeNull();
    }
  );

  it("does not link a document header whose display URL has not arrived", () => {
    const { container } = render(
      <WhatsAppActionRenderer
        headerMediaFormat="DOCUMENT"
        headerMediaUrl="gcs://bucket/workspace/terms.pdf"
        bodyText="Template body"
      />
    );

    expect(
      screen.getByTestId("whatsapp-header-media-placeholder")
    ).toBeInTheDocument();
    expect(container.querySelector("a[href^='gcs:']")).toBeNull();
  });

  it("uses the template flow button as the inline flow opener", async () => {
    const handleFlowOpen = jest.fn();
    render(
      <WhatsAppActionRenderer
        bodyText="Template text"
        onBodyTextChange={() => {}}
        buttons={[
          {
            type: "flow",
            label: "Open flow",
            flowId: "flow-1",
            flowAction: "navigate",
            onClick: handleFlowOpen,
          },
        ]}
        editorTray={<div>Button editors</div>}
      />
    );

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    expect(screen.getByTestId("whatsapp-action-editor-tray")).toBeTruthy();
    expect(screen.getByText("Button editors")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open flow/i }));
    expect(handleFlowOpen).toHaveBeenCalledTimes(1);
  });

  it("renders a custom Flow row leading action for editable template buttons", async () => {
    const handleOpenBuilder = jest.fn();

    render(
      <WhatsAppActionRenderer
        bodyText="Template text"
        onBodyTextChange={() => {}}
        buttons={[
          {
            type: "flow",
            label: "Open flow",
            flowId: "flow-1",
            flowAction: "navigate",
            onLabelChange: jest.fn(),
            leadingAction: (
              <button type="button" onClick={handleOpenBuilder}>
                Open builder
              </button>
            ),
          },
        ]}
      />
    );

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open builder" }));
    expect(handleOpenBuilder).toHaveBeenCalledTimes(1);
  });

  it("commits editable template text on blur", async () => {
    const handleBodyCommit = jest.fn();

    render(
      <WhatsAppActionRenderer
        bodyText="Template text"
        onBodyTextChange={() => {}}
        onBodyTextCommit={handleBodyCommit}
      />
    );

    fireEvent.blur(await screen.findByDisplayValue("Template text"));
    expect(handleBodyCommit).toHaveBeenCalledTimes(1);
  });

  it("commits editable button labels on blur", async () => {
    const handleLabelCommit = jest.fn();

    render(
      <WhatsAppActionRenderer
        bodyText="Template text"
        onBodyTextChange={() => {}}
        buttons={[
          {
            type: "quick_reply",
            label: "Kazakh",
            onLabelChange: jest.fn(),
            onLabelCommit: handleLabelCommit,
          },
        ]}
      />
    );

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    fireEvent.blur(screen.getByDisplayValue("Kazakh"));
    expect(handleLabelCommit).toHaveBeenCalledTimes(1);
  });

  it("renders preview chrome overrides inside the phone frame", async () => {
    render(
      <WhatsAppActionRenderer
        bodyText="Template text"
        onBodyTextChange={() => {}}
        statusBarAction={<button type="button">Close preview</button>}
        appBarContent={<div>Template picker</div>}
      />
    );

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close preview" })).toBeTruthy();
    expect(screen.getByText("Template picker")).toBeTruthy();
    expect(screen.queryByText("WhatsApp")).toBeNull();
    expect(screen.queryByText("...")).toBeNull();
  });

  it("keeps editable button label keyboard events inside the button row", async () => {
    const parentKeyDown = jest.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <WhatsAppActionRenderer
          bodyText="Template text"
          onBodyTextChange={() => {}}
          buttons={[
            {
              type: "quick_reply",
              label: "Kazakh",
              onLabelChange: jest.fn(),
            },
          ]}
        />
      </div>
    );

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    fireEvent.keyDown(screen.getByDisplayValue("Kazakh"), {
      key: "Backspace",
    });
    fireEvent.keyDown(screen.getByDisplayValue("Kazakh"), {
      key: "ArrowLeft",
    });

    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("keeps focus while editing preview button labels", async () => {
    function EditableButtonHarness() {
      const [label, setLabel] = useState("Kazakh");
      return (
        <WhatsAppActionRenderer
          bodyText="Template text"
          onBodyTextChange={() => {}}
          buttons={[
            {
              type: "quick_reply",
              label,
              onLabelChange: setLabel,
            },
          ]}
        />
      );
    }

    render(<EditableButtonHarness />);

    expect(await screen.findByDisplayValue("Template text")).toBeTruthy();
    const input = screen.getByDisplayValue("Kazakh");
    input.focus();
    fireEvent.change(input, { target: { value: "Kazakh tili" } });

    expect(screen.getByDisplayValue("Kazakh tili")).toBe(
      document.activeElement
    );
  });

  it("renders template button editors inside the WhatsApp button strip", async () => {
    const handleHeaderChange = jest.fn();
    const handleBodyChange = jest.fn();
    const handleFooterChange = jest.fn();

    render(
      <WhatsAppActionRenderer
        headerText="Template header"
        onHeaderTextChange={handleHeaderChange}
        bodyText="Template body"
        onBodyTextChange={handleBodyChange}
        footerText="Template footer"
        onFooterTextChange={handleFooterChange}
        buttonEditor={
          <>
            <div>Editable button row</div>
            <button type="button">Add button</button>
          </>
        }
      />
    );

    fireEvent.change(await screen.findByDisplayValue("Template header"), {
      target: { value: "Updated header" },
    });
    fireEvent.change(await screen.findByDisplayValue("Template body"), {
      target: { value: "Updated body" },
    });
    fireEvent.change(await screen.findByDisplayValue("Template footer"), {
      target: { value: "Updated footer" },
    });

    expect(handleHeaderChange).toHaveBeenCalledWith("Updated header");
    expect(handleBodyChange).toHaveBeenCalledWith("Updated body");
    expect(handleFooterChange).toHaveBeenCalledWith("Updated footer");
    expect(screen.getByTestId("whatsapp-action-button-editor")).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-action-editor-tray")).toBeNull();
    expect(screen.getByText("Editable button row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add button" })).toBeTruthy();
  });

  it("can render as fit-content without an internal scrolling message area", async () => {
    render(
      <WhatsAppActionRenderer
        bodyText={"Line 1\nLine 2\nLine 3"}
        onBodyTextChange={() => {}}
        buttonEditor={<button type="button">Add button</button>}
        fitContent
      />
    );

    expect(
      await screen.findByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toBeTruthy();
    const messageArea = screen.getByTestId("whatsapp-action-message-area");
    expect(messageArea.className).not.toContain("overflow-y-auto");
    expect(messageArea.className).not.toContain("flex-1");
    expect(messageArea.className).toContain("px-2");
    expect(messageArea.className).toContain("py-2");
    expect(messageArea.className).not.toContain("px-2.5");
    expect(screen.getByRole("button", { name: "Add button" })).toBeTruthy();
  });

  it("flushes phone chrome when embedded in an action node card", async () => {
    render(
      <WhatsAppActionRenderer
        bodyText="Hello"
        onBodyTextChange={() => {}}
        fitContent
        embedded
      />
    );

    expect(
      await screen.findByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toBeTruthy();
    const phone = screen.getByTestId("whatsapp-action-phone");
    expect(phone.className).toContain("rounded-none");
    expect(phone.className).toContain("shadow-none");
    expect(phone.className).toContain("border-0");
    expect(phone.className).not.toContain("shadow-sm");
    expect(phone.className).not.toContain("rounded-[28px]");
  });

  it("renders the flow-only state through the same shared renderer", async () => {
    const handleBodyChange = jest.fn();
    const handleFooterChange = jest.fn();
    const handleCtaChange = jest.fn();

    render(
      <WhatsAppActionRenderer
        bodyText="Flow body"
        onBodyTextChange={handleBodyChange}
        footerText="Flow footer"
        onFooterTextChange={handleFooterChange}
        ctaText="Start"
        onCtaTextChange={handleCtaChange}
        editorTray={<div>Flow form editor</div>}
      />
    );

    fireEvent.change(await screen.findByDisplayValue("Flow body"), {
      target: { value: "Updated flow body" },
    });
    fireEvent.change(await screen.findByDisplayValue("Flow footer"), {
      target: { value: "Updated flow footer" },
    });
    fireEvent.change(await screen.findByDisplayValue("Start"), {
      target: { value: "Continue" },
    });

    expect(handleBodyChange).toHaveBeenCalledWith("Updated flow body");
    expect(handleFooterChange).toHaveBeenCalledWith("Updated flow footer");
    expect(handleCtaChange).toHaveBeenCalledWith("Continue");
    expect(screen.queryByText("Flow form editor")).not.toBeNull();
  });

  it("names header media in the merchant language", () => {
    const { rerender } = render(
      <WhatsAppActionRenderer
        headerMediaFormat="IMAGE"
        headerMediaUrl="https://cdn.example/header.png"
        bodyText="Body"
      />
    );
    expect(
      screen.getByTestId("whatsapp-template-image-preview")
    ).toHaveAttribute("alt", "whatsappTemplateHeaderImage");

    rerender(
      <WhatsAppActionRenderer
        headerMediaFormat="VIDEO"
        headerMediaUrl="https://cdn.example/header.mp4"
        bodyText="Body"
      />
    );
    expect(
      screen.getByTestId("whatsapp-template-video-preview")
    ).toHaveAttribute("aria-label", "whatsappTemplateHeaderVideo");
  });

  it("shows an icon and a localized type for media without a preview", () => {
    render(
      <WhatsAppActionRenderer headerMediaFormat="DOCUMENT" bodyText="Body" />
    );
    const placeholder = screen.getByTestId("whatsapp-header-media-placeholder");
    expect(placeholder.textContent).toBe("whatsappServiceMediaDocument");
    expect(placeholder.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(screen.queryByText("DOCUMENT")).toBeNull();
  });

  it("labels the header and footer editors explicitly", async () => {
    render(
      <WhatsAppActionRenderer
        headerText=""
        onHeaderTextChange={() => {}}
        headerPlaceholder="Header (optional)"
        bodyText="Body"
        onBodyTextChange={() => {}}
        bodyPlaceholder="Write the message"
        footerText=""
        onFooterTextChange={() => {}}
        footerPlaceholder="Footer (optional)"
      />
    );
    expect(
      await screen.findByRole("textbox", { name: "Header (optional)" })
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Footer (optional)" })
    ).toBeTruthy();
  });
});
