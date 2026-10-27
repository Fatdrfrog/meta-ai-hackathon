import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import {
  BUSINESS_MEDIA_BUCKET,
  BUSINESS_MEDIA_PREFIXES,
  ensureBusinessMediaBucket,
  LEGACY_BUSINESS_MEDIA_BUCKETS,
  rewriteLegacyBusinessMediaUrls,
} from "../src/lib/media/business-media-bucket";
import { loadWebOperatorEnv } from "./load-web-operator-env";

/**
 * Moves business assets (template headers, scenario media, studio uploads)
 * out of the chat media buckets into the public business media bucket, so the
 * chat buckets can be made private. See docs/operations/private-chat-media.md.
 *
 * Run from apps/web. Dry run by default; output is counts only.
 *   pnpm operator:business-media-move            # inventory, nothing written
 *   pnpm operator:business-media-move --copy     # copy objects (idempotent)
 *   pnpm operator:business-media-move --rewrite  # rewrite stored links
 *   pnpm operator:business-media-move --apply    # copy, then rewrite
 * Legacy objects are never deleted.
 */

export type MoveMode = "dry-run" | "copy" | "rewrite" | "apply";

/**
 * Mongo collections that store links to business assets. A 2026-10-15 scan
 * of every collection (media fields of the large ones, and the template data
 * of all 37.5k template messages) found links only here and in
 * whatsapptemplateauditlogs, which stays unchanged as recorded history.
 * Postgres links live in message_templates.whatsapp_data only.
 */
export const BUSINESS_MEDIA_REFERENCE_COLLECTIONS: ReadonlyArray<{
  name: string;
  /** Large collections are filtered on these fields instead of scanned. */
  fields?: readonly string[];
}> = [
  { name: "scenariogenerationjobs" },
  { name: "scenariogeneratedmediaassets" },
];

const LEGACY_LINK_MARKER =
  /\/storage\/v1\/object\/public\/conversation-(?:images|attachments)\/(?:whatsapp-template-headers|scenarios|studio)\//;

export function parseMoveMode(argv: readonly string[]): MoveMode {
  const flags = argv.filter(arg => arg.startsWith("--"));
  if (argv.length !== flags.length || flags.length > 1) {
    throw new Error(
      "Usage: business-media-move-operator.ts [--dry-run | --copy | --rewrite | --apply]"
    );
  }
  const mode = (flags[0] ?? "--dry-run").slice(2);
  if (!["dry-run", "copy", "rewrite", "apply"].includes(mode)) {
    throw new Error(`Unknown mode --${mode}`);
  }
  return mode as MoveMode;
}

export type LinkChange = { path: string; from: string; to: string };

/**
 * Lists every string field of `value` that holds a legacy business-asset link,
 * with its dotted Mongo path and rewritten value. `_id` is never touched.
 */
export function planLinkRewrites(
  value: unknown,
  rewrite: (text: string) => string = rewriteLegacyBusinessMediaUrls,
  prefix = ""
): LinkChange[] {
  if (typeof value === "string") {
    const rewritten = rewrite(value);
    return rewritten === value
      ? []
      : [{ path: prefix, from: value, to: rewritten }];
  }
  if (!value || typeof value !== "object") return [];
  if (value instanceof Date || mongoose.isValidObjectId(value)) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([key, item]) =>
    !prefix && key === "_id"
      ? []
      : planLinkRewrites(item, rewrite, prefix ? `${prefix}.${key}` : key)
  );
}

export type ObjectPlan = {
  source: { bucket: string; path: string };
  alreadyCopied: boolean;
};

/** Objects to copy: every legacy business asset not yet in the target. */
export function planObjectCopies(
  legacy: ReadonlyArray<{ bucket: string; path: string }>,
  targetPaths: ReadonlySet<string>
): ObjectPlan[] {
  return legacy
    .filter(object =>
      BUSINESS_MEDIA_PREFIXES.some(prefix => object.path.startsWith(prefix))
    )
    .map(source => ({ source, alreadyCopied: targetPaths.has(source.path) }));
}

type StorageClient = ReturnType<typeof createClient>["storage"];

async function listObjectPaths(
  storage: StorageClient,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage
      .from(bucket)
      .list(prefix.replace(/\/$/, ""), { limit: 1000, offset });
    if (error) {
      if (/not found/i.test(error.message)) return paths;
      throw new Error(`List ${bucket}/${prefix} failed: ${error.message}`);
    }
    for (const entry of data ?? []) {
      const entryPath = `${prefix}${entry.name}`;
      if (entry.id) paths.push(entryPath);
      else
        paths.push(
          ...(await listObjectPaths(storage, bucket, `${entryPath}/`))
        );
    }
    if (!data || data.length < 1000) return paths;
  }
}

/** Business-asset object paths the repository links to (landing, manifests). */
function readRepositoryLinkedPaths(appRoot: string): Set<string> {
  const linked = new Set<string>();
  const pattern = new RegExp(
    `/storage/v1/object/public/(?:${[BUSINESS_MEDIA_BUCKET, ...LEGACY_BUSINESS_MEDIA_BUCKETS].join("|")})/((?:${BUSINESS_MEDIA_PREFIXES.map(prefix => prefix.replace("/", "")).join("|")})/[^"'\\s?)]+)`,
    "g"
  );
  const files = [
    path.join(appRoot, "src/lib/landing/public-template-examples.ts"),
  ];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) files.push(full);
    }
  };
  walk(path.resolve(appRoot, "../../docs/integrations"));
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) {
      linked.add(decodeURIComponent(match[1]));
    }
  }
  return linked;
}

