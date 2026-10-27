/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { CreativeAsset } from "./creative-assets-workspace";
import type {
  ReferenceVideoPlan,
  ReferenceVideoPlanInput,
} from "@/lib/creative-assets/reference-video/contracts";
import { REFERENCE_VIDEO_RECIPES } from "@/lib/creative-assets/reference-video/recipes";
import { buildReferenceVideoPlanSnapshot } from "@/lib/creative-assets/reference-video/plan";
import messages from "../../../messages/panel/en/page.json";
import { ReferenceVideoPlanDialog } from "./reference-video-plan-dialog";

jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const mockPickerProps = jest.fn();
jest.mock("./creative-asset-picker-dialog", () => ({
  CreativeAssetPickerDialog: (props: {
    workspaceId: string;
    open: boolean;
    showGenerate: boolean;
    onSelect: (asset: CreativeAsset) => void;
  }) => {
    const { Dialog, DialogContent, DialogTitle, DialogDescription } =
      jest.requireActual("@/components/ui/dialog");
    mockPickerProps(props);
    return props.open ? (
      <Dialog open>
        <DialogContent>
          <DialogTitle>Asset picker</DialogTitle>
          <DialogDescription>Select test media.</DialogDescription>
          <button
            onClick={() =>
              props.onSelect({
                id: "aaaaaaaaaaaaaaaaaaaaaaaa",
                workspaceId: props.workspaceId,
                kind: "image",
                source: "uploaded",
                status: "complete",
                url: "https://media.example/photo.jpg",
                fileName: "My product.jpg",
              })
            }
          >
            Choose photo
          </button>
          <button
            onClick={() =>
              props.onSelect({
                id: "bbbbbbbbbbbbbbbbbbbbbbbb",
                workspaceId: props.workspaceId,
                kind: "video",
                source: "uploaded",
                status: "complete",
                url: "https://media.example/clip.mp4",
                fileName: "My clip.mp4",
              })
            }
          >
            Choose video
          </button>
        </DialogContent>
      </Dialog>
    ) : null;
  },
}));

const t = (key: string, values?: Record<string, number | string>) => {
  const message = key
    .split(".")
    .reduce<unknown>(
      (current, part) => (current as Record<string, unknown>)[part],
      messages.CreativeAssetsWorkspace
    );
  if (typeof message !== "string")
    throw new Error(`Missing translation: ${key}`);
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    values?.[name] === undefined ? match : String(values[name])
  );
};
const reference = {
  providerVideoId: "1234567890",
  shareUrl: "https://www.tiktok.com/@creator/video/1234567890",
  title: "Original cafe story",
};
const originalFetch = globalThis.fetch;
let fetchMock: jest.MockedFunction<typeof fetch>;

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function planFor(input: ReferenceVideoPlanInput): ReferenceVideoPlan {
  const snapshot = buildReferenceVideoPlanSnapshot(input);
  return {
    recipeId: snapshot.recipeId,
    recipeVersion: snapshot.recipeVersion,
    title: snapshot.title,
    reference: snapshot.reference,
    scenes: snapshot.scenes,
    duration: snapshot.duration,
    cost: snapshot.cost,
    id: "cccccccccccccccccccccccc",
    hash: "a".repeat(64),
    outputAssetId: "dddddddddddddddddddddddd",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "draft",
  };
}
const outputAsset: CreativeAsset = {
  id: "dddddddddddddddddddddddd",
  workspaceId: "workspace-1",
  kind: "video",
  source: "edited",
  provider: "airi",
  status: "queued",
  fileName: "Lunch.mp4",
};

function renderPlanner(workspaceId = "workspace-1") {
  const onOpenChange = jest.fn();
  const onAssetCreated = jest.fn();
  const node = (id: string, open = true) => (
    <ReferenceVideoPlanDialog
      workspaceId={id}
      open={open}
      onOpenChange={onOpenChange}
      onAssetCreated={onAssetCreated}
      reference={reference}
      t={t}
    />
  );
  const view = render(node(workspaceId));
  return {
    ...view,
    onOpenChange,
    onAssetCreated,
    rerenderWorkspace: (id: string) => view.rerender(node(id)),
    close: () => view.rerender(node(workspaceId, false)),
  };
}
async function assignScene(number: number, kind: "photo" | "video" = "photo") {
  fireEvent.click(
    screen.getByRole("button", { name: `Choose asset for scene ${number}` })
  );
  const picker = screen.getByRole("dialog", { name: "Asset picker" });
  fireEvent.click(
    within(picker).getByRole("button", { name: `Choose ${kind}` })
  );
}
async function fillPlan() {
  fireEvent.change(screen.getByLabelText("Business or offer title"), {
    target: { value: "Friday lunch" },
  });
  for (let index = 1; index <= 3; index++)
    await assignScene(index, index === 2 ? "video" : "photo");
}
function mockReview() {
  fetchMock.mockImplementationOnce(async (_url, init) =>
    response({ plan: planFor(JSON.parse(String(init?.body))) })
  );
}

