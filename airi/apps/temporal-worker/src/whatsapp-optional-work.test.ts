import test from "node:test";
import assert from "node:assert/strict";
import {
  scheduleWhatsAppOptionalWork,
  startWhatsAppOptionalWork,
} from "./whatsapp-optional-work.js";
test("bounded optional acceleration rejects overload and closes with worker lifecycle", async () => {
  assert.equal(
    scheduleWhatsAppOptionalWork(async () => undefined),
    false,
  );
  const controller = new AbortController();
  const stop = await startWhatsAppOptionalWork(controller.signal);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  for (let i = 0; i < 256; i++)
    assert.equal(
      scheduleWhatsAppOptionalWork(async () => {
        started++;
        await blocked;
      }),
      true,
    );
  assert.equal(
    scheduleWhatsAppOptionalWork(async () => undefined),
    false,
  );
  await Promise.resolve();
  assert.equal(started, 8);
  controller.abort();
  assert.equal(
    scheduleWhatsAppOptionalWork(async () => undefined),
    false,
  );
  release();
  await stop();
  assert.equal(started, 256);
});
