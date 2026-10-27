// Scripted buyer conversations against a catalog built by `pnpm catalog`, each checked in code.
// Run: pnpm seller:eval [--catalog=.data/catalogs/<run>] [--only=<case name part>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { numberedGrid, type CatalogResult } from "@vitrina/catalog";
import { createBasetenClient, loadBasetenConfig, loadConfig, openSpendLedger } from "@vitrina/meta";
import { LABEL_MENTION, languageOf, pricesInText, runSellerTurn, type SellerMessage, type SellerProduct, type SellerTurn } from "@vitrina/seller";

const args = process.argv.slice(2);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = readdirSync(".data/catalogs").filter((d) => /^\d+$/.test(d)).sort();
const catalogDir = option("catalog") ?? join(".data/catalogs", runs.at(-1) ?? "");
const catalog = JSON.parse(readFileSync(join(catalogDir, "catalog.json"), "utf8")) as CatalogResult;

const products: SellerProduct[] = catalog.products.map((p, i) => ({
  id: `p${i + 1}`,
  localName: p.local_name,
  name: p.name,
  category: p.category,
  price: p.price,
}));
const sheet = join(catalogDir, "catalog-sheet.jpg");
await numberedGrid(
  catalog.products.map((p) => p.cutoutPath ?? p.framePath),
  sheet,
  { columns: 4, tileWidth: 320, tileHeight: 320, fit: "contain" },
);

// A buyer's photo: another frame of the doll's clip than the one its cut-out came from.
const dollIndex = catalog.products.findIndex((p) => /doll\b/i.test(p.name));
const dollFrames = join(catalogDir, "products", readdirSync(join(catalogDir, "products")).sort()[dollIndex] ?? "", "frames");
const buyerPhoto = join(dollFrames, readdirSync(dollFrames).sort()[2] ?? "");

const config = loadConfig();
const ledger = openSpendLedger(config.ledgerPath, config.budgetUsd);
const baseten = createBasetenClient(loadBasetenConfig(), ledger);

type Turn = string | { text: string; photo: string };
interface Case {
  name: string;
  turns: Turn[];
  check: (results: SellerTurn[]) => string[];
}

const productId = (pattern: RegExp) => products.find((p) => pattern.test(p.name))?.id ?? "missing";
const fails = (...checks: (string | false)[]) => checks.filter((c): c is string => Boolean(c));
const shows = (t: SellerTurn, pattern: RegExp) => t.productIds.includes(productId(pattern)) || `doesn't show ${pattern}`;
// Product names are the owner's own words, often Kazakh, so they're left out when judging the language.
const withoutNames = (text: string) => products.reduce((rest, p) => rest.replaceAll(p.localName, ""), text);
const speaks = (t: SellerTurn, lang: "kk" | "ru" | "en") => languageOf(withoutNames(t.reply)) === lang || `reply isn't in ${lang}`;
const tidy = (t: SellerTurn) => !/\([^)]*\b(toy|figurine|accessory|cup|doll)\b[^)]*\)/i.test(t.reply) || "copies catalog details in brackets";
const states = (t: SellerTurn, price: number) => pricesInText(t.reply).includes(price) || `doesn't state ${price} ₸`;
const asksOwner = (t: SellerTurn) => t.ownerQuestion !== null || "didn't pass the question to the owner";
const noOrder = (t: SellerTurn) => t.order === null || "created an order too early";
const pass = (r: true | string) => (r === true ? false : r);

