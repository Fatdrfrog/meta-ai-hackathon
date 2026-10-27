import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { numberedGrid } from "@vitrina/catalog";

export interface SheetItem {
  readonly id: string;
  readonly imagePath: string;
  readonly updatedAt: string;
}

// The seller matches a buyer's photo against one numbered sheet of the shop's products, in shelf
// order. The sheet is rebuilt only when the shelf changes.
export async function catalogSheet(dataDir: string, shopId: string, items: readonly SheetItem[]): Promise<string> {
  const key = createHash("sha1")
    .update(items.map((item) => `${item.id}:${item.updatedAt}`).join("|"))
    .digest("hex")
    .slice(0, 12);
  const path = join(dataDir, "shops", shopId, `catalog-sheet-${key}.jpg`);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await numberedGrid(
      items.map((item) => item.imagePath),
      path,
      { columns: 4, tileWidth: 320, tileHeight: 320, fit: "contain" },
    );
  }
  return path;
}
