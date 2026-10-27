/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { useState } from "react";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import {
  buildConversationChatKey,
  buildConversationFullKey,
  buildConversationMessagesPageUrl,
  ConversationPlanGateError,
  fetchConversationDetail,
  isConversationDetailPreloaded,
  preloadConversationDetail,
} from "./detail-client";

type DetailPayload = {
  id: string;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function DetailProbe({
  conversationId,
  workspaceId,
}: {
  conversationId: string;
  workspaceId: string;
}) {
  const key = buildConversationChatKey(conversationId, workspaceId);
  const { data, error } = useSWR<DetailPayload>(key, fetchConversationDetail, {
    dedupingInterval: 0,
    revalidateOnFocus: false,
    revalidateOnMount: !isConversationDetailPreloaded(key),
    shouldRetryOnError: false,
  });

  if (error) return <div role="alert">failed</div>;
  return <div>{data?.id ?? "loading-detail"}</div>;
}

function IntentHarness({
  conversationId,
  preloadWorkspaceId,
  detailWorkspaceId = preloadWorkspaceId,
}: {
  conversationId: string;
  preloadWorkspaceId: string;
  detailWorkspaceId?: string;
}) {
  const { mutate } = useSWRConfig();
  const [selected, setSelected] = useState(false);

  return (
    <div>
      <button
        type="button"
        onPointerDown={() => {
          void preloadConversationDetail(
            mutate,
            conversationId,
            preloadWorkspaceId
          ).catch(() => undefined);
        }}
        onClick={() => setSelected(true)}
      >
        Open conversation
      </button>
      {selected ? (
        <DetailProbe
          conversationId={conversationId}
          workspaceId={detailWorkspaceId}
        />
      ) : null}
    </div>
  );
}

function renderWithIsolatedCache(node: React.ReactNode) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      {node}
    </SWRConfig>
  );
}

const originalFetch = global.fetch;

describe("conversation detail client", () => {
  beforeEach(() => {
    global.fetch = jest.fn() as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("builds canonical workspace-bound chat and full keys", () => {
    expect(buildConversationChatKey("conversation/1", "workspace 1")).toBe(
      "/api/conversations/conversation%2F1?page=1&limit=30&view=chat&workspaceId=workspace+1"
    );
    expect(buildConversationFullKey("conversation/1", "workspace 1")).toBe(
      "/api/conversations/conversation%2F1?page=1&limit=1&view=full&workspaceId=workspace+1"
    );
    expect(buildConversationMessagesPageUrl("conversation/1", 3)).toBe(
      "/api/conversations/conversation%2F1?page=3&limit=30&messagesOnly=1"
    );
  });

  it("rejects a plan-hidden conversation with the structured plan gate", async () => {
    // The route answers a hidden conversation with the limit code plus planGate.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 402,
      text: async () =>
        JSON.stringify({
          code: "company_conversation_limit_exceeded",
          error: "Company conversation limit exceeded.",
          limit: { subscriptionType: "free" },
          planGate: { hiddenCount: 12, reason: "trial_expired" },
        }),
    });

    const error = await fetchConversationDetail("/plan-hidden").catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(ConversationPlanGateError);
    expect((error as ConversationPlanGateError).planGate).toEqual({
      hiddenCount: 12,
      reason: "trial_expired",
    });
  });

  it("rejects other failures with the server's error text", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          code: "company_conversation_limit_exceeded",
          error: " Forbidden ",
        }),
    });

    const error = await fetchConversationDetail("/forbidden").catch(
      (reason: unknown) => reason
    );

    expect(error).not.toBeInstanceOf(ConversationPlanGateError);
    expect((error as Error).message).toBe("Forbidden");
  });

  it("does not start a detail request before explicit intent", () => {
    renderWithIsolatedCache(
      <IntentHarness
        conversationId="conversation-no-intent"
        preloadWorkspaceId="workspace-1"
      />
    );

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("hands an in-flight pointer preload to the mounted SWR detail owner", async () => {
    const response = createDeferred<Response>();
    (global.fetch as jest.Mock).mockReturnValue(response.promise);

    renderWithIsolatedCache(
      <IntentHarness
        conversationId="conversation-in-flight"
        preloadWorkspaceId="workspace-1"
      />
    );

    const trigger = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/conversations/conversation-in-flight?page=1&limit=30&view=chat&workspaceId=workspace-1",
      expect.anything()
    );

    await act(async () => {
      response.resolve(jsonResponse({ id: "conversation-in-flight" }));
      await response.promise;
    });

    expect(
      await screen.findByText("conversation-in-flight")
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate a completed fresh preload on mount", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ id: "conversation-prefetched" })
    );

    renderWithIsolatedCache(
      <IntentHarness
        conversationId="conversation-prefetched"
        preloadWorkspaceId="workspace-1"
      />
    );

    const trigger = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.pointerDown(trigger);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        isConversationDetailPreloaded(
          buildConversationChatKey("conversation-prefetched", "workspace-1")
        )
      ).toBe(true);
    });

    fireEvent.click(trigger);

    expect(
      await screen.findByText("conversation-prefetched")
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("marks the response fresh before the cache publishes it to mounted subscribers", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ id: "publishing" })
    );
    const key = buildConversationChatKey("publishing", "workspace-1");
    const publish = jest.fn(
      async (_key: unknown, request: Promise<DetailPayload>) => {
        const data = await request;
        expect(isConversationDetailPreloaded(key)).toBe(true);
        return data;
      }
    );
    await preloadConversationDetail(
      publish as unknown as ReturnType<typeof useSWRConfig>["mutate"],
      "publishing",
      "workspace-1"
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a preload across workspaces", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ id: "workspace-1-detail" }))
      .mockResolvedValueOnce(jsonResponse({ id: "workspace-2-detail" }));

    renderWithIsolatedCache(
      <IntentHarness
        conversationId="conversation-workspace-bound"
        preloadWorkspaceId="workspace-1"
        detailWorkspaceId="workspace-2"
      />
    );

    const trigger = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.pointerDown(trigger);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger);

    expect(await screen.findByText("workspace-2-detail")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(
      (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url))
    ).toEqual([
      "/api/conversations/conversation-workspace-bound?page=1&limit=30&view=chat&workspaceId=workspace-1",
      "/api/conversations/conversation-workspace-bound?page=1&limit=30&view=chat&workspaceId=workspace-2",
    ]);
  });

  it("allows the canonical mount to retry after a failed preload", async () => {
    const failedPreload = createDeferred<Response>();
    (global.fetch as jest.Mock)
      .mockReturnValueOnce(failedPreload.promise)
      .mockResolvedValueOnce(jsonResponse({ id: "conversation-retried" }));

    renderWithIsolatedCache(
      <IntentHarness
        conversationId="conversation-retried"
        preloadWorkspaceId="workspace-1"
      />
    );

    const trigger = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.pointerDown(trigger);

    await act(async () => {
      failedPreload.reject(new Error("prefetch failed"));
      await failedPreload.promise.catch(() => undefined);
    });

    fireEvent.click(trigger);

    expect(await screen.findByText("conversation-retried")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
