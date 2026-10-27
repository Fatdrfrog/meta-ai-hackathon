/** @jest-environment jsdom */
import { act, render, renderHook, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { TextEncoder } from "node:util";
import { generateFlowJson } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import {
  fetchWhatsAppFlowDetails,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";
import { useFlowGalleryPreviews } from "./use-flow-gallery-previews";

jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchWhatsAppFlowDetails: jest.fn(),
}));

const fetchDetails = jest.mocked(fetchWhatsAppFlowDetails);
type DetailsResult = Awaited<ReturnType<typeof fetchWhatsAppFlowDetails>>;
const initialScope = {
  workspaceId: "workspace-a",
  sourceId: "source-a",
  revision: 0,
};
const formJson = generateFlowJson({
  templateId: "custom",
  ctaText: "Open",
  flowUiLocale: "en",
  screens: [
    {
      id: "START",
      title: "Contact",
      fields: [
        { id: "name", label: "Name", fieldType: "TextInput", required: true },
      ],
    },
  ],
});

function flow(id: string): WhatsAppFlowSummary {
  return { id, name: `Form ${id}`, status: "DRAFT" };
}

function deferredDetails() {
  let resolve!: (value: DetailsResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<DetailsResult>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function success(flowJson: unknown = formJson): DetailsResult {
  return { ok: true, status: 200, data: { flowJson } };
}

async function settle(
  request: ReturnType<typeof deferredDetails>,
  value = success()
) {
  await act(async () => {
    request.resolve(value);
  });
}

beforeAll(() => {
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
});

beforeEach(() => {
  fetchDetails.mockReset();
});

it("fetches only requested cards, caps reads at three, and drains the queue", async () => {
  const requests = Array.from({ length: 5 }, deferredDetails);
  requests.forEach(request =>
    fetchDetails.mockImplementationOnce(() => request.promise)
  );
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  expect(fetchDetails).not.toHaveBeenCalled();
  expect(result.current.get("1").status).toBe("idle");

  act(() => {
    ["1", "2", "3", "4", "5"].forEach(id => result.current.load(flow(id)));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(3);
  expect(result.current.get("3").status).toBe("loading");
  expect(result.current.get("4").status).toBe("queued");
  expect(fetchDetails.mock.calls[0][0]).toMatchObject({
    workspaceId: initialScope.workspaceId,
    sourceId: initialScope.sourceId,
    flowId: "1",
    includeJson: true,
  });
  expect(fetchDetails.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

  await settle(requests[1]);
  expect(fetchDetails).toHaveBeenCalledTimes(4);
  expect(result.current.get("2").status).toBe("ready");
  expect(result.current.get("4").status).toBe("loading");
  expect(result.current.get("5").status).toBe("queued");
  await settle(requests[0]);
  expect(fetchDetails).toHaveBeenCalledTimes(5);
  await act(async () => {
    requests.slice(2).forEach(request => request.resolve(success()));
  });
  expect(
    [...result.current.previews.values()].every(
      state => state.status === "ready"
    )
  ).toBe(true);
});

it("deduplicates loading, queued and ready cards and keeps load/retry stable", async () => {
  const requests = Array.from({ length: 4 }, deferredDetails);
  requests.forEach(request =>
    fetchDetails.mockImplementationOnce(() => request.promise)
  );
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  const load = result.current.load;
  const retry = result.current.retry;
  act(() => {
    ["1", "2", "3", "4"].forEach(id => result.current.load(flow(id)));
    result.current.load(flow("1"));
    result.current.load(flow("4"));
    result.current.retry(flow("1"));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(3);
  await settle(requests[0]);
  act(() => {
    result.current.load(flow("1"));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(4);
  expect(result.current.load).toBe(load);
  expect(result.current.retry).toBe(retry);
});

it("keeps a failed download distinct from an empty asset and retries explicitly", async () => {
  const failed = deferredDetails();
  const retried = deferredDetails();
  fetchDetails
    .mockImplementationOnce(() => failed.promise)
    .mockImplementationOnce(() => retried.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(failed, {
    ok: true,
    status: 200,
    data: { flowJson: null, flowJsonError: "Asset download failed" },
  });
  expect(result.current.get("1")).toEqual({
    status: "error",
    error: "Asset download failed",
  });
  act(() => {
    result.current.load(flow("1"));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(1);
  act(() => {
    result.current.retry(flow("1"));
    result.current.retry(flow("1"));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(2);
  await settle(retried, success(null));
  expect(result.current.get("1")).toEqual({
    status: "ready",
    model: { kind: "empty" },
  });
});

it.each([
  { status: "DRAFT", expected: "ready" },
  { status: "PUBLISHED", expected: "error" },
  { status: undefined, expected: "error" },
])(
  "uses the actual empty draft asset contract only for confirmed remote $status metadata",
  async ({ status, expected }) => {
    const request = deferredDetails();
    fetchDetails.mockImplementationOnce(() => request.promise);
    const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
    act(() => {
      result.current.load(flow("1"));
    });
    await settle(request, {
      ok: true,
      status: 200,
      data: {
        flow: { id: "1", status },
        flowJson: null,
        flowJsonError: "Flow JSON asset not found",
      },
    });
    expect(result.current.get("1")).toEqual(
      expected === "ready"
        ? { status: "ready", model: { kind: "empty" } }
        : { status: "error", error: "Flow JSON asset not found" }
    );
  }
);

it.each([
  "Flow JSON asset is empty",
  "Flow JSON asset is not valid JSON",
  "Failed to download flow JSON (status 500)",
])("keeps a confirmed draft's %s response retryable", async flowJsonError => {
  const request = deferredDetails();
  fetchDetails.mockImplementationOnce(() => request.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(request, {
    ok: true,
    status: 200,
    data: { flow: flow("1"), flowJson: null, flowJsonError },
  });
  expect(result.current.get("1")).toEqual({
    status: "error",
    error: flowJsonError,
  });
});

it("frees a failed network request's slot so queued cards can load", async () => {
  const requests = Array.from({ length: 4 }, deferredDetails);
  requests.forEach(request =>
    fetchDetails.mockImplementationOnce(() => request.promise)
  );
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  act(() => {
    ["1", "2", "3", "4"].forEach(id => result.current.load(flow(id)));
  });
  await act(async () => {
    requests[0].reject(new Error("Connection failed"));
  });
  expect(result.current.get("1")).toEqual({
    status: "error",
    error: "Connection failed",
  });
  expect(fetchDetails).toHaveBeenCalledTimes(4);
  expect(result.current.get("4").status).toBe("loading");
});

it.each(["sourceId", "workspaceId", "revision"] as const)(
  "aborts active reads and discards queued/stale work after %s changes",
  async key => {
    const requests = Array.from({ length: 4 }, deferredDetails);
    requests.forEach(request =>
      fetchDetails.mockImplementationOnce(() => request.promise)
    );
    const { result, rerender } = renderHook(
      props => useFlowGalleryPreviews(props),
      { initialProps: initialScope }
    );
    act(() => {
      ["1", "2", "3", "4"].forEach(id => result.current.load(flow(id)));
    });
    const signals = fetchDetails.mock.calls.map(([params]) => params.signal);
    rerender({ ...initialScope, [key]: key === "revision" ? 1 : "new-scope" });
    expect(signals.every(signal => signal?.aborted)).toBe(true);
    expect(result.current.previews.size).toBe(0);
    expect(result.current.get("4").status).toBe("idle");
    await act(async () => {
      requests.slice(0, 3).forEach(request => request.resolve(success()));
    });
    expect(fetchDetails).toHaveBeenCalledTimes(3);
    expect(result.current.previews.size).toBe(0);
    act(() => {
      result.current.load(flow("1"));
    });
    expect(fetchDetails).toHaveBeenCalledTimes(4);
    await settle(requests[3]);
    expect(result.current.get("1").status).toBe("ready");
  }
);

it("ignores a late completion after returning to the same source", async () => {
  const oldRequest = deferredDetails();
  const newRequest = deferredDetails();
  fetchDetails
    .mockImplementationOnce(() => oldRequest.promise)
    .mockImplementationOnce(() => newRequest.promise);
  const { result, rerender } = renderHook(
    props => useFlowGalleryPreviews(props),
    { initialProps: initialScope }
  );
  act(() => {
    result.current.load(flow("1"));
  });
  rerender({ ...initialScope, sourceId: "source-b" });
  rerender(initialScope);
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(newRequest, success(null));
  await settle(oldRequest);
  expect(result.current.get("1")).toEqual({
    status: "ready",
    model: { kind: "empty" },
  });
});

it("aborts on unmount and never starts the queued requests afterwards", async () => {
  const requests = Array.from({ length: 4 }, deferredDetails);
  requests.forEach(request =>
    fetchDetails.mockImplementationOnce(() => request.promise)
  );
  const { result, unmount } = renderHook(() =>
    useFlowGalleryPreviews(initialScope)
  );
  act(() => {
    ["1", "2", "3", "4"].forEach(id => result.current.load(flow(id)));
  });
  const signals = fetchDetails.mock.calls.map(([params]) => params.signal);
  unmount();
  expect(signals.every(signal => signal?.aborted)).toBe(true);
  await act(async () => {
    requests.slice(0, 3).forEach(request => request.resolve(success()));
  });
  expect(fetchDetails).toHaveBeenCalledTimes(3);
});

it("uses the lossless parser for authored fields and retains no source JSON", async () => {
  const request = deferredDetails();
  fetchDetails.mockImplementationOnce(() => request.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(request);
  const state = result.current.get("1");
  expect(state.status).toBe("ready");
  if (state.status !== "ready" || state.model.kind !== "visual")
    throw new Error("Expected authored form preview");
  expect(state.model.config.screens[0].fields[0]).toMatchObject({
    id: "name",
    label: "Name",
    fieldType: "TextInput",
  });
  expect(state.model.config.metaFlowId).toBe("1");
  expect(state.model).not.toHaveProperty("flowJson");
});

it("projects partial Meta JSON independently of strict edit support", async () => {
  const request = deferredDetails();
  fetchDetails.mockImplementationOnce(() => request.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  act(() => result.current.load(flow("partial")));
  await settle(
    request,
    success({
      version: "7.3",
      screens: [
        {
          id: "START",
          title: "Partial",
          layout: {
            type: "SingleColumnLayout",
            children: [
              { type: "TextBody", text: "Real saved content" },
              { type: "Image", src: "https://example.test/private" },
              { type: "TextInput", name: "name", label: "Name" },
            ],
          },
        },
      ],
    })
  );
  const state = result.current.get("partial");
  expect(state.status).toBe("ready");
  if (state.status !== "ready" || state.model.kind !== "document")
    throw new Error("Expected partial saved-content projection");
  expect(state.model.preview.config.screens[0].fields[0].label).toBe("Name");
  expect(state.model.preview.componentsByScreen.START).toContainEqual({
    kind: "unsupported",
    component: "Image",
  });
  expect(JSON.stringify(state.model)).not.toContain(
    "https://example.test/private"
  );
});

it("projects unsupported JSON to bounded actual screen labels without keeping large data", async () => {
  const request = deferredDetails();
  fetchDetails.mockImplementationOnce(() => request.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  const largeData = "raw-payload-".repeat(100_000);
  const screens = Array.from({ length: 25 }, (_, index) => ({
    id: `SCREEN_${index}`,
    title: index === 0 ? "A".repeat(500_000) : `Actual screen ${index}`,
    data: { secret: largeData },
    layout: { children: [{ type: "Image", src: largeData }] },
  }));
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(request, success({ version: "7.3", screens }));
  const state = result.current.get("1");
  expect(state.status).toBe("ready");
  if (state.status !== "ready" || state.model.kind !== "document")
    throw new Error("Expected bounded saved-content projection");
  expect(state.model.preview.config.screens).toHaveLength(20);
  expect(state.model.preview.totalScreens).toBe(25);
  expect(state.model.preview.config.screens[1]).toMatchObject({
    id: "SCREEN_1",
    title: "Actual screen 1",
  });
  expect(
    state.model.preview.config.screens[0].title.length
  ).toBeLessThanOrEqual(161);
  expect(state.model.preview.config.screens[0].title).toContain("…");
  expect(state.model.preview.componentsByScreen.SCREEN_0).toContainEqual({
    kind: "unsupported",
    component: "Image",
  });
  expect(JSON.stringify(state.model)).not.toContain(largeData);
  expect(JSON.stringify(state.model).length).toBeLessThan(15_000);
});

it("retains bounded supported content when a lossless form exceeds the gallery budget", async () => {
  const request = deferredDetails();
  fetchDetails.mockImplementationOnce(() => request.promise);
  const { result } = renderHook(() => useFlowGalleryPreviews(initialScope));
  const largeForm = generateFlowJson({
    templateId: "custom",
    ctaText: "Open",
    screens: [
      {
        id: "START",
        title: "Contact",
        fields: [
          {
            id: "name",
            label: "Name",
            fieldType: "TextInput",
            required: true,
            helperText: "X".repeat(300_000),
          },
        ],
      },
    ],
  });
  act(() => {
    result.current.load(flow("1"));
  });
  await settle(request, success(largeForm));
  const state = result.current.get("1");
  if (state.status !== "ready" || state.model.kind !== "document")
    throw new Error("Expected bounded form projection");
  expect(
    state.model.preview.config.screens[0].fields[0].helperText?.length
  ).toBeLessThanOrEqual(1025);
  expect(state.model.preview.config.screens[0].fields[0].label).toBe("Name");
  expect(JSON.stringify(state.model).length).toBeLessThan(256 * 1024);
});

it("restarts a viewport card during StrictMode effect replay and rejects its aborted completion", async () => {
  const aborted = deferredDetails();
  const restarted = deferredDetails();
  fetchDetails
    .mockImplementationOnce(() => aborted.promise)
    .mockImplementationOnce(() => restarted.promise);
  function Card({ load }: { load: (item: WhatsAppFlowSummary) => void }) {
    useEffect(() => {
      load(flow("1"));
    }, [load]);
    return null;
  }
  function Gallery() {
    const gallery = useFlowGalleryPreviews(initialScope);
    return (
      <>
        <Card load={gallery.load} />
        <span data-testid="state">{gallery.get("1").status}</span>
      </>
    );
  }
  render(
    <StrictMode>
      <Gallery />
    </StrictMode>
  );
  expect(fetchDetails).toHaveBeenCalledTimes(2);
  expect(fetchDetails.mock.calls[0][0].signal?.aborted).toBe(true);
  expect(fetchDetails.mock.calls[1][0].signal?.aborted).toBe(false);
  await settle(restarted, success(null));
  await settle(aborted);
  expect(screen.getByTestId("state").textContent).toBe("ready");
});
