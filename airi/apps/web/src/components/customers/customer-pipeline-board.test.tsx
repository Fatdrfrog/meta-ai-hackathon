/**
 * @jest-environment jsdom
 */

import { KeyboardSensor, useSensor } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomerPipelineBoard } from "./customer-pipeline-board";

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("next-intl", () =>
  jest.requireActual("./leads-i18n.test-mock").mockLeadsTranslations()
);

type MockAnnouncements = {
  onDragStart: (event: { active: { id: string } }) => string;
  onDragOver: (event: {
    active: { id: string };
    over: { id: string; data?: { current?: { stageKey?: string } } } | null;
  }) => string;
  onDragEnd: (event: {
    active: { id: string };
    over: { id: string; data?: { current?: { stageKey?: string } } } | null;
  }) => string;
  onDragCancel: (event: { active: { id: string } }) => string;
};

const mockDndAccessibility: {
  current: {
    announcements: MockAnnouncements;
    screenReaderInstructions: { draggable: string };
  } | null;
} = { current: null };

jest.mock("@dnd-kit/core", () => ({
  closestCorners: jest.fn(),
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    accessibility,
  }: {
    children: React.ReactNode;
    onDragStart?: (event: { active: { id: string } }) => void;
    onDragEnd?: (event: {
      active: { id: string };
      over: {
        id: string;
        data: { current: { stageKey: string } };
      };
    }) => void;
    accessibility?: typeof mockDndAccessibility.current;
  }) => {
    mockDndAccessibility.current = accessibility ?? null;
    return (
      <div>
        <button
          type="button"
          onClick={() => onDragStart?.({ active: { id: "card:customer-1" } })}
        >
          Start drag
        </button>
        <button
          type="button"
          onClick={() =>
            onDragEnd?.({
              active: { id: "list:qualified" },
              over: {
                id: "list:new",
                data: { current: { stageKey: "new" } },
              },
            })
          }
        >
          Reorder qualified before new
        </button>
        {children}
      </div>
    );
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="crm-pipeline-drag-overlay">{children}</div>
  ),
  KeyboardCode: { Space: "Space", Esc: "Escape", Enter: "Enter" },
  KeyboardSensor: jest.fn(),
  MouseSensor: jest.fn(),
  TouchSensor: jest.fn(),
  useDroppable: () => ({
    setNodeRef: jest.fn(),
    isOver: false,
  }),
  useSensor: jest.fn(),
  useSensors: jest.fn(() => []),
}));

jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  // Real dnd-kit attributes make the element they land on a focusable button.
  useSortable: () => ({
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-roledescription": "sortable",
    },
    listeners: {},
    setNodeRef: jest.fn(),
    setActivatorNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  sortableKeyboardCoordinates: jest.fn(),
  verticalListSortingStrategy: jest.fn(),
  horizontalListSortingStrategy: jest.fn(),
}));

jest.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: jest.fn(),
    },
  },
}));

jest.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onSelect?: (event: { preventDefault: () => void }) => void;
    }) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSelect?.({ preventDefault() {} })}
      >
        {children}
      </button>
    ),
  };
});

