/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

// Mount dialog children synchronously to exercise the player's native load
// effect independently of Radix Presence/Portal timing. The ordinary playback
// suite uses the real dialog, including its deferred mounting behavior.
jest.mock("@/components/ui/dialog", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const OpenContext = React.createContext(false);
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <OpenContext.Provider value={open}>{children}</OpenContext.Provider>
    ),
    DialogContent: ({ children }: { children: ReactNode }) =>
      React.useContext(OpenContext) ? (
        <section role="dialog">{children}</section>
      ) : null,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

describe("video autoplay lifecycle", () => {
  beforeEach(() => {
    installResizeObserver();
    installMatchMedia();
    jest
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("does not mute or retry a new source when the previous autoplay is rejected", async () => {
    let rejectPlay!: (error: Error) => void;
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectPlay = reject;
      })
    );
    const { container, rerender } = render(
      <VideoPlayer src="https://media.example/old.mp4" />
    );
    fireEvent.click(container.querySelector("video")!);
    const video = screen.getByRole("dialog").querySelector("video")!;
    fireEvent.canPlayThrough(video);
    expect(play).toHaveBeenCalledTimes(1);
    rerender(<VideoPlayer src="https://media.example/new.mp4" />);

    await act(async () => {
      rejectPlay(new DOMException("Autoplay blocked", "NotAllowedError"));
    });

    expect(video.muted).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("starts only one autoplay attempt when playable events repeat", async () => {
    let resolvePlay!: () => void;
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
      new Promise<void>(resolve => {
        resolvePlay = resolve;
      })
    );
    const { container } = render(
      <VideoPlayer src="https://media.example/video.mp4" />
    );
    fireEvent.click(container.querySelector("video")!);
    const video = screen.getByRole("dialog").querySelector("video")!;
    fireEvent.canPlayThrough(video);
    fireEvent.canPlayThrough(video);
    await act(async () => {
      resolvePlay();
    });
    expect(play).toHaveBeenCalledTimes(1);
  });
});
