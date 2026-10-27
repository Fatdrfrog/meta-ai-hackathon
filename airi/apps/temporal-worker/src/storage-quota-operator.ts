import { Storage } from "@google-cloud/storage";
import { CONVERSATION_CHANNELS } from "@icecore/shared/types/sources";
import { fileURLToPath } from "node:url";
import {
  COMPANY_STORAGE_LIMIT_BYTES,
  getStorageQuotaStore,
  getStorageQuotaRolloutMode,
  type StorageObjectInput,
  type StorageQuotaStore,
} from "@icecore/airi-runtime/storage-quota";
import {
  getGcsCreativeAssetsBucketName,
  statGcsCreativeAssetObject,
} from "./gcs-creative-assets.js";
import { loadTemporalWorkerEnv } from "./load-env.js";

type InventoryObject = StorageObjectInput;
type InventoryStore = Pick<
  StorageQuotaStore,
  "beginInventory" | "inventoryObject" | "finishInventory"
>;

export async function inventoryCompanyStorage(params: {
  companyId: string;
  objects: AsyncIterable<InventoryObject>;
  store?: InventoryStore;
}): Promise<{ objects: number; bytes: number; applied: boolean }> {
  if (params.store) await params.store.beginInventory(params.companyId);
  let objects = 0;
  let bytes = 0;
  for await (const object of params.objects) {
    if (
      object.companyId !== params.companyId ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0
    )
      throw new Error("Invalid storage inventory object");
    if (params.store) await params.store.inventoryObject(object);
    objects += 1;
    bytes += object.bytes;
    if (!Number.isSafeInteger(bytes))
      throw new Error("Inventory byte count exceeds the supported range");
  }
  if (params.store) await params.store.finishInventory(params.companyId);
  return { objects, bytes, applied: Boolean(params.store) };
}

function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error("Supabase storage inventory is not configured");
  return {
    url: url.replace(/\/$/, ""),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

/** Service-role Supabase REST/Storage request; the caller checks the status. */
export function supabaseServiceFetch(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const config = supabaseConfig();
  return fetch(`${config.url}${path}`, {
    headers: { ...config.headers, ...init.headers },
    method: init.method || (init.body === undefined ? "GET" : "POST"),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(20_000),
  });
}

async function supabaseJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await supabaseServiceFetch(path, { body });
  if (!response.ok)
    throw new Error(`Supabase inventory request failed (${response.status})`);
  return (await response.json()) as T;
}

const CONVERSATION_CHANNEL_SET: ReadonlySet<string> = new Set(
  CONVERSATION_CHANNELS,
);

/**
 * The workspace that owns a storage object, derived from its bucket/path
 * layout. KB paths resolve through their article; unknown layouts return
 * undefined so callers can refuse instead of guessing.
 */
export function storageObjectOwnerWorkspaceId(
  bucket: string,
  path: string,
  kbArticleWorkspaces: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  const parts = path.split("/");
  if (parts[0] === "kb") return kbArticleWorkspaces.get(parts[1]);
  if (parts[0] === "outbound" && CONVERSATION_CHANNEL_SET.has(parts[1]))
    return parts[2];
  if (parts[0] === "studio" && parts[1] === "instagram") return parts[2];
  if (
    CONVERSATION_CHANNEL_SET.has(parts[0]) ||
    ["scenarios", "whatsapp-template-headers", "workspaces"].includes(parts[0])
  )
    return parts[1];
  if (bucket === "email-attachments") return parts[0];
  return undefined;
}

