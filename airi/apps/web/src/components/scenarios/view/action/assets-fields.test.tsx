/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioActionAssetsFields } from "./assets-fields";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const noop = () => {};

describe("ScenarioActionAssetsFields", () => {
  beforeAll(() => {
    installMatchMedia();
  });

  it("renders video attachments as playable previews", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={["https://cdn.example.com/generated-launch.mp4"]}
        isUploadingActionImage={false}
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    const video = screen.getByTestId("scenario-action-video-preview");
    expect(video.getAttribute("src")).toBe(
      "https://cdn.example.com/generated-launch.mp4"
    );
  });

  it("shows a placeholder, not a broken image, while an attachment waits to be signed", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[
          "gcs://airi-assets/ws-1/card.png",
          "gs://airi-assets/ws-1/launch.mp4",
          "https://cdn.example.com/signed.png",
        ]}
        isUploadingActionImage={false}
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    const pending = screen.getAllByRole("img", { name: /action(File|Video)N/ });
    expect(pending.map(node => node.tagName)).toEqual(["DIV", "DIV", "IMG"]);
    expect(pending[2]?.getAttribute("src")).toBe(
      "https://cdn.example.com/signed.png"
    );
    expect(screen.queryByTestId("scenario-action-video-preview")).toBe(null);
    expect(document.querySelector('[src^="gcs://"], [src^="gs://"]')).toBe(
      null
    );
  });

  it("shows the primary link URL inline for WhatsApp reply link CTAs", () => {
    const onReplacePrimaryLinkUrl = jest.fn();

    render(
      <ScenarioActionAssetsFields
        linkUrls={["https://old.example.com/catalog"]}
        imageUrls={[]}
        isUploadingActionImage={false}
        ctaType="link"
        ctaButtonLabel="Open catalog"
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onCtaTypeChange={noop}
        onCtaButtonLabelChange={noop}
        onCtaFlowIdChange={noop}
        onReplacePrimaryLinkUrl={onReplacePrimaryLinkUrl}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    const linkInput = screen.getByDisplayValue(
      "https://old.example.com/catalog"
    );
    expect(
      screen.getByDisplayValue("Open catalog").getAttribute("maxlength")
    ).toBe("20");
    fireEvent.change(linkInput, {
      target: { value: "https://new.example.com/catalog" },
    });
    fireEvent.blur(linkInput);

    expect(onReplacePrimaryLinkUrl).toHaveBeenCalledWith(
      "https://new.example.com/catalog"
    );
    expect(screen.queryByText("actionFixedLinks")).toBeNull();
  });

  it("can render the attachment trigger as a file input label", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[]}
        isUploadingActionImage={false}
        uploadInputId="scenario-action-file-input-test"
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    const trigger = screen.getByTestId(
      "scenario-action-attachment-upload-trigger"
    );

    expect(trigger.tagName).toBe("LABEL");
    expect(trigger.getAttribute("for")).toBe("scenario-action-file-input-test");
  });

  it("adds links inline instead of in a dialog", () => {
    const onAddLinkUrl = jest.fn();
    const onRemoveLinkUrl = jest.fn();
    render(
      <ScenarioActionAssetsFields
        linkUrls={["https://example.com/menu"]}
        imageUrls={[]}
        isUploadingActionImage={false}
        onAddLinkUrl={onAddLinkUrl}
        onRemoveLinkUrl={onRemoveLinkUrl}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    expect(screen.getByText("actionFixedLinks")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    const input = screen.getByRole("textbox", { name: "actionLinkInputLabel" });
    expect(input.getAttribute("placeholder")).toBe("actionAddLinkPlaceholder");
    const add = screen.getByRole("button", { name: "actionAddLink" });
    expect(add).toHaveProperty("disabled", true);

    fireEvent.change(input, { target: { value: "https://example.com/menu" } });
    expect(screen.getByText("actionAddLinkAlreadyExists")).toBeTruthy();
    expect(add).toHaveProperty("disabled", true);

    fireEvent.change(input, { target: { value: "https://example.com/book" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddLinkUrl).toHaveBeenCalledWith("https://example.com/book");
    expect(input).toHaveProperty("value", "");

    fireEvent.click(screen.getByRole("button", { name: "actionRemoveLink" }));
    expect(onRemoveLinkUrl).toHaveBeenCalledWith("https://example.com/menu");
  });

  it("names the reply button fields and shows form names without raw ids", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[]}
        isUploadingActionImage={false}
        ctaType="flow"
        ctaButtonLabel="Book"
        ctaFlowId="flow-123"
        ctaFlowOptions={[]}
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onCtaTypeChange={noop}
        onCtaButtonLabelChange={noop}
        onCtaFlowIdChange={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "actionCtaType" })
    ).toBeTruthy();
    expect(screen.getByLabelText("buttonText")).toHaveProperty("value", "Book");
    const form = screen.getByRole("combobox", { name: "actionCtaTypeFlow" });
    expect(form.textContent).toContain("untitledForm");
    expect(form.textContent).not.toContain("flow-123");
  });

  it("shows a loading placeholder while forms load", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[]}
        isUploadingActionImage={false}
        ctaType="flow"
        ctaFlowOptions={[]}
        ctaFlowLoading
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onCtaTypeChange={noop}
        onCtaButtonLabelChange={noop}
        onCtaFlowIdChange={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    expect(screen.getByRole("status").textContent).toBe(
      "flowPickerExistingLoading"
    );
    expect(screen.queryByText("actionCtaFlowNoOptions")).toBeNull();
  });

  it("disables attaching at the limit and says why", () => {
    const onRemoveImageUrl = jest.fn();
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[
          "https://cdn.example.com/a.png",
          "https://cdn.example.com/b.pdf",
        ]}
        maxImageCount={2}
        isUploadingActionImage={false}
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={onRemoveImageUrl}
      />
    );

    expect(
      screen.getByTestId("scenario-action-attachment-count").textContent
    ).toBe("2/2");
    const trigger = screen.getByTestId(
      "scenario-action-attachment-upload-trigger"
    );
    expect(trigger).toHaveProperty("disabled", true);
    const limit = screen.getByText("actionAttachmentLimit");
    expect(trigger.getAttribute("aria-describedby")).toBe(limit.id);
    expect(screen.queryByText("actionAttachmentDropHint")).toBeNull();
    expect(screen.getByAltText("actionFileN")).toBeTruthy();
    expect(screen.getByText("whatsappServiceMediaDocument")).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: "actionRemoveFile" })[1]
    );
    expect(onRemoveImageUrl).toHaveBeenCalledWith(
      "https://cdn.example.com/b.pdf"
    );
  });

  it("shows one drop hint and no empty-state text", () => {
    render(
      <ScenarioActionAssetsFields
        linkUrls={[]}
        imageUrls={[]}
        isUploadingActionImage={false}
        onAddLinkUrl={noop}
        onRemoveLinkUrl={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    expect(screen.getAllByText("actionAttachmentDropHint")).toHaveLength(1);
    expect(
      screen.getByTestId("scenario-action-attachment-dropzone").textContent
    ).toBe("actionAttachmentDropHint");
    expect(screen.queryByText("actionAttachmentLimit")).toBeNull();
  });

  it("takes dropped files only while there is room", () => {
    const onUploadFiles = jest.fn();
    const props = {
      linkUrls: [],
      imageUrls: ["https://cdn.example.com/a.png"],
      maxImageCount: 2,
      isUploadingActionImage: false,
      onAddLinkUrl: noop,
      onRemoveLinkUrl: noop,
      onUploadImageClick: noop,
      onUploadFiles,
      onRemoveImageUrl: noop,
    };
    const { rerender } = render(<ScenarioActionAssetsFields {...props} />);
    const dropzone = screen.getByTestId("scenario-action-attachment-dropzone");
    const files = [new File(["b"], "b.png", { type: "image/png" })];

    const over = { dropEffect: "", files };
    fireEvent.dragOver(dropzone, { dataTransfer: over });
    expect(over.dropEffect).toBe("copy");
    expect(dropzone.className).toContain("border-primary/60");
    fireEvent.drop(dropzone, { dataTransfer: { dropEffect: "", files } });
    expect(onUploadFiles).toHaveBeenCalledWith(files);
    expect(dropzone.className).not.toContain("border-primary/60");

    rerender(
      <ScenarioActionAssetsFields
        {...props}
        imageUrls={[...props.imageUrls, "https://cdn.example.com/b.png"]}
      />
    );
    const full = { dropEffect: "", files };
    fireEvent.dragOver(dropzone, { dataTransfer: full });
    expect(full.dropEffect).toBe("none");
    expect(dropzone.className).not.toContain("border-primary/60");
    fireEvent.drop(dropzone, { dataTransfer: { dropEffect: "", files } });
    expect(onUploadFiles).toHaveBeenCalledTimes(1);
  });

  it("opens the file input from the attachment label with the keyboard", () => {
    const onInputClick = jest.fn();
    render(
      <>
        <input
          id="scenario-action-file-input-keys"
          type="file"
          onClick={onInputClick}
        />
        <ScenarioActionAssetsFields
          linkUrls={[]}
          imageUrls={[]}
          isUploadingActionImage={false}
          uploadInputId="scenario-action-file-input-keys"
          onAddLinkUrl={noop}
          onRemoveLinkUrl={noop}
          onUploadImageClick={noop}
          onRemoveImageUrl={noop}
        />
      </>
    );

    const trigger = screen.getByTestId(
      "scenario-action-attachment-upload-trigger"
    );
    fireEvent.keyDown(trigger, { key: "a" });
    expect(onInputClick).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onInputClick).toHaveBeenCalledTimes(2);
  });

  it("removes the link when a link CTA URL is cleared without a replace handler", () => {
    const onRemoveLinkUrl = jest.fn();
    render(
      <ScenarioActionAssetsFields
        linkUrls={["https://example.com/menu"]}
        imageUrls={[]}
        isUploadingActionImage={false}
        ctaType="link"
        onAddLinkUrl={noop}
        onRemoveLinkUrl={onRemoveLinkUrl}
        onCtaTypeChange={noop}
        onCtaButtonLabelChange={noop}
        onCtaFlowIdChange={noop}
        onUploadImageClick={noop}
        onRemoveImageUrl={noop}
      />
    );

    const linkInput = screen.getByDisplayValue("https://example.com/menu");
    fireEvent.change(linkInput, { target: { value: " " } });
    fireEvent.keyDown(linkInput, { key: "Enter" });

    expect(onRemoveLinkUrl).toHaveBeenCalledWith("https://example.com/menu");
    expect(linkInput).toHaveProperty("value", "");
  });

  it("names the Telegram URL button only when the action has links", () => {
    const onTelegramUrlButtonLabelChange = jest.fn();
    const props = {
      imageUrls: [],
      isUploadingActionImage: false,
      hideReplyCtaChrome: true,
      telegramUrlButtonLabel: "Visit",
      onTelegramUrlButtonLabelChange,
      onAddLinkUrl: noop,
      onRemoveLinkUrl: noop,
      onUploadImageClick: noop,
      onRemoveImageUrl: noop,
    };
    const { rerender } = render(
      <ScenarioActionAssetsFields {...props} linkUrls={[]} />
    );
    expect(screen.queryByLabelText("actionTelegramUrlButtonLabel")).toBeNull();

    rerender(
      <ScenarioActionAssetsFields
        {...props}
        linkUrls={["https://example.com/menu"]}
      />
    );
    const label = screen.getByLabelText("actionTelegramUrlButtonLabel");
    expect(label).toHaveProperty("value", "Visit");
    fireEvent.change(label, { target: { value: "Shop" } });
    expect(onTelegramUrlButtonLabelChange).toHaveBeenCalledWith("Shop");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
