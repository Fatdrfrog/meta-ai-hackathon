/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SentAccent } from "./landing-sent-accent";
import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";
import kz from "../../../messages/kz.json";

const normalize = (text: string | null) => (text ?? "").replace(/\u00a0/g, " ");

function renderHeading(lead: string, accent: string) {
  return render(
    <h1>
      {lead}{" "}
      <span>
        <SentAccent text={accent} />
      </span>
    </h1>
  );
}

describe("SentAccent", () => {
  it.each(
    Object.entries({ en, ru, kz }).flatMap(([locale, messages]) => [
      [
        `${locale} hero`,
        messages.LandingDemo.hero.title,
        messages.LandingDemo.hero.titleAccent,
      ],
      [
        `${locale} closing`,
        messages.LandingDemo.cta.title,
        messages.LandingDemo.cta.titleAccent,
      ],
    ])
  )(
    "keeps the %s heading readable as one sentence with decorative ticks",
    (_name, lead, accent) => {
      const { container } = renderHeading(lead, accent);
      const heading = screen.getByRole("heading", { level: 1 });
      expect(normalize(heading.textContent)).toBe(
        normalize(`${lead} ${accent}`)
      );
      const ticks = container.querySelectorAll("svg");
      expect(ticks).toHaveLength(1);
      expect(ticks[0]).toHaveAttribute("aria-hidden", "true");
      // The ticks share an unbreakable tail with the accent's final word.
      const tail = ticks[0].parentElement!;
      expect(tail).toHaveClass("accentTail");
      expect(tail.textContent).not.toContain(" ");
      expect(normalize(accent).endsWith(normalize(tail.textContent))).toBe(
        true
      );
    }
  );

  it("binds short words so a preposition never becomes its own bubble line", () => {
    const { container } = renderHeading("Продавайте больше", "в WhatsApp.");
    expect(container.querySelector(".accentTail")?.textContent).toBe(
      "в\u00a0WhatsApp."
    );
  });

  it("lets longer phrases wrap between words before the last one", () => {
    const { container } = renderHeading("Жақсы науқан", "әңгіме бастайды.");
    expect(container.querySelector(".accentTail")?.textContent).toBe(
      "бастайды."
    );
    expect(container.querySelector("h1 > span")?.textContent).toBe(
      "әңгіме бастайды."
    );
  });
});
