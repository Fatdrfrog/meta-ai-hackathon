/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import {
  DashboardBoardController,
  OutcomesBoardController,
} from "./dashboard-board-controller";
import type { DashboardBoardState } from "./dashboard-board-model";

jest.mock("next-intl", () => ({
  useTranslations:
    (namespace?: string) =>
    (key: string, values?: Record<string, string | number>) =>
      // The unreadable notice is page-specific, so it keeps its namespace.
      key === "unreadable"
        ? `${namespace}.${key}`
        : key === "deletePending"
          ? `${key} ${values?.count}: ${values?.names}`
          : key === "deletePendingName"
            ? `“${values?.name}”`
            : values?.card
              ? `${key} ${values.card}`
              : key.replace(/\{(\w+)\}/g, (_, name: string) =>
                  String(values?.[name] ?? "")
                ),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

// The per-browser dashboard memory must not leak between tests.
beforeEach(() => window.localStorage.clear());

const saved: DashboardBoardState = {
  version: 1,
  activeViewId: "overview",
  views: [
    {
      id: "overview",
      name: "My overview",
      templateId: "starter",
      cards: [
        { id: "total", width: 1, height: 1 },
        { id: "volume", width: 3, height: 2 },
      ],
    },
  ],
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mount(workspaceId = "workspace-one") {
  let refresh: (() => Promise<unknown>) | undefined;
  function Board() {
    const { mutate } = useSWRConfig();
    useEffect(() => {
      refresh = () =>
        mutate([
          `/api/workspaces/${workspaceId}/analytics/dashboards`,
          "member-one",
        ]);
    }, [mutate]);
    return (
      <DashboardBoardController workspaceId={workspaceId} memberId="member-one">
        {({ cards, editing, onCardsChange }) => (
          <>
            <output aria-label="card order">
              {cards.map(card => card.id).join(",")}
            </output>
            {editing && (
              <button
                onClick={() =>
                  onCardsChange(cards.filter(card => card.id !== "volume"))
                }
              >
                Remove volume
              </button>
            )}
          </>
        )}
      </DashboardBoardController>
    );
  }
  const result = render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      <Board />
    </SWRConfig>
  );
  return { ...result, refresh: () => refresh!() };
}

function mountOutcomes(
  workspaceId = "workspace-one",
  memberId = "member-one",
  inlineToolbar = false
) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      <OutcomesBoardController
        workspaceId={workspaceId}
        memberId={memberId}
        inlineToolbar={inlineToolbar}
      >
        {({ cards, editing, onCardsChange, toolbar }) => (
          <>
            <div aria-label="shared report controls">
              <button>Refresh reports</button>
              {toolbar}
            </div>
            <output aria-label="outcome order">
              {cards.map(card => card.id).join(",")}
            </output>
            {editing && (
              <button
                onClick={() =>
                  onCardsChange(cards.filter(card => card.id !== "acquisition"))
                }
              >
                Remove acquisition
              </button>
            )}
          </>
        )}
      </OutcomesBoardController>
    </SWRConfig>
  );
}

describe("personal Outcomes workspace", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest
      .fn()
      .mockResolvedValue(response({ state: saved, revision: 4 }));
    global.fetch = fetchMock;
  });

  it("renders one shared toolbar beside report controls and preserves editing, library, and focus", async () => {
    const user = userEvent.setup();
    mountOutcomes("workspace-one", "member-one", true);
    const controls = screen.getByLabelText("shared report controls");
    await waitFor(() =>
      expect(
        (
          within(controls).getByRole("button", {
            name: "edit",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(screen.getAllByRole("button", { name: "edit" })).toHaveLength(1);
    expect(
      within(controls).getByRole("button", { name: "Refresh reports" })
    ).toBeTruthy();
    await user.click(within(controls).getByRole("button", { name: "edit" }));
    expect(within(controls).getByRole("button", { name: "save" })).toBeTruthy();
    const add = within(controls).getByRole("button", { name: "add" });
    await user.click(add);
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    await user.click(within(library).getByRole("button", { name: "health" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(add));
    await user.click(within(controls).getByRole("button", { name: "cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(controls).getByRole("button", { name: "edit" })
      )
    );
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery"
    );
    expect(screen.getAllByRole("button", { name: "edit" })).toHaveLength(1);
  });

  it("keeps Edit, Add, and Reset available when an inline workspace is empty", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      response({ state: { ...saved, outcomes: { cards: [] } }, revision: 4 })
    );
    mountOutcomes("workspace-one", "member-one", true);
    await screen.findByText("emptyTitle");
    const controls = screen.getByLabelText("shared report controls");
    expect(within(controls).queryByRole("button", { name: "edit" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "edit" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "add" }));
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    await user.click(within(library).getByRole("button", { name: "health" }));
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("outcome order").textContent).toBe("health");
    expect(screen.getAllByRole("button", { name: "add" })).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(controls).getByRole("button", { name: "add" })
      )
    );
    await user.click(within(controls).getByRole("button", { name: "cancel" }));
    await screen.findByText("emptyTitle");
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery"
    );
    expect(screen.getAllByRole("button", { name: "reset" })).toHaveLength(1);
    expect(
      within(controls).getByRole("button", { name: "reset" })
    ).toBeTruthy();
    await user.click(within(controls).getByRole("button", { name: "cancel" }));
    await screen.findByText("emptyTitle");
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("keeps default reports readable after a failed preference read and prevents fallback saves", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503));
    mountOutcomes();
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery"
    );
    await screen.findByText("loadFailed");
    expect(
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("reads saved Outcomes leniently instead of locking the member out", async () => {
    fetchMock.mockResolvedValue(
      response({
        state: {
          ...saved,
          outcomes: {
            cards: [
              { id: "health", width: 4, height: 1 },
              { id: "health", width: 4, height: 1 },
              { id: "attribution", width: 4, height: 1 },
            ],
          },
        },
        revision: 4,
      })
    );
    mountOutcomes();
    await screen.findByText("health");
    expect(screen.queryByText("loadFailed")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("shows defaults for an unreadable saved layout and replaces it on save", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 5,
            })
          : response({ state: { ...saved, version: 2 }, revision: 4 })
      )
    );
    mountOutcomes();
    await screen.findByText("AnalyticsOutcomes.workspace.unreadable");
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery"
    );
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove acquisition" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(4);
    expect(
      submitted.state.outcomes.cards.map(({ id }: { id: string }) => id)
    ).toEqual(["attention", "delivery"]);
  });

  it("drops an Outcomes draft when the workspace or authenticated member changes", async () => {
    const first = {
      ...saved,
      outcomes: { cards: [{ id: "acquisition", width: 4, height: 1 }] },
    };
    const second = {
      ...saved,
      outcomes: { cards: [{ id: "retention", width: 4, height: 1 }] },
    };
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        response({
          state: url.includes("workspace-two") ? second : first,
          revision: 4,
        })
      )
    );
    const cache = new Map();
    function tree(workspaceId: string, memberId: string) {
      return (
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
          <OutcomesBoardController
            workspaceId={workspaceId}
            memberId={memberId}
          >
            {({ cards, editing, onCardsChange }) => (
              <>
                <output aria-label="outcome order">
                  {cards.map(card => card.id).join(",")}
                </output>
                {editing && (
                  <button onClick={() => onCardsChange([])}>
                    Empty workspace
                  </button>
                )}
              </>
            )}
          </OutcomesBoardController>
        </SWRConfig>
      );
    }
    const rendered = render(tree("workspace-one", "member-one"));
    await screen.findByText("acquisition");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Empty workspace" }));
    expect(screen.getByLabelText("outcome order").textContent).toBe("");
    rendered.rerender(tree("workspace-two", "member-two"));
    await screen.findByText("retention");
    expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === "/api/workspaces/workspace-two/analytics/dashboards"
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("saves Outcomes only on explicit save and preserves all named dashboard views", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 5,
            })
          : response({ state: saved, revision: 4 })
      )
    );
    mountOutcomes();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove acquisition" }));
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "attention,delivery"
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "edit" })
      )
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(4);
    expect(submitted.state.views).toEqual(saved.views);
    expect(submitted.state.activeViewId).toBe(saved.activeViewId);
    expect(
      submitted.state.outcomes.cards.map((card: { id: string }) => card.id)
    ).toEqual(["attention", "delivery"]);
    expect(submitted).not.toHaveProperty("userId");
  });

  it("allows cancelling a reset without changing saved Outcomes or dashboard preferences", async () => {
    const state = {
      ...saved,
      outcomes: { cards: [{ id: "health", width: 4, height: 1 }] },
    };
    fetchMock.mockResolvedValue(response({ state, revision: 4 }));
    mountOutcomes();
    await screen.findByText("health");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery"
    );
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByLabelText("outcome order").textContent).toBe("health");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "edit" })
      )
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("supports adding every optional report without duplicates and restores library trigger focus", async () => {
    const user = userEvent.setup();
    mountOutcomes();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    await user.click(screen.getByRole("button", { name: "edit" }));
    const trigger = screen.getByRole("button", { name: "add" });
    await user.click(trigger);
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    expect(
      within(library).queryByRole("button", { name: "acquisition" })
    ).toBeNull();
    for (const id of ["templates", "health", "flows", "retention"] as const) {
      const option = within(library).getByRole("button", { name: id });
      option.focus();
      await user.keyboard("{Enter}");
      expect(within(library).queryByRole("button", { name: id })).toBeNull();
      const next = {
        templates: "health",
        health: "flows",
        flows: "retention",
        retention: "libraryClose",
      }[id];
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(library).getByRole("button", { name: next })
        )
      );
    }
    expect(within(library).getByText("allAdded")).not.toBeNull();
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "acquisition,attention,delivery,templates,health,flows,retention"
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("retains the captured Outcomes draft after save failure and requires reload after conflict", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ state: saved, revision: 4 }))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(
        response({ state: { ...saved, outcomes: { cards: [] } }, revision: 7 })
      );
    mountOutcomes();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove acquisition" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("saveFailed");
    expect(screen.getByLabelText("outcome order").textContent).toBe(
      "attention,delivery"
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("conflict");
    expect(
      (screen.getByRole("button", { name: "save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    const submissions = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === "PUT"
    );
    expect(
      submissions.map(([, options]) => JSON.parse(options.body).revision)
    ).toEqual([4, 4]);
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await screen.findByText("emptyTitle");
    expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
    expect(screen.getByLabelText("outcome order").textContent).toBe("");
  });

  it("persists a first Outcomes save with null revision while retaining a valid default dashboard", async () => {
    fetchMock.mockResolvedValueOnce(response({ state: null, revision: null }));
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) =>
      Promise.resolve(
        response({
          state: JSON.parse(options.body as string).state,
          revision: 1,
        })
      )
    );
    mountOutcomes();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBeNull();
    expect(submitted.state.version).toBe(1);
    expect(submitted.state.views[0].cards).toHaveLength(7);
    expect(submitted.state.outcomes.cards).toHaveLength(3);
  });
});

