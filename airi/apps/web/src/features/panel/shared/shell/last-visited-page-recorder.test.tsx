/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react";
import { LastVisitedPageRecorder } from "./last-visited-page-recorder";
import { LAST_VISITED_PAGE_RECORD_DELAY_MS } from "./last-visited-page-schedule";

const mockPathname = jest.fn();
const mockSearchParams = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
  useSearchParams: () => mockSearchParams(),
}));

const scenariosPath = "/panel/w/workspace-1/scenarios";
const fetchMock = jest.fn();

function navigate(pathname: string, query = "") {
  mockPathname.mockReturnValue(pathname);
  mockSearchParams.mockReturnValue(new URLSearchParams(query));
}

function recordedPaths() {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).path
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("LastVisitedPageRecorder", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    setVisibility("visible");
    navigate(scenariosPath, "scenarioId=abc");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits for the page's own requests before sending the same record", () => {
    render(<LastVisitedPageRecorder />);

    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS - 1);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/users/last-visited-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${scenariosPath}?scenarioId=abc` }),
      keepalive: true,
    });
  });

  it("drops a pending record when the user moves on, keeping the newest", () => {
    const view = render(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS / 2);
    });

    navigate("/panel/w/workspace-1/kb");
    view.rerender(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS);
    });

    expect(recordedPaths()).toEqual(["/panel/w/workspace-1/kb"]);
  });

  it("records a route once, even when its search params object changes", () => {
    const view = render(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS / 2);
    });

    navigate(scenariosPath, "scenarioId=abc");
    view.rerender(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS * 2);
    });
    navigate(scenariosPath, "scenarioId=abc");
    view.rerender(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS * 2);
    });

    expect(recordedPaths()).toEqual([`${scenariosPath}?scenarioId=abc`]);
  });

  it.each([
    [
      "hidden",
      () => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
    ["unloaded", () => window.dispatchEvent(new Event("pagehide"))],
  ])("sends a pending record at once when the page is %s", (_label, leave) => {
    render(<LastVisitedPageRecorder />);

    act(leave);

    expect(recordedPaths()).toEqual([`${scenariosPath}?scenarioId=abc`]);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing after unmount or outside a workspace", () => {
    const view = render(<LastVisitedPageRecorder />);
    view.unmount();

    navigate("/panel/workspaces/new");
    render(<LastVisitedPageRecorder />);
    act(() => {
      jest.advanceTimersByTime(LAST_VISITED_PAGE_RECORD_DELAY_MS * 2);
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
