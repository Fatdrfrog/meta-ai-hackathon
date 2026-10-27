import type { FormattedRequest as RequestItem } from "@/features/panel/requests/formatting";
import { mergeDisplayRequests } from "./dialog-list-display";

function request(
  id: string,
  dateValue: string,
  overrides: Partial<RequestItem> = {}
) {
  return {
    id,
    dateValue,
    status: "open",
    client: id,
    request: "",
    category: null,
    action: null,
    channel: "whatsapp",
    source: "WhatsApp",
    isReadByManager: false,
    ...overrides,
  } as RequestItem;
}

describe("mergeDisplayRequests", () => {
  it("keeps a newer filtered query generation over an older realtime overlay", () => {
    const result = mergeDisplayRequests({
      allRequests: [
        request("match", "2026-10-13T07:00:00Z", {
          projectionGeneration: "20",
          lastMessageText: "New query message",
        }),
      ],
      realtimeRows: [
        request("match", "2026-10-13T07:00:00Z", {
          projectionGeneration: "19",
          lastMessageText: "Old overlay",
        }),
      ],
      updatedRowIds: new Set(),
      hasServerBackedFilter: true,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
    });
    expect(result[0].lastMessageText).toBe("New query message");
  });
  it("does not prepend unrelated realtime rows during server-backed filters", () => {
    const result = mergeDisplayRequests({
      allRequests: [request("match", "2026-04-30T12:00:00.000Z")],
      realtimeRows: [
        request("stale-1", "2026-04-30T12:05:00.000Z"),
        request("stale-2", "2026-04-30T12:04:00.000Z"),
        request("match", "2026-04-30T12:03:00.000Z", {
          request: "updated matching row",
        }),
      ],
      updatedRowIds: new Set(["match", "stale-1", "stale-2"]),
      hasServerBackedFilter: true,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
    });

    expect(result.map(row => row.id)).toEqual(["match"]);
    expect(result[0]?.request).toBe("updated matching row");
  });

  it("keeps realtime rows on the unfiltered list", () => {
    const result = mergeDisplayRequests({
      allRequests: [request("older", "2026-04-30T11:00:00.000Z")],
      realtimeRows: [request("new", "2026-04-30T12:00:00.000Z")],
      updatedRowIds: new Set(["new"]),
      hasServerBackedFilter: false,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
    });

    expect(result.map(row => row.id)).toEqual(["new", "older"]);
  });

  it("keeps realtime web widget rows in global date order", () => {
    const result = mergeDisplayRequests({
      allRequests: [request("whatsapp-newer", "2026-05-22T16:21:00.000Z")],
      realtimeRows: [
        request("widget-older", "2026-05-22T00:00:00.000Z", {
          channel: "web_widget",
          source: "Web",
        }),
      ],
      updatedRowIds: new Set(["widget-older"]),
      hasServerBackedFilter: false,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
    });

    expect(result.map(row => row.id)).toEqual([
      "whatsapp-newer",
      "widget-older",
    ]);
  });

  it("keeps a locally read row read when an older realtime hydration arrives", () => {
    const result = mergeDisplayRequests({
      allRequests: [
        request("read-row", "2026-06-21T11:40:00.000Z", {
          isReadByManager: true,
        }),
      ],
      realtimeRows: [
        request("read-row", "2026-06-21T11:40:00.000Z", {
          isReadByManager: false,
        }),
      ],
      updatedRowIds: new Set(["read-row"]),
      hasServerBackedFilter: false,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
      locallyReadAtByConversation: new Map([
        ["read-row", new Date("2026-06-21T11:41:00.000Z").getTime()],
      ]),
    });

    expect(result[0]?.isReadByManager).toBe(true);
  });

  it("allows a newer unread realtime row to show the unread indicator", () => {
    const result = mergeDisplayRequests({
      allRequests: [
        request("read-row", "2026-06-21T11:40:00.000Z", {
          isReadByManager: true,
        }),
      ],
      realtimeRows: [
        request("read-row", "2026-06-21T11:42:00.000Z", {
          isReadByManager: false,
        }),
      ],
      updatedRowIds: new Set(["read-row"]),
      hasServerBackedFilter: false,
      hasUnreadFilter: false,
      recentlyReadInUnreadView: new Set(),
      locallyReadAtByConversation: new Map([
        ["read-row", new Date("2026-06-21T11:41:00.000Z").getTime()],
      ]),
    });

    expect(result[0]?.isReadByManager).toBe(false);
  });
});
