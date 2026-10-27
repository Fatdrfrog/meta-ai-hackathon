/**
 * @jest-environment jsdom
 */

// Its own file so the section's chunk starts cold.
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { Component, type ComponentProps, type ReactNode } from "react";

jest.mock("./action-node-whatsapp-template-section", () => ({
  ActionNodeWhatsAppTemplateSection: () => <p>template editor</p>,
}));

import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { LazyActionNodeWhatsAppTemplateSection } from "./lazy-action-node-sections";

/** Stands in for the page's error screen, which replaces the whole panel. */
class PageErrorScreen extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">page error</p>
    ) : (
      this.props.children
    );
  }
}

describe("a lazy action section whose download fails", () => {
  it("keeps its placeholder and the canvas, then shows the editor after a retry", async () => {
    jest.useFakeTimers();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const load = jest.spyOn(
      scenarioEditorChunks.whatsAppTemplateSection,
      "load"
    );
    load.mockRejectedValueOnce(new Error("Loading chunk failed"));
    const props = {
      loadingLabel: "Loading templates",
    } as ComponentProps<typeof LazyActionNodeWhatsAppTemplateSection>;
    try {
      render(
        <PageErrorScreen>
          <LazyActionNodeWhatsAppTemplateSection {...props} />
          <p>other step</p>
        </PageErrorScreen>
      );
      await act(async () => undefined);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("other step")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Loading templates");

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await act(async () => undefined);

      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByText("template editor")).toBeInTheDocument();
    } finally {
      load.mockRestore();
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });
});
