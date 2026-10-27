/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react";
import { useRealtime } from "@/hooks/use-realtime";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { CRM_BOARD_REALTIME_DEBOUNCE_MS, CRM_BOARD_REALTIME_EVENT_NAMES } from "@/lib/crm/board-realtime-cache";
import { CrmWorkspaceRealtime } from "./crm-workspace-realtime";

const mockMutate = jest.fn();

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: jest.fn(),
}));

jest.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: mockMutate }),
}));

type BoundHandler = (event: RealtimeEventEnvelope) => void;

function makeEvent(
  name: RealtimeEventEnvelope["name"],
  conversationId?: string
): RealtimeEventEnvelope {
  return {
    eventId: `evt-${name}`,
    version: 1,
    name,
    workspaceId: "workspace-1",
    conversationId: conversationId || null,
    createdAt: "2026-08-28T12:00:00.000Z",
    dedupeKey: `${name}:workspace-1`,
    payload: {},
  };
}

describe("CrmWorkspaceRealtime", () => {
  const boundHandlers = new Map<string, BoundHandler>();
  let isConnected = false;

  beforeEach(() => {
    jest.useFakeTimers();
    mockMutate.mockReset();
    boundHandlers.clear();
    isConnected = false;
    (useRealtime as jest.Mock).mockImplementation(() => ({
      channel: {
        bind: (eventName: string, handler: BoundHandler) => {
          boundHandlers.set(eventName, handler);
        },
        unbind: (eventName: string) => {
          boundHandlers.delete(eventName);
        },
      },
      isConnected,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("debounces board revalidation for conversation and CRM events", () => {
    render(<CrmWorkspaceRealtime workspaceId="workspace-1" />);

    expect([...boundHandlers.keys()]).toEqual([
      ...CRM_BOARD_REALTIME_EVENT_NAMES,
    ]);

    boundHandlers.get("conversation.row.changed")?.(
      makeEvent("conversation.row.changed", "507f1f77bcf86cd799439011")
    );
    boundHandlers.get("crm.board.changed")?.(makeEvent("crm.board.changed"));

    expect(mockMutate).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(CRM_BOARD_REALTIME_DEBOUNCE_MS);
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const filter = mockMutate.mock.calls[0][0] as (key: unknown) => boolean;
    expect(
      filter("/api/workspaces/workspace-1/crm/board?status=active")
    ).toBe(true);
    expect(
      filter("/api/customers?workspaceId=workspace-1&page=1")
    ).toBe(true);
    expect(filter("/api/requests?workspaceId=workspace-1")).toBe(false);
  });

  it("revalidates immediately when the workspace socket reconnects", () => {
    const { rerender } = render(
      <CrmWorkspaceRealtime workspaceId="workspace-1" />
    );
    expect(mockMutate).not.toHaveBeenCalled();

    isConnected = true;
    rerender(<CrmWorkspaceRealtime workspaceId="workspace-1" />);

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });
});
