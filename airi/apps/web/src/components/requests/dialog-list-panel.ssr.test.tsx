/** @jest-environment jsdom */
import React from "react";
import { renderToString } from "react-dom/server.node";
import type { FormattedRequest } from "@/features/panel/requests/formatting";
import { DialogListPanel } from "./dialog-list-panel";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("@/components/tables/requests-realtime-provider", () => ({
  useRequestsRealtime: () => ({
    realtimeRows: [],
    updatedRowIds: new Set<string>(),
    patchRow: jest.fn(),
    patchRows: jest.fn(),
  }),
}));
jest.mock("swr", () => ({
  __esModule: true,
  default: () => ({ data: { labels: [] } }),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));

describe("DialogListPanel server visibility", () => {
  it.each([false, true])(
    "renders visible rows before hydration with isMobile=%s",
    isMobile => {
      const request = {
        id: "conversation-ssr",
        dateValue: "2026-06-23T08:02:00.000Z",
        status: "open",
        client: "Acme Customer",
        request: "Please invoice me",
        category: null,
        action: null,
        channel: "whatsapp",
        source: "WhatsApp",
      } as FormattedRequest;
      const html = renderToString(
        <DialogListPanel
          workspaceId="workspace-1"
          requests={[request]}
          initialAvailableChannels={["whatsapp"]}
          initialHasMore={false}
          initialRenderNowMs={1_700_000_000_000}
          activeConversationId={null}
          onSelectConversation={() => undefined}
          isMobile={isMobile}
          hasConfiguredSources={new Promise<boolean>(() => {})}
        />
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      const row = document.querySelector<HTMLElement>(
        '[data-request-row-observer-key="conversation-ssr"]'
      );
      expect(row?.textContent).toContain("Acme Customer");
      expect(row?.style.opacity).toBe("1");
      for (
        let element = row?.parentElement;
        element;
        element = element.parentElement
      ) {
        expect(element.style.opacity).not.toBe("0");
        expect(element.style.visibility).not.toBe("hidden");
        expect(element.style.display).not.toBe("none");
      }
    }
  );
});
jest.mock("@icecore/shared/types/requests-realtime", () => {
  global.TextEncoder = jest.requireActual("node:util").TextEncoder;
  return jest.requireActual("@icecore/shared/types/requests-realtime");
});
