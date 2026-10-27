import { CheckCheck } from "lucide-react";
import s from "./landing-workflow-studio.module.css";

// Short words (Russian prepositions, Kazakh "жол") stay with the next word.
const SHORT_WORD = /(^|\s)(\p{L}{1,3})\s+/gu;

/**
 * A heading accent set as a sent message: the read ticks never wrap away
 * from the last word, and the bubble can shrink to its longest line.
 */
export function SentAccent({ text }: { text: string }) {
  const words = text.replace(SHORT_WORD, "$1$2\u00a0").split(" ");
  const last = words.pop();
  return (
    <>
      {words.length > 0 ? `${words.join(" ")} ` : null}
      <span className={s.accentTail}>
        {last}
        <CheckCheck className={s.readTicks} aria-hidden />
      </span>
    </>
  );
}
