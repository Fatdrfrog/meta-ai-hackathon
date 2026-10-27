/**
 * @jest-environment jsdom
 */

import { fetchWhatsAppFlowsList } from "@/lib/whatsapp/flows/client";
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { StrictMode } from "react";
import { toast } from "sonner";
import { reloadToLatestAppVersion } from "@/lib/app-version-reload";
import {
  getTemplateEditorDraftKey,
  readTemplateEditorDraft,
} from "./template-editor-draft";
import { TemplateEditorForm } from "./template-editor-form";
import { TemplateFormDrawer } from "./template-form-drawer";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

jest.mock("@/lib/app-version-reload", () => ({
  reloadToLatestAppVersion: jest.fn(),
}));

installResizeObserver();

// The editor autosaves drafts to localStorage; each test starts without one.
beforeEach(() => {
  window.localStorage.clear();
});

const mockCreateUnifiedTemplateAction = jest.fn();
const mockUpdateTemplateAction = jest.fn();
const mockUpdateUnifiedTemplateAction = jest.fn();
const mockUploadToSignedUrl = jest.fn();
const mockFetchWhatsAppFlowsList =
  fetchWhatsAppFlowsList as jest.MockedFunction<typeof fetchWhatsAppFlowsList>;

jest.mock("@/features/panel/messengers/whatsapp-templates/actions", () => ({
  createUnifiedTemplateAction: (...args: unknown[]) =>
    mockCreateUnifiedTemplateAction(...args),
  updateTemplateAction: (...args: unknown[]) =>
    mockUpdateTemplateAction(...args),
  updateUnifiedTemplateAction: (...args: unknown[]) =>
    mockUpdateUnifiedTemplateAction(...args),
}));

jest.mock("@/lib/whatsapp/flows/client", () => ({
  ...jest.requireActual("@/lib/whatsapp/flows/client"),
  fetchWhatsAppFlowsList: jest.fn(),
}));

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        uploadToSignedUrl: (...args: unknown[]) =>
          mockUploadToSignedUrl(...args),
      }),
    },
  }),
}));

jest.mock("@/components/assets/creative-asset-picker-dialog", () => ({
  CreativeAssetPickerDialog: ({
    open,
    onSelect,
    assetFilter,
  }: {
    open: boolean;
    onSelect: (asset: {
      id: string;
      kind: "image" | "video";
      source: "higgsfield";
      status: "complete";
      url: string;
      mimeType: string;
      fileName: string;
      fileSize: number;
    }) => void;
    assetFilter?: (asset: {
      id: string;
      kind: "image" | "video";
      source: "higgsfield";
      status: "complete";
      url: string;
      mimeType: string;
      fileName: string;
      fileSize: number;
    }) => boolean;
  }) => {
    const imageAsset = {
      id: "asset-1",
      kind: "image" as const,
      source: "higgsfield" as const,
      status: "complete" as const,
      url: "https://storage.example.com/header.jpg",
      mimeType: "image/jpeg",
      fileName: "header.jpg",
      fileSize: 1234,
    };
    const movVideoAsset = {
      id: "asset-2",
      kind: "video" as const,
      source: "higgsfield" as const,
      status: "complete" as const,
      url: "https://storage.example.com/header.mov",
      mimeType: "video/quicktime",
      fileName: "header.mov",
      fileSize: 1234,
    };
    if (!open) return null;
    return (
      <>
        {!assetFilter || assetFilter(imageAsset) ? (
          <button type="button" onClick={() => onSelect(imageAsset)}>
            Pick asset
          </button>
        ) : null}
        {!assetFilter || assetFilter(movVideoAsset) ? (
          <button type="button" onClick={() => onSelect(movVideoAsset)}>
            Pick MOV asset
          </button>
        ) : null}
      </>
    );
  },
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      "form.attachMedia": "Attach media",
      "form.dropMediaHere": "Drop media here",
      "form.mediaDropzoneDescription":
        "Drag and drop a file here, or attach from device.",
      "form.mediaExample": "Media sample",
      "form.mediaExamplePlaceholder": "Public media URL or Meta header handle",
      "form.mediaRequirement":
        "Provide a sample media URL or existing Meta header handle so Meta can review this media header.",
      "form.mediaUploadFailed": "Failed to upload media",
      "form.mediaUploading": "Uploading media...",
      "form.removeMedia": "Remove uploaded media",
      "form.body": "Body (Required)",
      "form.bodyText": "Body Text",
      "form.authPreset": "Verification code",
      "form.authSecurityRecommendation":
        "Include a warning not to share the code",
      "form.authExpiry": "Expiry warning (minutes, optional)",
      "form.errors.authExpiryRange":
        "Choose a whole number from 1 to 90 minutes, or leave it empty.",
      "form.required": "required",
      "form.bodyPlaceholder": "Hello {v1}, your order {v2} is ready!",
      "form.footer": "Footer (Optional)",
      "form.addHeader": "Add Header",
      "form.removeHeader": "Remove Header",
      "form.addFooter": "Add footer",
      "form.removeFooter": "Remove footer",
      "form.buttons": "Buttons (Optional)",
      "form.addButtons": "Add buttons",
      "form.removeButtons": "Remove buttons",
      "form.layout": "Message shape",
      "form.layoutHint":
        "WhatsApp marketing templates are one shape. Carousel is not a button.",
      "form.layoutStandard": "Standard message",
      "form.layoutStandardDescription": "One bubble with optional extras.",
      "form.layoutStandardIncludes": "Optional header, footer, and buttons",
      "form.layoutStandardExcludes": "Cannot include carousel cards",
      "form.layoutCarousel": "Media carousel",
      "form.layoutCarouselDescription": "Body plus product cards.",
      "form.layoutCarouselIncludes": "Body plus 2–10 media cards",
      "form.layoutCarouselExcludes":
        "Cannot include a message header, footer, or buttons",
      "form.layoutHiddenStandard":
        "Header, footer, and message buttons stay saved.",
      "form.layoutHiddenCarousel": "Carousel cards stay saved.",
      "form.carousel": "Carousel cards",
      "form.addCarousel": "Add carousel",
      "form.removeCarousel": "Remove carousel",
      "form.carouselHint":
        "Every card must use the same media type and button types.",
      "form.carouselHeaderFormat": "Card media",
      "form.location": "Location",
      "form.carouselButtons": "Card buttons",
      "form.carouselButtonsHint":
        "Same buttons on every card ({count} of {max}).",
      "form.carouselButtonSlotType": "Button {index} type",
      "form.removeCarouselButtonSlot": "Remove button {index}",
      "form.carouselButtonTextPlaceholder": "Button label",
      "form.chooseAsset": "Choose asset",
      "form.addCarouselCard": "Add card",
      "form.removeCarouselCard": "Remove card",
      "form.carouselCard": "Card",
      "form.carouselCardBody": "Card text",
      "form.carouselCardBodyPlaceholder": "Short card caption",
      "form.image": "Image",
      "form.video": "Video",
      "form.flow": "Flow",
      "form.category": "Category",
      "categories.UTILITY": "Utility",
      "categories.MARKETING": "Marketing",
      "categories.AUTHENTICATION": "Authentication",
      "form.phoneNumber": "Phone Number",
      "form.errors.carouselCardMediaRequired":
        "Each carousel card needs a sample image or video",
      "form.errors.carouselCardBodyRequired":
        "Each carousel card needs body text",
      "form.errors.buttonTextRequired": "Button text is required",
      "form.removeButton": "Remove button",
      "form.button": "Button",
      "form.type": "Type",
      "form.quickReply": "Quick Reply",
      "form.buttonText": "Button Text",
      "form.buttonTextPlaceholder": "Get Started",
      "form.addButton": "Add Button",
      "form.url": "URL",
      "form.formatToolbar": "WhatsApp text formatting",
      "form.formatBold": "Bold",
      "form.formatItalic": "Italic",
      "form.formatStrikethrough": "Strikethrough",
      "form.formatMonospace": "Monospace",
      "form.templateVideoRequirement":
        "Template videos must be MP4 or 3GP and 16MB or smaller.",
      "form.templateVideoTooLarge": "Template videos must be 16MB or smaller.",
      "form.templateVideoUnsupported":
        "Template videos must be MP4 or 3GP. MOV is not supported for WhatsApp templates.",
      "form.editDisabledStatus":
        "Meta only allows editing WhatsApp templates after they are Approved, Rejected, or Paused. Delete or duplicate this template instead.",
      "form.updateTemplate": "Update Template",
      "form.uploadedMedia": "{fileName} attached",
      "flowHealth.screenMissing":
        'The "{button}" button opens screen {screen}, but Flow "{flow}" no longer has it. Customers can\'t open it.',
      "flowHealth.notPublished":
        'Flow "{flow}" isn\'t published. Customers can\'t open the "{button}" button.',
      "flowHealth.screensAvailable": "Screens in this Flow: {screens}",
      "flowHealth.missingScreenOption": "{screen} (not in this Flow)",
    };

    const translate = (key: string, values?: Record<string, string>) => {
      const template = messages[key] ?? key;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template
      );
    };
    translate.rich = (key: string) => messages[key] ?? key;
    return translate;
  },
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} alt={props.alt || ""} />
  ),
}));

