import "server-only";
import { isRecord } from "@icecore/shared/lib/value-utils";

import type { MetaAdsMcpTool } from "./client";

const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 5_000;
const MAX_VALIDATION_ERRORS = 12;

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "description",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "nullable",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "uniqueItems",
  "writeOnly",
]);

type JsonSchema = boolean | Record<string, unknown>;

export type MetaAdsMcpToolArgumentValidationResult =
  | { success: true }
  | { success: false; errors: string[] };

type ValidationState = {
  root: JsonSchema;
  errors: string[];
  nodes: number;
};

function addError(state: ValidationState, message: string): void {
  if (state.errors.length < MAX_VALIDATION_ERRORS) {
    state.errors.push(message);
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        key =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          jsonEquals(left[key], right[key])
      )
    );
  }
  return false;
}

function schemaAtLocalRef(root: JsonSchema, ref: string): JsonSchema | null {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const encodedSegment of ref.slice(2).split("/")) {
    if (!isRecord(current)) return null;
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[segment];
  }
  return typeof current === "boolean" || isRecord(current) ? current : null;
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function schemaArray(value: unknown): JsonSchema[] | null {
  if (!Array.isArray(value)) return null;
  const schemas = value.filter(
    (item): item is JsonSchema => typeof item === "boolean" || isRecord(item)
  );
  return schemas.length === value.length ? schemas : null;
}

function matchesSchema(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema,
  depth: number,
  sharedNodes: { value: number }
): boolean {
  const temporary: ValidationState = {
    root,
    errors: [],
    nodes: sharedNodes.value,
  };
  validateNode(schema, value, "$", temporary, depth);
  sharedNodes.value = temporary.nodes;
  return temporary.errors.length === 0;
}

function validateCombinators(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number
): void {
  const sharedNodes = { value: state.nodes };
  const anyOf = schemaArray(schema.anyOf);
  if (schema.anyOf !== undefined && !anyOf) {
    addError(state, `${path} has an invalid anyOf schema`);
  } else if (
    anyOf &&
    !anyOf.some(item =>
      matchesSchema(item, value, state.root, depth + 1, sharedNodes)
    )
  ) {
    addError(state, `${path} does not match any allowed shape`);
  }

  const oneOf = schemaArray(schema.oneOf);
  if (schema.oneOf !== undefined && !oneOf) {
    addError(state, `${path} has an invalid oneOf schema`);
  } else if (oneOf) {
    const matches = oneOf.filter(item =>
      matchesSchema(item, value, state.root, depth + 1, sharedNodes)
    ).length;
    if (matches !== 1) addError(state, `${path} must match exactly one shape`);
  }

  const allOf = schemaArray(schema.allOf);
  if (schema.allOf !== undefined && !allOf) {
    addError(state, `${path} has an invalid allOf schema`);
  } else {
    allOf?.forEach(item => validateNode(item, value, path, state, depth + 1));
  }

  if (typeof schema.not === "boolean" || isRecord(schema.not)) {
    if (matchesSchema(schema.not, value, state.root, depth + 1, sharedNodes)) {
      addError(state, `${path} matches a forbidden shape`);
    }
  } else if (schema.not !== undefined) {
    addError(state, `${path} has an invalid not schema`);
  }

  if (typeof schema.if === "boolean" || isRecord(schema.if)) {
    const branch = matchesSchema(
      schema.if,
      value,
      state.root,
      depth + 1,
      sharedNodes
    )
      ? schema.then
      : schema.else;
    if (typeof branch === "boolean" || isRecord(branch)) {
      validateNode(branch, value, path, state, depth + 1);
    } else if (branch !== undefined) {
      addError(state, `${path} has an invalid conditional schema`);
    }
  } else if (schema.if !== undefined) {
    addError(state, `${path} has an invalid if schema`);
  }
  state.nodes = Math.max(state.nodes, sharedNodes.value);
}

function validateString(
  schema: Record<string, unknown>,
  value: string,
  path: string,
  state: ValidationState
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    addError(
      state,
      `${path} must contain at least ${schema.minLength} characters`
    );
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    addError(
      state,
      `${path} must contain at most ${schema.maxLength} characters`
    );
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern, "u").test(value)) {
        addError(state, `${path} does not match the required pattern`);
      }
    } catch {
      addError(state, `${path} has an invalid pattern schema`);
    }
  }
}

