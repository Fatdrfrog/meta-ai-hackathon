import type { ShopPageData } from "@vitrina/server/api";
import { useEffect, useState } from "react";
import { loadShop } from "./api.ts";
import { formatPrice } from "./format.ts";
import { Shelf } from "./Shelf.tsx";
import { Chat } from "./shop/Chat.tsx";

export function ShopPage({ slug }: { slug: string }) {
  const [data, setData] = useState<ShopPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>();

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

  const first = data.products[0];
  const suggestions = [
    ...(first ? [`Сколько стоит ${first.localName}?`] : []),
    "Есть доставка?",
    "What do you have?",
  ];
  const ask = (text: string) => {
    setPrefill({ text, nonce: Date.now() });
    // On a wide screen the chat is already beside the shelf; only phones open it full screen.
    if (window.matchMedia("(max-width: 1023px)").matches) setChatOpen(true);
  };
  const chat = (onClose?: () => void) => (
    <Chat slug={slug} shopName={data.shop.name} suggestions={suggestions} prefill={prefill} onClose={onClose} />
  );

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-7xl px-4 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-10">
        <div className="min-w-0">
          <header className="pb-8 pt-12">
            <h1 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">{data.shop.name}</h1>
            <p className="mt-3 text-ink-soft">Prices in tenge. Ask the shop about anything on the shelf.</p>
          </header>
          <main className="pb-24 lg:pb-16">
            {data.products.length === 0 ? (
              <p className="border-b-[6px] border-shelf bg-wall px-5 py-16 text-center text-ink-soft">Nothing on the shelf yet. Products appear here once the shop confirms them.</p>
            ) : (
              <Shelf
                label={`${data.shop.name} products`}
                columns="grid-cols-2 sm:grid-cols-3"
                items={data.products.map((p) => ({
                  id: p.id,
                  imageUrl: p.imageUrl,
                  alt: p.localName,
                  price: formatPrice(p.price, p.currency),
                  below: (
                    <>
                      <p className="font-medium">{p.localName}</p>
                      <p className="text-sm text-ink-soft">{p.name}</p>
                      <button type="button" onClick={() => ask(`Расскажите про «${p.localName}»`)} className="mt-1.5 text-sm font-medium text-action underline-offset-4 hover:underline">
                        Ask about it
                      </button>
                    </>
                  ),
                }))}
              />
            )}
          </main>
          <footer className="border-t border-line py-6 text-sm text-ink-soft">Shelf made with Vitrina from a video of the shop.</footer>
        </div>

        <aside className="hidden lg:block" aria-label="Chat with the shop">
          <div className="sticky top-6 my-6 h-[calc(100dvh-3rem)] overflow-hidden border border-line">{chat()}</div>
        </aside>
      </div>

      {/* On a phone the chat opens full screen from a button that stays in reach. */}
      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed bottom-4 right-4 rounded-full bg-action px-5 py-3 font-medium text-white shadow-lg hover:bg-action-dark lg:hidden"
        >
          Ask the shop
        </button>
      )}
      {chatOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Chat with the shop">
          {chat(() => setChatOpen(false))}
        </div>
      )}
    </div>
  );
}
