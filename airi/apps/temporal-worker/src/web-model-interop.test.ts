import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import mongoose from "mongoose";

process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/icecore-test";

// Regression (2026-10-22): WhatsApp Business app contact sync imported 0 of
// every address book from late June on. Under this ESM runtime a plain
// `import Customer from "@/models/customer"` is the CommonJS module wrapper, so
// each contact threw "findOne is not a function" into a silent catch. The
// processor's own tests inject a mock model and never saw it.

const { readDefaultExport } = await import(
  "@icecore/airi-runtime/module-interop"
);
const { airiWorkerLogger } = await import("@icecore/airi-runtime/logging");
const { processWhatsAppContactSyncWebhook } = await import(
  "./whatsapp-contact-sync/processor.js"
);

test("web models unwrap to Mongoose models in the worker runtime", async () => {
  const modules = {
    customer: await import("@/models/customer"),
    chat: await import("@/models/chat"),
    message: await import("@/models/message"),
    user: await import("@/models/user"),
    whatsappCallSession: await import("@/models/whatsapp-call-session"),
  };

  for (const [name, moduleRecord] of Object.entries(modules)) {
    const model = readDefaultExport<{ findOne?: unknown }>(moduleRecord);
    assert.equal(typeof model.findOne, "function", name);
  }
});

test("contact sync writes through the real Customer model and logs failures once", async () => {
  // No database here: with buffering off the real model fails fast, which
  // proves the call reached Mongoose instead of a module wrapper.
  mongoose.set("bufferCommands", false);
  const logError = mock.method(airiWorkerLogger, "error", () => undefined);
  try {
    const result = await processWhatsAppContactSyncWebhook({
      source: { id: "source-1", workspace_id: "workspace-1", credentials: {} },
      phoneNumberId: "phone-business-1",
      stateSync: [
        {
          type: "contact",
          action: "add",
          contact: {
            full_name: "Ada Lovelace",
            phone_number: "77010000001",
            user_id: "KZ.1000000001",
          },
        },
        {
          type: "contact",
          action: "add",
          contact: { full_name: "Alan Turing", phone_number: "77010000002" },
        },
      ],
      persistCredentials: async () => undefined,
      connect: async () => undefined,
    });

    assert.deepEqual(result, { processedCount: 0, skippedCount: 2 });
    assert.equal(logError.mock.callCount(), 1);
    const [event, error, context] = logError.mock.calls[0].arguments;
    assert.equal(event, "whatsapp.contact_sync.contacts_failed");
    assert.doesNotMatch(String((error as Error)?.message), /is not a function/);
    assert.deepEqual(context, {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      failedCount: 2,
      recordCount: 2,
    });
    assert.doesNotMatch(JSON.stringify(context), /7701000000|Ada|Alan|KZ\./);
  } finally {
    logError.mock.restore();
    mongoose.set("bufferCommands", true);
  }
});

test("worker code never uses a raw default import of a web model", () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  // This file unwraps every default import with getRuntimeModel().
  const unwrapsLocally = new Set(["whatsapp-webhook-runtime-dependencies.ts"]);
  const rawDefaultImport =
    /^import\s+[A-Za-z_$][\w$]*\s+from\s+["']@\/models\//m;

  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const file = relative(srcDir, path).replace(/\\/g, "/");
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (unwrapsLocally.has(file)) continue;
      if (rawDefaultImport.test(readFileSync(path, "utf8")))
        offenders.push(file);
    }
  };
  visit(srcDir);

  assert.deepEqual(
    offenders,
    [],
    'use `import * as XModule from "@/models/x"` with readDefaultExport()',
  );
});
