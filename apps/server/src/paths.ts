import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Uploaded videos, cut-outs and the database. Git ignores .data. */
export const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, ".data", "app");
export const WEB_DIST = join(ROOT, "apps", "web", "dist");
