/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioPreviewDrawer } from "./drawer";

jest.mock("./conversation", () => ({
  ScenarioConversationPreview: () => <p>Conversation preview</p>,
}));

it("provides a visible close control in customer conversation mode", () => {
  const onOpenChange = jest.fn();
  render(
    <ScenarioPreviewDrawer
      open
      onOpenChange={onOpenChange}
      workspaceId="workspace"
      draftScenario={
        {
          scenarioId: "draft",
          name: "Draft",
          nodes: [
            {
              id: "message",
              data: {
                kind: "action",
                actionWhatsAppServiceMessage: {
                  version: 1,
                  message: {
                    kind: "text",
                    body: { mode: "fixed", text: "Hello" },
                  },
                },
              },
            },
          ],
          edges: [],
        } as never
      }
    />
  );
  expect(screen.getByText("Conversation preview")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "close" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