function createBoardResponse() {
  return {
    stages: [
      {
        id: "system-unassigned",
        key: "unassigned",
        name: "Unassigned",
        color: null,
        sortOrder: -1,
        isActive: true,
      },
      {
        id: "stage-new",
        key: "new",
        name: "New",
        color: "#2563eb",
        sortOrder: 0,
        isActive: true,
      },
      {
        id: "stage-qualified",
        key: "qualified",
        name: "Qualified",
        color: "#7c3aed",
        sortOrder: 1,
        isActive: true,
      },
    ],
    columns: [
      {
        stageKey: "unassigned",
        totalCount: 1,
        ltvSum: 1200,
        nextCursor: null,
        cards: [
          {
            id: "customer-1",
            displayName: "Acme buyer",
            status: "active",
            stageKey: "unassigned",
            primaryConversationId: "conversation-1",
            lastInteractionAt: "2026-06-20T08:00:00.000Z",
            createdAt: "2026-06-18T08:00:00.000Z",
            channels: ["whatsapp"],
            contactPoints: {
              emails: ["buyer@example.com"],
              phones: [],
              usernames: [],
            },
            conversationCount: 2,
            estimatedCustomerLtv: 1200,
            sentiment: "positive",
            churnRiskLevel: "high",
            lastInboundAt: "2026-06-20T08:00:00.000Z",
            lastOutboundAt: "2026-06-19T08:00:00.000Z",
            slaDueAt: "2026-06-23T08:00:00.000Z",
            category: "Sales",
            nextAction: "Follow up on pricing",
            attention: ["needs_reply"],
            followUpKind: "reply",
            followUpDueAt: "2026-06-23T08:00:00.000Z",
            warnings: ["objection"],
            ownerUserId: "user-1",
            ownerLabel: "Dana",
            lastInboundSnippet: "Need the quote today",
          },
        ],
      },
      {
        stageKey: "new",
        totalCount: 0,
        ltvSum: null,
        nextCursor: null,
        cards: [],
      },
      {
        stageKey: "qualified",
        totalCount: 0,
        ltvSum: null,
        nextCursor: null,
        cards: [],
      },
    ],
    archivedStages: [],
  };
}

function installBoardFetch(loadBoard: () => unknown = createBoardResponse) {
  global.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/crm/pipeline") && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => ({
            stages: JSON.parse(String(init.body)).stages,
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => loadBoard(),
      } as Response;
    }
  ) as jest.Mock;
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof CustomerPipelineBoard>> = {}
) {
  return render(
    <CustomerPipelineBoard
      workspaceId="workspace-1"
      status="active"
      search=""
      onSelectCustomer={jest.fn()}
      {...props}
    />
  );
}

