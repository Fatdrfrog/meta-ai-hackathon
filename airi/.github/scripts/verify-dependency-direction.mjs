import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_PATTERN = /\.(?:test|spec|type-test)\.[cm]?[jt]sx?$/i;
const TEST_DIRECTORY_NAMES = new Set([
  "__fixtures__",
  "__tests__",
  "test",
  "tests",
]);
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
]);

export const LEGACY_AIRI_RUNTIME_WEB_BUDGET = Object.freeze({
  "packages/airi-runtime/src/auto-reply.ts": 101,
  "packages/airi-runtime/src/bulk-campaign-dispatch.ts": 12,
  "packages/airi-runtime/src/bulk-dispatch-activity-dedupe.ts": 1,
  "packages/airi-runtime/src/campaign-node-run-activity.ts": 2,
  "packages/airi-runtime/src/job-runner.ts": 8,
  "packages/airi-runtime/src/knowledge-canonical-sync-activity.ts": 1,
  "packages/airi-runtime/src/website-crawl-activity.ts": 2,
  "packages/airi-runtime/src/whatsapp-message-processor.ts": 20,
});

export const LEGACY_AIRI_RUNTIME_WEB_MODULES = Object.freeze({
  "packages/airi-runtime/src/auto-reply.ts": [
    "apps/web/src/lib/airi/coach/coach-utils-server",
    "apps/web/src/lib/airi/interactive-no-reply",
    "apps/web/src/lib/airi/ops/suggestion-payloads",
    "apps/web/src/lib/airi/post-action-answer-matching",
    "apps/web/src/lib/airi/rag/knowledge/knowledge-gap-tracker",
    "apps/web/src/lib/airi/reply/delivery/outbound-message",
    "apps/web/src/lib/airi/reply/delivery/reply-delivery-gate",
    "apps/web/src/lib/airi/reply/delivery/reply-rich-text-format",
    "apps/web/src/lib/airi/reply/delivery/temporal-outbound",
    "apps/web/src/lib/airi/reply/generation/reply-language",
    "apps/web/src/lib/airi/reply/generation/reply-safety",
    "apps/web/src/lib/airi/reply/runtime/auto-reply-execution-gates",
    "apps/web/src/lib/airi/reply/runtime/auto-reply-guards",
    "apps/web/src/lib/airi/reply/runtime/auto-reply-input",
    "apps/web/src/lib/airi/reply/runtime/auto-reply-realtime",
    "apps/web/src/lib/airi/reply/runtime/auto-reply-template-utils",
    "apps/web/src/lib/airi/reply/runtime/context",
    "apps/web/src/lib/airi/reply/runtime/dispatch",
    "apps/web/src/lib/airi/reply/runtime/generative-ai-execution-store",
    "apps/web/src/lib/airi/reply/runtime/handoff-notify",
    "apps/web/src/lib/airi/reply/runtime/handoff-state",
    "apps/web/src/lib/airi/reply/runtime/inbound-burst",
    "apps/web/src/lib/airi/reply/runtime/intent",
    "apps/web/src/lib/airi/reply/runtime/manager-reply-guard",
    "apps/web/src/lib/airi/reply/runtime/media-only",
    "apps/web/src/lib/airi/reply/runtime/rag",
    "apps/web/src/lib/airi/reply/runtime/reply-action-utils",
    "apps/web/src/lib/airi/reply/runtime/reply-trace",
    "apps/web/src/lib/airi/reply/runtime/scenario",
    "apps/web/src/lib/airi/reply/runtime/scenario-followup-handoff",
    "apps/web/src/lib/airi/reply/runtime/whatsapp-book-call",
    "apps/web/src/lib/airi/scenario/scenario-runtime",
    "apps/web/src/lib/airi/scenario/scenario-runtime-dispatch",
    "apps/web/src/lib/airi/scenario/scenario-template",
    "apps/web/src/lib/airi/scenario/scenario-template-dynamics",
    "apps/web/src/lib/airi/shouldContinueProcessing",
    "apps/web/src/lib/airi/workspace-bot-contract",
    "apps/web/src/lib/airi/workspace-bot-default",
    "apps/web/src/lib/company-context",
    "apps/web/src/lib/conversation-attachments",
    "apps/web/src/lib/google-calendar/availability-context",
    "apps/web/src/lib/limits/company-limits",
    "apps/web/src/lib/media/message-media-utils",
    "apps/web/src/lib/realtime/server",
    "apps/web/src/lib/supabase/admin",
    "apps/web/src/lib/telegram",
    "apps/web/src/lib/whatsapp/flows/endpoint-token",
    "apps/web/src/models/conversation",
    "apps/web/src/models/message",
    "apps/web/src/types/models",
  ],
  "packages/airi-runtime/src/bulk-campaign-dispatch.ts": [
    "apps/web/src/lib/campaign/bulk-campaign-safety",
    "apps/web/src/lib/campaign/campaign-conversation-persistence",
    "apps/web/src/lib/campaign/campaign-history-store",
    "apps/web/src/lib/campaign/campaign-stats",
    "apps/web/src/lib/campaign/campaign-transport",
    "apps/web/src/lib/cross-store-outbox",
    "apps/web/src/lib/limits/company-limits",
    "apps/web/src/lib/mongoose",
    "apps/web/src/lib/supabase/admin",
    "apps/web/src/lib/telegram/subscribers",
    "apps/web/src/lib/telegram/validate-source",
    "apps/web/src/lib/whatsapp/send-context",
  ],
  "packages/airi-runtime/src/bulk-dispatch-activity-dedupe.ts": [
    "apps/web/src/models/bulk-dispatch-activity-dedupe",
  ],
  "packages/airi-runtime/src/campaign-node-run-activity.ts": [
    "apps/web/src/lib/campaign/campaign-delivery-runtime",
    "apps/web/src/lib/campaign/campaign-node-run-runtime",
  ],
  "packages/airi-runtime/src/job-runner.ts": [
    "apps/web/src/lib/airi/reply/delivery/outbound-message",
    "apps/web/src/lib/airi/reply/delivery/temporal-outbound",
    "apps/web/src/lib/airi/reply/runtime/generative-ai-execution-store",
    "apps/web/src/lib/limits/company-limits",
    "apps/web/src/lib/mongoose",
    "apps/web/src/lib/supabase/admin",
    "apps/web/src/lib/temporal/airi-turn-context",
    "apps/web/src/models/conversation",
  ],
  "packages/airi-runtime/src/knowledge-canonical-sync-activity.ts": [
    "apps/web/src/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner",
  ],
  "packages/airi-runtime/src/website-crawl-activity.ts": [
    "apps/web/src/lib/crawler/website-crawl-runner",
    "apps/web/src/lib/mongoose",
  ],
  "packages/airi-runtime/src/whatsapp-message-processor.ts": [
    "apps/web/src/lib/airi/workspace-bot-default",
    "apps/web/src/lib/conversation-messages",
    "apps/web/src/lib/media/handler",
    "apps/web/src/lib/media/whatsapp-media-url",
    "apps/web/src/lib/mongo-errors",
    "apps/web/src/lib/posthog/server",
    "apps/web/src/lib/provider-message-display",
    "apps/web/src/lib/whatsapp/contact/utils",
    "apps/web/src/lib/whatsapp/conversation-lookup",
    "apps/web/src/lib/whatsapp/identity/indexes",
    "apps/web/src/lib/whatsapp/media-types",
    "apps/web/src/lib/whatsapp/referral-enrichment",
    "apps/web/src/models/chat",
    "apps/web/src/models/conversation",
    "apps/web/src/models/message",
    "apps/web/src/models/user",
    "apps/web/src/models/whatsapp-pending-message-mutation",
    "apps/web/src/types/models",
  ],
});

