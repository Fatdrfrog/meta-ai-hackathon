import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("cart recovery requires explicit consent and a user-opened WhatsApp handoff", () => {
  const panel = readSource("../src/components/WidgetCartRecovery.tsx");
  assert.match(panel, /useState\(false\)/, "consent starts unchecked");
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /disabled=!consented|disabled=\{!consented/);
  assert.match(panel, /commerce\.createHandoff\(\s*cart\.cartId/);
  assert.match(panel, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(panel, /rel="noopener noreferrer"/);
  assert.match(panel, /handoffUrl \? \(/);
  assert.doesNotMatch(panel, /popupBlocked/);
  assert.match(
    panel,
    /receive cart reminders and other offers from this business on WhatsApp/,
  );
  assert.equal(/type="tel"|phone(number)?/i.test(panel), false);
});

test("cart recovery renders only active nonempty carts and provides recovery states", () => {
  const panel = readSource("../src/components/WidgetCartRecovery.tsx");
  const shell = readSource("../src/components/WidgetShell.tsx");
  assert.match(panel, /cart\.status === "checkout" && cart\.itemCount > 0/);
  assert.match(panel, /cart\.status === "cart" && cart\.itemCount > 0/);
  assert.match(panel, /cart\.itemCount > 0 && !cart\.linked/);
  assert.match(panel, /snapshot\.enabled !== true/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /copy\.retry/);
  assert.match(panel, /setDismissedCartId\(cart\.cartId\)/);
  assert.match(shell, /!isOpen && commerce/);
  assert.match(shell, /<WidgetCartRecovery/);
});
