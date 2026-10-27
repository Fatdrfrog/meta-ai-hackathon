import {
  loadConversationsClientMessages,
  loadScenariosClientMessages,
} from "./message-loader";
import { SCENARIO_BEHAVIOR_PRESETS } from "@icecore/scenario-contracts";
import { readFileSync } from "node:fs";
import path from "node:path";
test.each(["en", "ru", "kz"] as const)(
  "loads behavior editor and event-dialog copy for %s",
  async locale => {
    const scenarios = await loadScenariosClientMessages(locale);
    const conversations = await loadConversationsClientMessages(locale);
    const namespace = scenarios.CustomerBehavior as {
      presets: Record<string, string>;
      presetDescriptions: Record<string, string>;
      reasons: Record<string, string>;
      recordEvent: string;
    };
    expect(conversations.CustomerBehavior).toEqual(namespace);
    for (const preset of SCENARIO_BEHAVIOR_PRESETS)
      expect(namespace.presets[preset]).toEqual(expect.any(String));
    expect(namespace.presetDescriptions.abandoned_cart).toBeTruthy();
    expect(namespace.presetDescriptions.abandoned_checkout).toBeTruthy();
    expect(namespace.presetDescriptions.abandoned_cart).not.toBe(
      namespace.presetDescriptions.abandoned_checkout
    );
    expect(namespace.reasons.converted).toBeTruthy();
    expect(namespace.recordEvent).toBeTruthy();
  }
);

test("abandoned cart starts with a 60 minute inactivity delay", () => {
  const editor = readFileSync(
    path.join(
      process.cwd(),
      "src/components/scenarios/nodes/trigger-node/behavior-trigger-editor.tsx"
    ),
    "utf8"
  );
  expect(editor).toMatch(/abandoned_cart:\s*60/);
  expect(editor).toMatch(/\? 30 \* 1440\s*:\s*730 \* 1440/);
});
