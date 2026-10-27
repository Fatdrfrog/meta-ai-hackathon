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
import type React from "react";
import userEvent from "@testing-library/user-event";
import { CreativeAssetPickerDialog } from "./creative-asset-picker-dialog";

jest.setTimeout(20000);

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { value: jest.fn(() => false) },
  setPointerCapture: { value: jest.fn() },
  releasePointerCapture: { value: jest.fn() },
  scrollIntoView: { value: jest.fn() },
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe("CreativeAssetPickerDialog", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("auto-selects a generated asset after it completes", async () => {
    jest.useFakeTimers();
    const onSelect = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ assets: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            asset: {
              id: "asset-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "higgsfield",
              status: "queued",
              prompt: "Premium soup visual",
            },
          },
          202
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          assets: [
            {
              id: "asset-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "higgsfield",
              status: "complete",
              prompt: "Premium soup visual",
              url: "https://storage.example.com/asset.jpg",
              mimeType: "image/jpeg",
            },
          ],
        })
      )
      .mockResolvedValue(
        jsonResponse({
          assets: [
            {
              id: "asset-1",
              workspaceId: "workspace-1",
              kind: "image",
              source: "higgsfield",
              status: "complete",
              prompt: "Premium soup visual",
              url: "https://storage.example.com/asset.jpg",
              mimeType: "image/jpeg",
            },
          ],
        })
      );
    global.fetch = fetchMock as never;

    render(
      <CreativeAssetPickerDialog
        workspaceId="workspace-video-key"
        open
        onOpenChange={jest.fn()}
        showGenerate
        higgsfieldConfigured
        onSelect={onSelect}
      />
    );

    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Premium soup visual" },
    });
    const generateButton = screen.getByRole("button", {
      name: "Generate image",
    });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(await screen.findByText("Generating")).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "asset-1",
          status: "complete",
          url: "https://storage.example.com/asset.jpg",
        })
      )
    );
  });

  it("times out a stalled status poll before scheduling the next one", async () => {
    jest.useFakeTimers();
    const statusSignals: AbortSignal[] = [];
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("surface=status")) {
          const signal = init?.signal as AbortSignal;
          statusSignals.push(signal);
          return new Promise<Response>((_resolve, reject) => {
            const rejectOnAbort = () => reject(signal.reason);
            if (signal.aborted) {
              rejectOnAbort();
            } else {
              signal.addEventListener("abort", rejectOnAbort, { once: true });
            }
          });
        }
        if (url.includes("/assets/generate/higgsfield")) {
          return Promise.resolve(
            jsonResponse(
              {
                asset: {
                  id: "asset-pending",
                  workspaceId: "workspace-nonoverlap",
                  kind: "image",
                  source: "higgsfield",
                  status: "queued",
                  prompt: "Premium soup visual",
                },
              },
              202
            )
          );
        }
        return Promise.resolve(jsonResponse({ assets: [] }));
      }
    );
    global.fetch = fetchMock as never;

    const { unmount } = render(
      <CreativeAssetPickerDialog
        workspaceId="workspace-nonoverlap"
        open
        onOpenChange={jest.fn()}
        showGenerate
        higgsfieldConfigured
        onSelect={jest.fn()}
      />
    );

    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Premium soup visual" },
    });
    const generateButton = screen.getByRole("button", {
      name: "Generate image",
    });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Generating")).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statusSignals).toHaveLength(1);
    expect(statusSignals[0]?.aborted).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(9999);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statusSignals[0]?.aborted).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(statusSignals[0]?.aborted).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(3999);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(2);
    expect(statusSignals[1]?.aborted).toBe(false);

    unmount();
    expect(statusSignals[1]?.aborted).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(statusSignals).toHaveLength(2);
  });

  it("retires image-to-video keys only after a definite queued asset", async () => {
    const idempotencyKeys: string[] = [];
    let generationAttempt = 0;
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/assets/generate/higgsfield")) {
          generationAttempt += 1;
          idempotencyKeys.push(
            (init?.headers as Record<string, string>)["Idempotency-Key"]
          );
          if (generationAttempt === 1) {
            return Promise.reject(new TypeError("network disconnected"));
          }
          if (generationAttempt === 2) {
            return Promise.resolve({
              ok: true,
              status: 202,
              json: async () => {
                throw new SyntaxError("truncated JSON");
              },
            } as unknown as Response);
          }
          if (generationAttempt === 3) {
            return Promise.resolve(jsonResponse({}, 202));
          }
          return Promise.resolve(
            jsonResponse(
              {
                asset: {
                  id: `video-${generationAttempt}`,
                  workspaceId: "workspace-1",
                  kind: "video",
                  source: "higgsfield",
                  status: "queued",
                  prompt: "Smooth product reveal",
                },
              },
              202
            )
          );
        }
        return Promise.resolve(
          jsonResponse({
            assets: [
              {
                id: "source-1",
                workspaceId: "workspace-1",
                kind: "image",
                source: "uploaded",
                status: "complete",
                fileName: "source.jpg",
                url: "https://storage.example.com/source.jpg",
              },
            ],
          })
        );
      }
    );
    global.fetch = fetchMock as never;
    const user = userEvent.setup();

    render(
      <CreativeAssetPickerDialog
        workspaceId="workspace-1"
        open
        onOpenChange={jest.fn()}
        showGenerate
        higgsfieldConfigured
        onSelect={jest.fn()}
      />
    );
    await screen.findByText("source.jpg");
    await user.click(screen.getByRole("tab", { name: "Video" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "source.jpg" }));
    const motion = screen.getByLabelText("Motion");
    const generate = screen.getByRole("button", { name: "Generate video" });

    await user.type(motion, "Smooth product reveal");
    await user.click(generate);
    await waitFor(() => expect(generationAttempt).toBe(1));
    await user.click(generate);
    await waitFor(() => expect(generationAttempt).toBe(2));
    await user.click(generate);
    await waitFor(() => expect(generationAttempt).toBe(3));
    await user.click(generate);
    await waitFor(() => expect(generationAttempt).toBe(4));

    await user.type(motion, "Smooth product reveal");
    await user.click(generate);
    await waitFor(() => expect(generationAttempt).toBe(5));

    expect(idempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(idempotencyKeys[2]).toBe(idempotencyKeys[1]);
    expect(idempotencyKeys[3]).toBe(idempotencyKeys[2]);
    expect(idempotencyKeys[4]).not.toBe(idempotencyKeys[3]);
  });

  it("uses the lightweight picker asset list when generation controls are hidden", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      jsonResponse({
        assets: [
          {
            id: "asset-1",
            workspaceId: "workspace-1",
            kind: "image",
            source: "upload",
            status: "complete",
            fileName: "menu.png",
            url: "https://storage.example.com/menu.png",
            mimeType: "image/png",
          },
        ],
      })
    );
    global.fetch = fetchMock as never;

    render(
      <CreativeAssetPickerDialog
        workspaceId="workspace-1"
        open
        onOpenChange={jest.fn()}
        kind="image"
        onSelect={jest.fn()}
      />
    );

    expect(await screen.findByText("menu.png")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain("surface=picker");
    expect(String(fetchMock.mock.calls[0][0])).toContain("kind=image");
    expect(screen.queryByRole("button", { name: "Generate image" })).toBeNull();
  });
});