describe("DashboardBoardController", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest
      .fn()
      .mockResolvedValue(response({ state: saved, revision: 4 }));
    global.fetch = fetchMock;
  });

  it("preserves the separate saved Outcomes layout when editing a dashboard view", async () => {
    const state: DashboardBoardState = {
      ...saved,
      outcomes: { cards: [{ id: "retention", width: 4, height: 2 }] },
    };
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 5,
            })
          : response({ state, revision: 4 })
      )
    );
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.state.outcomes).toEqual(state.outcomes);
    expect(submitted.state.views[0].cards).toEqual([
      { id: "total", width: 1, height: 1 },
    ]);
  });

  it("renders a read-only default board after a failed read and never saves it", async () => {
    const starter =
      "total,new,resolved,first_response,volume,categories,category_comparison";
    fetchMock.mockResolvedValueOnce(response({}, 503));
    mount();
    // Cards (and so the metrics request) render before preferences resolve.
    expect(screen.getByLabelText("card order").textContent).toBe(starter);
    expect(screen.getByText("loading")).toBeTruthy();
    await screen.findByText("loadFailed");
    expect(screen.getByLabelText("card order").textContent).toBe(starter);
    for (const name of ["edit", "new"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    expect(screen.queryByText("unsavedChanges")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("total,volume");
    expect(
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(
      fetchMock.mock.calls.every(([, options]) => options?.method !== "PUT")
    ).toBe(true);
  });

  it("starts a member without a saved layout on the recommended template", async () => {
    fetchMock.mockResolvedValue(
      response({
        state: null,
        revision: null,
        recommendation: { templateId: "sales", reason: "ads_connected" },
      })
    );
    mount();
    await screen.findByText(
      "total,new,repeat,first_response,volume,channels,advertisements,campaigns"
    );
    expect(
      screen.getByRole("button", { name: "view templates.sales.title" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "new" }));
    const dialog = screen.getByRole("dialog", { name: "newTitle" });
    const templates = within(dialog).getAllByRole("button", {
      name: /^templates\./,
    });
    expect(templates.map(button => button.getAttribute("aria-label"))).toEqual([
      "templates.sales.title",
      "templates.starter.title",
      "templates.support.title",
      "templates.operations.title",
    ]);
    expect(within(templates[0]).getByText("recommended")).toBeTruthy();
    expect(
      within(templates[0]).getByText("recommendationReasons.ads_connected")
    ).toBeTruthy();
    expect(templates[0].getAttribute("aria-describedby")).toBeTruthy();
    expect(within(templates[1]).queryByText("recommended")).toBeNull();
  });

  it("shows the last confirmed layout read-only while the next read is pending", async () => {
    const first = mount();
    await screen.findByText("total,volume");
    first.unmount();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(screen.getByLabelText("card order").textContent).toBe(
      "total,volume"
    );
    expect(
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("lists every dashboard and remembers the opened one without a draft", async () => {
    const user = userEvent.setup();
    const two: DashboardBoardState = {
      ...saved,
      views: [
        ...saved.views,
        {
          id: "growth",
          name: "Growth board",
          templateId: "sales",
          cards: [{ id: "campaigns", width: 2, height: 2 }],
        },
      ],
    };
    fetchMock.mockResolvedValue(response({ state: two, revision: 4 }));
    const first = mount();
    await screen.findByText("total,volume");
    await user.click(screen.getByRole("button", { name: "view My overview" }));
    const list = screen.getByRole("list", { name: "dashboardsTitle" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("viewSummary")).toBeTruthy();
    expect(
      within(rows[0])
        .getByRole("button", { name: /^My overview/ })
        .getAttribute("aria-current")
    ).toBe("true");
    await user.click(
      within(rows[1]).getByRole("button", { name: /^Growth board/ })
    );
    expect(screen.getByLabelText("card order").textContent).toBe("campaigns");
    expect(screen.queryByText("unsavedChanges")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
    first.unmount();
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("card order").textContent).toBe("campaigns")
    );
    expect(
      screen.getByRole("button", { name: "view Growth board" })
    ).toBeTruthy();
  });

  it("renames and deletes dashboards from the list through an explicit save", async () => {
    const user = userEvent.setup();
    const two: DashboardBoardState = {
      ...saved,
      views: [
        ...saved.views,
        { id: "growth", name: "Growth board", templateId: "sales", cards: [] },
      ],
    };
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 5,
            })
          : response({ state: two, revision: 4 })
      )
    );
    mount();
    await screen.findByText("total,volume");
    await user.click(screen.getByRole("button", { name: "view My overview" }));
    await user.click(
      screen.getByRole("button", { name: "rename: Growth board" })
    );
    const name = screen.getByRole("textbox", { name: "name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.getAttribute("value")).toBe("Growth board");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    await user.click(screen.getByRole("button", { name: "view Growth board" }));
    await user.click(
      screen.getByRole("button", { name: "delete: My overview" })
    );
    expect(screen.getByText("deletePending 1: “My overview”")).toBeTruthy();
    expect(screen.getByText("unsavedChanges")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "save" })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(4);
    expect(submitted.state.views.map(({ id }: { id: string }) => id)).toEqual([
      "growth",
    ]);
    expect(submitted.state.activeViewId).toBe("growth");
  });

  it("lists every dashboard deleted in one edit until it is saved or cancelled", async () => {
    const three: DashboardBoardState = {
      ...saved,
      views: [
        ...saved.views,
        { id: "growth", name: "Growth board", templateId: "sales", cards: [] },
        { id: "care", name: "Care board", templateId: "support", cards: [] },
      ],
    };
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 5,
            })
          : response({ state: three, revision: 4 })
      )
    );
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(screen.getByText("deletePending 1: “My overview”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(
      screen.getByText("deletePending 2: “My overview”, “Growth board”")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByText(/^deletePending/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.queryByText(/^deletePending/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    expect(screen.queryByText(/^deletePending/)).toBeNull();
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.state.views.map(({ id }: { id: string }) => id)).toEqual([
      "care",
    ]);
  });

  it("shows a starting board for an unreadable layout and saves over its revision", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        options?.method === "PUT"
          ? response({
              state: JSON.parse(options.body as string).state,
              revision: 8,
            })
          : response({ state: { version: 3, views: "?" }, revision: 7 })
      )
    );
    mount();
    await screen.findByText("DashboardClientPage.board.unreadable");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(7);
    expect(submitted.state.views[0].templateId).toBe("starter");
    expect(
      screen.queryByText("DashboardClientPage.board.unreadable")
    ).toBeNull();
  });

  it("cancels card and rename edits without changing the saved view", async () => {
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByText("unsavedChanges")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    expect(screen.getByLabelText("card order").textContent).toBe("total");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByText("unsavedChanges")).toBeNull();
    expect(screen.getByLabelText("card order").textContent).toBe(
      "total,volume"
    );
    expect(
      screen.getByRole("button", { name: "view My overview" })
    ).toBeTruthy();
  });

  it("retains the draft after a failed save and sends the captured revision on retry", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === "PUT") return Promise.resolve(response({}, 503));
      return Promise.resolve(response({ state: saved, revision: 4 }));
    });
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("saveFailed");
    expect(screen.getByLabelText("card order").textContent).toBe("total");
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(4);
    expect(submitted.state.views[0].cards).toEqual([
      { id: "total", width: 1, height: 1 },
    ]);
    fetchMock.mockResolvedValueOnce(
      response({ state: submitted.state, revision: 5 })
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    expect(screen.getByLabelText("card order").textContent).toBe("total");
  });

  it("does not erase a draft when background data refreshes", async () => {
    const board = mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    fetchMock.mockResolvedValueOnce(response({ state: saved, revision: 5 }));
    await act(async () => {
      await board.refresh();
    });
    expect(screen.getByLabelText("card order").textContent).toBe("total");
    fetchMock.mockResolvedValueOnce(response({}, 409));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("conflict");
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    );
    expect(submitted.revision).toBe(4);
  });

  it("requires reloading a conflicting saved version while retaining the unsaved draft", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ state: saved, revision: 4 }))
      .mockResolvedValueOnce(response({}, 409));
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("conflict");
    expect(screen.getByLabelText("card order").textContent).toBe("total");
    expect(
      (screen.getByRole("button", { name: "save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "new" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() =>
      expect(screen.getByLabelText("card order").textContent).toBe(
        "total,volume"
      )
    );
    expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
  });

  it("creates an independently named template view only on explicit save", async () => {
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "new" }));
    const dialog = screen.getByRole("dialog", { name: "newTitle" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "name" }), {
      target: { value: "Growth" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /templates.sales.title/ })
    );
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
    expect(
      screen.getByRole("textbox", { name: "name" }).getAttribute("value")
    ).toBe("Growth");
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) =>
      Promise.resolve(
        response({
          state: JSON.parse(options.body as string).state,
          revision: 5,
        })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    ).state;
    expect(submitted.views).toHaveLength(2);
    expect(submitted.views[0]).toEqual(saved.views[0]);
    expect(submitted.views[1].name).toBe("Growth");
    expect(submitted.views[1].templateId).toBe("sales");
    expect(submitted.activeViewId).toBe(submitted.views[1].id);
  });

  it("requires a valid draft name before another dashboard can be created", async () => {
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    const name = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(name, { target: { value: "   " } });
    expect(
      (screen.getByRole("button", { name: "new" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByText("nameRequired")).not.toBeNull();
    fireEvent.change(name, { target: { value: "Support" } });
    fireEvent.click(screen.getByRole("button", { name: "new" }));
    const dialog = screen.getByRole("dialog", { name: "newTitle" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "templates.sales.title" })
    );
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) =>
      Promise.resolve(
        response({
          state: JSON.parse(options.body as string).state,
          revision: 5,
        })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull()
    );
    const submitted = JSON.parse(
      fetchMock.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body
    ).state;
    expect(submitted.views[0].name).toBe("Support");
    expect(submitted.views).toHaveLength(2);
  });

  it("shows template purpose and the real cards using text controls", async () => {
    const { container } = mount();
    await screen.findByText("total,volume");
    expect(container.querySelector(".lucide")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "new" }));
    const dialog = screen.getByRole("dialog", { name: "newTitle" });
    expect(within(dialog).getByText("templates.sales.question")).not.toBeNull();
    const growth = within(dialog).getByRole("button", {
      name: "templates.sales.title",
    });
    expect(within(growth).getByText("cards.campaigns")).not.toBeNull();
    expect(dialog.querySelector(".lucide")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("searches grouped card descriptions and scopes and closes with Done", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("total,volume");
    await user.click(screen.getByRole("button", { name: "edit" }));
    const trigger = screen.getByRole("button", { name: "addCard" });
    await user.click(trigger);
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    expect(library.querySelector(".lucide")).toBeNull();
    expect(
      within(library).getByRole("heading", { name: "groups.automation" })
    ).not.toBeNull();
    fireEvent.change(
      within(library).getByRole("textbox", { name: "librarySearch" }),
      { target: { value: "ai_usage" } }
    );
    expect(
      within(library).getByText("cardDescriptions.ai_usage")
    ).not.toBeNull();
    expect(within(library).getByText("scopes.ai")).not.toBeNull();
    expect(
      within(library).queryByRole("button", { name: "cards.campaigns" })
    ).toBeNull();
    await user.click(
      within(library).getByRole("button", { name: "cards.ai_usage" })
    );
    expect(screen.getByLabelText("card order").textContent).toBe(
      "total,volume,ai_usage"
    );
    await user.click(within(library).getByRole("button", { name: "done" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps the draft when a successful HTTP save returns no saved state", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ state: saved, revision: 4 }))
      .mockResolvedValueOnce(response({ state: null, revision: null }));
    mount();
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove volume" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("saveFailed");
    expect(screen.getByLabelText("card order").textContent).toBe("total");
  });

  it("restores a removed card to an empty saved dashboard without duplicating it", async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        state: { ...saved, views: [{ ...saved.views[0], cards: [] }] },
        revision: 4,
      })
    );
    mount();
    await screen.findByText("emptyTitle");
    fireEvent.click(screen.getByRole("button", { name: "addCard" }));
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    fireEvent.click(
      within(library).getByRole("button", { name: "cards.total" })
    );
    expect(screen.getByLabelText("card order").textContent).toBe("total");
    expect(
      within(library).queryByRole("button", { name: "cards.total" })
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")
    ).toBe(false);
  });

  it("returns keyboard focus to Add card when the library closes", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("total,volume");
    await user.click(screen.getByRole("button", { name: "edit" }));
    const trigger = screen.getByRole("button", { name: "addCard" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("announces a keyboard addition and moves focus to the stable search control", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("total,volume");
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "addCard" }));
    const library = screen.getByRole("dialog", { name: "libraryTitle" });
    const add = within(library).getByRole("button", { name: "cards.ai_usage" });
    add.focus();
    await user.keyboard("{Enter}");
    expect(
      within(library).queryByRole("button", { name: "cards.ai_usage" })
    ).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(library).getByRole("textbox", { name: "librarySearch" })
      )
    );
    expect(within(library).getByRole("status").textContent).toBe(
      "libraryAdded cards.ai_usage"
    );
  });

  it("disables editing during a save and ignores its result after switching workspace", async () => {
    let finishSave: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === "PUT")
        return new Promise(resolve => {
          finishSave = resolve;
        });
      return Promise.resolve(
        response({
          state: url.includes("workspace-two")
            ? {
                ...saved,
                views: [
                  {
                    ...saved.views[0],
                    cards: [{ id: "new", width: 1, height: 1 }],
                  },
                ],
              }
            : saved,
          revision: 4,
        })
      );
    });
    function Board({ workspaceId }: { workspaceId: string }) {
      return (
        <SWRConfig
          value={{ provider: () => new Map(), shouldRetryOnError: false }}
        >
          <DashboardBoardController
            workspaceId={workspaceId}
            memberId="member-one"
          >
            {({ cards, editing, onCardsChange }) => (
              <>
                <output aria-label="card order">
                  {cards.map(card => card.id).join(",")}
                </output>
                {editing && (
                  <button onClick={() => onCardsChange([])}>Clear cards</button>
                )}
              </>
            )}
          </DashboardBoardController>
        </SWRConfig>
      );
    }
    const view = render(<Board workspaceId="workspace-one" />);
    await screen.findByText("total,volume");
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    const clear = screen.getByRole("button", { name: "Clear cards" });
    expect(clear.closest("fieldset")?.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    view.rerender(<Board workspaceId="workspace-two" />);
    await waitFor(() =>
      expect(screen.getByLabelText("card order").textContent).toBe("new")
    );
    await act(async () => {
      finishSave!(response({ state: saved, revision: 5 }));
    });
    expect(screen.getByLabelText("card order").textContent).toBe("new");
  });

  it("isolates members sharing the same workspace and SWR cache during slow and failed reads", async () => {
    let finishMemberRead: ((response: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(response({ state: saved, revision: 4 }))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishMemberRead = resolve;
          })
      );
    const cache = new Map();
    function Board({ memberId }: { memberId: string }) {
      return (
        <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
          <DashboardBoardController
            workspaceId="workspace-one"
            memberId={memberId}
          >
            {({ cards }) => (
              <output aria-label="card order">
                {cards.map(card => card.id).join(",")}
              </output>
            )}
          </DashboardBoardController>
        </SWRConfig>
      );
    }
    const starter =
      "total,new,resolved,first_response,volume,categories,category_comparison";
    const editDisabled = () =>
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled;
    const view = render(<Board memberId="member-one" />);
    await screen.findByText("total,volume");
    view.rerender(<Board memberId="member-two" />);
    // Another member never sees the previous member's layout, even read-only.
    expect(screen.getByLabelText("card order").textContent).toBe(starter);
    expect(editDisabled()).toBe(true);
    await waitFor(() => expect(finishMemberRead).toBeDefined());
    await act(async () => {
      finishMemberRead!(response({}, 503));
    });
    await screen.findByText("loadFailed");
    expect(screen.getByLabelText("card order").textContent).toBe(starter);
    expect(editDisabled()).toBe(true);
  });

  it("rejects a saved state with an invalid zero revision", async () => {
    fetchMock.mockResolvedValueOnce(response({ state: saved, revision: 0 }));
    mount();
    await screen.findByText("loadFailed");
    expect(
      (screen.getByRole("button", { name: "edit" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