/** Lists every object below a Supabase bucket folder in bounded pages. */
export async function* listSupabaseBucketObjects(
  bucket: string,
  prefix: string,
  nextPage: () => void,
  depth = 0,
): AsyncGenerator<{ bucket: string; path: string; bytes: number }> {
  type SupabaseObject = {
    id: string | null;
    name: string;
    metadata?: { size?: unknown };
  };
  if (depth > 12) throw new Error("Storage inventory folder depth exceeded");
  for (let offset = 0; ; offset += 500) {
    nextPage();
    const rows = await supabaseJson<SupabaseObject[]>(
      `/storage/v1/object/list/${encodeURIComponent(bucket)}`,
      {
        prefix,
        limit: 500,
        offset,
        sortBy: { column: "name", order: "asc" },
      },
    );
    if (!Array.isArray(rows))
      throw new Error("Invalid Supabase inventory response");
    for (const row of rows) {
      if (
        !row.name ||
        row.name.includes("/") ||
        row.name === "." ||
        row.name === ".."
      )
        throw new Error("Invalid storage inventory path");
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (!row.id) {
        yield* listSupabaseBucketObjects(bucket, path, nextPage, depth + 1);
        continue;
      }
      const bytes = Number(row.metadata?.size);
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("Supabase object size is missing");
      yield { bucket, path, bytes };
    }
    if (rows.length < 500) break;
  }
}

export async function* physicalObjects(
  companyId: string,
  maxPages: number,
): AsyncGenerator<InventoryObject> {
  let pages = 0;
  const nextPage = () => {
    if (++pages > maxPages)
      throw new Error(
        "Inventory page budget reached; company remains inactive",
      );
  };
  async function rows<T>(table: string, select: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      nextPage();
      const query = new URLSearchParams({
        select,
        order: "id.asc",
        limit: "500",
        offset: String(offset),
      });
      const page = await supabaseJson<T[]>(`/rest/v1/${table}?${query}`);
      if (!Array.isArray(page))
        throw new Error("Invalid storage ownership response");
      result.push(...page);
      if (page.length < 500) return result;
    }
  }
  const workspaces = new Map(
    (
      await rows<{ id: string; company_id: string }>(
        "workspaces",
        "id,company_id",
      )
    ).map((row) => [row.id, row.company_id]),
  );
  const articles = new Map(
    (
      await rows<{ id: string; workspace_id: string }>(
        "kb_articles",
        "id,workspace_id",
      )
    ).map((row) => [row.id, row.workspace_id]),
  );
  function owner(
    bucket: string,
    path: string,
  ): { workspaceId: string; companyId: string } {
    const workspaceId = storageObjectOwnerWorkspaceId(bucket, path, articles);
    const objectCompanyId = workspaceId
      ? workspaces.get(workspaceId)
      : undefined;
    if (!workspaceId || !objectCompanyId)
      throw new Error(
        `Unassigned storage object: ${bucket}/${path}; resolve retained ownership before activation`,
      );
    return { workspaceId, companyId: objectCompanyId };
  }

  async function* supabaseObjects(
    bucket: string,
    prefix: string,
  ): AsyncGenerator<InventoryObject> {
    for await (const object of listSupabaseBucketObjects(
      bucket,
      prefix,
      nextPage,
    )) {
      const ownership = owner(bucket, object.path);
      if (ownership.companyId !== companyId) continue;
      yield {
        ...ownership,
        provider: "supabase",
        bucket,
        path: object.path,
        bytes: object.bytes,
      };
    }
  }

  const storage = new Storage();
  const gcsBucket = storage.bucket(getGcsCreativeAssetsBucketName());
  const [bucketMetadata] = await gcsBucket.getMetadata();
  const includeSoftDeleted =
    Number(bucketMetadata.softDeletePolicy?.retentionDurationSeconds) > 0;
  for (const softDeleted of includeSoftDeleted ? [false, true] : [false]) {
    let pageToken: string | undefined;
    do {
      nextPage();
      const [files, next] = await gcsBucket.getFiles({
        prefix: "workspaces/",
        maxResults: 500,
        autoPaginate: false,
        pageToken,
        ...(softDeleted ? { softDeleted: true } : { versions: true }),
      });
      for (const file of files) {
        if (file.name.split("/")[2] !== "creative-assets") continue;
        const ownership = owner(gcsBucket.name, file.name);
        if (ownership.companyId !== companyId) continue;
        const bytes = Number(file.metadata.size);
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error("GCS object size is missing");
        const archived = softDeleted || Boolean(file.metadata.timeDeleted);
        const generation = archived
          ? String(file.metadata.generation || "")
          : undefined;
        if (archived && !generation)
          throw new Error("GCS archived object generation is missing");
        yield {
          ...ownership,
          provider: "gcs",
          bucket: gcsBucket.name,
          path: file.name,
          bytes,
          ...(generation ? { generation } : {}),
        };
      }
      pageToken = next?.pageToken;
    } while (pageToken);
  }
  nextPage();
  const buckets =
    await supabaseJson<Array<{ id: string }>>("/storage/v1/bucket");
  if (!Array.isArray(buckets))
    throw new Error("Invalid storage bucket inventory");
  for (const bucket of buckets) {
    // Identity avatars have no single company owner and use their own bounded writer.
    if (bucket.id === "avatars") continue;
    yield* supabaseObjects(bucket.id, "");
  }
}

