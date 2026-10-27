import assert from "node:assert/strict";
import test from "node:test";

import { readDefaultExport, readRuntimeExport } from "./module-interop.js";

function createCompiledNamespace(defaultExport: unknown) {
  return Object.defineProperty(
    {
      NAMED_EXPORT: "kept",
      default: defaultExport,
    },
    "__esModule",
    { value: true },
  );
}

test("unwraps a transpiled namespace with named and default exports", () => {
  const model = { findOne() {} };
  const compiledNamespace = createCompiledNamespace(model);
  const runtimeModule = {
    default: compiledNamespace,
    "module.exports": compiledNamespace,
  };

  assert.equal(readDefaultExport(runtimeModule), model);
  assert.equal(readRuntimeExport(runtimeModule, "default"), model);
});

test("does not unwrap an ordinary named object without an interop marker", () => {
  const ordinaryObject = {
    NAMED_EXPORT: "kept",
    default: { findOne() {} },
  };
  const runtimeModule = {
    default: ordinaryObject,
    "module.exports": ordinaryObject,
  };

  assert.equal(readDefaultExport(runtimeModule), ordinaryObject);
  assert.equal(readRuntimeExport(runtimeModule, "default"), ordinaryObject);
});
