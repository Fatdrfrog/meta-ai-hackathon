/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageSquare, Route } from "lucide-react";
import type { ScenarioNodePaletteMenuSection } from "./scenario-node-palette-menu";
import { ScenarioNodePaletteMenu } from "./scenario-node-palette-menu";

const sections: ScenarioNodePaletteMenuSection[] = [
  {
    id: "action",
    title: "Message",
    subtitle: "Send a reply",
    icon: MessageSquare,
    items: [
      {
        id: "action-reply",
        kind: "action",
        title: "Simple reply",
      },
      {
        id: "action-whatsapp-template",
        kind: "action",
        title: "WhatsApp template",
      },
    ],
  },
  {
    id: "logic",
    title: "Logic",
    icon: Route,
    items: [
      {
        id: "logic-if-else",
        kind: "logic",
        title: "Gate",
      },
    ],
  },
];

function renderMenu() {
  return render(
    <ScenarioNodePaletteMenu
      contextMenu={{ left: 24, top: 24 }}
      title="Add Timeline Block"
      sourceLabel="Source: Any user reply"
      searchPlaceholder="Search blocks"
      emptyLabel="No blocks match"
      sections={sections}
      onAddNodeFromPaletteItem={jest.fn()}
      onClose={jest.fn()}
    />
  );
}

