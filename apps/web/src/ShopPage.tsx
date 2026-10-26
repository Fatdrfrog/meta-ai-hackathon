import type { ShopPageData } from "@vitrina/server/api";
import { useEffect, useState } from "react";
import { loadShop } from "./api.ts";
import { formatPrice } from "./format.ts";
import { Shelf } from "./Shelf.tsx";

export function ShopPage({ slug }: { slug: string }) {
  const [data, setData] = useState<ShopPageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadShop(slug).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  useEffect(() => {
    if (data) document.title = data.shop.name;
  }, [data]);

  if (error) {
    return (
      <main className="mx-auto max-w-xl px-4 py-24">
        <h1 className="font-display text-2xl font-semibold">There’s no shop at this address</h1>
        <p className="mt-3 text-ink-soft">{error}</p>
      </main>
    );
  }
  if (!data) return <main className="min-h-dvh" aria-busy="true" aria-label="Loading the shop" />;

  return (
    <div className="min-h-dvh">
      <header className="mx-auto max-w-6xl px-4 pb-8 pt-12">
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">{data.shop.name}</h1>
        <p className="mt-3 text-ink-soft">Prices in tenge.</p>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-16">
        {data.products.length === 0 ? (
          <p className="border-b-[6px] border-shelf bg-wall px-5 py-16 text-center text-ink-soft">Nothing on the shelf yet. Products appear here once the shop confirms them.</p>
        ) : (
          <Shelf
            label={`${data.shop.name} products`}
            items={data.products.map((p) => ({
              id: p.id,
              imageUrl: p.imageUrl,
              alt: p.localName,
              price: formatPrice(p.price, p.currency),
              below: (
                <>
                  <p className="font-medium">{p.localName}</p>
                  <p className="text-sm text-ink-soft">{p.name}</p>
                </>
              ),
            }))}
          />
        )}
      </main>
      <footer className="mx-auto max-w-6xl border-t border-line px-4 py-6 text-sm text-ink-soft">Shelf made with Vitrina from a video of the shop.</footer>
    </div>
  );
}
