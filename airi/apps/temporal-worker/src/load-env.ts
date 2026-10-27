import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

function resolveAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadTemporalWorkerEnv(): string[] {
  const appRoot = resolveAppRoot();
  const repoRoot = path.resolve(appRoot, "..", "..");
  const candidates = [
    path.join(appRoot, ".env.local"),
    path.join(appRoot, ".env"),
    path.join(repoRoot, "apps", "web", ".env.local"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ];

  const loaded: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    loadDotenv({ path: candidate, override: false });
    loaded.push(candidate);
  }

  return loaded;
}
