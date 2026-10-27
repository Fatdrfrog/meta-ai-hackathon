import {
  SCENARIO_PROMPT_INPUT_KEY_PATTERN,
  transliterateScenarioKeyText,
} from "@icecore/scenario-contracts";

/** The longest name the prompt-input key pattern allows. */
const MAX_KEY_LENGTH = 32;

/**
 * A variable name suggested from "What to collect": Latin letters, digits and
 * underscores, starting with a letter, unique among `takenKeys`. Returns an
 * empty string when the text has nothing usable.
 */
export function suggestPromptInputKey(
  text: string,
  takenKeys: ReadonlySet<string>
): string {
  const latin = transliterateScenarioKeyText(text);
  const base = latin
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/, "");
  if (!SCENARIO_PROMPT_INPUT_KEY_PATTERN.test(base)) return "";
  if (!takenKeys.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = "_" + suffix;
    const candidate =
      base.slice(0, MAX_KEY_LENGTH - tail.length).replace(/_+$/, "") + tail;
    if (!takenKeys.has(candidate)) return candidate;
  }
}
