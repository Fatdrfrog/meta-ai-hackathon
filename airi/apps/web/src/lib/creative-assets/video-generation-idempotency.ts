export type VideoGenerationIdempotencyKeys = Map<string, string>;

function operationKey(endpoint: string, serializedBody: string): string {
  return `${endpoint}\n${serializedBody}`;
}

export function getOrCreateVideoGenerationIdempotencyKey(
  keys: VideoGenerationIdempotencyKeys,
  endpoint: string,
  serializedBody: string,
  createKey: () => string = () => crypto.randomUUID()
): string {
  const key = operationKey(endpoint, serializedBody);
  const existing = keys.get(key);
  if (existing) return existing;

  const created = createKey();
  keys.set(key, created);
  return created;
}

export function retireVideoGenerationIdempotencyKey(
  keys: VideoGenerationIdempotencyKeys,
  endpoint: string,
  serializedBody: string
): void {
  keys.delete(operationKey(endpoint, serializedBody));
}
