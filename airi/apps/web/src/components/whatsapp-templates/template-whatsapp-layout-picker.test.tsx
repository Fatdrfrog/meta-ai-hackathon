/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { TemplateWhatsAppLayoutPicker } from "./template-whatsapp-layout-picker";

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      "form.layoutHint":
        "WhatsApp marketing templates are one shape. Carousel is not a button.",
      "form.layout": "Message shape",
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
    };
    return (key: string) => messages[key] ?? key;
  },
}));

describe("TemplateWhatsAppLayoutPicker", () => {
  it("shows both shapes and keeps only one selected", () => {
    const onChange = jest.fn();
    render(
      <TemplateWhatsAppLayoutPicker value="standard" onChange={onChange} />
    );

    const standard = screen.getByRole("radio", { name: "Standard message" });
    const carousel = screen.getByRole("radio", { name: "Media carousel" });

    expect(standard).toBeChecked();
    expect(carousel).not.toBeChecked();
    expect(
      screen.getByText("Cannot include a message header, footer, or buttons")
    ).toBeInTheDocument();

    fireEvent.click(carousel);
    expect(onChange).toHaveBeenCalledWith("carousel");
  });

  it("explains hidden exclusive sections without showing both editors", () => {
    const { rerender } = render(
      <TemplateWhatsAppLayoutPicker
        value="carousel"
        showHiddenStandardNote
        onChange={jest.fn()}
      />
    );

    expect(
      screen.getByText("Header, footer, and message buttons stay saved.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Carousel cards stay saved.")
    ).not.toBeInTheDocument();

    rerender(
      <TemplateWhatsAppLayoutPicker
        value="standard"
        showHiddenCarouselNote
        onChange={jest.fn()}
      />
    );

    expect(
      screen.getByText("Carousel cards stay saved.")
    ).toBeInTheDocument();
  });
});
