import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_PROJECTION,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  getCurrentConversationClassification,
  hasCurrentConversationClassification,
} from "./conversation-classification-freshness";

const EXACT_FRESHNESS_PATHS = [
  "is_classified",
  "classification_revision",
  "classification_state.contractVersion",
  "classification_state.status",
  "classification_state.requestedRevision",
  "classification_state.appliedRevision",
  "classification_meta.source_revision",
  "classification_meta.provenance_kind",
  "classification_meta.analysis_revision_id",
] as const;

function currentReadyConversation() {
  return {
    is_classified: true,
    classification_revision: 7,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 7,
      appliedRevision: 7,
    },
    classification_meta: {
      source_revision: 7,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-revision-7",
    },
    classification: {
      category: "Support",
      priority: "high",
    },
  };
}

test("buildCurrentConversationClassificationFilter returns a fresh exact predicate", () => {
  const first = buildCurrentConversationClassificationFilter();
  const second = buildCurrentConversationClassificationFilter();
  const expected = {
    is_classified: true,
    "classification_state.contractVersion": 2,
    "classification_state.status": "ready",
    "classification_meta.provenance_kind": "v2",
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

  assert.notStrictEqual(first, second);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);

  delete (first as { is_classified?: boolean }).is_classified;
  assert.deepEqual(second, expected);
});

test("canonical freshness select surfaces derive from the exact frozen path list", () => {
  assert.deepEqual(CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS, [
    ...EXACT_FRESHNESS_PATHS,
  ]);
  assert.equal(
    new Set(CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS).size,
    EXACT_FRESHNESS_PATHS.length,
  );
  assert.equal(
    (
      CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS as readonly string[]
    ).includes("classification"),
    false,
  );
  assert.equal(
    CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
    EXACT_FRESHNESS_PATHS.join(" "),
  );
  assert.deepEqual(
    CONVERSATION_CLASSIFICATION_FRESHNESS_PROJECTION,
    Object.fromEntries(EXACT_FRESHNESS_PATHS.map((path) => [path, 1])),
  );
  assert.equal(
    Object.isFrozen(CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS),
    true,
  );
  assert.equal(
    Object.isFrozen(CONVERSATION_CLASSIFICATION_FRESHNESS_PROJECTION),
    true,
  );
});

test("hasCurrentConversationClassification accepts an exact lean root", () => {
  assert.equal(
    hasCurrentConversationClassification(currentReadyConversation()),
    true,
  );
});

test("plain lean roots ignore polluted inherited toObject", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "toObject",
  );
  let calls = 0;
  Object.defineProperty(Object.prototype, "toObject", {
    configurable: true,
    value() {
      calls += 1;
      throw new Error("polluted prototype must not run");
    },
  });

  try {
    const value = currentReadyConversation();
    assert.equal(hasCurrentConversationClassification(value), true);
    assert.strictEqual(
      getCurrentConversationClassification(value),
      value.classification,
    );
    assert.equal(calls, 0);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Object.prototype, "toObject", originalDescriptor);
    } else {
      delete (Object.prototype as { toObject?: unknown }).toObject;
    }
  }
});

test("non-plain roots without a callable toObject fail closed", () => {
  class ConversationRecord {}

  const current = currentReadyConversation();
  const customPrototypeRoot = Object.assign(
    Object.create({ custom: true }) as Record<string, unknown>,
    current,
  );
  const classRoot = Object.assign(new ConversationRecord(), current);

  for (const value of [customPrototypeRoot, classRoot]) {
    assert.equal(hasCurrentConversationClassification(value), false);
    assert.equal(getCurrentConversationClassification(value), undefined);
  }
});

test("hydrated conversion fails closed when toObject returns a non-plain root", () => {
  const converted = Object.assign(
    Object.create({ custom: true }) as Record<string, unknown>,
    currentReadyConversation(),
  );
  let calls = 0;
  const hydrated = Object.create({
    toObject() {
      calls += 1;
      return converted;
    },
  }) as unknown;

  assert.equal(hasCurrentConversationClassification(hydrated), false);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(getCurrentConversationClassification(hydrated), undefined);
  assert.equal(calls, 1);
});

test("hydrated roots use an inherited toObject once with safe conversion options", () => {
  const lean = currentReadyConversation();
  const calls: unknown[] = [];
  const prototype = {
    toObject(options: unknown) {
      calls.push(options);
      return lean;
    },
  };
  const hydrated = Object.create(prototype) as unknown;

  assert.equal(hasCurrentConversationClassification(hydrated), true);
  assert.deepEqual(calls, [
    {
      depopulate: true,
      flattenMaps: true,
      versionKey: false,
    },
  ]);
});

test("getCurrentConversationClassification converts a document at most once", () => {
  const lean = currentReadyConversation();
  let callCount = 0;
  const hydrated = Object.create({
    toObject() {
      callCount += 1;
      return lean;
    },
  }) as unknown;

  assert.strictEqual(
    getCurrentConversationClassification(hydrated),
    lean.classification,
  );
  assert.equal(callCount, 1);
});

test("getCurrentConversationClassification returns only an own record classification", () => {
  const current = currentReadyConversation();
  assert.strictEqual(
    getCurrentConversationClassification(current),
    current.classification,
  );

  for (const classification of [undefined, null, [], "Support", 7]) {
    assert.equal(
      getCurrentConversationClassification({ ...current, classification }),
      undefined,
    );
  }

  const inheritedClassification = Object.create({
    classification: current.classification,
  }) as Record<string, unknown>;
  Object.assign(inheritedClassification, current);
  delete inheritedClassification.classification;
  assert.equal(
    getCurrentConversationClassification(inheritedClassification),
    undefined,
  );
});

