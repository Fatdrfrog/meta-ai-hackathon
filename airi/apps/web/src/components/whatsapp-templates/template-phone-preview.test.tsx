/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import type { WhatsAppTemplateSelectionItem } from "@/lib/whatsapp/templates/selection-utils";
import {
  TemplatePhonePreview,
  buildTemplatePhonePreviewModel,
} from "./template-phone-preview";

describe("TemplatePhonePreview", () => {
  it("converts WhatsApp template components into an iPhone preview model", () => {
    const template: WhatsAppTemplateSelectionItem = {
      id: "template-1",
      name: "order_confirmation",
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
        { type: "BODY", text: "Hi {{2}}, your order is ready." },
        { type: "FOOTER", text: "Reply STOP to unsubscribe" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Confirm" },
            { type: "URL", text: "Track", url: "https://example.com/{{1}}" },
            {
              type: "FLOW",
              text: "Details",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
    };

    const model = buildTemplatePhonePreviewModel(template);

    expect(model.channel).toBe("whatsapp");
    expect(model.preview?.headerText).toBe("Order {{1}}");
    expect(model.preview?.bodyText).toBe("Hi {{2}}, your order is ready.");
    expect(model.preview?.footerText).toBe("Reply STOP to unsubscribe");
    expect(model.preview?.buttons).toEqual([
      { type: "quick_reply", label: "Confirm" },
      { type: "url", label: "Track", value: "https://example.com/{{1}}" },
      {
        type: "flow",
        label: "Details",
        flowId: "flow-1",
        flowAction: "navigate",
      },
    ]);
    expect(model.height).toBeGreaterThan(220);
    expect(model.height).toBeLessThan(500);
  });

  it("normalizes numeric Meta Flow ids in template previews", () => {
    const template: WhatsAppTemplateSelectionItem = {
      id: "template-flow-number",
      name: "lead_flow",
      language: "en_US",
      category: "MARKETING",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        { type: "BODY", text: "Open the lead form." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Start",
              flow_id: "12345",
              flow_action: "navigate",
            },
          ],
        },
      ],
    };

    const model = buildTemplatePhonePreviewModel(template);

    expect(model.preview?.buttons).toEqual([
      {
        type: "flow",
        label: "Start",
        flowId: "12345",
        flowAction: "navigate",
      },
    ]);

    render(<TemplatePhonePreview template={template} model={model} />);

    expect(screen.getByTestId("whatsapp-action-renderer")).toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("keeps media headers and renders a Telegram-only fallback card", () => {
    const mediaTemplate: WhatsAppTemplateSelectionItem = {
      id: "media-template",
      name: "media_header",
      language: "en",
      category: "MARKETING",
      status: "PENDING",
      channel: "whatsapp",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["https://cdn.example.com/header.png"] },
        },
        { type: "BODY", text: "Media body" },
      ],
    };
    const telegramTemplate: WhatsAppTemplateSelectionItem = {
      id: "telegram-template",
      name: "telegram_alert",
      language: "",
      category: "UTILITY",
      status: "APPROVED",
      channel: "telegram",
      components: [],
      telegramData: {
        text: "Telegram fallback message",
        parseMode: "None",
      },
    };

    expect(buildTemplatePhonePreviewModel(mediaTemplate).preview).toMatchObject(
      {
        headerMediaFormat: "IMAGE",
        headerMediaUrl: "https://cdn.example.com/header.png",
        bodyText: "Media body",
      }
    );

    render(<TemplatePhonePreview template={telegramTemplate} />);

    expect(screen.getByTestId("template-phone-preview")).toHaveAttribute(
      "data-channel",
      "telegram"
    );
    expect(screen.getByText("Telegram fallback message")).toBeInTheDocument();
    expect(screen.queryByText("1:22 PM")).not.toBeInTheDocument();
  });

  it("renders Meta authentication copy-code buttons in template previews", () => {
    const authTemplate: WhatsAppTemplateSelectionItem = {
      id: "auth-template",
      name: "login_code",
      language: "en",
      category: "AUTHENTICATION",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        { type: "BODY", text: "{{1}} is your verification code." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "OTP",
              otp_type: "COPY_CODE",
              text: "Copy code",
            },
          ],
        },
      ],
    };

    const model = buildTemplatePhonePreviewModel(authTemplate);

    expect(model.preview?.buttons).toEqual([
      { type: "copy_code", label: "Copy code" },
    ]);

    render(<TemplatePhonePreview template={authTemplate} model={model} />);

    expect(screen.getByText("Copy code")).toBeInTheDocument();
  });

  it("renders request-contact-info buttons as fixed Meta contact buttons", () => {
    const template: WhatsAppTemplateSelectionItem = {
      id: "contact-template",
      name: "request_contact",
      language: "en",
      category: "UTILITY",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        { type: "BODY", text: "Please share your phone number." },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "REQUEST_CONTACT_INFO",
            },
          ],
        },
      ],
    };

    const model = buildTemplatePhonePreviewModel(template);

    expect(model.preview?.buttons).toEqual([
      {
        type: "request_contact_info",
        label: "Request contact info",
      },
    ]);

    render(<TemplatePhonePreview template={template} model={model} />);

    expect(screen.getByText("Request contact info")).toBeInTheDocument();
  });

  it("renders browser-loadable image and video media headers efficiently", () => {
    const imageTemplate: WhatsAppTemplateSelectionItem = {
      id: "image-template",
      name: "image_header",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: {
            header_handle: ["https://cdn.example.com/template-image.png"],
          },
        },
        { type: "BODY", text: "Image body" },
      ],
    };
    const videoTemplate: WhatsAppTemplateSelectionItem = {
      id: "video-template",
      name: "video_header",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        {
          type: "HEADER",
          format: "VIDEO",
          example: {
            header_handle: ["https://cdn.example.com/template-video.mp4"],
          },
        },
        { type: "BODY", text: "Video body" },
      ],
    };

    render(<TemplatePhonePreview template={imageTemplate} />);
    const image = screen.getByTestId("whatsapp-template-image-preview");
    expect(image).toHaveAttribute(
      "src",
      "https://cdn.example.com/template-image.png"
    );
    expect(image).toHaveAttribute("loading", "lazy");

    cleanup();

    render(<TemplatePhonePreview template={videoTemplate} mode="card" />);
    const video = screen.getByTestId("whatsapp-template-video-preview");
    expect(video).toHaveAttribute(
      "src",
      "https://cdn.example.com/template-video.mp4"
    );
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("controls");

    cleanup();

    render(<TemplatePhonePreview template={videoTemplate} mode="modal" />);
    const modalVideo = screen.getByTestId("whatsapp-template-video-preview");
    expect(modalVideo).toHaveAttribute("preload", "metadata");
    expect(modalVideo).toHaveAttribute(
      "src",
      "https://cdn.example.com/template-video.mp4"
    );
    expect(modalVideo).toHaveAttribute("controls");
  });

  it("keeps Meta media handles as placeholders instead of broken media elements", () => {
    const handleTemplate: WhatsAppTemplateSelectionItem = {
      id: "handle-template",
      name: "meta_handle",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::meta-header-handle"] },
        },
        { type: "BODY", text: "Handle body" },
      ],
    };

    const model = buildTemplatePhonePreviewModel(handleTemplate);
    expect(model.headerMedia).toMatchObject({
      format: "IMAGE",
      rawHandle: "4::meta-header-handle",
      isRenderable: false,
    });
    expect(model.preview?.headerMediaUrl).toBeUndefined();

    render(<TemplatePhonePreview template={handleTemplate} />);

    expect(
      screen.queryByTestId("whatsapp-template-image-preview")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("whatsapp-header-media-placeholder")
    ).toHaveTextContent("whatsappServiceMediaImage");
  });

  it("renders carousel cards under the template bubble", () => {
    const template: WhatsAppTemplateSelectionItem = {
      id: "carousel-template",
      name: "promo_carousel",
      language: "en",
      category: "MARKETING",
      status: "APPROVED",
      channel: "whatsapp",
      components: [
        { type: "BODY", text: "Pick a card" },
        {
          type: "CAROUSEL",
          cards: [
            {
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: ["https://cdn.example.com/one.png"],
                  },
                },
                { type: "BODY", text: "First card" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Select" }],
                },
              ],
            },
            {
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: ["https://cdn.example.com/two.png"],
                  },
                },
                { type: "BODY", text: "Second card" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Select" }],
                },
              ],
            },
          ],
        },
      ],
    };

    render(<TemplatePhonePreview template={template} />);

    expect(screen.getByTestId("template-carousel-preview")).toBeInTheDocument();
    expect(screen.getByText("First card")).toBeInTheDocument();
    expect(screen.getByText("Second card")).toBeInTheDocument();
    expect(screen.getAllByText("Select")).toHaveLength(2);
  });

  it("marks each carousel button with its type's icon", () => {
    render(
      <TemplatePhonePreview
        template={{
          id: "mixed-carousel",
          name: "promo_carousel",
          language: "en",
          category: "MARKETING",
          status: "APPROVED",
          channel: "whatsapp",
          components: [
            { type: "BODY", text: "Pick a card" },
            {
              type: "CAROUSEL",
              cards: ["one", "two"].map(name => ({
                components: [
                  {
                    type: "HEADER" as const,
                    format: "IMAGE" as const,
                    example: {
                      header_handle: [`https://cdn.example.com/${name}.png`],
                    },
                  },
                  { type: "BODY" as const, text: `Card ${name}` },
                  {
                    type: "BUTTONS" as const,
                    buttons: [
                      { type: "QUICK_REPLY" as const, text: "Interested" },
                      {
                        type: "URL" as const,
                        text: "Buy",
                        url: `https://shop.example.com/${name}`,
                      },
                    ],
                  },
                ],
              })),
            },
          ],
        }}
      />
    );

    const rows = screen
      .getAllByText(/^(Interested|Buy)$/)
      .map(label => label.closest("[data-button-type]"));
    const iconClass = (index: number) =>
      rows[index]?.querySelector("svg")?.getAttribute("class");

    expect(rows.map(row => row?.getAttribute("data-button-type"))).toEqual([
      "QUICK_REPLY",
      "URL",
      "QUICK_REPLY",
      "URL",
    ]);
    expect(iconClass(0)).toBeTruthy();
    expect(iconClass(0)).not.toBe(iconClass(1));
    expect(iconClass(2)).toBe(iconClass(0));
    expect(iconClass(3)).toBe(iconClass(1));
  });

  it("previews incomplete carousel cards instead of hiding the strip", () => {
    render(
      <TemplatePhonePreview
        template={{
          id: "draft-carousel",
          name: "promo_carousel",
          language: "en",
          category: "MARKETING",
          status: "PENDING",
          channel: "whatsapp",
          components: [
            { type: "BODY", text: "template" },
            {
              type: "CAROUSEL",
              cards: [
                {
                  components: [
                    { type: "HEADER", format: "IMAGE" },
                    { type: "BODY", text: "" },
                    {
                      type: "BUTTONS",
                      buttons: [{ type: "QUICK_REPLY", text: "" }],
                    },
                  ],
                },
                {
                  components: [
                    { type: "HEADER", format: "IMAGE" },
                    { type: "BODY", text: "" },
                    {
                      type: "BUTTONS",
                      buttons: [{ type: "QUICK_REPLY", text: "" }],
                    },
                  ],
                },
              ],
            },
          ],
        }}
      />
    );

    expect(screen.getByTestId("template-carousel-preview")).toBeInTheDocument();
  });
});
