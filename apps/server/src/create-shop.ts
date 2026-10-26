// Creates a shop and prints the owner's studio link. Run: pnpm shop:create "QazOner Group"
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { openStore } from "./store.ts";

const name = process.argv.slice(2).join(" ").trim();
if (!name) {
  console.error('Usage: pnpm shop:create "<shop name>"');
  process.exit(1);
}

const shop = openStore(join(DATA_DIR, "vitrina.db")).createShop(name);
const base = process.env.PUBLIC_URL ?? "http://localhost:5173";
console.log(`Studio, for the owner only: ${base}/studio/${shop.ownerToken}`);
console.log(`Shop page, for buyers:      ${base}/s/${shop.slug}`);