const originalFetch = global.fetch;
const TEMPLATE_VIDEO_LIMIT_BYTES = 16 * 1024 * 1024;

function renderImageHeaderForm(layout?: "default" | "modal") {
  return render(
    <TemplateEditorForm
      workspaceId="workspace-1"
      onSuccess={jest.fn()}
      layout={layout}
      template={
        {
          id: "template-1",
          metaId: "meta-template-1",
          name: "promo_image",
          language: "en",
          category: "MARKETING",
          channel: "whatsapp",
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: {
                header_handle: ["https://example.com/old-header.jpg"],
              },
            },
            {
              type: "BODY",
              text: "See our new offer",
            },
          ],
        } as never
      }
    />
  );
}

function renderVideoHeaderForm() {
  return render(
    <TemplateEditorForm
      workspaceId="workspace-1"
      onSuccess={jest.fn()}
      template={
        {
          id: "template-1",
          metaId: "meta-template-1",
          name: "promo_video",
          language: "en",
          category: "MARKETING",
          channel: "whatsapp",
          components: [
            {
              type: "HEADER",
              format: "VIDEO",
              example: {
                header_handle: ["https://example.com/old-header.mp4"],
              },
            },
            {
              type: "BODY",
              text: "See our new offer",
            },
          ],
        } as never
      }
    />
  );
}

function renderFlowButtonForm() {
  return render(
    <TemplateEditorForm
      workspaceId="workspace-1"
      onSuccess={jest.fn()}
      template={
        {
          id: "template-1",
          metaId: "meta-template-1",
          name: "flow_template",
          language: "en",
          category: "MARKETING",
          channel: "whatsapp",
          components: [
            {
              type: "BODY",
              text: "Open the flow",
            },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "FLOW",
                  text: "Start",
                  flow_id: "flow-1",
                  flow_action: "navigate",
                  navigate_screen: "START",
                },
              ],
            },
          ],
        } as never
      }
    />
  );
}

