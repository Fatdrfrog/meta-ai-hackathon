import type { ApiProduct, StudioData } from "@vitrina/server/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioApi } from "../api.ts";
import { formatPrice } from "../format.ts";
import { Shelf } from "../Shelf.tsx";
import { ProductEditor } from "./ProductEditor.tsx";
import { UploadVideo } from "./UploadVideo.tsx";
import { VideoFailed, VideoInProgress, VideoTranscript } from "./VideoStatus.tsx";

const POLL_MS = 2000;

export function Studio({ token }: { token: string }) {
  const api = useMemo(() => studioApi(token), [token]);
  const [data, setData] = useState<StudioData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [arriving, setArriving] = useState<ReadonlyMap<string, number>>(new Map());
  const finishedVideos = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.load();
      // Products from a video that just finished get the arrival animation, in shelf order.
      const finished = new Set(next.videos.filter((v) => v.status === "done").map((v) => v.id));
      const seen = finishedVideos.current;
      if (seen) {
        const fresh = next.products.filter((p) => finished.has(p.videoId) && !seen.has(p.videoId));
        if (fresh.length > 0) setArriving(new Map(fresh.map((p, i) => [p.id, i])));
      }
      finishedVideos.current = finished;
      setData(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const building = data?.videos.some((v) => v.status === "queued" || v.status === "processing") ?? false;
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [building, refresh]);

  useEffect(() => {
    if (data) document.title = `Studio for ${data.shop.name}`;
  }, [data]);

  const replace = (product: ApiProduct) => setData((d) => d && { ...d, products: d.products.map((p) => (p.id === product.id ? product : p)) });
  const drop = (id: string) => setData((d) => d && { ...d, products: d.products.filter((p) => p.id !== id) });

  if (!data) {
    return loadError ? (
      <main className="mx-auto max-w-xl px-4 py-24">
        <h1 className="font-display text-2xl font-semibold">This studio didn't open</h1>
        <p className="mt-3 text-ink-soft">{loadError}</p>
        <button type="button" onClick={() => void refresh()} className="mt-6 rounded-md bg-action px-4 py-2 font-medium text-white hover:bg-action-dark">
          Try again
        </button>
      </main>
    ) : (
      <main className="mx-auto max-w-6xl px-4 py-10" aria-busy="true" aria-label="Loading your studio">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="aspect-[4/5] border-b-[6px] border-shelf bg-wall motion-safe:animate-pulse" />
          ))}
        </div>
      </main>
    );
  }

  const active = data.videos.filter((v) => v.status === "queued" || v.status === "processing");
  const failed = data.videos.filter((v) => v.status === "failed");
  const finished = data.videos.filter((v) => v.status === "done");
  const confirmable = data.products.filter((p) => !p.confirmed && p.notes.length === 0).length;
  const confirmed = data.products.filter((p) => p.confirmed).length;
  const fresh = data.products.length === 0 && data.videos.length === 0;

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <span className="font-display text-lg font-semibold">Vitrina</span>
          <span className="truncate text-ink-soft">{data.shop.name}</span>
          <a href={`/s/${data.shop.slug}`} target="_blank" rel="noreferrer" className="ml-auto shrink-0 font-medium text-action underline-offset-4 hover:underline">
            Shop page
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 pb-24 pt-8">
        {fresh ? (
          <section className="max-w-2xl pt-6">
            <h1 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">Film your shelf. We’ll build the shop.</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Walk past your products and say each one’s name and price out loud. Vitrina cuts every product out of the video and writes its price tag from your words.
            </p>
            <div className="mt-8">
              <UploadVideo upload={api.uploadVideo} onUploaded={() => void refresh()} prominent />
            </div>
          </section>
        ) : (
          <UploadVideo upload={api.uploadVideo} onUploaded={() => void refresh()} prominent={false} />
        )}

        {active.map((video) => (
          <VideoInProgress key={video.id} video={video} />
        ))}
        {failed.map((video) => (
          <VideoFailed key={video.id} video={video} onRetry={() => void api.retryVideo(video.id).then(refresh)} />
        ))}

        {data.products.length > 0 && (
          <section aria-labelledby="shelf-heading">
            <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h2 id="shelf-heading" className="font-display text-2xl font-semibold">
                Your shelf
              </h2>
              <p className="text-ink-soft">
                {data.products.length} {data.products.length === 1 ? "product" : "products"}, {confirmed} confirmed. Buyers see only confirmed products.
              </p>
              {confirmable > 0 && (
                <button
                  type="button"
                  onClick={() => void api.confirmAll().then(refresh)}
                  className="rounded-md border border-action px-3 py-1.5 font-medium text-action hover:bg-action hover:text-white sm:ml-auto"
                >
                  Confirm the {confirmable} without notes
                </button>
              )}
            </div>
            <Shelf
              label="Your products"
              items={data.products.map((p) => ({
                id: p.id,
                imageUrl: p.imageUrl,
                alt: p.localName,
                price: formatPrice(p.price, p.currency),
                arriving: arriving.get(p.id),
                below: (
                  <ProductEditor
                    product={p}
                    save={async (patch) => replace(await api.updateProduct(p.id, patch))}
                    remove={async () => {
                      await api.removeProduct(p.id);
                      drop(p.id);
                    }}
                  />
                ),
              }))}
            />
          </section>
        )}

        {finished.length > 0 && (
          <section aria-label="Your videos">
            {finished.map((video) => (
              <VideoTranscript key={video.id} video={video} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