// This activity is the composition root for the two typed scenario hosts.
// Exact adapter paths are checked separately; this is not permission for model imports.
const SCENARIO_ACTIVITY_HOST_MODULES = new Set([
  "apps/web/src/lib/airi/scenario/auto-reply-runtime-dependencies",
  "apps/web/src/lib/airi/scenario/timer-runtime-dependencies",
]);

export const LEGACY_TEMPORAL_WORKER_WEB_BUDGET = Object.freeze({
  "apps/temporal-worker/src/activities/airi-auto-reply.ts": 2,
  "apps/temporal-worker/src/activities/background-jobs.ts": 3,
  "apps/temporal-worker/src/activities/billing-subscription.ts": 1,
  "apps/temporal-worker/src/activities/campaign-schedule-action.ts": 6,
  "apps/temporal-worker/src/activities/campaign-schedule-reconcile.ts": 3,
  "apps/temporal-worker/src/activities/conversation-media-analysis.ts": 5,
  "apps/temporal-worker/src/activities/creative-asset-edits.ts": 4,
  // Through its one host module, lib/creative-assets/image-generation-worker-host.
  "apps/temporal-worker/src/activities/creative-image-generation.ts": 1,
  "apps/temporal-worker/src/activities/cross-store-outbox-drain.ts": 4,
  "apps/temporal-worker/src/activities/elevenlabs-creative-transcription.ts": 7,
  "apps/temporal-worker/src/activities/happyhorse-video.ts": 8,
  // Through its one host module, lib/products/import-worker-host.
  "apps/temporal-worker/src/activities/product-video-import.ts": 1,
  // The WhatsApp intake for Products, through the same host module.
  "apps/temporal-worker/src/products/whatsapp-intake.ts": 1,
  "apps/temporal-worker/src/activities/higgsfield-assets.ts": 16,
  "apps/temporal-worker/src/activities/scenario-generative-ai.ts": 10,
  "apps/temporal-worker/src/activities/scenario-generative-source.ts": 3,
  "apps/temporal-worker/src/activities/video-generation/finalize.ts": 5,
  "apps/temporal-worker/src/activities/video-generation/providers/google.ts": 4,
  "apps/temporal-worker/src/activities/video-generation/providers/happyhorse.ts": 5,
  "apps/temporal-worker/src/activities/video-generation/providers/higgsfield.ts": 7,
  "apps/temporal-worker/src/activities/video-generation/submit.ts": 9,
  "apps/temporal-worker/src/activities/video-generation-reconcile.ts": 5,
  "apps/temporal-worker/src/activities/wan-avatar.ts": 10,
  "apps/temporal-worker/src/activities/wan-morph.ts": 8,
  "apps/temporal-worker/src/activities/whatsapp-calls/call-activities.ts": 12,
  "apps/temporal-worker/src/activities/whatsapp-calls/recording-activities.ts": 7,
  "apps/temporal-worker/src/activities/workspace-usage-repair.ts": 2,
  // Shipped by #294 while this gate was already failing on another file;
  // recorded here so the ratchet blocks any further growth.
  "apps/temporal-worker/src/activities/whatsapp-webhook-drain.ts": 1,
  // Lazy composition root for the analytics collector, which is owned by web lib.
  "apps/temporal-worker/src/analytics-projection-runtime.ts": 1,
  "apps/temporal-worker/src/backfill-usage-snapshots.ts": 2,
  "apps/temporal-worker/src/gateway.ts": 2,
  "apps/temporal-worker/src/gcp-llm-analytics.ts": 1,
  "apps/temporal-worker/src/migrate-creative-assets-gcs.ts": 3,
  "apps/temporal-worker/src/otp-api.ts": 1,
  "apps/temporal-worker/src/pubsub/conversation-classification-consumer.ts": 12,
  "apps/temporal-worker/src/pubsub/workspace-usage-consumer.ts": 2,
  "apps/temporal-worker/src/realtime-outbox-replayer.ts": 1,
  "apps/temporal-worker/src/replay-whatsapp-message-link.ts": 1,
  "apps/temporal-worker/src/replay-whatsapp-webhook-events.ts": 6,
  "apps/temporal-worker/src/whatsapp-call-conversation-linker.ts": 7,
  "apps/temporal-worker/src/whatsapp-call-session-reducer.ts": 2,
  "apps/temporal-worker/src/whatsapp-contact-sync/processor.ts": 1,
  "apps/temporal-worker/src/whatsapp-identity-change-message-link.ts": 1,
  "apps/temporal-worker/src/whatsapp-identity-change.ts": 10,
  "apps/temporal-worker/src/whatsapp-message-dedupe.ts": 1,
  // Consent moved to its shared web service owner; the host injects consent and cart effects.
  // Removing the old consent module's three imports decreases total worker web debt by one.
  // #294/#296/#298 added four customer-webhook and template references while this
  // gate was already failing on another file; recorded so it cannot grow further.
  "apps/temporal-worker/src/whatsapp-webhook-runtime-dependencies.ts": 34,
  "apps/temporal-worker/src/worker-realtime.ts": 2,
});