function validateNumber(
  schema: Record<string, unknown>,
  value: number,
  path: string,
  state: ValidationState
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    addError(state, `${path} must be at least ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    addError(state, `${path} must be at most ${schema.maximum}`);
  }
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    addError(state, `${path} must be greater than ${schema.exclusiveMinimum}`);
  }
  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    addError(state, `${path} must be less than ${schema.exclusiveMaximum}`);
  }
  if (
    typeof schema.multipleOf === "number" &&
    schema.multipleOf > 0 &&
    Math.abs(
      value / schema.multipleOf - Math.round(value / schema.multipleOf)
    ) >
      Number.EPSILON * 10
  ) {
    addError(state, `${path} must be a multiple of ${schema.multipleOf}`);
  }
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown[],
  path: string,
  state: ValidationState,
  depth: number
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    addError(state, `${path} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    addError(state, `${path} must contain at most ${schema.maxItems} items`);
  }
  if (
    schema.uniqueItems === true &&
    value.some((item, index) =>
      value.slice(0, index).some(previous => jsonEquals(previous, item))
    )
  ) {
    addError(state, `${path} must contain unique items`);
  }

  const prefixItems = schemaArray(schema.prefixItems);
  if (schema.prefixItems !== undefined && !prefixItems) {
    addError(state, `${path} has an invalid prefixItems schema`);
  }
  prefixItems?.forEach((itemSchema, index) => {
    if (index < value.length) {
      validateNode(
        itemSchema,
        value[index],
        `${path}[${index}]`,
        state,
        depth + 1
      );
    }
  });

  const tupleItems = schemaArray(schema.items);
  if (tupleItems) {
    tupleItems.forEach((itemSchema, index) => {
      if (index < value.length) {
        validateNode(
          itemSchema,
          value[index],
          `${path}[${index}]`,
          state,
          depth + 1
        );
      }
    });
    if (value.length > tupleItems.length) {
      if (schema.additionalItems === false) {
        addError(state, `${path} contains unsupported extra items`);
      } else if (
        typeof schema.additionalItems === "boolean" ||
        isRecord(schema.additionalItems)
      ) {
        value
          .slice(tupleItems.length)
          .forEach((item, offset) =>
            validateNode(
              schema.additionalItems as JsonSchema,
              item,
              `${path}[${tupleItems.length + offset}]`,
              state,
              depth + 1
            )
          );
      }
    }
  } else if (typeof schema.items === "boolean" || isRecord(schema.items)) {
    const start = prefixItems?.length || 0;
    value
      .slice(start)
      .forEach((item, offset) =>
        validateNode(
          schema.items as JsonSchema,
          item,
          `${path}[${start + offset}]`,
          state,
          depth + 1
        )
      );
  } else if (schema.items !== undefined) {
    addError(state, `${path} has an invalid items schema`);
  }

  if (typeof schema.contains === "boolean" || isRecord(schema.contains)) {
    const sharedNodes = { value: state.nodes };
    const matchCount = value.filter(item =>
      matchesSchema(
        schema.contains as JsonSchema,
        item,
        state.root,
        depth + 1,
        sharedNodes
      )
    ).length;
    const minimum =
      typeof schema.minContains === "number" ? schema.minContains : 1;
    const maximum =
      typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
    if (matchCount < minimum || matchCount > maximum) {
      addError(state, `${path} does not contain the required matching items`);
    }
    state.nodes = Math.max(state.nodes, sharedNodes.value);
  }
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  state: ValidationState,
  depth: number
): void {
  const keys = Object.keys(value);
  if (
    typeof schema.minProperties === "number" &&
    keys.length < schema.minProperties
  ) {
    addError(
      state,
      `${path} must contain at least ${schema.minProperties} fields`
    );
  }
  if (
    typeof schema.maxProperties === "number" &&
    keys.length > schema.maxProperties
  ) {
    addError(
      state,
      `${path} must contain at most ${schema.maxProperties} fields`
    );
  }

  if (Array.isArray(schema.required)) {
    for (const requiredKey of schema.required) {
      if (
        typeof requiredKey !== "string" ||
        !Object.prototype.hasOwnProperty.call(value, requiredKey)
      ) {
        addError(
          state,
          typeof requiredKey === "string"
            ? `${path}.${requiredKey} is required`
            : `${path} has an invalid required schema`
        );
      }
    }
  } else if (schema.required !== undefined) {
    addError(state, `${path} has an invalid required schema`);
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const patternProperties = isRecord(schema.patternProperties)
    ? schema.patternProperties
    : {};
  const patterns = Object.entries(patternProperties).flatMap(
    ([pattern, childSchema]) => {
      if (typeof childSchema !== "boolean" && !isRecord(childSchema)) return [];
      try {
        return [{ expression: new RegExp(pattern, "u"), schema: childSchema }];
      } catch {
        addError(state, `${path} has an invalid patternProperties schema`);
        return [];
      }
    }
  );

  for (const key of keys) {
    const childPath = `${path}.${key}`;
    let matched = false;
    const propertySchema = properties[key];
    if (typeof propertySchema === "boolean" || isRecord(propertySchema)) {
      matched = true;
      validateNode(propertySchema, value[key], childPath, state, depth + 1);
    }
    for (const pattern of patterns) {
      if (!pattern.expression.test(key)) continue;
      matched = true;
      validateNode(pattern.schema, value[key], childPath, state, depth + 1);
    }
    if (matched) continue;
    if (schema.additionalProperties === false) {
      addError(state, `${childPath} is not allowed`);
    } else if (
      typeof schema.additionalProperties === "boolean" ||
      isRecord(schema.additionalProperties)
    ) {
      validateNode(
        schema.additionalProperties as JsonSchema,
        value[key],
        childPath,
        state,
        depth + 1
      );
    }
  }

  if (
    typeof schema.propertyNames === "boolean" ||
    isRecord(schema.propertyNames)
  ) {
    keys.forEach(key =>
      validateNode(
        schema.propertyNames as JsonSchema,
        key,
        `${path} property name`,
        state,
        depth + 1
      )
    );
  }

  if (isRecord(schema.dependentRequired)) {
    for (const [key, dependencies] of Object.entries(
      schema.dependentRequired
    )) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (!Array.isArray(dependencies)) {
        addError(state, `${path} has an invalid dependentRequired schema`);
        continue;
      }
      for (const dependency of dependencies) {
        if (
          typeof dependency !== "string" ||
          !Object.prototype.hasOwnProperty.call(value, dependency)
        ) {
          addError(state, `${path}.${dependency} is required with ${key}`);
        }
      }
    }
  }

  if (isRecord(schema.dependentSchemas)) {
    for (const [key, dependentSchema] of Object.entries(
      schema.dependentSchemas
    )) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (typeof dependentSchema === "boolean" || isRecord(dependentSchema)) {
        validateNode(dependentSchema, value, path, state, depth + 1);
      } else {
        addError(state, `${path} has an invalid dependentSchemas schema`);
      }
    }
  }
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number
): void {
  state.nodes += 1;
  if (depth > MAX_SCHEMA_DEPTH || state.nodes > MAX_SCHEMA_NODES) {
    addError(state, `${path} exceeds the supported schema complexity`);
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    addError(state, `${path} is not allowed`);
    return;
  }

  const unsupportedKey = Object.keys(schema).find(
    key => !SUPPORTED_SCHEMA_KEYS.has(key) && !key.startsWith("x-")
  );
  if (unsupportedKey) {
    addError(
      state,
      `${path} uses unsupported schema keyword ${unsupportedKey}`
    );
    return;
  }

  if (typeof schema.$ref === "string") {
    const referencedSchema = schemaAtLocalRef(state.root, schema.$ref);
    if (!referencedSchema) {
      addError(state, `${path} contains an unsupported schema reference`);
      return;
    }
    validateNode(referencedSchema, value, path, state, depth + 1);
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some(item => jsonEquals(item, value))
  ) {
    addError(state, `${path} must be one of the allowed values`);
  }
  if (
    Object.prototype.hasOwnProperty.call(schema, "const") &&
    !jsonEquals(schema.const, value)
  ) {
    addError(state, `${path} must equal the required value`);
  }

  const allowedTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type) &&
          schema.type.every(item => typeof item === "string")
        ? schema.type
        : [];
  if (schema.nullable === true && !allowedTypes.includes("null")) {
    allowedTypes.push("null");
  }
  if (schema.type !== undefined && allowedTypes.length === 0) {
    addError(state, `${path} has an invalid type schema`);
    return;
  }
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.some(type => valueMatchesType(value, type))
  ) {
    addError(state, `${path} must be ${allowedTypes.join(" or ")}`);
    return;
  }

  validateCombinators(schema, value, path, state, depth);
  if (typeof value === "string") validateString(schema, value, path, state);
  if (typeof value === "number" && Number.isFinite(value)) {
    validateNumber(schema, value, path, state);
  }
  if (Array.isArray(value)) validateArray(schema, value, path, state, depth);
  if (isRecord(value)) validateObject(schema, value, path, state, depth);
}

export function validateMetaAdsMcpToolArguments(params: {
  tool: MetaAdsMcpTool;
  arguments: Record<string, unknown>;
}): MetaAdsMcpToolArgumentValidationResult {
  const root: JsonSchema = params.tool.inputSchema;
  const state: ValidationState = { root, errors: [], nodes: 0 };
  validateNode(root, params.arguments, "$", state, 0);
  return state.errors.length === 0
    ? { success: true }
    : { success: false, errors: state.errors };
}
