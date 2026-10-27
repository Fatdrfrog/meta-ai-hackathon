export function parseMessageTextPhrases(value: string | null | undefined) {
  const seen = new Set<string>();
  const phrases: string[] = [];

  for (const rawPhrase of String(value || "").split(/[,;|\n]+/)) {
    const phrase = rawPhrase.trim();
    if (!phrase) continue;

    const key = phrase.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }

  return phrases;
}

export function formatMessageTextPhrases(phrases: readonly string[]) {
  return parseMessageTextPhrases(phrases.join(", ")).join(", ");
}

export function addMessageTextPhrases(
  currentPhrases: readonly string[],
  input: string | null | undefined
) {
  return parseMessageTextPhrases(
    [...currentPhrases, ...parseMessageTextPhrases(input)].join(", ")
  );
}

export function removeMessageTextPhrase(
  currentPhrases: readonly string[],
  phraseToRemove: string
) {
  const removeKey = phraseToRemove.trim().toLocaleLowerCase();
  return currentPhrases.filter(
    phrase => phrase.trim().toLocaleLowerCase() !== removeKey
  );
}