export const LEGACY_OTP_RUNTIME_WEB_BUDGET = Object.freeze({});

export const LEGACY_CROSS_WORKSPACE_SOURCE_BUDGET = Object.freeze({
  "apps/temporal-worker/src/gateway.ts": 2,
  // Shipped by #292 (public key validation shared with CJS config) while this
  // gate was already failing on another file; recorded so it cannot grow.
  "apps/web/src/lib/supabase/public-key.ts": 1,
  "packages/airi-runtime/src/auto-reply.ts": 1,
  "packages/airi-runtime/src/bulk-campaign-dispatch.ts": 12,
  "packages/airi-runtime/src/bulk-dispatch-activity-dedupe.ts": 1,
  "packages/airi-runtime/src/campaign-node-run-activity.ts": 2,
  "packages/airi-runtime/src/job-runner.ts": 8,
  "packages/airi-runtime/src/knowledge-canonical-sync-activity.ts": 1,
  "packages/airi-runtime/src/website-crawl-activity.ts": 2,
  "packages/scenario-contracts/src/scenario-bulk.ts": 1,
  "packages/scenario-contracts/src/scenario-node-data.ts": 1,
  "packages/scenario-contracts/src/whatsapp-template-types.ts": 1,
  "packages/scenario-contracts/src/scenario-channel-configs.ts": 1,
  // The stored service-message preview envelope lives in shared, which cannot
  // import contracts; the compiler specializes it with the typed send command.
  "packages/scenario-contracts/src/whatsapp-service-message-compiler.ts": 1,
});

const normalizePath = (value) => value.replaceAll("\\", "/");

function relativePath(repoRoot, filePath) {
  return normalizePath(path.relative(repoRoot, filePath));
}

function sortedMap(counts) {
  return new Map(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function workspaceOwner(relativePath) {
  return (
    /^(apps|packages)\/([^/]+)\/src(?:\/|$)/
      .exec(relativePath)?.[0]
      ?.replace(/\/src\/?$/, "") ?? null
  );
}

function increment(counts, file) {
  counts.set(file, (counts.get(file) ?? 0) + 1);
}

export function isTestOnlySourcePath(filePath) {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  return (
    TEST_FILE_PATTERN.test(parts.at(-1) ?? "") ||
    parts.some((part) => TEST_DIRECTORY_NAMES.has(part))
  );
}

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      current.kind === ts.SyntaxKind.TypeAssertionExpression ||
      (typeof ts.isSatisfiesExpression === "function" &&
        ts.isSatisfiesExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      current = current.right;
      continue;
    }
    break;
  }
  return current;
}

const FACTORY_EXPORT_NAMES = new Set(["createRequire", "createWebRequire"]);

function factoryNameFromCallee(expression, factoryNames) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee) && factoryNames.has(callee.text)) {
    return callee.text;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    FACTORY_EXPORT_NAMES.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    FACTORY_EXPORT_NAMES.has(callee.argumentExpression.text)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

function isFactoryCallee(expression, factoryNames) {
  return factoryNameFromCallee(expression, factoryNames) !== null;
}

function isModuleLoadCallee(expression, requireCallees, factoryNames) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee) && requireCallees.has(callee.text)) {
    return true;
  }
  return (
    ts.isCallExpression(callee) &&
    isFactoryCallee(callee.expression, factoryNames)
  );
}

function isResolveCallee(expression, requireCallees) {
  const callee = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "resolve"
  ) {
    return false;
  }
  const object = unwrapExpression(callee.expression);
  return ts.isIdentifier(object) && requireCallees.has(object.text);
}

function addNamedImportAliases(node, names) {
  if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings) {
    return;
  }
  const bindings = node.importClause.namedBindings;
  if (!ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (names.has(importedName)) {
      names.add(element.name.text);
    }
  }
}

function addBindingPatternAliases(name, factoryNames) {
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const importedName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (factoryNames.has(importedName)) {
      factoryNames.add(element.name.text);
    }
  }
}