export async function runStorageQuotaOperator(
  args: string[],
): Promise<unknown> {
  const option = (name: string) => args[args.indexOf(name) + 1];
  const companyId = args.includes("--company-id") ? option("--company-id") : "";
  if (!/^[a-f0-9-]{36}$/i.test(companyId || ""))
    throw new Error("A company UUID is required with --company-id");
  const apply = args.includes("--apply");
  if (args[0] === "inventory") {
    if (apply && !args.includes("--legacy-writers-quiesced"))
      throw new Error(
        "Applying inventory requires --legacy-writers-quiesced after all legacy upload writers and sessions stop",
      );
    const maxPages = args.includes("--max-pages")
      ? Number(option("--max-pages"))
      : 2000;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100_000)
      throw new Error("--max-pages must be between 1 and 100000");
    const store = apply ? await getStorageQuotaStore() : undefined;
    if (store) await store.ensureIndexes();
    return inventoryCompanyStorage({
      companyId,
      store,
      objects: physicalObjects(companyId, maxPages),
    });
  }
  const store = await getStorageQuotaStore();
  const usage = await store.usage(companyId);
  if (args[0] === "status")
    return {
      usage,
      limitBytes: COMPANY_STORAGE_LIMIT_BYTES,
      rolloutMode: getStorageQuotaRolloutMode(),
    };
  if (args[0] !== "reconcile")
    throw new Error("Use inventory, status, or reconcile");
  const after = args.includes("--after") ? option("--after") : "";
  const pending = await store.pending(companyId, after, 100);
  const results: Array<{ id: string; exists: boolean; bytes?: number }> = [];
  for (const object of pending) {
    let observed: { exists: false } | { exists: true; bytes: number };
    if (object.provider === "gcs") {
      const result = await statGcsCreativeAssetObject({
        bucket: object.bucket,
        path: object.path,
        workspaceId: object.workspaceId,
      });
      if (result.exists && result.fileSize === null)
        throw new Error("Object size is unavailable; reservation retained");
      observed = result.exists
        ? { exists: true, bytes: result.fileSize! }
        : { exists: false };
    } else {
      const config = supabaseConfig();
      const response = await fetch(
        `${config.url}/storage/v1/object/info/${encodeURIComponent(object.bucket)}/${object.path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: config.headers, signal: AbortSignal.timeout(20_000) },
      );
      if (response.status === 404) observed = { exists: false };
      else {
        if (!response.ok)
          throw new Error(
            "Supabase object status is unavailable; reservation retained",
          );
        const metadata = (await response.json()) as { size?: number };
        if (!Number.isSafeInteger(metadata.size) || metadata.size! < 0)
          throw new Error("Supabase object size is unavailable");
        observed = { exists: true, bytes: metadata.size! };
      }
    }
    if (apply) await store.reconcile(object._id, observed);
    results.push({ id: object._id, ...observed });
  }
  return { applied: apply, results, nextAfter: pending.at(-1)?._id || null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadTemporalWorkerEnv();
  runStorageQuotaOperator(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 0;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Storage operator failed",
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      const { default: mongoose } = await import("mongoose");
      await mongoose.disconnect();
    });
}
