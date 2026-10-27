type AiriChatMessageMetadata = Record<string, unknown> | null | undefined;

/**
 * Each message's metadata is parsed once per field, however often its row and
 * cards render: a message's metadata object never changes after it arrives
 * (an update replaces the message), so the parse is cached on that object.
 */
const parsedMetadataFields = new WeakMap<object, Map<string, unknown>>();

export function readAiriChatMessageMetadata<T>(
  metadata: AiriChatMessageMetadata,
  field: string,
  parse: (metadata: AiriChatMessageMetadata) => T
): T {
  if (!metadata) return parse(metadata);
  let fields = parsedMetadataFields.get(metadata);
  if (!fields) {
    fields = new Map();
    parsedMetadataFields.set(metadata, fields);
  }
  if (fields.has(field)) return fields.get(field) as T;
  const value = parse(metadata);
  fields.set(field, value);
  return value;
}

/** The run was stopped (Stop): the message keeps what was written so far. */
export function isAiriChatMessageStopped(
  metadata: AiriChatMessageMetadata
): boolean {
  return metadata?.cancelled === true;
}
