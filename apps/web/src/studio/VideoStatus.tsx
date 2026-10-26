import type { ApiVideo, VideoStage } from "@vitrina/server/api";
import { formatSeconds } from "../format.ts";

const STEPS: readonly { stage: VideoStage; label: string }[] = [
  { stage: "preparing", label: "Preparing the video" },
  { stage: "listening", label: "Listening to you" },
  { stage: "watching", label: "Watching the video" },
  { stage: "cutting", label: "Cutting out products" },
];

export function VideoInProgress({ video }: { video: ApiVideo }) {
  const current = video.status === "queued" ? -1 : STEPS.findIndex((s) => s.stage === video.stage);
  return (
    <section aria-live="polite" className="border border-line px-5 py-4">
      <h2 className="font-display text-lg font-semibold">{video.status === "queued" ? "Waiting to start" : "Building your shelf"}</h2>
      <ol className="mt-3 space-y-1.5">
        {STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "now" : "next";
          const count = step.stage === "cutting" && state === "now" && video.total ? `: ${video.done ?? 0} of ${video.total}` : "";
          return (
            <li key={step.stage} className={`flex items-center gap-3 ${state === "next" ? "text-ink-soft" : ""}`} aria-current={state === "now" ? "step" : undefined}>
              <span
                aria-hidden
                className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                  state === "done" ? "bg-ok text-white" : state === "now" ? "bg-tag text-ink motion-safe:animate-pulse" : "border border-line"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className={state === "now" ? "font-medium" : ""}>
                {step.label}
                {count}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm text-ink-soft">About two minutes for a one-minute video. You can leave this page; the shelf keeps building.</p>
    </section>
  );
}

export function VideoFailed({ video, onRetry }: { video: ApiVideo; onRetry: () => void }) {
  return (
    <section role="alert" className="border border-check bg-check-bg px-5 py-4">
      <h2 className="font-display text-lg font-semibold text-check">The shelf couldn't be built from this video</h2>
      <p className="mt-2 break-words text-ink">{video.error}</p>
      <button type="button" onClick={onRetry} className="mt-3 rounded-md bg-action px-4 py-2 font-medium text-white hover:bg-action-dark">
        Try again
      </button>
    </section>
  );
}

export function VideoTranscript({ video }: { video: ApiVideo }) {
  // The studio is in English, so dates are too, whatever the browser's language.
  const when = new Date(video.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return (
    <details className="group border-t border-line py-3">
      <summary className="cursor-pointer text-ink-soft hover:text-ink">
        What you said in the video from {when}: {video.productCount} {video.productCount === 1 ? "product" : "products"}
        {video.seconds !== null ? `, ready in ${formatSeconds(video.seconds)}` : ""}
      </summary>
      <p className="mt-3 max-w-prose whitespace-pre-wrap leading-relaxed">{video.transcript || "Nothing was said in this video."}</p>
    </details>
  );
}
