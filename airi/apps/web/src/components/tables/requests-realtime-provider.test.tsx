/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react";
import {
  RequestsRealtimeProvider,
  useRequestsRealtime,
  type RequestRow,
} from "./requests-realtime-provider";

type RealtimeContext = ReturnType<typeof useRequestsRealtime>;

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "conv_1",
    projectionGeneration: "1",
    readStateWatermark: "0000000000000000",
    dateValue: "2026-06-21T12:00:00.000Z",
    source: "WhatsApp",
    status: "open",
    client: "Alice",
    request: "Original summary",
    category: null,
    action: null,
    channel: "whatsapp",
    isReadByManager: false,
    ...overrides,
  };
}

function ContextProbe({
  onValue,
}: {
  onValue: (value: RealtimeContext) => void;
}) {
  onValue(useRequestsRealtime());
  return null;
}

function renderProvider() {
  let context: RealtimeContext | null = null;

  render(
    <RequestsRealtimeProvider>
      <ContextProbe
        onValue={value => {
          context = value;
        }}
      />
    </RequestsRealtimeProvider>
  );

  return () => {
    if (!context) {
      throw new Error("RequestsRealtimeProvider context was not captured");
    }
    return context;
  };
}

describe("RequestsRealtimeProvider", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not highlight identical row hydrations", () => {
    const getContext = renderProvider();
    const row = request();

    act(() => {
      getContext().addNewRow(row, { highlight: false });
    });

    const rowsBefore = getContext().realtimeRows;

    act(() => {
      getContext().updateRow({ ...row });
    });

    expect(getContext().realtimeRows).toBe(rowsBefore);
    expect(getContext().updatedRowIds.has(row.id)).toBe(false);
  });

  it("applies silent row updates without marking the row as just updated", () => {
    const getContext = renderProvider();
    const row = request();

    act(() => {
      getContext().addNewRow(row, { highlight: false });
      getContext().updateRow(request({ request: "Updated summary" }), {
        highlight: false,
      });
    });

    expect(getContext().realtimeRows[0]?.request).toBe("Updated summary");
    expect(getContext().updatedRowIds.has(row.id)).toBe(false);
  });

  it("highlights changed realtime row updates by default", () => {
    const getContext = renderProvider();
    const row = request();

    act(() => {
      getContext().addNewRow(row, { highlight: false });
      getContext().updateRow(request({ request: "Realtime summary" }));
    });

    expect(getContext().realtimeRows[0]?.request).toBe("Realtime summary");
    expect(getContext().updatedRowIds.has(row.id)).toBe(true);
  });

  it("skips no-op read patches", () => {
    const getContext = renderProvider();
    const row = request({ isReadByManager: true });

    act(() => {
      getContext().addNewRow(row, { highlight: false });
    });

    const rowsBefore = getContext().realtimeRows;

    act(() => {
      getContext().patchRow(row.id, { isReadByManager: true });
    });

    expect(getContext().realtimeRows).toBe(rowsBefore);
  });
});
