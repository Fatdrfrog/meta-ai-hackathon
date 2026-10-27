import type { Schema } from "mongoose";
import { isRecord } from "@icecore/shared/lib/value-utils";

type QueryValidationContext = {
  getOptions(): Record<string, unknown>;
  getUpdate(): unknown;
  mongooseOptions(): Record<string, unknown>;
  op: string;
};

export type ResolvedValidationValue<T> =
  | { known: true; value: T | undefined }
  | { known: false };

export type AtomicUpdateField<T> =
  | {
      touched: true;
      source: "$set" | "$setOnInsert" | "$unset";
      value: T | undefined;
    }
  | { touched: false };

export type AtomicUpdateShape = {
  $set: Readonly<Record<string, unknown>>;
  $setOnInsert: Readonly<Record<string, unknown>>;
  $unset: Readonly<Record<string, unknown>>;
};

export type AtomicUpdateGuardOptions = {
  upsert: boolean;
};

export type AtomicUpdateGuardPolicy = {
  validationOnlyPaths?: readonly string[];
  monotonicIncrementPaths?: readonly string[];
};

type ParsedAtomicUpdateShape = {
  shape: AtomicUpdateShape;
  touchedInvariantPaths: readonly string[];
  touchedValidationOnlyPaths: readonly string[];
};