function addFactoryBinding(node, factoryNames, requireCallees) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return;
  }
  if (!node.initializer) return;
  const initializer = unwrapExpression(node.initializer);
  if (isFactoryCallee(initializer, factoryNames)) {
    factoryNames.add(node.name.text);
    return;
  }
  if (
    ts.isCallExpression(initializer) &&
    isFactoryCallee(initializer.expression, factoryNames)
  ) {
    requireCallees.add(node.name.text);
  }
}

export function collectModuleReferences(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const references = [];
  const requireCallees = new Set(["require", "requireWeb"]);
  const factoryNames = new Set(["createRequire", "createWebRequire"]);
  const record = (literal, kind) => {
    if (!ts.isStringLiteralLike(literal)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(
      literal.getStart(sourceFile),
    );
    references.push({ specifier: literal.text, line: position.line + 1, kind });
  };
  const recordNonLiteral = (expression, kind) => {
    const position = sourceFile.getLineAndCharacterOfPosition(
      expression.getStart(sourceFile),
    );
    references.push({
      specifier: "<non-literal>",
      line: position.line + 1,
      kind,
    });
  };
  const recordLoadArgument = (expression, kind) => {
    if (ts.isStringLiteralLike(expression)) {
      record(expression, kind);
      return;
    }
    recordNonLiteral(
      expression,
      kind === "dynamic-import" ? "non-literal-import" : "non-literal-require",
    );
  };
  const loadKind = (expression) => {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) return callee.text;
    return "factory-require";
  };
  const collectBindings = (node) => {
    addNamedImportAliases(node, factoryNames);
    if (ts.isVariableDeclaration(node)) {
      addBindingPatternAliases(node.name, factoryNames);
      addFactoryBinding(node, factoryNames, requireCallees);
    }
    ts.forEachChild(node, collectBindings);
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      record(node.moduleSpecifier, "static");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      record(node.moduleReference.expression, "import-equals");
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      record(node.argument.literal, "import-type");
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const firstArgument = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        recordLoadArgument(firstArgument, "dynamic-import");
      } else if (
        isModuleLoadCallee(node.expression, requireCallees, factoryNames)
      ) {
        recordLoadArgument(firstArgument, loadKind(node.expression));
      } else if (isResolveCallee(node.expression, requireCallees)) {
        recordLoadArgument(firstArgument, "require.resolve");
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ["jest", "vi"].includes(node.expression.expression.text) &&
        node.expression.name.text === "mock"
      ) {
        record(firstArgument, "test-mock");
      }
    }
    ts.forEachChild(node, visit);
  };
  collectBindings(sourceFile);
  visit(sourceFile);
  return references;
}

export function collectProductionSourceFiles(
  rootPath,
  { includeTests = false } = {},
) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (
        SOURCE_FILE_PATTERN.test(entry.name) &&
        (includeTests ||
          !isTestOnlySourcePath(path.relative(rootPath, absolutePath)))
      ) {
        files.push(absolutePath);
      }
    }
  };
  visit(rootPath);
  return files.sort((left, right) => left.localeCompare(right));
}

export function resolveModuleReference(repoRoot, sourcePath, specifier) {
  const sourceRelativePath = relativePath(repoRoot, sourcePath);
  if (specifier.startsWith("@/")) {
    return normalizePath(
      path.posix.normalize(`apps/web/src/${specifier.slice(2)}`),
    );
  }
  if (/^(?:apps|packages)\/[^/]+\/src(?:\/|$)/.test(specifier)) {
    return normalizePath(path.posix.normalize(specifier));
  }
  if (!specifier.startsWith(".")) return null;
  return normalizePath(
    path.posix.normalize(
      path.posix.join(path.posix.dirname(sourceRelativePath), specifier),
    ),
  );
}

export function collectForbiddenModuleReferences({
  repoRoot,
  relativeRoots,
  excludedPrefixes = [],
  includeTests = false,
  isForbidden,
}) {
  const records = [];
  for (const root of relativeRoots) {
    const rootPath = path.join(repoRoot, root);
    if (!fs.existsSync(rootPath)) continue;
    for (const sourcePath of collectProductionSourceFiles(rootPath, {
      includeTests,
    })) {
      const file = relativePath(repoRoot, sourcePath);
      if (
        excludedPrefixes.some((prefix) => {
          const normalizedPrefix = normalizePath(prefix);
          return normalizedPrefix.endsWith("/")
            ? file.startsWith(normalizedPrefix)
            : file === normalizedPrefix;
        })
      )
        continue;
      const sourceText = fs.readFileSync(sourcePath, "utf8");
      for (const reference of collectModuleReferences(sourceText, sourcePath)) {
        const resolvedPath = resolveModuleReference(
          repoRoot,
          sourcePath,
          reference.specifier,
        );
        if (
          isForbidden({ file, specifier: reference.specifier, resolvedPath })
        ) {
          records.push({
            file,
            line: reference.line,
            specifier: reference.specifier,
            resolvedPath,
          });
        }
      }
    }
  }
  return records.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.specifier.localeCompare(right.specifier),
  );
}

function namedValueBindings(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.isTypeOnly ||
      !bindings ||
      !ts.isNamedImports(bindings)
    ) {
      return [];
    }
    return bindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text);
  }
  if (
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text);
  }
  return [];
}

export function collectNamedValueImports(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const names = namedValueBindings(statement);
    if (names.length === 0) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(
      statement.moduleSpecifier.getStart(sourceFile),
    );
    imports.push({
      specifier: statement.moduleSpecifier.text,
      line: position.line + 1,
      names,
    });
  }
  return imports;
}

const RUNTIME_WEB_IMPORT_ROOTS = Object.freeze([
  "packages/airi-runtime/src",
  "apps/temporal-worker/src",
]);