beforeEach(() => {
  fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
  globalThis.fetch = fetchMock;
  mockPickerProps.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("requires every scene asset and business title, and makes no request before review", async () => {
  renderPlanner();
  expect(screen.getByRole("button", { name: "Review plan" })).toBeDisabled();
  expect(
    screen.getByRole("link", { name: "Original cafe story" })
  ).toHaveAttribute("href", reference.shareUrl);
  expect(
    screen.getByText(/do not automatically analyze or recreate/)
  ).toBeVisible();
  expect(screen.getAllByRole("option")).toHaveLength(10);
  await fillPlan();
  expect(screen.getByRole("button", { name: "Review plan" })).toBeEnabled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockPickerProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ showGenerate: false })
  );
});

it("reviews exact assets, edited captions and trims, then approves only the reviewed hash", async () => {
  mockReview();
  fetchMock.mockResolvedValueOnce(response({ asset: outputAsset }, 202));
  renderPlanner();
  await fillPlan();
  fireEvent.change(screen.getByLabelText("Scene 1 caption"), {
    target: { value: "Lunch for two — $15" },
  });
  fireEvent.change(screen.getByLabelText("Scene 2: start from (seconds)"), {
    target: { value: "1.23456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  await screen.findByRole("heading", { name: "Review your video plan" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(request).toEqual({
    recipeId: "product-reveal",
    title: "Friday lunch",
    reference,
    scenes: [
      {
        assetId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        caption: "Lunch for two — $15",
        sourceStart: 0,
      },
      {
        assetId: "bbbbbbbbbbbbbbbbbbbbbbbb",
        caption: "Take a closer look",
        sourceStart: 1.23456,
      },
      {
        assetId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        caption: "Discover the collection",
        sourceStart: 0,
      },
    ],
  });
  expect(screen.getByText("Use 4s starting at 1.235s")).toBeVisible();
  expect(screen.getByText("No AI generation charge")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and create video" })
  );
  await screen.findByText("Assembling your approved video…");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe(
    "/api/workspaces/workspace-1/assets/reference-video-plans/cccccccccccccccccccccccc/approve"
  );
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
    hash: "a".repeat(64),
  });
  expect(
    fetchMock.mock.calls.every(([url]) => !String(url).includes("/generate/"))
  ).toBe(true);
});

it("freezes editing and duplicate clicks while a review request is pending", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const view = renderPlanner();
  await fillPlan();
  const review = screen.getByRole("button", { name: "Review plan" });
  fireEvent.click(review);
  fireEvent.click(review);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Business or offer title")).toBeDisabled();
  expect(screen.getByLabelText("Editing format")).toBeDisabled();
  expect(screen.getByLabelText("Scene 1 caption")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Choose asset for scene 1" })
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  view.unmount();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(response({ error: "ignored" }, 500));
  });
});

it("invalidates approval when the user edits or changes the recipe", async () => {
  mockReview();
  mockReview();
  renderPlanner();
  await fillPlan();
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  await screen.findByRole("button", { name: "Approve and create video" });
  fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
  fireEvent.change(screen.getByLabelText("Scene 1 caption"), {
    target: { value: "Updated offer" },
  });
  expect(
    screen.queryByRole("button", { name: "Approve and create video" })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  await screen.findByRole("button", { name: "Approve and create video" });
  expect(
    JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).scenes[0].caption
  ).toBe("Updated offer");
  fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
  fireEvent.change(screen.getByLabelText("Editing format"), {
    target: { value: "how-it-works" },
  });
  expect(screen.getByRole("button", { name: "Review plan" })).toBeDisabled();
  expect(screen.getAllByText("Choose a photo or video")).toHaveLength(4);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retries an uncertain approval using the same plan and hash", async () => {
  mockReview();
  fetchMock.mockRejectedValueOnce(new Error("Connection interrupted"));
  fetchMock.mockResolvedValueOnce(
    response({ asset: outputAsset, duplicate: true })
  );
  renderPlanner();
  await fillPlan();
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and create video" })
  );
  await screen.findByText("Connection interrupted");
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and create video" })
  );
  await screen.findByText("Assembling your approved video…");
  expect(fetchMock.mock.calls[2][0]).toBe(fetchMock.mock.calls[1][0]);
  expect(fetchMock.mock.calls[2][1]?.body).toBe(
    fetchMock.mock.calls[1][1]?.body
  );
});

