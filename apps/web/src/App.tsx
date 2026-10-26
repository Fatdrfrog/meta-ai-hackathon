import { ShopPage } from "./ShopPage.tsx";
import { Studio } from "./studio/Studio.tsx";

export function App() {
  const path = window.location.pathname;
  const studio = /^\/studio\/([^/]+)\/?$/.exec(path);
  if (studio?.[1]) return <Studio token={decodeURIComponent(studio[1])} />;
  const shop = /^\/s\/([^/]+)\/?$/.exec(path);
  if (shop?.[1]) return <ShopPage slug={decodeURIComponent(shop[1])} />;
  return (
    <main className="mx-auto max-w-2xl px-4 py-24">
      <p className="font-display text-lg font-semibold">Vitrina</p>
      <h1 className="mt-10 font-display text-3xl font-semibold leading-tight sm:text-5xl">Film your shelf. We’ll build the shop.</h1>
      <p className="mt-5 text-lg text-ink-soft">To add products, open the studio link you were given.</p>
    </main>
  );
}