function mockSuccessfulUpload(url: string, fileName: string) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      upload: {
        bucket: "conversation-images",
        path: "whatsapp-template-headers/workspace-1/header.png",
        token: "signed-token",
      },
      media: {
        url,
        fileName,
        mimeType: "image/png",
        fileSize: 7,
      },
    }),
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe("TemplateEditorForm media header uploads", () => {
  it("updates an approved location template without dropping its header or requesting media", async () => {
    mockUpdateTemplateAction.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    mockUpdateUnifiedTemplateAction.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    const { container } = render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-1",
            dbId: "db-1",
            name: "location_demo",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              { type: "HEADER", format: "LOCATION" },
              { type: "BODY", text: "Original demo body" },
            ],
          } as never
        }
      />
    );
    expect(screen.getByText("Location", { selector: "span" })).toBeVisible();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(
      screen.queryByTestId("template-header-media-dropzone")
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Original demo body"), {
      target: { value: "Updated demo body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));
    await waitFor(() =>
      expect(mockUpdateTemplateAction).toHaveBeenCalledTimes(1)
    );
    expect(mockUpdateTemplateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          { type: "HEADER", format: "LOCATION" },
          { type: "BODY", text: "Updated demo body" },
        ],
      })
    );
  });

  beforeEach(() => {
    mockUploadToSignedUrl.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it.each(["success", "failure", "exception"])(
    "ignores old create %s after the drawer closes and reopens",
    async outcome => {
      let resolve!: (value: {
        success: boolean;
        data?: { id: string };
        error?: string;
      }) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<{
        success: boolean;
        data?: { id: string };
        error?: string;
      }>((complete, fail) => {
        resolve = complete;
        reject = fail;
      });
      mockCreateUnifiedTemplateAction.mockReturnValueOnce(pending);
      const onSuccess = jest.fn();
      const props = {
        workspaceId: "workspace-1",
        onSuccess,
        onOpenChange: jest.fn(),
      };
      const { rerender } = render(<TemplateFormDrawer {...props} open />);
      fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
        target: { value: "first_template" },
      });
      fireEvent.change(screen.getByPlaceholderText(/^Hello /), {
        target: { value: "First body" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "form.createTemplate" })
      );
      await waitFor(() =>
        expect(mockCreateUnifiedTemplateAction).toHaveBeenCalledTimes(1)
      );
      rerender(<TemplateFormDrawer {...props} open={false} />);
      rerender(<TemplateFormDrawer {...props} open />);
      fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
        target: { value: "new_template" },
      });
      fireEvent.change(screen.getByPlaceholderText(/^Hello /), {
        target: { value: "New body" },
      });
      await act(async () =>
        outcome === "exception"
          ? reject(new Error("Old exception"))
          : resolve(
              outcome === "success"
                ? { success: true, data: { id: "created" } }
                : { success: false, error: "Old rejection" }
            )
      );
      expect(screen.getByDisplayValue("new_template")).toBeInTheDocument();
      expect(screen.getByDisplayValue("New body")).toBeInTheDocument();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(props.onOpenChange).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it("edits preset authentication options without an editable message or variable toolbar", async () => {
    mockUpdateTemplateAction.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    const { container } = render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "auth-template-1",
            metaId: "meta-auth-1",
            name: "verification_code",
            language: "en",
            status: "APPROVED",
            category: "AUTHENTICATION",
            channel: "whatsapp",
            components: [
              {
                type: "BODY",
                text: "{{1}} is your verification code.",
                add_security_recommendation: true,
              },
              {
                type: "FOOTER",
                text: "This code expires in 5 minutes.",
                code_expiration_minutes: 5,
              },
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "URL",
                    text: "Copy code",
                    url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}",
                  },
                ],
              },
            ],
          } as never
        }
      />
    );
    expect(
      screen.queryByRole("textbox", { name: /Body Text/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("WhatsApp text formatting")
    ).not.toBeInTheDocument();
    expect(container.querySelector("textarea")).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Include a warning not to share the code",
      })
    );
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Expiry warning (minutes, optional)",
      }),
      { target: { value: "10" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));
    await waitFor(() =>
      expect(mockUpdateTemplateAction).toHaveBeenCalledTimes(1)
    );
    expect(mockUpdateTemplateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [
          { type: "BODY", add_security_recommendation: false },
          { type: "FOOTER", code_expiration_minutes: 10 },
          {
            type: "BUTTONS",
            buttons: [{ type: "OTP", otp_type: "COPY_CODE" }],
          },
        ],
      })
    );
  });

  it.each(["0", "91", "1.5"])(
    "blocks invalid authentication expiry %s in the editor",
    async expiry => {
      const { container } = render(
        <TemplateEditorForm
          workspaceId="workspace-1"
          onSuccess={jest.fn()}
          template={
            {
              id: "auth-template-1",
              metaId: "meta-auth-1",
              name: "verification_code",
              language: "en",
              status: "APPROVED",
              category: "AUTHENTICATION",
              channel: "whatsapp",
              components: [
                { type: "BODY", add_security_recommendation: true },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "OTP", otp_type: "COPY_CODE" }],
                },
              ],
            } as never
          }
        />
      );
      fireEvent.change(
        screen.getByRole("spinbutton", {
          name: "Expiry warning (minutes, optional)",
        }),
        { target: { value: expiry } }
      );
      fireEvent.submit(container.querySelector("form")!);
      expect(
        await screen.findByText(
          "Choose a whole number from 1 to 90 minutes, or leave it empty."
        )
      ).toBeInTheDocument();
      expect(mockUpdateTemplateAction).not.toHaveBeenCalled();
    }
  );

  it("submits once and completes normally with StrictMode effect replay", async () => {
    let resolve!: (value: { success: true; data: { id: string } }) => void;
    mockCreateUnifiedTemplateAction.mockReturnValueOnce(
      new Promise(complete => {
        resolve = complete;
      })
    );
    const onSuccess = jest.fn();
    const { container } = render(
      <StrictMode>
        <TemplateEditorForm workspaceId="workspace-1" onSuccess={onSuccess} />
      </StrictMode>
    );
    fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
      target: { value: "first_template" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Hello /), {
      target: { value: "First body" },
    });
    fireEvent.submit(container.querySelector("form")!);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() =>
      expect(mockCreateUnifiedTemplateAction).toHaveBeenCalledTimes(1)
    );
    await act(async () => resolve({ success: true, data: { id: "created" } }));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("finishes the unified update after a successful Meta update even when unmounted", async () => {
    let resolve!: (value: { success: true; data: { success: true } }) => void;
    mockUpdateTemplateAction.mockReturnValueOnce(
      new Promise(complete => {
        resolve = complete;
      })
    );
    mockUpdateUnifiedTemplateAction.mockResolvedValueOnce({
      success: true,
      data: { success: true },
    });
    const onSuccess = jest.fn();
    const { unmount } = render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={onSuccess}
        template={
          {
            id: "template-1",
            metaId: "meta-1",
            dbId: "db-1",
            name: "approved_template",
            language: "en",
            status: "APPROVED",
            category: "UTILITY",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Original body" }],
          } as never
        }
      />
    );
    fireEvent.change(screen.getByDisplayValue("Original body"), {
      target: { value: "Updated body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));
    await waitFor(() =>
      expect(mockUpdateTemplateAction).toHaveBeenCalledTimes(1)
    );
    unmount();
    await act(async () => resolve({ success: true, data: { success: true } }));
    expect(mockUpdateUnifiedTemplateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        templateId: "db-1",
      })
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("uploads an attached local media file and uses the returned public URL as the media sample", async () => {
    const fetchMock = mockSuccessfulUpload(
      "https://cdn.example.com/templates/header.png",
      "header.png"
    );
    const { container } = renderImageHeaderForm();
    const file = new File(["header"], "header.png", { type: "image/png" });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(
        screen.getByDisplayValue("https://cdn.example.com/templates/header.png")
      ).toBeInTheDocument();
    });
    expect(screen.getByText("header.png attached")).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/whatsapp-template-header-media",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      mode: "direct",
      fileName: "header.png",
      fileSize: file.size,
      format: "IMAGE",
      mimeType: "image/png",
    });
    expect(mockUploadToSignedUrl).toHaveBeenCalledWith(
      "whatsapp-template-headers/workspace-1/header.png",
      "signed-token",
      file,
      expect.objectContaining({
        contentType: "image/png",
        upsert: false,
      })
    );
  });

  it("shows an HTTP upload error instead of leaking HTML JSON parse failures", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 413,
      text: async () => "<html><body>Request Entity Too Large</body></html>",
    });
    global.fetch = fetchMock as typeof fetch;
    const { container } = renderImageHeaderForm();
    const file = new File(["header"], "header.png", { type: "image/png" });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByText(
        "Media upload request is too large for the current upload endpoint. Try a smaller file or choose an existing uploaded asset."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
  });

  it("uses a selected workspace asset as the media sample", async () => {
    renderImageHeaderForm();

    fireEvent.click(screen.getByRole("button", { name: "Choose asset" }));
    fireEvent.click(await screen.findByText("Pick asset"));

    expect(
      screen.getByPlaceholderText("Public media URL or Meta header handle")
    ).toHaveValue("https://storage.example.com/header.jpg");
    expect(screen.getByText("header.jpg attached")).toBeInTheDocument();
  });

  it("filters unsupported workspace assets out of WhatsApp video header selection", async () => {
    renderVideoHeaderForm();

    fireEvent.click(screen.getByRole("button", { name: "Choose asset" }));

    expect(screen.queryByText("Pick MOV asset")).not.toBeInTheDocument();
  });

  it("uploads a dropped local media file and uses the returned public URL as the media sample", async () => {
    const fetchMock = mockSuccessfulUpload(
      "https://cdn.example.com/templates/drop.png",
      "drop.png"
    );
    renderImageHeaderForm();
    const file = new File(["drop"], "drop.png", { type: "image/png" });

    fireEvent.drop(screen.getByTestId("template-header-media-dropzone"), {
      dataTransfer: {
        files: [file],
        items: [
          {
            kind: "file",
            getAsFile: () => file,
          },
        ],
        types: ["Files"],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByDisplayValue("https://cdn.example.com/templates/drop.png")
      ).toBeInTheDocument();
    });
    expect(screen.getByText("drop.png attached")).toBeInTheDocument();

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      mode: "direct",
      fileName: "drop.png",
      fileSize: file.size,
      format: "IMAGE",
      mimeType: "image/png",
    });
    expect(mockUploadToSignedUrl).toHaveBeenCalledWith(
      "whatsapp-template-headers/workspace-1/header.png",
      "signed-token",
      file,
      expect.objectContaining({
        contentType: "image/png",
        upsert: false,
      })
    );
  });

  it("keeps the latest media upload when an older upload resolves later", async () => {
    let resolveFirstUpload:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    let resolveSecondUpload:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirstUpload = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveSecondUpload = resolve;
          })
      );
    global.fetch = fetchMock as typeof fetch;
    const { container } = renderImageHeaderForm();
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    const firstFile = new File(["first"], "first.png", { type: "image/png" });
    const secondFile = new File(["second"], "second.png", {
      type: "image/png",
    });

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [firstFile] },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [secondFile] },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    resolveSecondUpload?.({
      ok: true,
      json: async () => ({
        success: true,
        upload: {
          bucket: "conversation-images",
          path: "whatsapp-template-headers/workspace-1/second.png",
          token: "signed-token-2",
        },
        media: {
          url: "https://cdn.example.com/templates/second.png",
          fileName: "second.png",
          mimeType: "image/png",
          fileSize: 7,
        },
      }),
    });
    await waitFor(() => {
      expect(
        screen.getByDisplayValue("https://cdn.example.com/templates/second.png")
      ).toBeInTheDocument();
    });

    resolveFirstUpload?.({
      ok: true,
      json: async () => ({
        success: true,
        upload: {
          bucket: "conversation-images",
          path: "whatsapp-template-headers/workspace-1/first.png",
          token: "signed-token-1",
        },
        media: {
          url: "https://cdn.example.com/templates/first.png",
          fileName: "first.png",
          mimeType: "image/png",
          fileSize: 7,
        },
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(
      screen.getByDisplayValue("https://cdn.example.com/templates/second.png")
    ).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("https://cdn.example.com/templates/first.png")
    ).not.toBeInTheDocument();
  });

  it("rejects MOV files for WhatsApp template video headers before upload", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    const { container } = renderVideoHeaderForm();
    const file = new File(["video"], "clip.mov", { type: "video/quicktime" });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("accept", "video/mp4,video/3gpp");

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByText(
        "Template videos must be MP4 or 3GP. MOV is not supported for WhatsApp templates."
      )
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows WhatsApp template video headers at exactly 16MB before upload", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        upload: {
          bucket: "conversation-images",
          path: "whatsapp-template-headers/workspace-1/header.mp4",
          token: "signed-video-token",
        },
        media: {
          url: "https://cdn.example.com/templates/header.mp4",
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          fileSize: TEMPLATE_VIDEO_LIMIT_BYTES,
        },
      }),
    });
    global.fetch = fetchMock as typeof fetch;
    const { container } = renderVideoHeaderForm();
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", {
      value: TEMPLATE_VIDEO_LIMIT_BYTES,
    });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByText("Template videos must be 16MB or smaller.")
    ).not.toBeInTheDocument();
  });

  it("rejects WhatsApp template video headers larger than 16MB before upload", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    const { container } = renderVideoHeaderForm();
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", {
      value: TEMPLATE_VIDEO_LIMIT_BYTES + 1,
    });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByText("Template videos must be 16MB or smaller.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the modal phone preview read-only and marks the body label required", () => {
    const { container } = render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "promo_body",
            language: "en",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              {
                type: "BODY",
                text: "Body copy",
              },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
              },
            ],
          } as never
        }
      />
    );

    const preview = screen.getByTestId("template-phone-preview");
    expect(preview.querySelector('[contenteditable="true"]')).toBeNull();
    expect(
      preview.querySelector('input[name^="wa-template-button-label"]')
    ).toBeNull();
    expect(screen.queryByText("Body (Required)")).not.toBeInTheDocument();

    const bodyLabel = Array.from(container.querySelectorAll("label")).find(
      label =>
        label.textContent?.replace(/\s+/g, " ").trim() === "Body Text *required"
    );
    expect(bodyLabel).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Hello {{1}}, your order {{2}} is ready!")
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("templates.form.bodyPlaceholder")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Header" })).toHaveAttribute(
      "data-variant",
      "outline"
    );
    expect(screen.getByRole("button", { name: "Add footer" })).toHaveAttribute(
      "data-variant",
      "outline"
    );
    expect(
      screen.getByRole("button", { name: "Remove buttons" })
    ).toHaveAttribute("data-variant", "outline");
    const typeTrigger = screen.getByRole("combobox", { name: "Type" });
    expect(typeTrigger).toHaveClass("w-full");
    expect(typeTrigger).toHaveClass("h-9");
  });

  it("inserts raw WhatsApp formatting markers into the template body", async () => {
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "promo_body",
            language: "en",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              {
                type: "BODY",
                text: "Approved copy",
              },
            ],
          } as never
        }
      />
    );

    const bodyInput = screen.getByDisplayValue(
      "Approved copy"
    ) as HTMLTextAreaElement;
    bodyInput.focus();
    bodyInput.setSelectionRange(0, "Approved".length);

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));

    await waitFor(() => {
      expect(bodyInput).toHaveValue("*Approved* copy");
    });
  });

  it("dedupes Flow list loading and preloads screens for existing Flow buttons", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      data: {
        flows: [{ id: "flow-1", name: "Lead Flow", status: "DRAFT" }],
      },
    } as never);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flowJson: {
          screens: [{ id: "START" }, { id: "DETAILS" }],
        },
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    renderFlowButtonForm();

    await waitFor(() => {
      expect(mockFetchWhatsAppFlowsList).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/api/whatsapp/flows?workspaceId=workspace-1&flowId=flow-1&includeJson=true"
    );
    // The Flow list says DRAFT, so the button can't open for customers.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Flow "Lead Flow" isn\'t published. Customers can\'t open the "Start" button.'
    );
  });

  it("warns when the saved screen is gone from the Flow and keeps it visible", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      data: {
        flows: [{ id: "flow-1", name: "Lead Flow", status: "PUBLISHED" }],
      },
    } as never);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flowJson: { screens: [{ id: "SURVEY_FORM" }] } }),
    }) as typeof fetch;

    renderFlowButtonForm();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      'The "Start" button opens screen START, but Flow "Lead Flow" no longer has it.'
    );
    expect(alert).toHaveTextContent("Screens in this Flow: SURVEY_FORM");
    // The screen picker keeps showing the saved value instead of going blank.
    expect(
      screen.getAllByRole("combobox").map(node => node.textContent)
    ).toContain("START (not in this Flow)");
  });

  it("stays quiet when the saved screen exists in a published Flow", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      data: {
        flows: [{ id: "flow-1", name: "Lead Flow", status: "PUBLISHED" }],
      },
    } as never);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flowJson: { screens: [{ id: "START" }, { id: "DETAILS" }] },
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    renderFlowButtonForm();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks Meta updates for pending WhatsApp templates before submit", () => {
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "pending_template",
            language: "en",
            status: "PENDING",
            category: "MARKETING",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Waiting for review" }],
          } as never
        }
      />
    );

    expect(
      screen.getByText(
        "Meta only allows editing WhatsApp templates after they are Approved, Rejected, or Paused. Delete or duplicate this template instead."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update Template" })
    ).toBeDisabled();
    expect(mockUpdateTemplateAction).not.toHaveBeenCalled();
  });

  it("omits unchanged category from approved WhatsApp template edit payloads", async () => {
    mockUpdateTemplateAction.mockResolvedValue({
      success: true,
      data: { success: true },
    });
    const onSuccess = jest.fn();

    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={onSuccess}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "approved_template",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Approved copy" }],
          } as never
        }
      />
    );

    fireEvent.change(screen.getByDisplayValue("Approved copy"), {
      target: { value: "Approved copy edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
    expect(mockUpdateTemplateAction).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      templateId: "meta-template-1",
      components: expect.arrayContaining([
        expect.objectContaining({
          type: "BODY",
          text: "Approved copy edited",
        }),
      ]),
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("skips Meta updates for unchanged approved WhatsApp templates", async () => {
    const onSuccess = jest.fn();

    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={onSuccess}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "approved_template",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Approved copy" }],
          } as never
        }
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(mockUpdateTemplateAction).not.toHaveBeenCalled();
  });

  it("submits URL buttons from approved WhatsApp template edits", async () => {
    mockUpdateTemplateAction.mockResolvedValue({
      success: true,
      data: { success: true },
    });

    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "approved_url_template",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              { type: "BODY", text: "Apply today" },
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "URL",
                    text: "Apply",
                    url: "https://road2battlefield.com/",
                  },
                ],
              },
            ],
          } as never
        }
      />
    );

    fireEvent.change(screen.getByDisplayValue("Apply today"), {
      target: { value: "Apply today!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
    expect(mockUpdateTemplateAction).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      templateId: "meta-template-1",
      components: expect.arrayContaining([
        {
          type: "BODY",
          text: "Apply today!",
        },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Apply",
              url: "https://road2battlefield.com/",
            },
          ],
        },
      ]),
    });
  });

  it("switches URL and phone fields without uncontrolled inputs and submits only the active destination", async () => {
    Element.prototype.scrollIntoView = jest.fn();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockUpdateTemplateAction.mockResolvedValue({
      success: true,
      data: { success: true },
    });
    try {
      render(
        <TemplateEditorForm
          workspaceId="workspace-1"
          onSuccess={jest.fn()}
          template={
            {
              id: "template-1",
              metaId: "meta-template-1",
              name: "switch_buttons",
              language: "en",
              status: "APPROVED",
              category: "MARKETING",
              channel: "whatsapp",
              components: [
                { type: "BODY", text: "Contact our shop" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Contact" }],
                },
              ],
            } as never
          }
        />
      );
      for (const [option, placeholder, value, inputType] of [
        ["URL", "https://example.com", "https://example.com/shop", "url"],
        ["Phone Number", "+1234567890", "+77001234567", "tel"],
      ]) {
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Type" }), {
          key: "ArrowDown",
        });
        fireEvent.click(await screen.findByRole("option", { name: option }));
        const input = screen.getByPlaceholderText(placeholder);
        fireEvent.change(input, { target: { value } });
        expect(input.getAttribute("type")).toBe(inputType);
      }
      fireEvent.click(screen.getByRole("button", { name: "Update Template" }));
      await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
      expect(
        mockUpdateTemplateAction.mock.calls[0][0].components
      ).toContainEqual({
        type: "BUTTONS",
        buttons: [
          {
            type: "PHONE_NUMBER",
            text: "Contact",
            phone_number: "+77001234567",
          },
        ],
      });
      expect(
        consoleError.mock.calls.filter(args =>
          /uncontrolled|controlled input/.test(String(args[0]))
        )
      ).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  }, 15000);

  it("shows exclusive marketing layouts and hides header footer buttons for carousel", async () => {
    renderImageHeaderForm("modal");

    expect(
      screen.getByRole("radio", { name: "Standard message" })
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Media carousel" })
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Remove Header" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add footer" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add buttons" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Card 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Media carousel" }));

    expect(
      await screen.findByRole("radio", { name: "Media carousel" })
    ).toBeChecked();
    expect(screen.getByText("Card 1")).toBeInTheDocument();
    expect(screen.getByText("Card 2")).toBeInTheDocument();
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Each carousel card needs a sample image or video")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Each carousel card needs body text")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Button text is required")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("template-carousel-preview")).toBeInTheDocument();
    expect(
      screen.getByText("Header, footer, and message buttons stay saved.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Header" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add footer" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add buttons" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Standard message" }));

    expect(
      await screen.findByRole("button", { name: "Remove Header" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Card 1")).not.toBeInTheDocument();
  });

  it("validates carousel cards after submit, not on layout click", async () => {
    const { container } = render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "promo_image",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: ["https://example.com/old-header.jpg"],
                },
              },
              {
                type: "BODY",
                text: "See our new offer",
              },
            ],
          } as never
        }
      />
    );

    expect(container.querySelector("form")).toHaveAttribute("novalidate");
    fireEvent.click(screen.getByRole("radio", { name: "Media carousel" }));
    expect(await screen.findByText("Card 1")).toBeInTheDocument();
    expect(
      screen.queryByText("Each carousel card needs a sample image or video")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    expect(
      await screen.findAllByText(
        "Each carousel card needs a sample image or video"
      )
    ).toHaveLength(2);
    expect(
      screen.getAllByText("Each carousel card needs body text")
    ).toHaveLength(2);
    expect(screen.getAllByText("Button text is required")).toHaveLength(2);
  });

  it("gives each carousel button slot its own type and removes the chosen slot", async () => {
    Element.prototype.scrollIntoView = jest.fn();
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "promo_image",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "See our new offer" }],
          } as never
        }
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Media carousel" }));
    expect(await screen.findByText("Card 1")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove button 1" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Button" }));
    expect(
      await screen.findByRole("combobox", { name: "Button 2 type" })
    ).toHaveTextContent("Quick Reply");
    expect(
      screen.queryByRole("button", { name: "Add Button" })
    ).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Button 2 type" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "URL" }));

    expect(await screen.findAllByText("Button 2 · URL")).toHaveLength(2);
    expect(screen.getAllByText("Button 1 · Quick Reply")).toHaveLength(2);
    expect(screen.getAllByPlaceholderText("https://")).toHaveLength(2);
    expect(
      screen.getByRole("combobox", { name: "Button 1 type" })
    ).toHaveTextContent("Quick Reply");

    fireEvent.click(screen.getByRole("button", { name: "Remove button 1" }));

    expect(await screen.findAllByText("Button 1 · URL")).toHaveLength(2);
    expect(
      screen.queryByText("Button 1 · Quick Reply")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Button 1 type" })
    ).toHaveTextContent("URL");
    expect(
      screen.queryByRole("combobox", { name: "Button 2 type" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove button 1" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Button" })).toBeEnabled();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Button 1 type" }), {
      key: "ArrowDown",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Phone Number" })
    );
    expect(await screen.findAllByText("Button 1 · Phone Number")).toHaveLength(
      2
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Button" }));
    fireEvent.keyDown(
      await screen.findByRole("combobox", { name: "Button 2 type" }),
      { key: "ArrowDown" }
    );
    expect(
      await screen.findByRole("option", { name: "Phone Number" })
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a loaded carousel's mixed button types through card and media changes", async () => {
    Element.prototype.scrollIntoView = jest.fn();
    mockUpdateTemplateAction.mockResolvedValue({
      success: true,
      data: { success: true },
    });
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "mixed_carousel",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              { type: "BODY", text: "Pick a product" },
              {
                type: "CAROUSEL",
                cards: ["one", "two"].map(name => ({
                  components: [
                    {
                      type: "HEADER",
                      format: "IMAGE",
                      example: {
                        header_handle: [`https://cdn.example.com/${name}.png`],
                      },
                    },
                    { type: "BODY", text: `Card ${name}` },
                    {
                      type: "BUTTONS",
                      buttons: [
                        { type: "QUICK_REPLY", text: "Interested" },
                        {
                          type: "URL",
                          text: "Buy",
                          url: `https://shop.example.com/${name}`,
                        },
                      ],
                    },
                  ],
                })),
              },
            ],
          } as never
        }
      />
    );

    expect(await screen.findAllByText("Button 2 · URL")).toHaveLength(2);
    expect(
      screen.getByRole("combobox", { name: "Button 1 type" })
    ).toHaveTextContent("Quick Reply");
    expect(
      screen.getByRole("combobox", { name: "Button 2 type" })
    ).toHaveTextContent("URL");

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    expect(await screen.findAllByText("Button 2 · URL")).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove card" })[2]!);
    await waitFor(() =>
      expect(screen.getAllByText("Button 2 · URL")).toHaveLength(2)
    );

    const mediaSelect = screen.getByRole("combobox", { name: "Card media" });
    expect(mediaSelect).toHaveTextContent("Image");
    fireEvent.keyDown(mediaSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Video" }));
    expect(await screen.findAllByText("Button 2 · URL")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
    const carousel = mockUpdateTemplateAction.mock.calls[0][0].components.find(
      (component: { type: string }) => component.type === "CAROUSEL"
    );
    expect(
      carousel.cards.map(
        (card: { components: Array<{ type: string; format?: string }> }) =>
          card.components.find(item => item.type === "HEADER")?.format
      )
    ).toEqual(["VIDEO", "VIDEO"]);
    expect(
      carousel.cards.map(
        (card: { components: Array<{ type: string; buttons?: unknown }> }) =>
          card.components.find(item => item.type === "BUTTONS")?.buttons
      )
    ).toEqual(
      ["one", "two"].map(name => [
        { type: "QUICK_REPLY", text: "Interested" },
        { type: "URL", text: "Buy", url: `https://shop.example.com/${name}` },
      ])
    );
  });

  it("inserts a variable where the author is typing", async () => {
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "greeting",
            language: "en",
            status: "APPROVED",
            category: "UTILITY",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Hello there friend" }],
          } as never
        }
      />
    );

    const body = screen.getByDisplayValue(
      "Hello there friend"
    ) as HTMLTextAreaElement;
    body.setSelectionRange(6, 6);
    fireEvent.click(
      screen.getByRole("button", { name: "form.insertVariable" })
    );

    expect(body.value).toBe("Hello {{1}} there friend");
  });

  it("checks carousel card variables and link variables before saving", async () => {
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "variable_carousel",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [
              { type: "BODY", text: "Pick a product" },
              {
                type: "CAROUSEL",
                cards: ["one", "two"].map(name => ({
                  components: [
                    {
                      type: "HEADER",
                      format: "IMAGE",
                      example: {
                        header_handle: [`https://cdn.example.com/${name}.png`],
                      },
                    },
                    { type: "BODY", text: `Look at {{2}} ${name}` },
                    {
                      type: "BUTTONS",
                      buttons: [
                        {
                          type: "URL",
                          text: "Buy",
                          url: "https://shop.example.com/{{1}}/item",
                        },
                      ],
                    },
                  ],
                })),
              },
            ],
          } as never
        }
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    expect(
      await screen.findAllByText("form.variableNumberingError")
    ).toHaveLength(2);
    expect(
      screen.getAllByText("form.errors.urlVariablePlacement")
    ).toHaveLength(2);
    expect(mockUpdateTemplateAction).not.toHaveBeenCalled();
  });

  describe("named variables", () => {
    function carouselCards(bodies: string[]) {
      return bodies.map((text, index) => ({
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: [`4::card-${index + 1}`] },
          },
          { type: "BODY", text },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Заказать каталог" },
              {
                type: "URL",
                text: "Перейти в Инстаграм",
                url: "https://www.instagram.com/boutique.example/",
              },
            ],
          },
        ],
      }));
    }

    function renderTemplate(components: unknown[], category = "MARKETING") {
      return render(
        <TemplateEditorForm
          workspaceId="workspace-1"
          onSuccess={jest.fn()}
          template={
            {
              id: "template-1",
              metaId: "meta-template-1",
              name: "boutique_fall_2026",
              language: "ru",
              status: "APPROVED",
              category,
              channel: "whatsapp",
              components,
            } as never
          }
        />
      );
    }

    beforeEach(() => {
      mockUpdateTemplateAction.mockResolvedValue({
        success: true,
        data: { success: true },
      });
    });

    it("sends a named template loaded from Meta back with its named samples", async () => {
      renderTemplate([
        {
          type: "BODY",
          text: "Уважаемый {{name}}, поступила коллекция Fall 2026.",
          example: {
            body_text_named_params: [
              { param_name: "name", example: "Александр" },
            ],
          },
        },
        {
          type: "CAROUSEL",
          cards: carouselCards(["Premiata", "Lacoste"]),
        },
      ]);

      fireEvent.change(
        screen.getByDisplayValue(
          "Уважаемый {{name}}, поступила коллекция Fall 2026."
        ),
        {
          target: {
            value: "Уважаемый {{name}}, поступила новая коллекция Fall 2026.",
          },
        }
      );
      fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

      await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
      const [{ components }] = mockUpdateTemplateAction.mock.calls[0] as [
        { components: Array<Record<string, unknown>> },
      ];
      expect(components[0]).toEqual({
        type: "BODY",
        text: "Уважаемый {{name}}, поступила новая коллекция Fall 2026.",
        example: {
          body_text_named_params: [
            { param_name: "name", example: "Александр" },
          ],
        },
      });
      expect(components[1]).toMatchObject({
        type: "CAROUSEL",
        cards: [
          {
            components: expect.arrayContaining([
              { type: "BODY", text: "Premiata" },
            ]),
          },
          {
            components: expect.arrayContaining([
              { type: "BODY", text: "Lacoste" },
            ]),
          },
        ],
      });
    });

    it("flags numbered variables next to named ones and names Meta rejects", async () => {
      renderTemplate(
        [
          { type: "HEADER", format: "TEXT", text: "Update for {{1}} today" },
          { type: "BODY", text: "Hi {{First_Name}}, thanks for waiting." },
        ],
        "UTILITY"
      );

      fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

      expect(
        await screen.findByText("form.errors.variablesMixed")
      ).toBeInTheDocument();
      expect(
        screen.getByText("form.errors.variableNameInvalid")
      ).toBeInTheDocument();
      expect(mockUpdateTemplateAction).not.toHaveBeenCalled();
    });

    it("renames a variable in carousel cards too, so the template stays named", async () => {
      renderTemplate([
        { type: "BODY", text: "Hello {{1}}, pick a card" },
        {
          type: "CAROUSEL",
          cards: carouselCards(["Look at {{1}} one", "Look at {{1}} two"]),
        },
      ]);

      fireEvent.change(screen.getByDisplayValue("1"), {
        target: { value: "name" },
      });
      fireEvent.click(screen.getByRole("button", { name: "form.applyRename" }));
      fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

      await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
      const [{ components }] = mockUpdateTemplateAction.mock.calls[0] as [
        {
          components: Array<{
            text?: string;
            example?: unknown;
            cards?: Array<{ components: Array<{ type: string }> }>;
          }>;
        },
      ];
      expect(components[0]).toEqual({
        type: "BODY",
        text: "Hello {{name}}, pick a card",
        example: {
          body_text_named_params: [{ param_name: "name", example: "John" }],
        },
      });
      expect(
        components[1]?.cards?.map(card =>
          card.components.find(item => item.type === "BODY")
        )
      ).toEqual(
        ["one", "two"].map(name => ({
          type: "BODY",
          text: `Look at {{name}} ${name}`,
          example: {
            body_text_named_params: [
              { param_name: "name", example: "Sample name" },
            ],
          },
        }))
      );
    });
  });
});