// apps/web is not an ES module package, so the worker loads its modules as
// CommonJS and ESM callers cannot link named value imports from them: worker
// startup fails with "does not provide an export named". Runtime code imports
// web modules as namespaces and reads values through readRuntimeExport.
export function findRuntimeWebNamedValueImports(repoRoot) {
  const records = [];
  for (const root of RUNTIME_WEB_IMPORT_ROOTS) {
    const rootPath = path.join(repoRoot, root);
    if (!fs.existsSync(rootPath)) continue;
    for (const sourcePath of collectProductionSourceFiles(rootPath)) {
      const sourceText = fs.readFileSync(sourcePath, "utf8");
      for (const entry of collectNamedValueImports(sourceText, sourcePath)) {
        const resolvedPath = resolveModuleReference(
          repoRoot,
          sourcePath,
          entry.specifier,
        );
        if (!isReverseWebReference(entry, resolvedPath)) continue;
        records.push({
          file: relativePath(repoRoot, sourcePath),
          line: entry.line,
          specifier: entry.specifier,
          names: entry.names,
        });
      }
    }
  }
  return records.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export function assertRuntimeWebNamespaceImports(repoRoot) {
  assert.deepEqual(
    findRuntimeWebNamedValueImports(repoRoot),
    [],
    "Import apps/web modules into runtime code with `import * as` and readRuntimeExport, or with `import type` for types.",
  );
}

function isReverseWebReference(reference, resolvedPath) {
  return (
    reference.specifier === "<non-literal>" ||
    reference.specifier.startsWith("@/") ||
    resolvedPath === "apps/web/src" ||
    resolvedPath?.startsWith("apps/web/src/")
  );
}

function webModuleKey(reference, resolvedPath) {
  return resolvedPath ?? reference.specifier;
}

function scanFiles(repoRoot, relativeRoots, callback) {
  for (const root of relativeRoots) {
    const rootPath = path.join(repoRoot, root);
    if (!fs.existsSync(rootPath)) continue;
    for (const sourcePath of collectProductionSourceFiles(rootPath)) {
      const file = relativePath(repoRoot, sourcePath);
      const sourceText = fs.readFileSync(sourcePath, "utf8");
      for (const reference of collectModuleReferences(sourceText, sourcePath)) {
        callback({
          file,
          sourcePath,
          reference,
          resolvedPath: resolveModuleReference(
            repoRoot,
            sourcePath,
            reference.specifier,
          ),
        });
      }
    }
  }
}

function sourceRoots(repoRoot) {
  const roots = [];
  for (const parent of ["apps", "packages"]) {
    const parentPath = path.join(repoRoot, parent);
    if (!fs.existsSync(parentPath)) continue;
    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        fs.existsSync(path.join(parentPath, entry.name, "src"))
      ) {
        roots.push(`${parent}/${entry.name}/src`);
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

export function assertScenarioActivityHostImports(repoRoot) {
  const scenarioActivityHostViolations = collectForbiddenModuleReferences({
    repoRoot,
    relativeRoots: ["apps/temporal-worker/src/activities"],
    includeTests: false,
    isForbidden: ({ file, specifier, resolvedPath }) =>
      file === "apps/temporal-worker/src/activities/airi-auto-reply.ts" &&
      (specifier === "<non-literal>" ||
        specifier.startsWith("@/") ||
        resolvedPath?.startsWith("apps/web/src/")) &&
      !SCENARIO_ACTIVITY_HOST_MODULES.has(
        resolvedPath?.replace(SOURCE_FILE_PATTERN, ""),
      ),
  });
  assert.deepEqual(scenarioActivityHostViolations, []);
}

export function assertScenarioPresentationImports(repoRoot) {
  // These modules perform server operations. Pure scenario helpers and the
  // declared Next.js server-action proxy remain valid presentation dependencies.
  const serverScenarioOwners = [
    "eval-flywheel",
    "legacy-routing-conversion-service",
    "legacy-routing-migration-preimage",
    "linked-condition-reconciler",
    "linked-condition-repository",
    "linked-conditions",
    "linked-conditions-validation",
    "linked-parent-summaries",
    "list-workspace-scenario-summaries",
    "prompt-optimizer",
    "scenario-asset-media-enrichment",
    "scenario-asset-resolve",
    "scenario-asset-storage",
    "scenario-create",
    "scenario-delete",
    "scenario-detail",
    "scenario-flow-analytics",
    "scenario-flow-suppression",
    "scenario-graph-mutation",
    "scenario-http",
    "scenario-save",
    "scenario-write-validation",
    "task-utils",
  ].map((owner) => `apps/web/src/lib/scenarios/${owner}`);
  const violations = collectForbiddenModuleReferences({
    repoRoot,
    relativeRoots: ["apps/web/src/components/scenarios"],
    isForbidden: ({ specifier, resolvedPath }) => {
      const modulePath = resolvedPath?.replace(SOURCE_FILE_PATTERN, "");
      const packagePath = specifier.replace(SOURCE_FILE_PATTERN, "");
      return (
        specifier === "<non-literal>" ||
        [
          "next/server",
          "next/headers",
          "server-only",
          "mongoose",
          "mongodb",
          "@icecore/airi-runtime/mongoose",
        ].some(
          (owner) =>
            packagePath === owner || packagePath.startsWith(`${owner}/`),
        ) ||
        [
          "apps/web/src/app/api",
          "apps/web/src/models",
          "apps/web/src/lib/mongo",
          "apps/web/src/lib/mongoose",
          "apps/web/src/lib/supabase/admin",
          "apps/web/src/lib/supabase/server",
          "apps/web/src/lib/supabase/workspace-api-access",
          "apps/web/src/features/panel/scenarios/server",
          "apps/web/src/lib/airi/scenario/scenario-runtime",
          "apps/web/src/lib/airi/scenario/auto-reply-runtime-dependencies",
          "apps/web/src/lib/airi/scenario/timer-runtime-dependencies",
          ...serverScenarioOwners,
        ].some(
          (owner) =>
            modulePath === owner || modulePath?.startsWith(`${owner}/`),
        )
      );
    },
  });
  assert.deepEqual(violations, []);
}

export function buildDependencyDebtSnapshot(repoRoot) {
  const airiRuntimeWeb = new Map();
  const temporalWorkerWeb = new Map();
  const otpRuntimeWeb = new Map();
  const directCrossWorkspaceSource = new Map();
  const reverseWebRoots = [
    ["packages/airi-runtime/src", airiRuntimeWeb],
    ["apps/temporal-worker/src", temporalWorkerWeb],
    ["packages/otp-runtime/src", otpRuntimeWeb],
  ];

  for (const [root, counts] of reverseWebRoots) {
    scanFiles(repoRoot, [root], ({ file, reference, resolvedPath }) => {
      if (isReverseWebReference(reference, resolvedPath)) {
        increment(counts, file);
      }
    });
  }

  scanFiles(
    repoRoot,
    sourceRoots(repoRoot),
    ({ file, reference, resolvedPath }) => {
      if (
        !resolvedPath ||
        !(
          reference.specifier.startsWith(".") ||
          /^(?:apps|packages)\//.test(reference.specifier)
        )
      ) {
        return;
      }
      const sourceOwner = workspaceOwner(file);
      const targetOwner = workspaceOwner(resolvedPath);
      if (sourceOwner && targetOwner && sourceOwner !== targetOwner) {
        increment(directCrossWorkspaceSource, file);
      }
    },
  );

  return {
    airiRuntimeWeb: sortedMap(airiRuntimeWeb),
    temporalWorkerWeb: sortedMap(temporalWorkerWeb),
    otpRuntimeWeb: sortedMap(otpRuntimeWeb),
    directCrossWorkspaceSource: sortedMap(directCrossWorkspaceSource),
  };
}

export function findBudgetViolations({ label, observed, allowed }) {
  return [...observed.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, count]) => {
      const maximum = allowed[file] ?? 0;
      return count > maximum
        ? [
            `${label}: ${file} has ${count} reference${count === 1 ? "" : "s"}; allowed ${maximum}`,
          ]
        : [];
    });
}

export function collectAiriRuntimeWebModules(repoRoot) {
  const modulesByFile = new Map();
  scanFiles(
    repoRoot,
    ["packages/airi-runtime/src"],
    ({ file, reference, resolvedPath }) => {
      if (!isReverseWebReference(reference, resolvedPath)) return;
      const modules = modulesByFile.get(file) ?? new Set();
      modules.add(webModuleKey(reference, resolvedPath));
      modulesByFile.set(file, modules);
    },
  );
  return new Map(
    [...modulesByFile.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, modules]) => [file, [...modules].sort()]),
  );
}

