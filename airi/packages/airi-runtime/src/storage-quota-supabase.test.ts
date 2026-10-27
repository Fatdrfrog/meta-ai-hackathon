import assert from "node:assert/strict";
import test from "node:test";
import {
  createReservedSupabaseUpload,
  storeSupabaseWorkspaceBuffer,
} from "./storage-quota";

test("Supabase direct grants reserve the provider ceiling and disable overwrite", async () => {
  const actions: unknown[] = [];
  const result = await createReservedSupabaseUpload({
    workspaceId: "workspace",
    bucket: "bucket",
    path: "path",
    declaredBytes: 4,
    storage: {
      getBucket: async () => ({ data: { file_size_limit: 100 }, error: null }),
      from: () => ({
        createSignedUploadUrl: async (_path, options) => {
          actions.push(options);
          return { data: { token: "token" }, error: null };
        },
      }),
    },
    quota: {
      reserve: async (input) => {
        actions.push(input.bytes);
        return { _id: "reserved" };
      },
      settle: async () => {},
    },
  });
  assert.equal(result.token, "token");
  assert.deepEqual(actions, [100, { upsert: false }]);
});

test("an unbounded Supabase bucket cannot grant direct uploads", async () => {
  let called = false;
  await assert.rejects(
    createReservedSupabaseUpload({
      workspaceId: "workspace",
      bucket: "bucket",
      path: "path",
      declaredBytes: 4,
      storage: {
        getBucket: async () => ({
          data: { file_size_limit: null },
          error: null,
        }),
        from: () => ({
          createSignedUploadUrl: async () => {
            called = true;
            return { data: { token: "token" } };
          },
        }),
      },
    }),
    /finite.*limit/i,
  );
  assert.equal(called, false);
});

test("Supabase buffer uploads reserve before writing and recover a lost response", async () => {
  const actions: unknown[] = [];
  await storeSupabaseWorkspaceBuffer({
    workspaceId: "workspace",
    bucket: "bucket",
    path: "path",
    buffer: Buffer.from("test"),
    mimeType: "image/png",
    storage: {
      from: () => ({
        upload: async (_path, buffer, options) => {
          actions.push([buffer.byteLength, options.upsert]);
          return { error: { message: "response lost" } };
        },
        info: async () => ({ data: { size: 4 }, error: null }),
      }),
    },
    quota: {
      reserve: async (input) => {
        actions.push(input.bytes);
        return { _id: "reserved" };
      },
      settle: async (_id, bytes) => {
        actions.push(bytes);
      },
    },
  });
  assert.deepEqual(actions, [4, [4, false], 4]);
});

test("deleted identities cannot reach either Supabase write boundary", async () => {
  let calls = 0;
  const quota = {
    reserve: async () => ({ _id: "deleted", status: "tombstoned" as const }),
    settle: async () => {},
  };
  await assert.rejects(
    storeSupabaseWorkspaceBuffer({
      workspaceId: "workspace",
      bucket: "bucket",
      path: "path",
      buffer: Buffer.from("test"),
      mimeType: "image/png",
      quota,
      storage: {
        from: () => ({
          upload: async () => {
            calls++;
            return {};
          },
        }),
      },
    }),
    /deleted/,
  );
  await assert.rejects(
    createReservedSupabaseUpload({
      workspaceId: "workspace",
      bucket: "bucket",
      path: "path",
      declaredBytes: 4,
      quota,
      storage: {
        getBucket: async () => ({ data: { file_size_limit: 100 } }),
        from: () => ({
          createSignedUploadUrl: async () => {
            calls++;
            return { data: { token: "token" } };
          },
        }),
      },
    }),
    /deleted/,
  );
  assert.equal(calls, 0);
});
