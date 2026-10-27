/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LandingTemplateCta } from "./landing-template-cta";
import enMessages from "../../../messages/en.json";
import ruMessages from "../../../messages/ru.json";
import kzMessages from "../../../messages/kz.json";

let mockLocale = "en";
jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: () => (key: string) => key,
}));
jest.mock("./template-request-dialog", () => ({
  TemplateRequestDialog: ({
    templateId,
    onClose,
    ready,
    readinessLoading,
    readinessUnavailable,
  }: {
    templateId: string | null;
    onClose: () => void;
    ready: boolean;
    readinessLoading: boolean;
    readinessUnavailable: boolean;
  }) =>
    templateId ? (
      <div
        role="dialog"
        data-ready={ready}
        data-loading={readinessLoading}
        data-unavailable={readinessUnavailable}
      >
        {templateId}
        <button onClick={onClose}>Close request</button>
      </div>
    ) : null,
}));

beforeEach(() => {
  mockLocale = "en";
  global.fetch = jest.fn();
});

it.each([enMessages, ruMessages, kzMessages])(
  "has real navigation and request labels in every public locale",
  messages => {
    expect(messages.LandingDemo.templates.navigation).toEqual(
      expect.any(String)
    );
    expect(messages.LandingDemo.templates.landingCta).toEqual(
      expect.any(String)
    );
    expect(messages.LandingDemo.templates.landingCta.trim()).not.toBe("");
  }
);

it("checks the selected example only when requested and restores focus after close", async () => {
  (fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      readyTemplateIds: ["abandoned-cart"],
      unavailableTemplateIds: [],
    }),
  });
  render(<LandingTemplateCta templateId="abandoned-cart" />);
  expect(fetch).not.toHaveBeenCalled();
  const opener = screen.getByRole("button", { name: "landingCta" });
  fireEvent.click(opener);
  expect(fetch).toHaveBeenCalledWith("/api/landing/template-request?locale=en");
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "true")
  );
  fireEvent.click(screen.getByRole("button", { name: "Close request" }));
  await waitFor(() => expect(opener).toHaveFocus());
});

it("keeps an unavailable example browsable after a readiness failure", async () => {
  (fetch as jest.Mock).mockRejectedValue(new Error("offline"));
  render(<LandingTemplateCta templateId="seasonal-offer" />);
  fireEvent.click(screen.getByRole("button", { name: "landingCta" }));
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveAttribute("data-loading", "false")
  );
  expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "false");
  expect(screen.getByRole("dialog")).toHaveAttribute(
    "data-unavailable",
    "true"
  );
});

it("keeps an unprepared example distinct from an availability outage", async () => {
  (fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ readyTemplateIds: [], unavailableTemplateIds: [] }),
  });
  render(<LandingTemplateCta templateId="seasonal-offer" />);
  fireEvent.click(screen.getByRole("button", { name: "landingCta" }));
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveAttribute("data-loading", "false")
  );
  expect(screen.getByRole("dialog")).toHaveAttribute(
    "data-unavailable",
    "false"
  );
});

it.each(["en", "ru", "kz"])(
  "shows a selected temporary Flow outage without treating ready landing demos as unavailable in %s",
  async locale => {
    mockLocale = locale;
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        readyTemplateIds: ["abandoned-cart"],
        unavailableTemplateIds: ["course-enrollment"],
      }),
    });
    const { rerender } = render(
      <LandingTemplateCta templateId="course-enrollment" />
    );
    fireEvent.click(screen.getByRole("button", { name: "landingCta" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-loading",
        "false"
      )
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "false");
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-unavailable",
      "true"
    );
    expect(fetch).toHaveBeenCalledWith(
      `/api/landing/template-request?locale=${locale}`
    );
    fireEvent.click(screen.getByRole("button", { name: "Close request" }));
    rerender(<LandingTemplateCta templateId="abandoned-cart" />);
    fireEvent.click(screen.getByRole("button", { name: "landingCta" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "true")
    );
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-unavailable",
      "false"
    );
  }
);