export function findUnknownModuleViolations({ label, observed, allowed }) {
  return [...observed.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, modules]) => {
      const allow = new Set(allowed[file] ?? []);
      return modules
        .filter((modulePath) => !allow.has(modulePath))
        .map((modulePath) => `${label}: ${file} imports ${modulePath}`);
    });
}

export function findStaleModuleViolations({ label, observed, allowed }) {
  return Object.keys(allowed)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((file) => {
      const actual = new Set(observed.get(file) ?? []);
      return allowed[file]
        .filter((modulePath) => !actual.has(modulePath))
        .map(
          (modulePath) => `${label}: ${file} no longer imports ${modulePath}`,
        );
    });
}

export function findCatalogFileMismatch({ label, budget, modules }) {
  const budgetFiles = new Set(Object.keys(budget));
  const moduleFiles = new Set(Object.keys(modules));
  return [
    ...[...budgetFiles]
      .filter((file) => !moduleFiles.has(file))
      .sort()
      .map(
        (file) =>
          `${label}: ${file} is in the count budget but not the module catalog`,
      ),
    ...[...moduleFiles]
      .filter((file) => !budgetFiles.has(file))
      .sort()
      .map(
        (file) =>
          `${label}: ${file} is in the module catalog but not the count budget`,
      ),
  ];
}

const WEB_MODULE_FILE_SUFFIXES = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cts",
  ".mts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
]);

export function resolveExistingWebModuleFile(repoRoot, moduleKey) {
  for (const suffix of WEB_MODULE_FILE_SUFFIXES) {
    const relative = `${moduleKey}${suffix}`;
    if (fs.existsSync(path.join(repoRoot, relative))) {
      return relative;
    }
  }
  return null;
}

export function findMissingWebModuleFiles({ label, repoRoot, allowed }) {
  return [...new Set(Object.values(allowed).flat())]
    .sort((left, right) => left.localeCompare(right))
    .filter((modulePath) => !resolveExistingWebModuleFile(repoRoot, modulePath))
    .map((modulePath) => `${label}: missing on disk ${modulePath}`);
}

export function assertAllowedWebModules(options) {
  const violations = [
    ...findUnknownModuleViolations(options),
    ...findStaleModuleViolations(options),
  ];
  assert.equal(violations.length, 0, violations.join("\n"));
}