describe("TemplateEditorForm authoring aids", () => {
  beforeAll(() => {
    // cmdk scrolls the active language into view.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function renderNewTemplate() {
    mockCreateUnifiedTemplateAction.mockResolvedValue({
      success: true,
      data: { id: "created" },
    });
    return render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
      />
    );
  }

  function fillNameAndBody() {
    fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
      target: { value: "spring_sale" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Hello /), {
      target: { value: "Spring sale is on" },
    });
  }

  function addHeaderText(value: string) {
    fireEvent.click(screen.getByRole("button", { name: "Add Header" }));
    fireEvent.change(
      screen.getByPlaceholderText("form.headerTextPlaceholder"),
      { target: { value } }
    );
  }

  function submittedWhatsAppData() {
    return mockCreateUnifiedTemplateAction.mock.calls[0]?.[0]?.whatsappData as {
      category: string;
      language: string;
      components: Array<{ type: string }>;
    };
  }

  it("starts a new template as Marketing and sends that category", async () => {
    const { container } = renderNewTemplate();

    expect(
      screen.getByRole("combobox", { name: "Category" })
    ).toHaveTextContent("Marketing");
    expect(
      screen.getByText("form.categoryHints.MARKETING")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Standard message" })
    ).toBeChecked();

    fillNameAndBody();
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() =>
      expect(mockCreateUnifiedTemplateAction).toHaveBeenCalledTimes(1)
    );
    expect(submittedWhatsAppData()).toMatchObject({
      category: "MARKETING",
      language: "en",
    });
  });

  it("finds and sends a language picked from the searchable list", async () => {
    const { container } = renderNewTemplate();
    const trigger = screen.getByRole("combobox", { name: "form.lang" });
    expect(trigger).toHaveTextContent("English");

    fireEvent.click(trigger);
    fireEvent.change(await screen.findByPlaceholderText("form.langSearch"), {
      target: { value: "қазақ" },
    });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]!);

    expect(trigger).toHaveTextContent("Kazakh");
    fillNameAndBody();
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() =>
      expect(mockCreateUnifiedTemplateAction).toHaveBeenCalledTimes(1)
    );
    expect(submittedWhatsAppData().language).toBe("kk");
  });

  it("edits a Meta template in a language outside the main markets", async () => {
    mockUpdateTemplateAction.mockResolvedValue({
      success: true,
      data: { success: true },
    });
    render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        template={
          {
            id: "template-1",
            metaId: "meta-template-1",
            name: "promo_id",
            language: "id",
            status: "APPROVED",
            category: "MARKETING",
            channel: "whatsapp",
            components: [{ type: "BODY", text: "Diskon akhir pekan" }],
          } as never
        }
      />
    );
    expect(
      screen.getByRole("combobox", { name: "form.lang" })
    ).toHaveTextContent("Indonesian");

    fireEvent.change(screen.getByDisplayValue("Diskon akhir pekan"), {
      target: { value: "Diskon akhir pekan ini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Template" }));

    await waitFor(() => expect(mockUpdateTemplateAction).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("types the template name in WhatsApp's format and explains the rules", () => {
    renderNewTemplate();
    const name = screen.getByPlaceholderText("order_confirmation");

    fireEvent.change(name, { target: { value: "Spring Sale" } });

    expect(name).toHaveValue("spring_sale");
    expect(screen.getByText("form.nameValidation")).toBeInTheDocument();
  });

  it("keeps the caret where a space was typed mid-name", async () => {
    renderNewTemplate();
    const name = screen.getByPlaceholderText(
      "order_confirmation"
    ) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "springsale" } });

    await userEvent.type(name, " ", {
      initialSelectionStart: 6,
      initialSelectionEnd: 6,
    });

    expect(name).toHaveValue("spring_sale");
    expect(name.selectionStart).toBe(7);
  });

  it("titles the live preview with the typed name and explains an empty bubble", () => {
    renderNewTemplate();
    const preview = screen.getByTestId("template-phone-preview");
    expect(preview).toHaveTextContent("form.previewEmpty");

    fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
      target: { value: "spring_sale" },
    });

    expect(preview).toHaveTextContent("spring_sale [en]");
  });

  it("does not check a removed header's text", async () => {
    const { container } = renderNewTemplate();
    addHeaderText("{{1}} is back");
    fireEvent.click(screen.getByRole("button", { name: "Remove Header" }));

    fillNameAndBody();
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() =>
      expect(mockCreateUnifiedTemplateAction).toHaveBeenCalledTimes(1)
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      submittedWhatsAppData().components.map(component => component.type)
    ).toEqual(["BODY"]);
  });

  it("allows one variable in a text header", async () => {
    const { container } = renderNewTemplate();
    addHeaderText("Hi {{1}} there");
    const [headerInsert] = screen.getAllByRole("button", {
      name: "form.insertVariable",
    });
    expect(headerInsert).toBeDisabled();

    fireEvent.change(screen.getByDisplayValue("Hi {{1}} there"), {
      target: { value: "Hi {{1}} and {{2}} there" },
    });
    fillNameAndBody();
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("form.errors.headerOneVariable")
    );
    expect(mockCreateUnifiedTemplateAction).not.toHaveBeenCalled();
  });

  it("warns about formatting markers in the header, not variable names", () => {
    renderNewTemplate();
    addHeaderText("Hi {{first_name}} there");
    expect(
      screen.queryByText("form.headerFormattingWarning")
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Hi {{first_name}} there"), {
      target: { value: "*Spring* sale" },
    });
    expect(
      screen.getByText("form.headerFormattingWarning")
    ).toBeInTheDocument();
    expect(screen.getByTestId("whatsapp-header-text")).toHaveTextContent(
      "*Spring* sale"
    );
  });

  it("counts footer characters like the header", () => {
    renderNewTemplate();
    fireEvent.click(screen.getByRole("button", { name: "Add footer" }));
    fireEvent.change(screen.getByPlaceholderText("form.footerPlaceholder"), {
      target: { value: "Reply STOP to opt out" },
    });

    expect(screen.getByText("21/60")).toBeInTheDocument();
  });
});

