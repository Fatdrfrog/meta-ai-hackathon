import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "@google-cloud/storage";
import { physicalObjects } from "./storage-quota-operator";
import { inventoryCompanyStorage } from "./storage-quota-operator";

const item = {
  companyId: "company",
  workspaceId: "workspace",
  provider: "gcs" as const,
  bucket: "bucket",
  path: "orphan",
  bytes: 7,
};

test("dry-run physical inventory counts objects without writing accounting", async () => {
  async function* objects() {
    yield item;
    yield { ...item, path: "second", bytes: 3 };
  }
  assert.deepEqual(
    await inventoryCompanyStorage({ companyId: "company", objects: objects() }),
    { objects: 2, bytes: 10, applied: false },
  );
});

test("an incomplete physical scan cannot activate company admission", async () => {
  const calls: string[] = [];
  async function* objects() {
    yield item;
    throw new Error("page budget reached");
  }
  await assert.rejects(
    inventoryCompanyStorage({
      companyId: "company",
      objects: objects(),
      store: {
        beginInventory: async () => {
          calls.push("begin");
        },
        inventoryObject: async () => {
          calls.push("object");
        },
        finishInventory: async () => {
          calls.push("activate");
        },
      },
    }),
    /page budget/,
  );
  assert.deepEqual(calls, ["begin", "object"]);
});

test("activation follows the final physical inventory write", async () => {
  const calls: string[] = [];
  async function* objects() {
    yield item;
  }
  await inventoryCompanyStorage({
    companyId: "company",
    objects: objects(),
    store: {
      beginInventory: async () => {
        calls.push("begin");
      },
      inventoryObject: async () => {
        calls.push("object");
      },
      finishInventory: async () => {
        calls.push("activate");
      },
    },
  });
  assert.deepEqual(calls, ["begin", "object", "activate"]);
});

test("physical inventory includes legacy buckets, unreferenced files and retained GCS versions", async (t) => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "isolated-test-key";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
  const files = [
    ["conversation-images", "web_widget/workspace/unreferenced.png", 3],
    ["scenario-assets", "scenarios/workspace/legacy.pdf", 4],
    ["conversation-images", "outbound/whatsapp/workspace/legacy.jpg", 5],
    ["conversation-attachments", "scenarios/workspace/legacy.pdf", 6],
    ["kb-attachments", "kb/article/figure.png", 7],
    ["email-attachments", "workspace/email.png", 8],
    ["conversation-images", "whatsapp/another-workspace/other.jpg", 99],
    ["avatars", "unknown-global-user/profile", 999],
  ] as const;
  let unassignedPath: string | null = null;
  let deletedGcsOwner = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rest/v1/workspaces?"))
        return Response.json([
          { id: "workspace", company_id: "company" },
          { id: "another-workspace", company_id: "another-company" },
        ]);
      if (url.includes("/rest/v1/kb_articles?"))
        return Response.json([{ id: "article", workspace_id: "workspace" }]);
      if (url.endsWith("/storage/v1/bucket"))
        return Response.json(
          [...new Set(files.map((file) => file[0]))].map((id) => ({ id })),
        );
      assert.match(url, /\/storage\/v1\/object\/list\//);
      const bucket = decodeURIComponent(url.split("/").at(-1)!);
      const { prefix, limit } = JSON.parse(String(options?.body));
      assert.equal(limit, 500);
      const entries = new Map<string, unknown>();
      const paths: ReadonlyArray<readonly [string, string, number]> =
        unassignedPath
          ? [...files, ["conversation-images", unassignedPath, 9]]
          : files;
      for (const [fileBucket, path, bytes] of paths) {
        const base = prefix ? `${prefix}/` : "";
        if (fileBucket !== bucket || !path.startsWith(base)) continue;
        const rest = path.slice(base.length);
        const name = rest.split("/")[0]!;
        entries.set(
          name,
          rest.includes("/")
            ? { id: null, name }
            : { id: path, name, metadata: { size: bytes } },
        );
      }
      return Response.json([...entries.values()]);
    },
  );
  t.mock.method(Storage.prototype, "bucket", () => ({
    name: "bucket",
    getMetadata: async () => [
      { softDeletePolicy: { retentionDurationSeconds: "604800" } },
    ],
    getFiles: async (options: {
      softDeleted?: boolean;
      maxResults: number;
      autoPaginate: boolean;
    }) => {
      assert.equal(options.maxResults, 500);
      assert.equal(options.autoPaginate, false);
      if (deletedGcsOwner)
        return [
          [
            {
              name: "workspaces/deleted-workspace/creative-assets/lost",
              metadata: { size: "8", generation: "9" },
            },
          ],
          null,
        ];
      return [
        options.softDeleted
          ? [
              {
                name: "workspaces/workspace/creative-assets/soft",
                metadata: { size: "7", generation: "3" },
              },
            ]
          : [
              {
                name: "workspaces/workspace/creative-assets/live",
                metadata: { size: "5", generation: "2" },
              },
              {
                name: "workspaces/workspace/creative-assets/live",
                metadata: {
                  size: "2",
                  generation: "1",
                  timeDeleted: "2026-10-10T00:00:00Z",
                },
              },
            ],
        null,
      ];
    },
  }));
  const objects = [];
  for await (const object of physicalObjects("company", 100))
    objects.push(object);
  assert.equal(
    objects.reduce((sum, object) => sum + object.bytes, 0),
    47,
  );
  assert.deepEqual(
    objects
      .filter((object) => object.provider === "gcs")
      .map((object) => object.generation),
    [undefined, "1", "3"],
  );
  for (const [bucket, path] of files.filter((file) => file[2] < 99))
    assert.ok(
      objects.some(
        (object) => object.bucket === bucket && object.path === path,
      ),
      path,
    );
  for (const path of [
    "telegram/deleted-workspace/media.jpg",
    "kb/deleted-article/figure.jpg",
    "-4937344260/legacy.jpg",
  ]) {
    unassignedPath = path;
    let activated = false;
    await assert.rejects(
      inventoryCompanyStorage({
        companyId: "company",
        objects: physicalObjects("company", 100),
        store: {
          beginInventory: async () => {},
          inventoryObject: async () => {},
          finishInventory: async () => {
            activated = true;
          },
        },
      }),
      /unassigned storage object/i,
    );
    assert.equal(activated, false);
  }
  unassignedPath = null;
  deletedGcsOwner = true;
  await assert.rejects(async () => {
    for await (const _object of physicalObjects("company", 100)) {
    }
  }, /unassigned.*deleted-workspace/i);
  deletedGcsOwner = false;
  await assert.rejects(async () => {
    for await (const _object of physicalObjects("company", 1)) {
    }
  }, /page budget/);
});