export function assertAiriRuntimeWebCatalog(repoRoot) {
  const label = "airi-runtime web modules";
  const catalogViolations = [
    ...findCatalogFileMismatch({
      label,
      budget: LEGACY_AIRI_RUNTIME_WEB_BUDGET,
      modules: LEGACY_AIRI_RUNTIME_WEB_MODULES,
    }),
    ...findMissingWebModuleFiles({
      label,
      repoRoot,
      allowed: LEGACY_AIRI_RUNTIME_WEB_MODULES,
    }),
  ];
  assert.equal(catalogViolations.length, 0, catalogViolations.join("\n"));
  assertAllowedWebModules({
    label,
    observed: collectAiriRuntimeWebModules(repoRoot),
    allowed: LEGACY_AIRI_RUNTIME_WEB_MODULES,
  });
}

export function assertPerFileBudget(options) {
  const violations = findBudgetViolations(options);
  assert.equal(violations.length, 0, violations.join("\n"));
}

function readJson(repoRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

export function parseCommandChain(value, label = "command") {
  assert.equal(typeof value, "string", `${label} must be a command string`);

  const commands = [[]];
  const operators = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const pushToken = () => {
    if (!token) return;
    commands.at(-1).push(token);
    token = "";
  };
  const pushOperator = (operator) => {
    pushToken();
    operators.push(operator);
    commands.push([]);
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "\r" && value[index + 1] === "\n") {
      pushOperator("\n");
      index += 1;
    } else if (character === "\n") {
      pushOperator("\n");
    } else if (character === "&" && value[index + 1] === "&") {
      pushOperator("&&");
      index += 1;
    } else if (character === "|" && value[index + 1] === "|") {
      pushOperator("||");
      index += 1;
    } else if (character === ";" || character === "|") {
      pushOperator(character);
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      token += character;
    }
  }

  assert.equal(quote, null, `${label} contains an unterminated quote`);
  assert.equal(escaped, false, `${label} contains a dangling escape`);
  pushToken();
  return { commands, operators };
}

function withoutLeadingAssignments(tokens) {
  const commandIndex = tokens.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token),
  );
  return commandIndex < 0 ? [] : tokens.slice(commandIndex);
}

export function assertSingleCommand(value, { label, expectedTokens }) {
  const parsed = parseCommandChain(value, label);
  assert.deepEqual(
    parsed.operators,
    [],
    `${label} must be one unmasked command`,
  );
  assert.equal(
    parsed.commands.length,
    1,
    `${label} must be one unmasked command`,
  );
  const tokens = withoutLeadingAssignments(parsed.commands[0]);
  assert.deepEqual(tokens, expectedTokens, `${label} has unexpected tokens`);
  return tokens;
}

