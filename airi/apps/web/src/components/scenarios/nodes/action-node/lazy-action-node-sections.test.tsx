/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

const mockLoadedSections: string[] = [];

function mockSection(name: string, exportName: string) {
  mockLoadedSections.push(name);
  return { [exportName]: () => <p>{name} editor</p> };
}

jest.mock("./action-node-whatsapp-service-message-section", () =>
  mockSection("service-message", "ActionNodeWhatsAppServiceMessageSection")
);
jest.mock("./action-node-whatsapp-template-section", () =>
  mockSection("template", "ActionNodeWhatsAppTemplateSection")
);
jest.mock("./action-node-generative-ai-section", () =>
  mockSection("generative", "ActionNodeGenerativeAISection")
);
jest.mock("./action-node-settings", () =>
  mockSection("settings", "ActionNodeSettings")
);
jest.mock("../../builders/telegram", () =>
  mockSection("telegram", "TelegramReplyBuilder")
);

import {
  LazyActionNodeGenerativeAISection,
  LazyActionNodeSettings,
  LazyActionNodeWhatsAppServiceMessageSection,
  LazyActionNodeWhatsAppTemplateSection,
  LazyTelegramReplyBuilder,
} from "./lazy-action-node-sections";

// Read before any test runs, so the check does not depend on test order.
const sectionsLoadedOnImport = [...mockLoadedSections];

// The placeholders need no props; the mocked editors ignore them.
const anySection = (section: unknown) =>
  section as ComponentType<{ loadingLabel?: string }>;

const cases: Array<[string, ComponentType<{ loadingLabel?: string }>, string]> =
  [
    [
      "service-message",
      anySection(LazyActionNodeWhatsAppServiceMessageSection),
      "loadingItems",
    ],
    [
      "template",
      anySection(LazyActionNodeWhatsAppTemplateSection),
      "Loading templates",
    ],
    [
      "generative",
      anySection(LazyActionNodeGenerativeAISection),
      "loadingItems",
    ],
    ["telegram", anySection(LazyTelegramReplyBuilder), "loadingItems"],
    ["settings", anySection(LazyActionNodeSettings), "loadingItems"],
  ];

describe("lazy action node sections", () => {
  it("downloads no editor before a step of its kind renders", () => {
    expect(sectionsLoadedOnImport).toEqual([]);
  });

  it.each(cases)(
    "shows a placeholder until the %s editor loads",
    async (name, LazySection, loadingLabel) => {
      render(<LazySection loadingLabel="Loading templates" />);

      expect(screen.getByRole("status")).toHaveTextContent(loadingLabel);
      expect(await screen.findByText(`${name} editor`)).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(mockLoadedSections).toContain(name);
    }
  );
});
