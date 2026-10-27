import { createRequire } from "node:module";

export function createWebRequire(importMetaUrl: string) {
  return createRequire(importMetaUrl);
}

function isInteropWrapper(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.__esModule === true &&
    Object.prototype.hasOwnProperty.call(record, "default")
  ) {
    return true;
  }
  const keys = Object.keys(value);
  if (!keys.includes("default")) return false;
  return keys.every(
    (key) =>
      key === "default" || key === "module.exports" || key === "__esModule",
  );
}

function unwrapDefaultExport(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4 && isInteropWrapper(current); depth += 1) {
    current = current.default;
  }
  return current;
}

export function readDefaultExport<T>(moduleRecord: unknown): T {
  if (
    moduleRecord &&
    typeof moduleRecord === "object" &&
    "default" in moduleRecord
  ) {
    return unwrapDefaultExport(
      (moduleRecord as { default: unknown }).default,
    ) as T;
  }

  return unwrapDefaultExport(moduleRecord) as T;
}

export function readRuntimeExport<T>(
  moduleRecord: unknown,
  exportName: string,
): T {
  if (moduleRecord && typeof moduleRecord === "object") {
    const record = moduleRecord as Record<string, unknown>;
    const defaultExport = record.default;
    if (exportName === "default" && defaultExport !== undefined) {
      return unwrapDefaultExport(defaultExport) as T;
    }

    if (exportName in record) {
      return record[exportName] as T;
    }

    if (defaultExport && typeof defaultExport === "object") {
      const defaultRecord = defaultExport as Record<string, unknown>;
      if (exportName in defaultRecord) {
        return defaultRecord[exportName] as T;
      }
    }
  }

  throw new Error(`Runtime export "${exportName}" was not found.`);
}
