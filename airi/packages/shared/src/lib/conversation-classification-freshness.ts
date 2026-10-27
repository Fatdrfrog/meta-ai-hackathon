import { isRecord, isPlainRecord } from "./value-utils";

export const CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION = 2 as const;
export const CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS = [
  "v2",
  "legacy_unknown",
] as const;
export type ConversationClassificationProvenanceKind =
  (typeof CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS)[number];

export const CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS: readonly string[] =
  Object.freeze([
    "is_classified",
    "classification_revision",
    "classification_state.contractVersion",
    "classification_state.status",
    "classification_state.requestedRevision",
    "classification_state.appliedRevision",
    "classification_meta.source_revision",
    "classification_meta.provenance_kind",
    "classification_meta.analysis_revision_id",
  ]);

export const CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT =
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS.join(" ");

export const CONVERSATION_CLASSIFICATION_FRESHNESS_PROJECTION: Readonly<
  Record<string, 1>
> = Object.freeze(
  Object.fromEntries(
    CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS.map((path) => [path, 1]),
  ) as Record<string, 1>,
);

const NATIVE_V2_PROVENANCE_KIND =
  CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS[0];

const HYDRATED_TO_OBJECT_OPTIONS = Object.freeze({
  depopulate: true,
  flattenMaps: true,
  versionKey: false,
});

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function findDocumentToObject(value: Record<string, unknown>): unknown {
  let owner: object | null = value;
  while (owner && owner !== Object.prototype) {
    if (Object.getOwnPropertyDescriptor(owner, "toObject")) {
      return Reflect.get(value, "toObject") as unknown;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

function asConversationRoot(value: unknown): Record<string, unknown> | null {
  try {
    if (!isRecord(value)) return null;
    if (isPlainRecord(value)) return value;

    const toObject = findDocumentToObject(value);
    if (typeof toObject !== "function") return null;

    const converted = Reflect.apply(toObject, value, [
      HYDRATED_TO_OBJECT_OPTIONS,
    ]) as unknown;
    return isPlainRecord(converted) ? converted : null;
  } catch {
    return null;
  }
}

function hasCurrentClassificationRoot(
  conversation: Record<string, unknown>,
): boolean {
  try {
    const stateValue = ownValue(conversation, "classification_state");
    const metaValue = ownValue(conversation, "classification_meta");
    if (!isRecord(stateValue) || !isRecord(metaValue)) return false;

    const revision = ownValue(conversation, "classification_revision");
    const analysisRevisionId = ownValue(metaValue, "analysis_revision_id");
    return (
      ownValue(conversation, "is_classified") === true &&
      ownValue(stateValue, "contractVersion") ===
        CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION &&
      ownValue(stateValue, "status") === "ready" &&
      Number.isSafeInteger(revision) &&
      (revision as number) > 0 &&
      ownValue(stateValue, "requestedRevision") === revision &&
      ownValue(stateValue, "appliedRevision") === revision &&
      ownValue(metaValue, "source_revision") === revision &&
      ownValue(metaValue, "provenance_kind") === NATIVE_V2_PROVENANCE_KIND &&
      typeof analysisRevisionId === "string" &&
      analysisRevisionId.trim().length > 0
    );
  } catch {
    return false;
  }
}

export function buildCurrentConversationClassificationFilter(): Record<
  string,
  unknown
> {
  return {
    is_classified: true,
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.status": "ready",
    "classification_meta.provenance_kind": NATIVE_V2_PROVENANCE_KIND,
    "classification_meta.analysis_revision_id": {
      $type: "string",
      $regex: /\S/u,
    },
    $expr: {
      $and: [
        { $isNumber: "$classification_revision" },
        { $gt: ["$classification_revision", 0] },
        { $lte: ["$classification_revision", Number.MAX_SAFE_INTEGER] },
        {
          $eq: [
            { $trunc: "$classification_revision" },
            "$classification_revision",
          ],
        },
        {
          $eq: [
            "$classification_revision",
            "$classification_state.requestedRevision",
          ],
        },
        {
          $eq: [
            "$classification_revision",
            "$classification_state.appliedRevision",
          ],
        },
        {
          $eq: [
            "$classification_revision",
            "$classification_meta.source_revision",
          ],
        },
      ],
    },
  };
}

export function hasCurrentConversationClassification(value: unknown): boolean {
  const conversation = asConversationRoot(value);
  return conversation !== null && hasCurrentClassificationRoot(conversation);
}

export function getCurrentConversationClassification<T>(
  value: unknown,
): T | undefined {
  const conversation = asConversationRoot(value);
  if (!conversation || !hasCurrentClassificationRoot(conversation)) {
    return undefined;
  }

  try {
    const classification = ownValue(conversation, "classification");
    return isPlainRecord(classification) ? (classification as T) : undefined;
  } catch {
    return undefined;
  }
}
