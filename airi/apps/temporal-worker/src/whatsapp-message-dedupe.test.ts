import assert from "node:assert/strict";
import test from "node:test";

function createMessageModel() {
  return {
    findOne() {
      return {
        select() {
          return {
            async lean() {
              return null;
            },
          };
        },
      };
    },
  };
}

async function loadDedupeModule() {
  process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/icecore-test";
  return await import("./whatsapp-message-dedupe.js");
}

test("resolves the named TypeScript namespace nested in the runtime default", async () => {
  const { resolveWhatsAppDedupeMessageModel } = await loadDedupeModule();
  const model = createMessageModel();
  const compiledNamespace = Object.defineProperty(
    {
      MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS: {},
      default: model,
    },
    "__esModule",
    { value: true },
  );
  const runtimeModule = {
    default: compiledNamespace,
    "module.exports": compiledNamespace,
  };

  assert.equal(resolveWhatsAppDedupeMessageModel(runtimeModule), model);
});

test("resolves direct and default Message model exports", async () => {
  const { resolveWhatsAppDedupeMessageModel } = await loadDedupeModule();
  const model = createMessageModel();

  assert.equal(resolveWhatsAppDedupeMessageModel(model), model);
  assert.equal(resolveWhatsAppDedupeMessageModel({ default: model }), model);
});

test("rejects invalid Message model module shapes", async () => {
  const { resolveWhatsAppDedupeMessageModel } = await loadDedupeModule();
  assert.throws(
    () => resolveWhatsAppDedupeMessageModel({ default: {} }),
    /Message model export not found/,
  );
});