function assertWebCheckTypesCommand(value) {
  const label = "apps/web check-types";
  const parsed = parseCommandChain(value, label);
  assert.deepEqual(
    parsed.operators,
    [],
    `${label} must be one unmasked compiler command`,
  );
  assert.equal(
    parsed.commands.length,
    1,
    `${label} must be one unmasked compiler command`,
  );
  let tokens = withoutLeadingAssignments(parsed.commands[0]);
  if (tokens[0] === "pnpm" && tokens[1] === "exec") tokens = tokens.slice(2);
  assert.equal(tokens[0], "tsc", `${label} must invoke tsc`);
  assert.equal(
    tokens.length,
    4,
    `${label} permits only compiler/project flags`,
  );
  assert.equal(
    tokens.filter((token) => token === "--noEmit").length,
    1,
    `${label} must invoke tsc --noEmit`,
  );
  const projectFlags = tokens.flatMap((token, index) =>
    ["--project", "-p"].includes(token) ? [index] : [],
  );
  assert.equal(
    projectFlags.length,
    1,
    `${label} must select tsconfig.build.json once`,
  );
  // The production program that `next build` checks. The editor's
  // tsconfig.json adds every test root and needs more than 5 GB of heap.
  assert.equal(
    tokens[projectFlags[0] + 1]?.replace(/^\.\//, ""),
    "tsconfig.build.json",
    `${label} must select tsconfig.build.json`,
  );
}

function assertRootCheckTypesCommand(value) {
  const label = "root check-types";
  const parsed = parseCommandChain(value, label);
  assert.deepEqual(
    parsed.operators,
    ["&&"],
    `${label} must join exactly two gates with &&`,
  );
  assert.equal(
    parsed.commands.length,
    2,
    `${label} must contain exactly two gates`,
  );
  assert.deepEqual(
    withoutLeadingAssignments(parsed.commands[0]),
    ["pnpm", "run", "verify:dependency-direction"],
    `${label} must run dependency verification first`,
  );
  assert.deepEqual(
    withoutLeadingAssignments(parsed.commands[1]),
    ["turbo", "run", "check-types"],
    `${label} must run Turbo check-types second`,
  );
}

export function assertVerificationConfiguration(repoRoot) {
  const webPackage = readJson(repoRoot, "apps/web/package.json");
  const rootPackage = readJson(repoRoot, "package.json");
  const turbo = readJson(repoRoot, "turbo.json");
  assertWebCheckTypesCommand(webPackage.scripts?.["check-types"]);
  assertSingleCommand(webPackage.scripts?.["type-check"], {
    label: "apps/web type-check",
    expectedTokens: ["pnpm", "run", "check-types"],
  });
  assert.equal(
    webPackage.scripts?.["type-check:full"],
    undefined,
    "apps/web type-check:full must be absent",
  );
  assertSingleCommand(rootPackage.scripts?.["verify:dependency-direction"], {
    label: "root verify:dependency-direction executable verifier configuration",
    expectedTokens: ["node", ".github/scripts/verify-dependency-direction.mjs"],
  });
  assertRootCheckTypesCommand(rootPackage.scripts?.["check-types"]);

  assert.ok(
    turbo.tasks &&
      typeof turbo.tasks === "object" &&
      !Array.isArray(turbo.tasks),
    "turbo.json: tasks must be an object",
  );

  for (const taskName of [
    "@icecore/airi-runtime#check-types",
    "@icecore/airi-runtime#test",
    "@icecore/temporal-worker#check-types",
    "@icecore/temporal-worker#test",
  ]) {
    const task = turbo.tasks[taskName];
    assert.ok(
      task && typeof task === "object" && !Array.isArray(task),
      `turbo.json: task "${taskName}" must be an object`,
    );
    assert.ok(
      Array.isArray(task.inputs) &&
        task.inputs.includes("$TURBO_ROOT$/apps/web/src/**"),
      `turbo.json: task "${taskName}" inputs must include "$TURBO_ROOT$/apps/web/src/**"`,
    );
  }
}

export function verifyRepositoryDependencyContract(repoRoot) {
  assertVerificationConfiguration(repoRoot);
  const violations = collectForbiddenModuleReferences({
    repoRoot,
    relativeRoots: ["apps/web/src/app/api"],
    excludedPrefixes: [],
    includeTests: false,
    isForbidden: ({ resolvedPath }) =>
      resolvedPath === "apps/web/src/components" ||
      resolvedPath?.startsWith("apps/web/src/components/"),
  });
  assert.deepEqual(violations, []);
  const serverOwnedScenarioViolations = collectForbiddenModuleReferences({
    repoRoot,
    relativeRoots: [
      "apps/web/src/lib/scenario-generator",
      "apps/web/src/lib/scenarios",
      "apps/web/src/lib/whatsapp/flows",
      "apps/web/src/lib/whatsapp/qr-entry-points",
    ],
    includeTests: false,
    isForbidden: ({ resolvedPath }) =>
      resolvedPath === "apps/web/src/components/scenarios/types",
  });
  assert.deepEqual(serverOwnedScenarioViolations, []);
  const scenarioPersistenceOwners = new Set([
    "apps/web/src/lib/scenarios/scenario-graph-persistence.ts",
    "apps/web/src/lib/scenarios/scenario-serialization.ts",
    "apps/web/src/lib/scenarios/scenario-summary-serialization.ts",
  ]);
  const scenarioPersistenceTransportViolations =
    collectForbiddenModuleReferences({
      repoRoot,
      relativeRoots: ["apps/web/src/lib/scenarios"],
      includeTests: false,
      isForbidden: ({ file, specifier, resolvedPath }) => {
        if (!scenarioPersistenceOwners.has(file)) return false;
        const modulePath = resolvedPath?.replace(SOURCE_FILE_PATTERN, "");
        return (
          [
            "next",
            "next-auth",
            "mongoose",
            "mongodb",
            "@icecore/airi-runtime/mongoose",
          ].some(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          ) ||
          [
            "apps/web/src/app/api",
            "apps/web/src/lib/supabase",
            "apps/web/src/lib/auth",
            "apps/web/src/lib/mongoose",
            "apps/web/src/models",
            "apps/web/src/lib/scenarios/api-shared",
            "apps/web/src/lib/scenarios/scenario-http",
          ].some(
            (owner) =>
              modulePath === owner || modulePath?.startsWith(`${owner}/`),
          )
        );
      },
    });
  assert.deepEqual(scenarioPersistenceTransportViolations, []);
  assertScenarioPresentationImports(repoRoot);
  assertScenarioActivityHostImports(repoRoot);
  assertRuntimeWebNamespaceImports(repoRoot);
  const snapshot = buildDependencyDebtSnapshot(repoRoot);
  assertPerFileBudget({
    label: "airi-runtime web debt",
    observed: snapshot.airiRuntimeWeb,
    allowed: LEGACY_AIRI_RUNTIME_WEB_BUDGET,
  });
  assertAiriRuntimeWebCatalog(repoRoot);
  assertPerFileBudget({
    label: "temporal-worker web debt",
    observed: snapshot.temporalWorkerWeb,
    allowed: LEGACY_TEMPORAL_WORKER_WEB_BUDGET,
  });
  assertPerFileBudget({
    label: "otp-runtime web debt",
    observed: snapshot.otpRuntimeWeb,
    allowed: LEGACY_OTP_RUNTIME_WEB_BUDGET,
  });
  assertPerFileBudget({
    label: "direct cross-workspace source debt",
    observed: snapshot.directCrossWorkspaceSource,
    allowed: LEGACY_CROSS_WORKSPACE_SOURCE_BUDGET,
  });
}

function baselineSection(counts) {
  return {
    counts: Object.fromEntries(counts),
    references: [...counts.values()].reduce((sum, count) => sum + count, 0),
    files: counts.size,
  };
}

function printBaseline(repoRoot) {
  const snapshot = buildDependencyDebtSnapshot(repoRoot);
  console.log(
    JSON.stringify(
      {
        airiRuntimeWeb: baselineSection(snapshot.airiRuntimeWeb),
        airiRuntimeWebModules: Object.fromEntries(
          collectAiriRuntimeWebModules(repoRoot),
        ),
        temporalWorkerWeb: baselineSection(snapshot.temporalWorkerWeb),
        otpRuntimeWeb: baselineSection(snapshot.otpRuntimeWeb),
        directCrossWorkspaceSource: baselineSection(
          snapshot.directCrossWorkspaceSource,
        ),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  if (process.argv.includes("--print-baseline")) {
    printBaseline(repoRoot);
  } else {
    verifyRepositoryDependencyContract(repoRoot);
    console.log("Dependency direction contract verified.");
  }
}
