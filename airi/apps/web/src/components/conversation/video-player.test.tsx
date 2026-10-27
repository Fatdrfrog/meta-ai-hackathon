/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { VideoPlayer } from "./video-player";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

// The player reads its strings from the conversations catalog.
jest.mock("next-intl", () => {
  const { ConversationDetailView } = jest.requireActual(
    "../../../messages/conversations/en/page.json"
  ) as { ConversationDetailView: { videoPlayer: Record<string, string> } };
  return {
    useTranslations: () => (key: string) =>
      ConversationDetailView.videoPlayer[key] ?? key,
  };
});

describe("video playback failures", () => {
  beforeEach(() => {
    installResizeObserver();
    installMatchMedia();
    jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    jest
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("shows the existing error fallback when the bottom play control rejects", async () => {
    const onLoadError = jest.fn();
    const { container } = render(
      <VideoPlayer
        src="https://media.example/unsupported.mp4"
        onLoadError={onLoadError}
      />
    );
    fireEvent.loadedMetadata(container.querySelector("video")!);
    fireEvent.click(container.querySelector("video")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.loadedData(dialog.querySelector("video")!);
    jest
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(
        new DOMException("No supported source", "NotSupportedError")
      );

    // The bottom control is separate from the large central play button.
    const buttons = within(dialog).getAllByRole("button");
    const bottomPlay = buttons.find(
      button =>
        button.querySelector("svg.lucide-play") &&
        button.classList.contains("h-8")
    )!;
    await act(async () => fireEvent.click(bottomPlay));

    expect(
      within(dialog).getByText("Video format not supported")
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Open video in new tab" })
    ).toHaveAttribute("href", "https://media.example/unsupported.mp4");
    expect(onLoadError).toHaveBeenCalledTimes(1);
  });

  it("shows the thumbnail of a video whose metadata loaded before mounting", () => {
    jest
      .spyOn(HTMLMediaElement.prototype, "readyState", "get")
      .mockReturnValue(HTMLMediaElement.HAVE_ENOUGH_DATA);

    render(<VideoPlayer src="https://media.example/cached.mp4" />);

    expect(screen.queryByText("Loading video...")).not.toBeInTheDocument();
  });

  it("starts playing once the dialog's video can play", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play");
    const { container } = render(
      <VideoPlayer src="https://media.example/clip.mp4" />
    );
    fireEvent.click(container.querySelector("video")!);
    const video = screen.getByRole("dialog").querySelector("video")!;

    await act(async () => fireEvent.canPlayThrough(video));

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("starts playing a dialog video the thumbnail already loaded", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play");
    jest
      .spyOn(HTMLMediaElement.prototype, "readyState", "get")
      .mockReturnValue(HTMLMediaElement.HAVE_ENOUGH_DATA);
    const { container } = render(
      <VideoPlayer src="https://media.example/cached.mp4" />
    );

    await act(async () => fireEvent.click(container.querySelector("video")!));

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("keeps the thumbnail's open-in-new-tab link reachable after a load error", () => {
    const { container } = render(
      <VideoPlayer src="https://media.example/broken.mp4" />
    );
    fireEvent.error(container.querySelector("video")!);

    expect(
      screen.getByRole("link", { name: "Open video in new tab" })
    ).toHaveAttribute("href", "https://media.example/broken.mp4");
    // The play overlay spans the whole thumbnail and would swallow the click.
    expect(container.querySelector("svg.lucide-play")).toBeNull();
  });

  it("shows a load that failed before mounting as unavailable", () => {
    // jsdom has no media error; this one is already set when the player mounts.
    Object.defineProperty(HTMLMediaElement.prototype, "error", {
      configurable: true,
      get: () => ({ code: 4, MEDIA_ERR_ABORTED: 1 }),
    });
    try {
      render(<VideoPlayer src="https://media.example/missing.mp4" />);
    } finally {
      delete (HTMLMediaElement.prototype as { error?: unknown }).error;
    }

    expect(screen.getByText("Video unavailable")).toBeInTheDocument();
    // A 404 reports the same code as an unsupported format.
    expect(screen.queryByText("Video format not supported")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open video in new tab" })
    ).toHaveAttribute("href", "https://media.example/missing.mp4");
  });

  it("does not show an aborted load as a broken video", () => {
    const onLoadError = jest.fn();
    const { container } = render(
      <VideoPlayer
        src="https://media.example/clip.mp4"
        onLoadError={onLoadError}
      />
    );
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "error", {
      value: { code: 1, MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2 },
    });
    fireEvent.error(video);

    expect(screen.queryByText("Video unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
    expect(onLoadError).not.toHaveBeenCalled();
  });

  it("fits the thumbnail to a portrait clip and shows its length and size", () => {
    const { container } = render(
      <VideoPlayer src="https://media.example/clip.mp4" fileSize={4442851} />
    );
    const video = container.querySelector("video")!;
    Object.defineProperties(video, {
      videoWidth: { value: 720 },
      videoHeight: { value: 1280 },
      duration: { value: 5.4 },
    });
    fireEvent.loadedMetadata(video);

    const card = screen.getByRole("button", { name: "Play video (0:05)" });
    expect(card).toHaveStyle({ width: "203px", aspectRatio: "0.5625" });
    expect(within(card).getByText(/^0:05 · 4\.2/)).toBeInTheDocument();
  });

  it("keeps the thumbnail loaded while the dialog loads its own copy", () => {
    const { container } = render(
      <VideoPlayer src="https://media.example/clip.mp4" />
    );
    fireEvent.loadedMetadata(container.querySelector("video")!);
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(container).queryByText("Loading video…")
    ).not.toBeInTheDocument();
  });

  it("ignores a rejected play from the previous source on a reused video element", async () => {
    let rejectPlay!: (error: Error) => void;
    jest.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectPlay = reject;
      })
    );
    const onLoadError = jest.fn();
    const { container, rerender } = render(
      <VideoPlayer
        src="https://media.example/expired.mp4"
        onLoadError={onLoadError}
      />
    );
    fireEvent.click(container.querySelector("video")!);
    const dialog = screen.getByRole("dialog");
    const video = dialog.querySelector("video")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Play video" }));
    rerender(
      <VideoPlayer
        src="https://media.example/refreshed.mp4"
        onLoadError={onLoadError}
      />
    );
    expect(dialog.querySelector("video")).toBe(video);

    await act(async () => {
      rejectPlay(new DOMException("Expired source", "NotSupportedError"));
    });

    expect(dialog.querySelector("video")).toHaveAttribute(
      "src",
      "https://media.example/refreshed.mp4"
    );
    expect(onLoadError).not.toHaveBeenCalled();
  });

  it("keeps a refreshed source paused when the old play promise resolves", async () => {
    let resolvePlay!: () => void;
    jest.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
      new Promise<void>(resolve => {
        resolvePlay = resolve;
      })
    );
    const { container, rerender } = render(
      <VideoPlayer src="https://media.example/old.mp4" />
    );
    fireEvent.click(container.querySelector("video")!);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Play video" }));
    rerender(<VideoPlayer src="https://media.example/new.mp4" />);
    fireEvent.loadedData(dialog.querySelector("video")!);

    await act(async () => {
      resolvePlay();
    });

    expect(
      within(dialog).queryByRole("button", { name: "Pause video" })
    ).toBeNull();
    expect(
      within(dialog).getAllByRole("button", { name: "Play video" })
    ).toHaveLength(2);
  });
});