export async function runBusinessMediaMoveOperator(
  argv: readonly string[]
): Promise<number> {
  let mode: MoveMode;
  try {
    mode = parseMoveMode(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  loadWebOperatorEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mongoUri = process.env.MONGODB_URI;
  if (!supabaseUrl || !serviceKey || !mongoUri) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and MONGODB_URI are required"
    );
    return 2;
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const report: Record<string, unknown> = {
    mode,
    target: BUSINESS_MEDIA_BUCKET,
  };

  // 1. Objects.
  const legacy: Array<{ bucket: string; path: string }> = [];
  for (const bucket of LEGACY_BUSINESS_MEDIA_BUCKETS) {
    for (const prefix of BUSINESS_MEDIA_PREFIXES) {
      for (const objectPath of await listObjectPaths(
        supabase.storage,
        bucket,
        prefix
      )) {
        legacy.push({ bucket, path: objectPath });
      }
    }
  }
  const targetPaths = new Set<string>();
  for (const prefix of BUSINESS_MEDIA_PREFIXES) {
    for (const objectPath of await listObjectPaths(
      supabase.storage,
      BUSINESS_MEDIA_BUCKET,
      prefix
    )) {
      targetPaths.add(objectPath);
    }
  }
  const plans = planObjectCopies(legacy, targetPaths);
  const linked = readRepositoryLinkedPaths(process.cwd());
  const available = new Set([
    ...legacy.map(object => object.path),
    ...targetPaths,
  ]);
  report.objects = {
    legacy: legacy.length,
    alreadyInTarget: plans.filter(plan => plan.alreadyCopied).length,
    toCopy: plans.filter(plan => !plan.alreadyCopied).length,
    duplicatePathsAcrossLegacyBuckets:
      legacy.length - new Set(legacy.map(object => object.path)).size,
    repositoryLinked: linked.size,
    repositoryLinkedMissingEverywhere: [...linked].filter(
      p => !available.has(p)
    ).length,
  };

  if (mode === "copy" || mode === "apply") {
    await ensureBusinessMediaBucket(supabase.storage, BUSINESS_MEDIA_BUCKET);
    let copied = 0;
    let failed = 0;
    for (const plan of plans) {
      if (plan.alreadyCopied) continue;
      const { error } = await supabase.storage
        .from(plan.source.bucket)
        .copy(plan.source.path, plan.source.path, {
          destinationBucket: BUSINESS_MEDIA_BUCKET,
        });
      if (!error || /already exists/i.test(error.message)) copied += 1;
      else failed += 1;
    }
    report.copy = { copied, failed };
    if (failed > 0) {
      console.log(JSON.stringify(report, null, 2));
      console.error("Some objects failed to copy; links were not rewritten.");
      return 1;
    }
  }

  // 2. Stored links.
  const { data: templates, error: templateError } = await supabase
    .from("message_templates")
    .select("id, whatsapp_data");
  if (templateError)
    throw new Error(`Read message_templates: ${templateError.message}`);
  const templateUpdates = (templates ?? []).flatMap(row => {
    const before = JSON.stringify(row.whatsapp_data ?? null);
    const after = rewriteLegacyBusinessMediaUrls(before);
    return after === before
      ? []
      : [{ id: row.id as string, whatsappData: JSON.parse(after) }];
  });

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db!;
  const mongoPlans: Array<{
    collection: string;
    id: unknown;
    changes: LinkChange[];
  }> = [];
  for (const target of BUSINESS_MEDIA_REFERENCE_COLLECTIONS) {
    const filter = target.fields
      ? {
          $or: target.fields.map(field => ({
            [field]: { $regex: LEGACY_LINK_MARKER.source },
          })),
        }
      : {};
    for await (const doc of db.collection(target.name).find(filter)) {
      if (!target.fields && !LEGACY_LINK_MARKER.test(JSON.stringify(doc)))
        continue;
      const changes = planLinkRewrites(doc);
      if (changes.length)
        mongoPlans.push({ collection: target.name, id: doc._id, changes });
    }
  }
  report.links = {
    messageTemplates: templateUpdates.length,
    mongoDocuments: Object.fromEntries(
      BUSINESS_MEDIA_REFERENCE_COLLECTIONS.map(({ name }) => [
        name,
        mongoPlans.filter(plan => plan.collection === name).length,
      ])
    ),
  };

  if (mode === "rewrite" || mode === "apply") {
    let templatesUpdated = 0;
    for (const update of templateUpdates) {
      const { error } = await supabase
        .from("message_templates")
        .update({ whatsapp_data: update.whatsappData })
        .eq("id", update.id);
      if (error) throw new Error(`Update message_templates: ${error.message}`);
      templatesUpdated += 1;
    }
    let mongoUpdated = 0;
    let mongoChangedConcurrently = 0;
    for (const plan of mongoPlans) {
      // Only while every rewritten field still holds the old link.
      const result = await db.collection(plan.collection).updateOne(
        {
          _id: plan.id as never,
          ...Object.fromEntries(
            plan.changes.map(change => [change.path, change.from])
          ),
        },
        {
          $set: Object.fromEntries(
            plan.changes.map(change => [change.path, change.to])
          ),
        }
      );
      if (result.modifiedCount === 1) mongoUpdated += 1;
      else mongoChangedConcurrently += 1;
    }
    report.rewrite = {
      templatesUpdated,
      mongoUpdated,
      mongoChangedConcurrently,
    };
  }

  await mongoose.disconnect();
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (
  /business-media-move-operator\.(?:ts|js|mjs)$/.test(process.argv[1] || "")
) {
  void runBusinessMediaMoveOperator(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