/** Waits for the pipeline PUT and returns the stages it saved. */
async function savedPipelineStages(workspaceId = "workspace-1") {
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/crm/pipeline`,
      expect.objectContaining({ method: "PUT" })
    );
  });

  const putCall = (global.fetch as jest.Mock).mock.calls.find(
    ([url, init]) =>
      String(url).includes("/crm/pipeline") && init?.method === "PUT"
  );
  return JSON.parse(String(putCall?.[1]?.body)).stages;
}

describe("CustomerPipelineBoard", () => {
  beforeEach(() => {
    installBoardFetch();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders a floating drag overlay for the active card", async () => {
    const onSelectCustomer = jest.fn();
    renderBoard({ attention: "attention", salesOnly: false, onSelectCustomer });

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    expect(screen.getByLabelText("Owner Dana")).toBeTruthy();
    expect(screen.getByText("Needs reply")).toBeTruthy();
    expect(screen.getByText("Objection")).toBeTruthy();
    expect(screen.getByText("Positive")).toBeTruthy();
    expect(screen.getByText("Churn High")).toBeTruthy();
    expect(screen.getAllByText("LTV 1,200").length).toBeGreaterThan(0);
    expect(screen.getByText(/In /)).toBeTruthy();
    expect(screen.getByText(/Out /)).toBeTruthy();
    expect(screen.getByText(/overdue/)).toBeTruthy();
    expect(screen.getByText("Need the quote today")).toBeTruthy();
    expect(screen.queryByText(/Follow up on pricing/)).toBeNull();
    // Trello-style: the card itself opens the lead; the chat link is a
    // sibling control, never nested inside the card's button.
    const cardButton = screen.getByRole("button", { name: "Acme buyer" });
    fireEvent.click(cardButton);
    expect(onSelectCustomer).toHaveBeenCalledWith("customer-1");
    const chatLink = screen.getByRole("link", {
      name: "Open chat for Acme buyer",
    });
    expect(chatLink.getAttribute("href")).toBe(
      "/panel/w/workspace-1/requests?conversation=conversation-1"
    );
    expect(cardButton.contains(chatLink)).toBe(false);
    expect(cardButton.closest("li")?.contains(chatLink)).toBe(true);
    expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start drag" }));

    expect(
      screen.getByTestId("crm-pipeline-drag-overlay").textContent
    ).toContain("Acme buyer");
  });

  it("lets sideways scrolling over cards reach the board scroller", async () => {
    renderBoard();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    expect(screen.getByTestId("crm-pipeline-columns").className).toContain(
      "overflow-x-auto"
    );
    // `overscroll-contain` on both axes trapped horizontal swipes and
    // Shift+wheel inside each column, so the board never scrolled sideways.
    const cardClasses = screen
      .getByTestId("crm-pipeline-column-cards-unassigned")
      .className.split(/\s+/);
    expect(cardClasses).toContain("overflow-y-auto");
    expect(cardClasses).toContain("overflow-x-hidden");
    expect(cardClasses).toContain("overscroll-y-contain");
    expect(cardClasses).not.toContain("overscroll-contain");
  });

  it("drags columns by a keyboard-reachable grip, not the whole column", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    const column = screen
      .getByTestId("crm-pipeline-column-cards-qualified")
      .closest("section");
    expect(column?.getAttribute("role")).toBeNull();
    expect(column?.getAttribute("tabindex")).toBeNull();
    expect(screen.getByRole("button", { name: "Drag Qualified" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Drag Unassigned" })
    ).toBeNull();
    // Space picks up; Enter stays free to open the focused card.
    expect(useSensor).toHaveBeenCalledWith(
      KeyboardSensor,
      expect.objectContaining({
        coordinateGetter: sortableKeyboardCoordinates,
        keyboardCodes: expect.objectContaining({ start: ["Space"] }),
      })
    );
  });

  it("names each list for assistive tech and lists its cards", async () => {
    renderBoard();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    const cards = screen.getByTestId("crm-pipeline-column-cards-unassigned");
    expect(cards.tagName).toBe("UL");
    expect(cards.querySelectorAll(":scope > li")).toHaveLength(1);
    const column = cards.closest("section");
    const titleId = column?.getAttribute("aria-labelledby");
    expect(titleId && document.getElementById(titleId)?.textContent).toBe(
      "Unassigned"
    );
    // LTV sits inline in the one-row header, so all list headers line up.
    expect(column?.firstElementChild?.textContent).toContain("LTV 1,200");
    expect(screen.getByRole("region", { name: "Pipeline board" })).toBeTruthy();
  });

  it("announces drags by lead and list name in the interface language", async () => {
    renderBoard();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    const accessibility = mockDndAccessibility.current;
    expect(accessibility?.screenReaderInstructions.draggable).toMatch(
      /press Space/
    );
    const announcements = accessibility!.announcements;
    expect(
      announcements.onDragStart({ active: { id: "card:customer-1" } })
    ).toBe("Picked up Acme buyer.");
    expect(
      announcements.onDragOver({
        active: { id: "card:customer-1" },
        over: { id: "column:new", data: { current: { stageKey: "new" } } },
      })
    ).toBe("Acme buyer is over New.");
    expect(
      announcements.onDragEnd({
        active: { id: "list:qualified" },
        over: { id: "list:new", data: { current: { stageKey: "new" } } },
      })
    ).toBe("Qualified was dropped on New.");
    expect(
      announcements.onDragCancel({ active: { id: "card:customer-1" } })
    ).toBe("Moving Acme buyer was cancelled.");
  });

  it("reports the lead total to the page toolbar", async () => {
    const onTotalChange = jest.fn();
    renderBoard({ workspaceId: "workspace-total", onTotalChange });

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    await waitFor(() => {
      expect(onTotalChange).toHaveBeenLastCalledWith(1);
    });
  });

  it("turns a vertical wheel on the empty board into sideways scroll", async () => {
    renderBoard();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    const board = screen.getByTestId("crm-pipeline-columns");
    let scrollLeft = 0;
    Object.defineProperty(board, "scrollWidth", { value: 2000 });
    Object.defineProperty(board, "clientWidth", { value: 800 });
    Object.defineProperty(board, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    // Over a list, the wheel stays the list's own vertical scroll.
    fireEvent.wheel(screen.getByTestId("crm-pipeline-column-cards-new"), {
      deltaY: 120,
    });
    expect(scrollLeft).toBe(0);

    fireEvent.wheel(board, { deltaY: 120 });
    expect(scrollLeft).toBe(120);
    // A trackpad's own sideways delta is left to the browser.
    fireEvent.wheel(board, { deltaX: 40, deltaY: 10 });
    expect(scrollLeft).toBe(120);
  });

  it("names archived default stages the same way as their columns", async () => {
    installBoardFetch(() => ({
      ...createBoardResponse(),
      archivedStages: [
        {
          id: "default-won",
          key: "won",
          name: "won",
          color: "#16a34a",
          sortOrder: 3,
          isActive: false,
        },
      ],
    }));

    renderBoard({ workspaceId: "workspace-archived-default" });

    expect(
      await screen.findByRole("button", { name: "Won · Restore stage" })
    ).toBeTruthy();
  });

  it("renames a column from the board title like Trello", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename Qualified" }));

    const titleInput = screen.getByLabelText("Rename Qualified");
    fireEvent.change(titleInput, { target: { value: "Hot leads" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    const stages = await savedPipelineStages();
    expect(stages).toEqual([
      expect.objectContaining({
        key: "new",
        name: "New",
        sortOrder: 0,
      }),
      expect.objectContaining({
        key: "qualified",
        name: "Hot leads",
        sortOrder: 1,
      }),
    ]);
    expect(
      stages.some((stage: { key?: string }) => stage.key === "unassigned")
    ).toBe(false);
  });

  it("does not let operators rename the Unassigned column", async () => {
    renderBoard();

    expect(await screen.findByText("Unassigned")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename Unassigned" })).toBeNull();
  });

  it("adds a column from the board composer", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add another list" }));
    fireEvent.change(screen.getByLabelText("Enter list title…"), {
      target: { value: "Negotiation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add list" }));

    const stages = await savedPipelineStages();
    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "new", name: "New" }),
        expect.objectContaining({ key: "qualified", name: "Qualified" }),
        expect.objectContaining({
          key: "negotiation",
          name: "Negotiation",
          isActive: true,
        }),
      ])
    );
    expect(stages).toHaveLength(3);
  });

  it("archives a column from the list menu", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    const archiveButtons = screen.getAllByRole("button", {
      name: "Archive stage",
    });
    expect(archiveButtons).toHaveLength(2);
    fireEvent.click(archiveButtons[1]);

    expect(await savedPipelineStages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "new", isActive: true }),
        expect.objectContaining({ key: "qualified", isActive: false }),
      ])
    );
  });

  it("changes a column color from the list menu", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Use #16a34a for Qualified" })
    );

    expect(await savedPipelineStages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "qualified", color: "#16a34a" }),
      ])
    );
  });

  it("reorders columns from the board", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reorder qualified before new" })
    );

    const stages = await savedPipelineStages();
    expect(stages.map((stage: { key: string }) => stage.key)).toEqual([
      "qualified",
      "new",
    ]);
  });

  it("does not show a pipeline manager modal", async () => {
    renderBoard();

    expect(await screen.findByText("Qualified")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage pipeline" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText("Pipeline stages")).toBeNull();
  });

  it("restores an archived stage from the archived list", async () => {
    const archivedBoard = {
      ...createBoardResponse(),
      archivedStages: [
        {
          id: "stage-lost",
          key: "lost",
          name: "Lost",
          color: "#dc2626",
          sortOrder: 2,
          isActive: false,
        },
      ],
    };
    installBoardFetch(() => archivedBoard);

    renderBoard({ workspaceId: "workspace-archived" });

    expect(
      await screen.findByRole("button", { name: "Lost · Restore stage" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Lost · Restore stage" })
    );

    expect(await savedPipelineStages("workspace-archived")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "lost", isActive: true }),
      ])
    );
  });
});