const cases: Case[] = [
  {
    name: "price, Kazakh",
    turns: ["Сәлеметсіз бе! Қуыршақ қанша тұрады?"],
    check: ([t]) => fails(pass(speaks(t!, "kk")), pass(shows(t!, /doll\b/i)), pass(states(t!, 5000))),
  },
  {
    name: "price, Russian",
    turns: ["Сколько стоит динозавр?"],
    check: ([t]) => fails(pass(speaks(t!, "ru")), pass(shows(t!, /dinosaur/i)), pass(states(t!, 300)), pass(tidy(t!))),
  },
  {
    name: "price, English",
    turns: ["Hi! How much is the rooster?"],
    check: ([t]) => fails(pass(speaks(t!, "en")), pass(shows(t!, /rooster/i)), pass(states(t!, 500)), pass(tidy(t!))),
  },
  {
    name: "buyer photo",
    turns: [{ text: "Есть такое?", photo: buyerPhoto }],
    check: ([t]) => fails(pass(shows(t!, /doll\b/i))),
  },
  {
    name: "delivery goes to the owner",
    turns: ["Есть доставка в Алматы?"],
    check: ([t]) => fails(pass(asksOwner(t!)), pass(noOrder(t!))),
  },
  {
    name: "no invented discount",
    turns: ["Сделаете скидку 50% на куклу?"],
    check: ([t]) => fails(pass(asksOwner(t!)), pricesInText(t!.reply).some((p) => p !== 5000) && "stated a discounted price"),
  },
  {
    name: "not in the shop",
    turns: ["У вас есть велосипеды?"],
    check: ([t]) => fails(t!.order !== null && "ordered something unrelated"),
  },
  {
    name: "order asks for contacts first",
    turns: ["Хочу купить телефон-игрушку", "Айгуль, 8 701 123 45 67"],
    check: ([first, second]) =>
      fails(
        pass(noOrder(first!)),
        second!.order === null && "no order after the contacts",
        second!.order !== null && second!.order.items[0]?.productId !== productId(/toy phone/i) && "ordered the wrong product",
        second!.order !== null && second!.order.buyerPhone !== "+77011234567" && "wrong phone",
        /\?\s*$/.test(second!.reply) && "still asks a question after ordering",
      ),
  },
];

const only = option("only");
const report = [];
for (const c of cases.filter((c) => !only || c.name.includes(only))) {
  const history: SellerMessage[] = [];
  const results: SellerTurn[] = [];
  const started = Date.now();
  const spentBefore = ledger.totalUsd();
  for (const turn of c.turns) {
    const text = typeof turn === "string" ? turn : turn.text;
    const result = await runSellerTurn(baseten, {
      shopName: "QazOner Group",
      channel: "web",
      products,
      catalogSheetPath: sheet,
      history,
      buyerText: text,
      buyerPhotoPath: typeof turn === "string" ? undefined : turn.photo,
    });
    results.push(result);
    history.push({ role: "buyer", text: typeof turn === "string" ? text : `${text} (sent a photo)` }, { role: "seller", text: result.reply });
  }
  // Every reply stays short (the product cards carry names, photos and prices) and never shows the
  // model's internal product labels, which the buyer can't see.
  const failures = [
    ...c.check(results),
    ...results.filter((r) => r.reply.length > 280).map((r) => `reply is ${r.reply.length} characters long`),
    ...results.filter((r) => LABEL_MENTION.test(r.reply)).map(() => "mentions a product label"),
  ];
  report.push({ case: c.name, ok: failures.length === 0, failures, seconds: (Date.now() - started) / 1000, usd: ledger.totalUsd() - spentBefore, results });
  console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${c.name} (${((Date.now() - started) / 1000).toFixed(1)}s)${failures.length ? `: ${failures.join("; ")}` : ""}`);
  for (const r of results) {
    console.log(`     → ${r.reply}${r.productIds.length ? ` [shows ${r.productIds.join(",")}]` : ""}${r.ownerQuestion ? ` [owner: ${r.ownerQuestion}]` : ""}${r.order ? ` [order ${JSON.stringify(r.order)}]` : ""}${r.corrections.length ? ` [corrected: ${r.corrections.join("; ")}]` : ""}`);
  }
}
const passed = report.filter((r) => r.ok).length;
writeFileSync(join(catalogDir, "seller-eval.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${passed}/${report.length} passed. Spend so far: $${ledger.totalUsd().toFixed(4)} of $${ledger.limitUsd}`);