function hasOwn(record: Record<string, unknown>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, path);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}.`) ||
    right.startsWith(`${left}.`)
  );
}

function findOverlappingInvariantPath(
  path: string,
  invariantPaths: readonly string[]
): string | undefined {
  return invariantPaths.find(invariantPath =>
    pathsOverlap(path, invariantPath)
  );
}

function readOperator(
  update: Record<string, unknown>,
  operator: "$set" | "$setOnInsert" | "$unset"
): Record<string, unknown> {
  const value = update[operator];
  return isRecord(value) ? value : {};
}

function parseAtomicUpdateShape(
  update: unknown,
  invariantPaths: readonly string[],
  options: AtomicUpdateGuardOptions,
  policy: AtomicUpdateGuardPolicy
): ParsedAtomicUpdateShape {
  if (Array.isArray(update)) {
    throw new Error("Update pipelines cannot mutate durable ledger records");
  }
  if (!isRecord(update)) {
    throw new Error("Durable ledger updates must be update objects");
  }

  const validationOnlyPaths = policy.validationOnlyPaths ?? [];
  const monotonicIncrementPaths = policy.monotonicIncrementPaths ?? [];

  for (const path of Object.keys(update)) {
    if (!path.startsWith("$")) {
      const invariantPath = findOverlappingInvariantPath(path, invariantPaths);
      if (invariantPath !== undefined) {
        throw new Error(
          `Invariant path ${invariantPath} must use an allowed operator`
        );
      }
      const validationOnlyPath = findOverlappingInvariantPath(
        path,
        validationOnlyPaths
      );
      if (validationOnlyPath !== undefined) {
        throw new Error(
          `Validation-only path ${validationOnlyPath} must use an allowed operator`
        );
      }
    }
  }

  const shape: AtomicUpdateShape = {
    $set: readOperator(update, "$set"),
    $setOnInsert: readOperator(update, "$setOnInsert"),
    $unset: readOperator(update, "$unset"),
  };

  const touchedValidationOnlyPaths = new Set<string>();
  for (const [operator, values] of Object.entries(shape) as Array<
    [keyof AtomicUpdateShape, Readonly<Record<string, unknown>>]
  >) {
    for (const path of Object.keys(values)) {
      const invariantPath = findOverlappingInvariantPath(path, invariantPaths);
      if (invariantPath !== undefined && path !== invariantPath) {
        throw new Error(
          `Invariant path ${invariantPath} cannot be mutated through ${path}`
        );
      }

      const validationOnlyPath = findOverlappingInvariantPath(
        path,
        validationOnlyPaths
      );
      if (validationOnlyPath === undefined) {
        continue;
      }

      const monotonicIncrementPath = findOverlappingInvariantPath(
        path,
        monotonicIncrementPaths
      );
      if (
        monotonicIncrementPath !== undefined &&
        !(options.upsert && operator === "$setOnInsert")
      ) {
        throw new Error(
          `Fence path ${monotonicIncrementPath} can only advance with one atomic increment`
        );
      }
      touchedValidationOnlyPaths.add(path);
    }
  }

  for (const [operator, values] of Object.entries(update)) {
    if (
      operator === "$set" ||
      operator === "$setOnInsert" ||
      operator === "$unset" ||
      !operator.startsWith("$")
    ) {
      continue;
    }
    if (!isRecord(values)) {
      continue;
    }

    for (const [path, value] of Object.entries(values)) {
      const sourceInvariantPath = findOverlappingInvariantPath(
        path,
        invariantPaths
      );
      const sourceValidationOnlyPath = findOverlappingInvariantPath(
        path,
        validationOnlyPaths
      );
      const targetInvariantPath =
        operator === "$rename" && typeof value === "string"
          ? findOverlappingInvariantPath(value, invariantPaths)
          : undefined;
      const targetValidationOnlyPath =
        operator === "$rename" && typeof value === "string"
          ? findOverlappingInvariantPath(value, validationOnlyPaths)
          : undefined;

      if (
        operator === "$inc" &&
        sourceInvariantPath === undefined &&
        sourceValidationOnlyPath !== undefined &&
        monotonicIncrementPaths.includes(path) &&
        value === 1
      ) {
        continue;
      }

      if (
        sourceInvariantPath !== undefined ||
        targetInvariantPath !== undefined ||
        sourceValidationOnlyPath !== undefined ||
        targetValidationOnlyPath !== undefined
      ) {
        throw new Error(
          `${operator} cannot mutate durable ledger protected path ${
            sourceInvariantPath ??
            targetInvariantPath ??
            sourceValidationOnlyPath ??
            targetValidationOnlyPath
          }`
        );
      }
    }
  }

  for (const path of invariantPaths) {
    const owners = [shape.$set, shape.$setOnInsert, shape.$unset].filter(
      values => hasOwn(values as Record<string, unknown>, path)
    );
    if (owners.length > 1) {
      throw new Error(`Invariant path ${path} has ambiguous update operators`);
    }
  }

  return {
    shape,
    touchedInvariantPaths: invariantPaths.filter(path =>
      [shape.$set, shape.$setOnInsert, shape.$unset].some(values =>
        hasOwn(values as Record<string, unknown>, path)
      )
    ),
    touchedValidationOnlyPaths: [...touchedValidationOnlyPaths],
  };
}

export function resolveAtomicUpdateField<T>(
  shape: AtomicUpdateShape,
  path: string
): AtomicUpdateField<T> {
  for (const source of ["$set", "$setOnInsert", "$unset"] as const) {
    const values = shape[source] as Record<string, unknown>;
    if (hasOwn(values, path)) {
      return {
        touched: true,
        source,
        value: source === "$unset" ? undefined : (values[path] as T),
      };
    }
  }
  return { touched: false };
}

export function assertRequiredSetOnInsertFields(
  shape: AtomicUpdateShape,
  requiredPaths: readonly string[]
): void {
  const missingOrMisplacedPaths = requiredPaths.filter(path => {
    const field = resolveAtomicUpdateField(shape, path);
    return (
      !field.touched ||
      field.source !== "$setOnInsert" ||
      field.value === null ||
      field.value === undefined
    );
  });
  if (missingOrMisplacedPaths.length > 0) {
    throw new Error(
      `Required insert fields must use one $setOnInsert: ${missingOrMisplacedPaths.join(
        ", "
      )}`
    );
  }
}

export function installInvariantUpdateShapeGuard<T>(
  schema: Schema<T>,
  invariantPaths: readonly string[],
  assertValid: (
    shape: AtomicUpdateShape,
    options: AtomicUpdateGuardOptions
  ) => void,
  policy: AtomicUpdateGuardPolicy = {}
): void {
  const validationOnlyPaths = policy.validationOnlyPaths ?? [];
  for (const path of policy.monotonicIncrementPaths ?? []) {
    if (findOverlappingInvariantPath(path, validationOnlyPaths) === undefined) {
      throw new Error(
        `Monotonic increment path ${path} must belong to a validation-only path`
      );
    }
  }

  function guardUpdateShape(
    this: QueryValidationContext
  ): void | Promise<void> {
    if (
      this.op === "updateMany" ||
      this.op === "replaceOne" ||
      this.op === "findOneAndReplace"
    ) {
      throw new Error(
        `${this.op} cannot mutate individual durable ledger records`
      );
    }

    const queryOptions = this.getOptions();
    const upsert = queryOptions.upsert === true;
    const guardOptions = { upsert };
    const parsed = parseAtomicUpdateShape(
      this.getUpdate(),
      invariantPaths,
      guardOptions,
      policy
    );
    const requiresShapeAssertion =
      upsert || parsed.touchedInvariantPaths.length > 0;
    const requiresValidation =
      requiresShapeAssertion || parsed.touchedValidationOnlyPaths.length > 0;
    if (!requiresValidation) {
      return;
    }

    if (queryOptions.runValidators !== true) {
      throw new Error(
        "Durable ledger invariant updates require runValidators: true"
      );
    }
    if (upsert && this.mongooseOptions().setDefaultsOnInsert !== false) {
      throw new Error(
        "Durable ledger upserts require setDefaultsOnInsert: false"
      );
    }

    if (requiresShapeAssertion) {
      assertValid(parsed.shape, guardOptions);
    }
  }

  schema.pre("updateOne", { document: false, query: true }, guardUpdateShape);
  schema.pre(
    "findOneAndUpdate",
    { document: false, query: true },
    guardUpdateShape
  );
  schema.pre("updateMany", { document: false, query: true }, guardUpdateShape);
  schema.pre("replaceOne", { document: false, query: true }, guardUpdateShape);
  schema.pre(
    "findOneAndReplace",
    { document: false, query: true },
    guardUpdateShape
  );
}

export function isQueryValidationContext(
  context: unknown
): context is QueryValidationContext {
  return (
    context !== null &&
    typeof context === "object" &&
    "getUpdate" in context &&
    typeof (context as QueryValidationContext).getUpdate === "function"
  );
}

function resolveQueryUpdateValue<T>(
  context: QueryValidationContext,
  path: string
): ResolvedValidationValue<T> {
  const update = context.getUpdate();
  if (!isRecord(update)) {
    return { known: false };
  }

  const candidates: Array<T | undefined> = [];
  if (hasOwn(update, path)) {
    candidates.push(update[path] as T | undefined);
  }

  for (const operator of ["$set", "$setOnInsert"] as const) {
    const values = update[operator];
    if (isRecord(values) && hasOwn(values, path)) {
      candidates.push(values[path] as T | undefined);
    }
  }

  const unsetValues = update.$unset;
  if (isRecord(unsetValues) && hasOwn(unsetValues, path)) {
    candidates.push(undefined);
  }

  for (const [operator, values] of Object.entries(update)) {
    if (
      operator.startsWith("$") &&
      operator !== "$set" &&
      operator !== "$setOnInsert" &&
      operator !== "$unset" &&
      isRecord(values) &&
      hasOwn(values, path)
    ) {
      return { known: false };
    }
  }

  return candidates.length === 1
    ? { known: true, value: candidates[0] }
    : { known: false };
}

export function resolveValidationValue<T>(
  context: unknown,
  path: string
): ResolvedValidationValue<T> {
  if (isQueryValidationContext(context)) {
    return resolveQueryUpdateValue<T>(context, path);
  }
  if (context === null || typeof context !== "object") {
    return { known: false };
  }

  const documentContext = context as {
    get?: (documentPath: string) => unknown;
  } & Record<string, unknown>;
  if (typeof documentContext.get === "function") {
    return {
      known: true,
      value: documentContext.get(path) as T | undefined,
    };
  }
  if (path in documentContext) {
    return {
      known: true,
      value: documentContext[path] as T | undefined,
    };
  }
  return { known: false };
}