test("getCurrentConversationClassification rejects non-plain classification records", () => {
  class ClassificationRecord {
    category = "Support";
  }

  const current = currentReadyConversation();
  const customPrototype = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    { category: "Support" },
  );
  const throwingPrototypeProxy = new Proxy(
    { category: "Support" },
    {
      getPrototypeOf() {
        throw new Error("do not leak");
      },
    },
  );

  for (const classification of [
    new Date("2026-08-10T10:00:00.000Z"),
    new ClassificationRecord(),
    customPrototype,
    throwingPrototypeProxy,
  ]) {
    assert.doesNotThrow(() =>
      getCurrentConversationClassification({ ...current, classification }),
    );
    assert.equal(
      getCurrentConversationClassification({ ...current, classification }),
      undefined,
    );
  }
});

test("getCurrentConversationClassification accepts a null-prototype plain record", () => {
  const current = currentReadyConversation();
  const classification = Object.assign(Object.create(null) as object, {
    category: "Support",
  });

  assert.strictEqual(
    getCurrentConversationClassification({ ...current, classification }),
    classification,
  );
});

const freshnessMismatches: readonly [
  string,
  (value: ReturnType<typeof currentReadyConversation>) => void,
][] = [
  ["false classified flag", (value) => void (value.is_classified = false)],
  [
    "wrong contract version",
    (value) => void (value.classification_state.contractVersion = 1),
  ],
  [
    "non-ready status",
    (value) => void (value.classification_state.status = "pending"),
  ],
  ["zero revision", (value) => void (value.classification_revision = 0)],
  [
    "fractional revision",
    (value) => {
      value.classification_revision = 7.5;
      value.classification_state.requestedRevision = 7.5;
      value.classification_state.appliedRevision = 7.5;
      value.classification_meta.source_revision = 7.5;
    },
  ],
  [
    "unsafe revision",
    (value) => {
      value.classification_revision = Number.MAX_SAFE_INTEGER + 1;
      value.classification_state.requestedRevision =
        Number.MAX_SAFE_INTEGER + 1;
      value.classification_state.appliedRevision = Number.MAX_SAFE_INTEGER + 1;
      value.classification_meta.source_revision = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "requested revision mismatch",
    (value) => void (value.classification_state.requestedRevision = 8),
  ],
  [
    "applied revision mismatch",
    (value) => void (value.classification_state.appliedRevision = 6),
  ],
  [
    "source revision mismatch",
    (value) => void (value.classification_meta.source_revision = 6),
  ],
  [
    "legacy provenance",
    (value) =>
      void (value.classification_meta.provenance_kind = "legacy_unknown"),
  ],
  [
    "blank analysis revision id",
    (value) => void (value.classification_meta.analysis_revision_id = " \t "),
  ],
];

for (const [name, mutate] of freshnessMismatches) {
  test(`freshness rejects ${name}`, () => {
    const value = currentReadyConversation();
    mutate(value);
    assert.equal(hasCurrentConversationClassification(value), false);
    assert.equal(getCurrentConversationClassification(value), undefined);
  });
}

test("freshness rejects every partial projection", () => {
  const deletePath = (value: Record<string, unknown>, path: string) => {
    const segments = path.split(".");
    const key = segments.pop();
    let owner = value;
    for (const segment of segments) {
      owner = owner[segment] as Record<string, unknown>;
    }
    delete owner[key!];
  };

  for (const path of EXACT_FRESHNESS_PATHS) {
    const value = structuredClone(currentReadyConversation()) as Record<
      string,
      unknown
    >;
    deletePath(value, path);
    assert.equal(
      hasCurrentConversationClassification(value),
      false,
      `expected missing ${path} to fail closed`,
    );
  }
});

test("freshness reads required persisted fields only from own properties", () => {
  const current = currentReadyConversation();
  const inheritedRoot = Object.create(current) as unknown;
  const inheritedState = {
    ...current,
    classification_state: Object.create(current.classification_state),
  };
  const inheritedMeta = {
    ...current,
    classification_meta: Object.create(current.classification_meta),
  };

  for (const value of [inheritedRoot, inheritedState, inheritedMeta]) {
    assert.equal(hasCurrentConversationClassification(value), false);
    assert.equal(getCurrentConversationClassification(value), undefined);
  }
});

test("freshness fails closed for unknown, array, malformed, and throwing values", () => {
  const throwingToObject = Object.create({
    toObject() {
      throw new Error("do not leak");
    },
  }) as unknown;
  const throwingGetter = { ...currentReadyConversation() };
  Object.defineProperty(throwingGetter, "classification_state", {
    get() {
      throw new Error("do not leak");
    },
  });
  const throwingProxy = new Proxy(currentReadyConversation(), {
    getOwnPropertyDescriptor() {
      throw new Error("do not leak");
    },
  });

  for (const value of [
    null,
    undefined,
    [],
    {},
    { ...currentReadyConversation(), classification_state: [] },
    { ...currentReadyConversation(), classification_meta: [] },
    throwingToObject,
    throwingGetter,
    throwingProxy,
  ]) {
    assert.doesNotThrow(() => hasCurrentConversationClassification(value));
    assert.equal(hasCurrentConversationClassification(value), false);
    assert.doesNotThrow(() => getCurrentConversationClassification(value));
    assert.equal(getCurrentConversationClassification(value), undefined);
  }
});
