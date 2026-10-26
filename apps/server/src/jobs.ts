import { dirname } from "node:path";
import { buildCatalog, type SpeechProvider } from "@vitrina/catalog";
import type { MetaClient } from "@vitrina/meta";
import type { Store, Video } from "./store.ts";

// One video at a time: the Meta calls inside a video already run in parallel, and a small shop
// uploads rarely, so a queue in the database is enough and survives restarts.
export function startJobRunner(store: Store, meta: MetaClient, speech: SpeechProvider) {
  let running = false;

  async function processVideo(video: Video): Promise<void> {
    store.setProgress(video.id, "processing", "preparing", null, null);
    try {
      const result = await buildCatalog({
        sourcePath: video.sourcePath,
        workDir: dirname(video.sourcePath),
        meta,
        speech,
        onProgress: (p) =>
          store.setProgress(video.id, "processing", p.stage, p.stage === "cutting" ? p.done : null, p.stage === "cutting" ? p.total : null),
      });
      store.finishVideo(video, result);
      console.log(`video ${video.id}: ${result.products.length} products, $${result.spentUsd.toFixed(3)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`video ${video.id} failed:`, error);
      store.failVideo(video.id, message);
    }
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let video = store.nextQueuedVideo(); video; video = store.nextQueuedVideo()) await processVideo(video);
    } finally {
      running = false;
    }
  }

  const requeued = store.requeueInterrupted();
  if (requeued > 0) console.log(`requeued ${requeued} interrupted video(s)`);
  void drain();
  return { kick: () => void drain() };
}
