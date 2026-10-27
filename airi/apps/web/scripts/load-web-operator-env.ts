import fs from "node:fs";
import path from "node:path";

/** Web operators run from apps/web; explicit environment values always win. */
export function loadWebOperatorEnv(): void {
  const appRoot = process.cwd();
  const repoRoot = path.resolve(appRoot, "..", "..");
  for (const file of [
    path.join(appRoot, ".env.local"),
    path.join(appRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
