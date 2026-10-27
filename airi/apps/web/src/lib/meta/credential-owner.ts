export type MetaCredentialOwner = "configured_app" | "source_token";

type MetaCredentialAttributedError = {
  metaCredentialOwner: MetaCredentialOwner;
};

export function getMetaCredentialOwner(
  error: unknown
): MetaCredentialOwner | null {
  if (typeof error !== "object" || error === null) return null;
  const owner = (error as Partial<MetaCredentialAttributedError>)
    .metaCredentialOwner;
  return owner === "configured_app" || owner === "source_token" ? owner : null;
}

function copyMetaErrorMetadata(target: Error, error: unknown): void {
  if (typeof error !== "object" || error === null) return;

  for (const key of [
    "status",
    "statusText",
    "url",
    "details",
    "metaError",
    "formattedError",
    "success",
  ] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (value !== undefined) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
      });
    }
  }
}

export function attributeMetaCredentialOwner(
  error: unknown,
  owner: MetaCredentialOwner
): unknown {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, "metaCredentialOwner", {
        configurable: true,
        enumerable: true,
        value: owner,
      });
      return error;
    } catch {
      // Fall through to a metadata-preserving wrapper for frozen errors.
    }
  }

  const wrapped = new Error(error instanceof Error ? error.message : String(error));
  Object.defineProperty(wrapped, "cause", {
    configurable: true,
    enumerable: false,
    value: error,
  });
  Object.defineProperty(wrapped, "metaCredentialOwner", {
    configurable: true,
    enumerable: true,
    value: owner,
  });
  copyMetaErrorMetadata(wrapped, error);
  return wrapped;
}
