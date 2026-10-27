import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPLOAD_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Content-Range",
  "Range",
  "Location",
  "X-Goog-Upload-Status",
  "X-Goog-Content-Length-Range",
  "X-Goog-If-Generation-Match",
  "X-Goog-Meta-Workspaceid",
  "X-Goog-Meta-Assetid",
  "X-Goog-Meta-Kind",
];
const TEMPORARY_PREFIXES = ["tmp/", "uploads/tmp/", "bulk_campaign_dispatch/"];

export function buildCreativeAssetsCors(appOrigin = "https://airi.chat") {
  const origins = [
    appOrigin,
    "https://airi.chat",
    "https://www.airi.chat",
    "http://localhost:3000",
  ].map((value) => new URL(value).origin);
  return [
    {
      origin: [...new Set(origins)],
      method: ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
      responseHeader: [...UPLOAD_HEADERS],
      maxAgeSeconds: 3600,
    },
  ];
}

export function buildCreativeAssetsLifecycle() {
  return {
    rule: [
      {
        action: { type: "Delete" },
        condition: { age: 2, matchesPrefix: ["tmp/", "uploads/tmp/"] },
      },
      {
        action: { type: "Delete" },
        condition: {
          daysSinceCustomTime: 0,
          matchesPrefix: ["bulk_campaign_dispatch/"],
        },
      },
      {
        action: { type: "Delete" },
        condition: { age: 60, matchesPrefix: ["bulk_campaign_dispatch/"] },
      },
    ],
  };
}

function hasCorsHeaders(actual, expected) {
  const headers = new Set(
    (actual.responseHeader || actual.response_header || []).map((value) =>
      value.toLowerCase(),
    ),
  );
  return expected.responseHeader.every((value) =>
    headers.has(value.toLowerCase()),
  );
}

function matchesCorsRequest(entry, origin, method) {
  return (
    (entry.origin?.includes(origin) || entry.origin?.includes("*")) &&
    entry.method?.includes(method)
  );
}

function coversCorsRequests(entries, expected) {
  return expected.origin.every((origin) =>
    expected.method.every((method) => {
      // GCS uses the first rule matching the origin and method.
      const match = entries.find((entry) =>
        matchesCorsRequest(entry, origin, method),
      );
      return match !== undefined && hasCorsHeaders(match, expected);
    }),
  );
}

export function mergeCreativeAssetsCors(current = [], appOrigin) {
  const expected = buildCreativeAssetsCors(appOrigin)[0];
  const merged = current.map((entry) => {
    const overlaps = expected.origin.some((origin) =>
      expected.method.some((method) => matchesCorsRequest(entry, origin, method)),
    );
    if (!overlaps || hasCorsHeaders(entry, expected)) return entry;
    const headerKey = entry.response_header ? "response_header" : "responseHeader";
    const headers = entry[headerKey] || [];
    const existing = new Set(headers.map((header) => header.toLowerCase()));
    return {
      ...entry,
      [headerKey]: [
        ...headers,
        ...expected.responseHeader.filter(
          (header) => !existing.has(header.toLowerCase()),
        ),
      ],
    };
  });
  return coversCorsRequests(merged, expected) ? merged : [...merged, expected];
}

export function inspectCreativeAssetsBucket(bucket, appOrigin) {
  const safetyErrors = [];
  if (bucket.public_access_prevention !== "enforced")
    safetyErrors.push("public_access_prevention_required");
  if (bucket.uniform_bucket_level_access !== true)
    safetyErrors.push("uniform_bucket_access_required");
  const rules = bucket.lifecycle_config?.rule || [];
  for (const rule of rules) {
    if (rule.action?.type !== "Delete") continue;
    const prefixes =
      rule.condition?.matchesPrefix || rule.condition?.matches_prefix;
    if (
      !Array.isArray(prefixes) ||
      prefixes.length === 0 ||
      prefixes.some(
        (prefix) =>
          typeof prefix !== "string" ||
          !TEMPORARY_PREFIXES.some((allowed) => prefix.startsWith(allowed)),
      )
    ) {
      safetyErrors.push("lifecycle_can_remove_tenant_tombstones");
      break;
    }
  }
  const expected = buildCreativeAssetsCors(appOrigin)[0];
  const corsReady =
    Array.isArray(bucket.cors_config) &&
    coversCorsRequests(bucket.cors_config, expected);
  return { safetyErrors, corsReady };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "generate") {
    fs.writeFileSync(
      process.env.CORS_FILE,
      JSON.stringify(buildCreativeAssetsCors(process.env.APP_ORIGIN)),
    );
    fs.writeFileSync(
      process.env.LIFECYCLE_FILE,
      JSON.stringify(buildCreativeAssetsLifecycle()),
    );
  } else if (process.argv[2] === "validate") {
    const result = inspectCreativeAssetsBucket(
      JSON.parse(process.env.BUCKET_JSON),
      process.env.APP_ORIGIN,
    );
    if (result.safetyErrors.length || !result.corsReady) {
      console.error(
        JSON.stringify({
          event: "creative_assets_bucket_not_ready",
          ...result,
        }),
      );
      process.exitCode = 1;
    }
  } else {
    throw new Error("Expected generate or validate");
  }
}