describe("ScenarioNodePaletteMenu", () => {
  it("searches existing route destinations and exposes disconnect independently from ending", () => {
    const select = jest.fn();
    const disconnect = jest.fn();
    const onEnd = jest.fn();
    render(
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24, connectFromNodeId: "source" }}
        title="Change destination"
        searchPlaceholder="Search steps"
        emptyLabel="No steps"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={jest.fn()}
        route={{
          destinations: [
            { nodeId: "catalog", label: "Catalog" },
            { nodeId: "help", label: "Help" },
          ],
          currentDestinationId: "catalog",
          onSelect: select,
          onDisconnect: disconnect,
          newMessageLabel: "New message",
          existingStepLabel: "Existing step",
          endLabel: "End this path",
          disconnectLabel: "Disconnect",
          onEnd,
        }}
      />
    );
    expect(screen.queryByRole("menuitem", { name: "Help" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Existing step" }));
    expect(screen.getByRole("menuitem", { name: "Help" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search steps"), {
      target: { value: "help" },
    });
    expect(screen.queryByRole("menuitem", { name: "Catalog" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    expect(select).toHaveBeenCalledWith("help");
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("menuitem", { name: "End this path" })
    ).toBeTruthy();
    expect(onEnd).not.toHaveBeenCalled();
  });
  it("focuses search and filters block palette items", async () => {
    renderMenu();

    const search = screen.getByPlaceholderText("Search blocks");
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.change(search, { target: { value: "template" } });

    expect(screen.getByText("WhatsApp template")).toBeTruthy();
    expect(screen.queryByText("Simple reply")).toBeNull();
    expect(screen.queryByText("Gate")).toBeNull();
  });

  it("shows an empty state when no palette item matches the search", () => {
    renderMenu();

    fireEvent.change(screen.getByPlaceholderText("Search blocks"), {
      target: { value: "missing block" },
    });

    expect(screen.getByText("No blocks match")).toBeTruthy();
  });

  it("closes immediately on Escape even when search text is present", () => {
    const onClose = jest.fn();
    render(
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24 }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={onClose}
      />
    );
    const search = screen.getByPlaceholderText("Search blocks");
    fireEvent.change(search, { target: { value: "template" } });

    fireEvent.keyDown(search, { key: "Escape" });

    expect((search as HTMLInputElement).value).toBe("template");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the originating control", async () => {
    const origin = document.createElement("button");
    origin.textContent = "Add next block";
    document.body.append(origin);
    origin.focus();
    const onClose = jest.fn();
    const view = render(
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24 }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={onClose}
      />
    );
    const search = screen.getByPlaceholderText("Search blocks");
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <ScenarioNodePaletteMenu
        contextMenu={null}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={onClose}
      />
    );

    await waitFor(() => expect(document.activeElement).toBe(origin));
    origin.remove();
  });

  it("retargets focus and restoration when another handle opens the existing menu", async () => {
    const firstOrigin = document.createElement("button");
    firstOrigin.textContent = "Add first branch";
    document.body.append(firstOrigin);
    firstOrigin.focus();
    const view = render(
      <ScenarioNodePaletteMenu
        contextMenu={{
          left: 24,
          top: 24,
          connectFromNodeId: "action-1",
          connectFromSourceHandle: "choice-a",
        }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={jest.fn()}
      />
    );
    const search = screen.getByPlaceholderText("Search blocks");
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: "template" } });

    const secondOrigin = document.createElement("button");
    secondOrigin.textContent = "Add second branch";
    document.body.append(secondOrigin);
    secondOrigin.focus();
    view.rerender(
      <ScenarioNodePaletteMenu
        contextMenu={{
          left: 24,
          top: 24,
          connectFromNodeId: "action-1",
          connectFromSourceHandle: "choice-b",
        }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={jest.fn()}
      />
    );

    await waitFor(() => expect(document.activeElement).toBe(search));
    expect((search as HTMLInputElement).value).toBe("");

    view.rerender(
      <ScenarioNodePaletteMenu
        contextMenu={null}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={jest.fn()}
      />
    );

    await waitFor(() => expect(document.activeElement).toBe(secondOrigin));
    firstOrigin.remove();
    secondOrigin.remove();
  });

  it("closes on Escape after keyboard focus moves into the menu", () => {
    const onClose = jest.fn();
    render(
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24 }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={onClose}
      />
    );
    const item = screen.getByRole("menuitem", { name: /Simple reply/i });
    item.focus();

    fireEvent.keyDown(item, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a helper and blocks clicks on disabled palette items", () => {
    const onAdd = jest.fn();
    render(
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24 }}
        title="Add Timeline Block"
        searchPlaceholder="Search blocks"
        emptyLabel="No blocks match"
        sections={[
          {
            id: "action",
            title: "Message",
            icon: MessageSquare,
            items: [
              {
                id: "action-reply",
                kind: "action",
                title: "Reply",
                disabled: true,
                disabledHint: "Add a start block first",
              },
            ],
          },
        ]}
        onAddNodeFromPaletteItem={onAdd}
        onClose={jest.fn()}
      />
    );

    expect(screen.getByText("Add a start block first")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Reply/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("separates the branch toggle from route actions and marks its direction", () => {
    const routeMenu = (branchCollapsed: boolean) => (
      <ScenarioNodePaletteMenu
        contextMenu={{ left: 24, top: 24, connectFromNodeId: "source" }}
        title="Change next step"
        searchPlaceholder="Search steps"
        emptyLabel="No steps"
        sections={sections}
        onAddNodeFromPaletteItem={jest.fn()}
        onClose={jest.fn()}
        route={{
          destinations: [{ nodeId: "catalog", label: "Catalog" }],
          currentDestinationId: "catalog",
          onSelect: jest.fn(),
          onDisconnect: jest.fn(),
          newMessageLabel: "New message",
          existingStepLabel: "Existing step",
          endLabel: "End this path",
          disconnectLabel: "Disconnect",
          onEnd: jest.fn(),
          branchLabel: branchCollapsed ? "Expand branch" : "Collapse branch",
          branchCollapsed,
          onToggleBranch: jest.fn(),
        }}
      />
    );
    const { container, rerender } = render(routeMenu(false));
    const toggle = screen.getByRole("menuitem", { name: "Collapse branch" });
    const separator = screen.getByRole("separator");
    expect(separator.nextElementSibling).toBe(toggle);
    expect(container.querySelector(".lucide-chevrons-down-up")).not.toBeNull();
    rerender(routeMenu(true));
    expect(
      screen.getByRole("menuitem", { name: "Expand branch" })
    ).toBeTruthy();
    expect(container.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });
});
