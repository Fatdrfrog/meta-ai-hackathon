/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import { WhatsAppInlineEditor } from "./inline-editor";

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number | Date>) => {
      if (key === "variableFieldFirstName") return "Имя";
      if (key === "variableRemove") return `Убрать «${values?.label}»`;
      return key;
    },
}));

describe("ScenarioVariableExtension chips", () => {
  it("names catalog chips in the viewer's language and keeps inserted labels", async () => {
    const { container } = render(
      <WhatsAppInlineEditor
        value="Hi {{first_name}}, {{input.sport}}"
        onChange={jest.fn()}
      />
    );

    expect(
      await screen.findByRole("button", { name: "Убрать «Имя»" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Убрать «Sport»" })
      ).toBeTruthy()
    );
    const chips = Array.from(
      container.querySelectorAll(".scenario-variable-chip")
    );
    expect(chips.map(chip => chip.textContent)).toEqual(["Имя", "Sport"]);
    expect(chips.some(chip => chip.hasAttribute("title"))).toBe(false);
  });
});
