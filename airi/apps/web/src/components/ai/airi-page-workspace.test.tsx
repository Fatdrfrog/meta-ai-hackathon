/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type React from "react";
import type { AiriDesktopColumnsProps } from "./airi-chat-workspace";
import {
  AiriPageWorkspace,
  AiriResizableDesktopColumns,
} from "./airi-page-workspace";

const mockLayouts: Array<(sizes: number[]) => void> = [];

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    onLayout,
  }: {
    children: React.ReactNode;
    onLayout?: (sizes: number[]) => void;
  }) => {
    if (onLayout) mockLayouts.push(onLayout);
    return <div data-testid="panel-group">{children}</div>;
  },
  ResizablePanel: ({
    children,
    defaultSize,
  }: {
    children: React.ReactNode;
    defaultSize?: number;
  }) => (
    <div data-testid="panel" data-default-size={defaultSize}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-testid="panel-handle" />,
}));

const mockWorkspaceProps: Array<Record<string, unknown>> = [];

jest.mock("@/components/ai/airi-chat-workspace", () => ({
  AiriChatWorkspace: (
    props: Record<string, unknown> & {
      desktopColumns: React.ComponentType<AiriDesktopColumnsProps>;
    }
  ) => {
    mockWorkspaceProps.push(props);
    const Columns = props.desktopColumns;
    return (
      <Columns
        threadList={<p>Chat list</p>}
        thread={<p>Thread</p>}
        sidePanel={null}
        sidePanelSize={32}
        onSidePanelSizeChange={() => undefined}
      />
    );
  },
}));

beforeEach(() => {
  mockLayouts.length = 0;
  mockWorkspaceProps.length = 0;
});

describe("AiriPageWorkspace", () => {
  it("renders the page workspace in resizable columns on the first render", () => {
    render(
      <AiriPageWorkspace workspaceId="workspace-1" initialSource="manual" />
    );

    // No lazy chunk: the columns are in the page's own module.
    const group = screen.getByTestId("panel-group");
    expect(within(group).getByText("Chat list")).toBeInTheDocument();
    expect(within(group).getByText("Thread")).toBeInTheDocument();
    expect(mockWorkspaceProps[0]).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        initialSource: "manual",
        desktopColumns: AiriResizableDesktopColumns,
      })
    );
    expect(mockWorkspaceProps[0]).not.toHaveProperty("compact");
  });
});

describe("AiriResizableDesktopColumns", () => {
  function renderColumns(params: {
    sidePanel: React.ReactNode | null;
    onSidePanelSizeChange?: jest.Mock;
  }) {
    return render(
      <AiriResizableDesktopColumns
        threadList={<p>Chat list</p>}
        thread={<p>Thread</p>}
        sidePanel={params.sidePanel}
        sidePanelSize={36}
        onSidePanelSizeChange={params.onSidePanelSizeChange ?? jest.fn()}
      />
    );
  }

  it("shows two columns while the side panel is closed and ignores layout sizes", () => {
    const onSidePanelSizeChange = jest.fn();
    renderColumns({ sidePanel: null, onSidePanelSizeChange });

    expect(screen.getAllByTestId("panel")).toHaveLength(2);
    expect(screen.getAllByTestId("panel-handle")).toHaveLength(1);
    mockLayouts.at(-1)?.([24, 76]);
    expect(onSidePanelSizeChange).not.toHaveBeenCalled();
  });

  it("opens the side panel at its remembered size and keeps a size the user drags within bounds", () => {
    const onSidePanelSizeChange = jest.fn();
    renderColumns({
      sidePanel: <p>Builder</p>,
      onSidePanelSizeChange,
    });

    const panels = screen.getAllByTestId("panel");
    expect(panels).toHaveLength(3);
    expect(panels[2]).toHaveAttribute("data-default-size", "36");
    expect(within(panels[2]).getByText("Builder")).toBeInTheDocument();
    expect(screen.getAllByTestId("panel-handle")).toHaveLength(2);

    const onLayout = mockLayouts.at(-1);
    onLayout?.([20, 40.4, 39.6]);
    onLayout?.([20, 70, 10]);
    onLayout?.([10, 30, 60]);
    expect(onSidePanelSizeChange.mock.calls).toEqual([[40]]);
  });
});