it("aborts a departed workspace request and ignores its late result", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const view = renderPlanner();
  await fillPlan();
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  const originalInput = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  view.rerenderWorkspace("workspace-2");
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(response({ plan: planFor(originalInput) }));
  });
  expect(screen.getByLabelText("Business or offer title")).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Approve and create video" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review plan" })).toBeDisabled();
});

it("polls the approved output and shows the completed video with a download link", async () => {
  jest.useFakeTimers();
  mockReview();
  fetchMock.mockResolvedValueOnce(response({ asset: outputAsset }));
  fetchMock.mockResolvedValueOnce(
    response({
      assets: [
        {
          ...outputAsset,
          status: "complete",
          url: "https://media.example/result.mp4",
        },
      ],
    })
  );
  const { onAssetCreated } = renderPlanner();
  await fillPlan();
  fireEvent.click(screen.getByRole("button", { name: "Review plan" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and create video" })
  );
  await screen.findByText("Assembling your approved video…");
  expect(onAssetCreated).toHaveBeenCalledWith(outputAsset);
  await act(async () => {
    jest.advanceTimersByTime(4000);
  });
  expect(screen.getByText("Your video is ready")).toBeVisible();
  expect(onAssetCreated).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: outputAsset.id,
      status: "complete",
      url: "https://media.example/result.mp4",
    })
  );
  expect(screen.getByLabelText("Finished video preview")).toHaveAttribute(
    "src",
    "https://media.example/result.mp4"
  );
  expect(
    screen.getByRole("link", { name: "Open / download video" })
  ).toHaveAttribute("href", "https://media.example/result.mp4");
  expect(fetchMock.mock.calls[2][0]).toContain(
    "surface=status&ids=dddddddddddddddddddddddd"
  );
  await act(async () => {
    jest.advanceTimersByTime(12000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("bounds scene preview playback and seeking to the selected trim and scene duration", async () => {
  renderPlanner();
  await fillPlan();
  fireEvent.change(screen.getByLabelText("Scene 2: start from (seconds)"), {
    target: { value: "1.5" },
  });
  const video = screen.getByLabelText("Scene 2 preview") as HTMLVideoElement;
  const pause = jest.spyOn(video, "pause").mockImplementation(() => undefined);
  expect(video).toHaveAttribute(
    "src",
    "https://media.example/clip.mp4#t=1.5,5.5"
  );
  video.currentTime = 0;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(1.5);
  video.currentTime = 12;
  fireEvent.seeking(video);
  expect(video.currentTime).toBe(5.5);
  expect(pause).toHaveBeenCalledTimes(1);
  fireEvent.play(video);
  expect(video.currentTime).toBe(1.5);
  video.currentTime = 5.5;
  fireEvent.timeUpdate(video);
  expect(pause).toHaveBeenCalledTimes(2);
  video.currentTime = 0.5;
  fireEvent.seeking(video);
  expect(video.currentTime).toBe(1.5);
});

it("keeps invalid video offsets out of the review request", async () => {
  renderPlanner();
  await fillPlan();
  fireEvent.change(screen.getByLabelText("Scene 2: start from (seconds)"), {
    target: { value: "-1" },
  });
  expect(screen.getByRole("button", { name: "Review plan" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Scene 2: start from (seconds)"), {
    target: { value: "" },
  });
  expect(screen.getByRole("button", { name: "Review plan" })).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("has localized recipe labels and captions for every supported locale", async () => {
  for (const locale of ["en", "ru", "kz"]) {
    const bundle = (await import(`../../../messages/panel/${locale}/page.json`))
      .CreativeAssetsWorkspace;
    for (const recipe of REFERENCE_VIDEO_RECIPES) {
      const translated = bundle.referenceVideoRecipes[recipe.id];
      expect(translated.title.length).toBeGreaterThan(0);
      for (const scene of recipe.scenes) {
        expect(translated.scenes[scene.id].label.length).toBeGreaterThan(0);
        expect(translated.scenes[scene.id].caption.length).toBeLessThanOrEqual(
          120
        );
      }
    }
  }
});