describe("TemplateEditorForm drafts across a deploy", () => {
  const newDraftKey = getTemplateEditorDraftKey({ workspaceId: "workspace-1" });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function renderNewTemplate(
    props: Partial<React.ComponentProps<typeof TemplateEditorForm>> = {}
  ) {
    return render(
      <TemplateEditorForm
        workspaceId="workspace-1"
        onSuccess={jest.fn()}
        layout="modal"
        {...props}
      />
    );
  }

  function fillNameAndBody() {
    fireEvent.change(screen.getByPlaceholderText("order_confirmation"), {
      target: { value: "car_alarm" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^Hello /), {
      target: { value: "Your car alarm is ready" },
    });
  }

  it("keeps unsaved edits quietly when the editor reopens on the same page", () => {
    const first = renderNewTemplate();
    fillNameAndBody();
    first.unmount();

    renderNewTemplate();

    expect(screen.getByPlaceholderText("order_confirmation")).toHaveValue(
      "car_alarm"
    );
    expect(screen.getByPlaceholderText(/^Hello /)).toHaveValue(
      "Your car alarm is ready"
    );
    expect(screen.queryByText("form.draftRestored")).not.toBeInTheDocument();
  });

  it("announces a draft from before a reload and can discard it", () => {
    // Written by the previous page load, so this page never saved it.
    window.localStorage.setItem(
      newDraftKey,
      JSON.stringify({
        savedAt: Date.now() - 60_000,
        values: {
          name: "car_alarm",
          targetPlatform: "whatsapp",
          language: "en",
          category: "MARKETING",
          bodyText: "Your car alarm is ready",
        },
      })
    );

    renderNewTemplate();

    expect(screen.getByPlaceholderText("order_confirmation")).toHaveValue(
      "car_alarm"
    );
    expect(screen.getByRole("status")).toHaveTextContent("form.draftRestored");

    fireEvent.click(screen.getByRole("button", { name: "form.draftDiscard" }));

    expect(screen.getByPlaceholderText("order_confirmation")).toHaveValue("");
    expect(screen.getByPlaceholderText(/^Hello /)).toHaveValue("");
    expect(screen.queryByText("form.draftRestored")).not.toBeInTheDocument();
    expect(readTemplateEditorDraft(newDraftKey)).toBeNull();
  });

  it("keeps no draft when only the layout was switched", () => {
    const { unmount } = renderNewTemplate();
    fireEvent.click(screen.getByRole("radio", { name: "Media carousel" }));
    fireEvent.click(screen.getByRole("radio", { name: "Standard message" }));
    unmount();

    expect(readTemplateEditorDraft(newDraftKey)).toBeNull();
  });

  it("drops the draft on Cancel but keeps it when the editor just closes", () => {
    const closed = renderNewTemplate({ onCancel: jest.fn() });
    fillNameAndBody();
    closed.unmount();
    expect(readTemplateEditorDraft(newDraftKey)?.values.name).toBe("car_alarm");

    const cancelled = renderNewTemplate({ onCancel: jest.fn() });
    fireEvent.click(screen.getByRole("button", { name: "form.cancel" }));
    cancelled.unmount();

    expect(readTemplateEditorDraft(newDraftKey)).toBeNull();
  });

  it("keeps a draft for each template apart from the new-template draft", () => {
    const edited = renderImageHeaderForm();
    fireEvent.change(screen.getByDisplayValue("See our new offer"), {
      target: { value: "See our autumn offer" },
    });
    edited.unmount();

    const created = renderNewTemplate();
    expect(screen.getByPlaceholderText("order_confirmation")).toHaveValue("");
    created.unmount();

    renderImageHeaderForm();
    expect(
      screen.getByDisplayValue("See our autumn offer")
    ).toBeInTheDocument();
  });

  it("clears the draft after the template is saved", async () => {
    mockCreateUnifiedTemplateAction.mockResolvedValueOnce({
      success: true,
      data: { id: "created" },
    });
    const onSuccess = jest.fn();
    const { container, unmount } = renderNewTemplate({ onSuccess });
    fillNameAndBody();

    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    unmount();

    expect(readTemplateEditorDraft(newDraftKey)).toBeNull();
  });

  it("saves the draft and offers a reload that reopens the editor after a deploy", async () => {
    mockCreateUnifiedTemplateAction.mockRejectedValueOnce(
      new UnrecognizedActionError(
        'Server Action "405c0d8d" was not found on the server.'
      )
    );
    const { container } = renderNewTemplate({
      reopenSearchParams: { create: "1" },
    });
    fillNameAndBody();

    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "form.staleVersion"
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(readTemplateEditorDraft(newDraftKey)?.values).toMatchObject({
      name: "car_alarm",
      bodyText: "Your car alarm is ready",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "form.staleVersionReload" })
    );
    const reloadUrl = (reloadToLatestAppVersion as jest.Mock).mock
      .calls[0]?.[0] as URL;
    expect(reloadUrl.searchParams.get("create")).toBe("1");
  });
});
