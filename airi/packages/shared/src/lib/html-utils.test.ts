import assert from "node:assert/strict";
import test from "node:test";

import { decodeHtmlEntities, escapeHtml } from "./html-utils";

test("escapeHtml escapes &, <, > and double quotes but not apostrophes", () => {
  assert.equal(
    escapeHtml(`<a href="x?a=1&b=2">Tom's</a>`),
    "&lt;a href=&quot;x?a=1&amp;b=2&quot;&gt;Tom's&lt;/a&gt;",
  );
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml(""), "");
  assert.equal(
    decodeHtmlEntities(escapeHtml(`<b>"x" & y</b>`)),
    `<b>"x" & y</b>`,
  );
});
