/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { INTEGRATIONS } from "@/components/integrations/integration-registry";
import { SourcesSection } from "./sources-section";
jest.mock("next-intl", () => ({
  useTranslations: jest
    .requireActual("./landing-test-utils")
    .catalogTranslations({
      ...jest.requireActual("../../../messages/en.json"),
      ...jest.requireActual(
        "../../../messages/settings/integrations/en/page.json"
      ),
    }),
}));
jest.mock("next/image", () =>
  jest.requireActual("./landing-test-utils").nextImageMock()
);

describe("Landing channels", () => {
  it("shows the four supported customer channels once, with a localized heading", () => {
    render(<SourcesSection />);
    const section = screen.getByRole("region", {
      name: "Start with WhatsApp, then add your other channels.",
    });
    expect(section).toHaveAttribute("id", "integrations");
    const items = within(section).getAllByRole("listitem");
    const channels = INTEGRATIONS.filter(
      i => !i.disabled && (i.category === "channel" || i.category === "widget")
    );
    expect(items).toHaveLength(channels.length);
    for (const name of ["WhatsApp", "Instagram", "Telegram", "Website chat"])
      expect(within(section).getByText(name)).toBeInTheDocument();
    expect(section.querySelector('[aria-hidden="true"] ul')).toBeNull();
  });
  it("leads with WhatsApp, as the heading promises", () => {
    render(<SourcesSection />);
    const section = screen.getByRole("region", {
      name: "Start with WhatsApp, then add your other channels.",
    });
    const [first] = within(section).getAllByRole("listitem");
    expect(first).toHaveTextContent("WhatsApp");
  });
  it("does not present creative vendors as customer channels or hide links behind hover", () => {
    render(<SourcesSection />);
    for (const name of [
      "Higgsfield",
      "HappyHorse",
      "Bria",
      "ElevenLabs",
      "Canva",
    ])
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
