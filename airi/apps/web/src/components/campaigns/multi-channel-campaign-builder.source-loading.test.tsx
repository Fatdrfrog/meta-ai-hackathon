/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { MultiChannelCampaignBuilder } from "./multi-channel-campaign-builder";
import { invalidateWhatsAppTemplateCatalog } from "@/lib/whatsapp/templates/catalog-client";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => ({ data: undefined }),
}));

jest.mock("@/components/email/email-content-editor", () => ({
  EmailContentEditor: () => null,
}));

jest.mock("./campaign-dispatch-plan-card", () => ({
  CampaignDispatchPlanCard: () => null,
}));

const mockSourceTransitions: string[] = [];

jest.mock("./campaign-recipient-picker", () => ({
  CampaignRecipientPicker: ({ sourceIds = [] }: { sourceIds?: string[] }) => {
    const sourceKey = sourceIds.join(",");
    if (mockSourceTransitions.at(-1) !== sourceKey) {
      mockSourceTransitions.push(sourceKey);
    }
    // Bound a regression that would otherwise keep scheduling React updates.
    if (mockSourceTransitions.length > 20) {
      throw new Error("Campaign source selection did not settle");
    }
    return <div data-testid="recipient-source">{sourceKey}</div>;
  },
}));

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <div role="alert">{this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

const sourceId = "whatsapp-source-1";
const batchPlan = {
  channel: "whatsapp",
  configured: true,
  batchPlan: { batchSize: 20, delayMs: 334, ratePerSecond: 60 },
  recipientLimit: { maxRecipients: 250, rawLimit: "250", source: "meta" },
  whatsappMeta: { sourceId },
  readiness: {
    state: "ready",
    checkedAt: "2026-09-19T13:34:00.000Z",
    remainingCapacity: null,
    reasons: [],
  },
};

describe("MultiChannelCampaignBuilder source loading", () => {
  beforeEach(() => {
    mockSourceTransitions.length = 0;
    invalidateWhatsAppTemplateCatalog();
    installMatchMedia();
    installResizeObserver();
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  it.each([
    "WHATSAPP_TEMPLATES_RATE_LIMITED",
    "WHATSAPP_TEMPLATES_UNAVAILABLE",
  ])("stops automatic template reads after %s", async code => {
    jest.useFakeTimers();
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/whatsapp/templates")
        return Promise.resolve({
          ok: false,
          status: 429,
          json: async () => ({
            error: "Refresh unavailable",
            code,
            retryAt: "2099-10-06T13:00:00.000Z",
          }),
        } as Response);
      if (url.pathname === "/api/campaigns/batch-plan")
        return Promise.resolve(jsonResponse(batchPlan));
      if (url.pathname.endsWith("/integrations"))
        return Promise.resolve(
          jsonResponse({ sources: [{ id: sourceId, type: "whatsapp" }] })
        );
      return Promise.resolve(jsonResponse({}));
    });
    global.fetch = fetchMock as jest.Mock;
    try {
      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <MultiChannelCampaignBuilder
            workspaceId={`retry-${code}`}
            emailEnabled={false}
          />
        </SWRConfig>
      );
      await screen.findByText("templatesUnavailable");
      const reads = () =>
        fetchMock.mock.calls.filter(
          ([input]) =>
            new URL(String(input), "http://localhost").pathname ===
            "/api/whatsapp/templates"
        ).length;
      const settledReads = reads();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(300_000);
      });
      expect(reads()).toBe(settledReads);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(["success", "http_failure", "missing_metadata"])(
    "keeps the selected WhatsApp source through a slow %s plan response",
    async outcome => {
      const integrations = deferredResponse();
      const scopedPlan = deferredResponse();
      const fetchMock = jest.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname.endsWith("/integrations")) return integrations.promise;
        if (url.pathname === "/api/campaigns/batch-plan") {
          return url.searchParams.has("sourceId")
            ? scopedPlan.promise
            : Promise.resolve(jsonResponse(batchPlan));
        }
        if (url.pathname.includes("/api/whatsapp/templates")) {
          return Promise.resolve(jsonResponse({ templates: [] }));
        }
        return Promise.resolve(jsonResponse({}));
      });
      global.fetch = fetchMock as jest.Mock;
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        render(
          <SWRConfig
            value={{
              provider: () => new Map(),
              dedupingInterval: 0,
              shouldRetryOnError: false,
            }}
          >
            <ErrorBoundary>
              <MultiChannelCampaignBuilder
                workspaceId="00000000-0000-4000-8000-000000000901"
                emailEnabled={false}
              />
            </ErrorBoundary>
          </SWRConfig>
        );

        await waitFor(() => {
          expect(
            fetchMock.mock.calls.some(([url]) =>
              String(url).includes(`sourceId=${sourceId}`)
            )
          ).toBe(true);
        });

        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("recipient-source").textContent).toBe(
          sourceId
        );
        expect(mockSourceTransitions).toEqual(["", sourceId]);
        expect(
          fetchMock.mock.calls.some(([input]) => {
            const url = new URL(String(input), "http://localhost");
            return (
              url.pathname === "/api/whatsapp/templates" &&
              url.searchParams.get("sourceId") === sourceId
            );
          })
        ).toBe(true);

        await act(async () => {
          integrations.resolve(
            jsonResponse({
              sources:
                outcome === "success"
                  ? [{ id: sourceId, type: "whatsapp" }]
                  : [],
            })
          );
          scopedPlan.resolve(
            outcome === "success"
              ? jsonResponse(batchPlan)
              : outcome === "http_failure"
                ? ({
                    ok: false,
                    status: 503,
                    json: async () => ({ error: "Source check unavailable" }),
                  } as Response)
                : jsonResponse({
                    channel: "whatsapp",
                    configured: false,
                    error: "Source check unavailable",
                  })
          );
        });

        expect(screen.getByTestId("recipient-source").textContent).toBe(
          sourceId
        );
        expect(mockSourceTransitions).toEqual(["", sourceId]);
        expect(
          fetchMock.mock.calls.filter(([input]) => {
            const url = new URL(String(input), "http://localhost");
            return (
              url.pathname === "/api/campaigns/batch-plan" &&
              !url.searchParams.has("sourceId")
            );
          })
        ).toHaveLength(1);
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    }
  );
});
