import "server-only";

import airiDemo186 from "./delivery-bindings-186.json";

/** Select reviewed, bundled data only; never resolve a visitor or environment path. */
export function selectPublicTemplateManifest(selector: string): unknown {
  return selector === "airi-demo-186-v1" ? airiDemo186 : null;
}
