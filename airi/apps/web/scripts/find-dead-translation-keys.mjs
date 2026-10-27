import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_ROOT = path.resolve(__dirname, "../messages");
const SRC_ROOT = path.resolve(__dirname, "../src");
const LOCALES = ["en", "kz", "ru"];

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function collectLeafPaths(value, prefix = []) {
  if (typeof value === "string") return [prefix.join(".")];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    collectLeafPaths(child, [...prefix, key])
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sourceFiles = listFiles(SRC_ROOT).filter(file => /\.(ts|tsx)$/.test(file));
const allSourceText = sourceFiles.map(file => fs.readFileSync(file, "utf8"));
const combinedSource = allSourceText.join("\n");

/** @typedef {{ staticKeys: Set<string>, rawPrefixes: Set<string>, templatePatterns: Array<{ prefix: string, suffix: string }> }} NamespaceUsage */

/** @type {Map<string, NamespaceUsage>} */
const namespaceUsage = new Map();

function emptyUsage() {
  return {
    staticKeys: new Set(),
    rawPrefixes: new Set(),
    templatePatterns: [],
  };
}

function getNamespaceUsage(rootNamespace) {
  const cached = namespaceUsage.get(rootNamespace);
  if (cached) return cached;

  const usage = emptyUsage();
  const escapedRoot = escapeRegex(rootNamespace);
  const hookPattern = new RegExp(
    `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:useTranslations|getTranslations)\\(\\s*(?:\\{\\s*namespace:\\s*)?["'](${escapedRoot}(?:\\.[^"']+)?)["']`,
    "g"
  );

  for (const text of allSourceText) {
    let hookMatch;
    while ((hookMatch = hookPattern.exec(text))) {
      const identifier = hookMatch[1];
      const hookNamespace = hookMatch[2];
      const namespacePrefix =
        hookNamespace === rootNamespace
          ? ""
          : hookNamespace.slice(rootNamespace.length + 1);
      const after = text;

      const addStaticKey = key => {
        usage.staticKeys.add(
          namespacePrefix ? `${namespacePrefix}.${key}` : key
        );
      };
      const addRawPrefix = prefix => {
        usage.rawPrefixes.add(
          namespacePrefix ? `${namespacePrefix}.${prefix}` : prefix
        );
      };
      const addTemplatePattern = pattern => {
        usage.templatePatterns.push({
          prefix: namespacePrefix
            ? `${namespacePrefix}.${pattern.prefix}`
            : pattern.prefix,
          suffix: pattern.suffix,
        });
      };

      const staticCallPattern = new RegExp(
        `\\b${escapeRegex(identifier)}(?:\\?\\.)?\\(\\s*["']([^"']+)["']`,
        "g"
      );
      let staticMatch;
      while ((staticMatch = staticCallPattern.exec(after))) {
        addStaticKey(staticMatch[1]);
      }

      const rawStaticPattern = new RegExp(
        `\\b${escapeRegex(identifier)}\\.raw\\(\\s*["']([^"']+)["']`,
        "g"
      );
      let rawStaticMatch;
      while ((rawStaticMatch = rawStaticPattern.exec(after))) {
        addRawPrefix(rawStaticMatch[1]);
      }

      const rawTemplatePattern = new RegExp(
        `\\b${escapeRegex(identifier)}\\.raw\\(\\s*\`([^\`]*)\``,
        "g"
      );
      let rawTemplateMatch;
      while ((rawTemplateMatch = rawTemplatePattern.exec(after))) {
        const parts = rawTemplateMatch[1].split(/\$\{[^}]+\}/);
        if (parts.length >= 2) {
          addTemplatePattern({
            prefix: parts[0],
            suffix: parts.slice(1).join(""),
          });
        } else if (parts[0]) {
          addRawPrefix(parts[0]);
        }
      }

      const templateCallPattern = new RegExp(
        `\\b${escapeRegex(identifier)}(?:\\?\\.)?\\(\\s*\`([^\`]*)\``,
        "g"
      );
      let templateMatch;
      while ((templateMatch = templateCallPattern.exec(after))) {
        const parts = templateMatch[1].split(/\$\{[^}]+\}/);
        if (parts.length >= 2) {
          addTemplatePattern({
            prefix: parts[0],
            suffix: parts.slice(1).join(""),
          });
        }
      }
    }
  }

  namespaceUsage.set(rootNamespace, usage);
  return usage;
}

function hasNamespaceRef(namespace) {
  const escaped = escapeRegex(namespace);
  const nextIntl = new RegExp(
    `(useTranslations|getTranslations|createTranslator)\\(\\s*(?:\\{\\s*namespace:\\s*)?["']${escaped}(?:[."']|$)`
  );
  const direct = new RegExp(`\\.${escaped}\\b`);
  return nextIntl.test(combinedSource) || direct.test(combinedSource);
}

function matchesTemplatePattern(key, pattern) {
  if (!key.startsWith(pattern.prefix)) return false;
  if (pattern.suffix && !key.endsWith(pattern.suffix)) return false;
  return true;
}

function isKeyReferenced(namespace, key) {
  const usage = getNamespaceUsage(namespace);

  if (usage.staticKeys.has(key)) return true;

  for (const prefix of usage.rawPrefixes) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return true;
  }

  for (const pattern of usage.templatePatterns) {
    if (matchesTemplatePattern(key, pattern)) return true;
  }

  for (const staticKey of usage.staticKeys) {
    if (key.startsWith(`${staticKey}.`) || staticKey.startsWith(`${key}.`)) {
      return true;
    }
  }

  if (!key.includes(".")) {
    const directPropertyAccess = new RegExp(`\\bi18n\\.${escapeRegex(key)}\\b`);
    const namespaceTypeField = new RegExp(
      `\\b${escapeRegex(namespace)}Translations\\b[\\s\\S]*?\\b${escapeRegex(key)}\\s*:\\s*string`
    );
    if (
      directPropertyAccess.test(combinedSource) ||
      namespaceTypeField.test(combinedSource)
    ) {
      return true;
    }
  }

  return (
    combinedSource.includes(`"${key}"`) || combinedSource.includes(`'${key}'`)
  );
}

function deleteLeafPath(value, leafPath) {
  const parts = leafPath.split(".");
  let current = value;

  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (!current || typeof current !== "object" || !(part in current)) {
      return value;
    }
    current = current[part];
  }

  const leaf = parts.at(-1);
  if (current && typeof current === "object" && leaf && leaf in current) {
    delete current[leaf];
  }

  return value;
}

function pruneEmptyObjects(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      pruneEmptyObjects(child);
      if (Object.keys(child).length === 0) {
        delete value[key];
      }
    }
  }

  return value;
}

function collectMessageFiles() {
  const files = [];

  for (const locale of LOCALES) {
    files.push({
      locale,
      file: path.join(MESSAGES_ROOT, `${locale}.json`),
      bundleId: "root",
    });
  }

  for (const file of listFiles(MESSAGES_ROOT)) {
    const relativePath = path.relative(MESSAGES_ROOT, file).replace(/\\/g, "/");
    const match = relativePath.match(/^(.*)\/(en|kz|ru)\/page\.json$/);
    if (!match) continue;
    const [, bundleId, locale] = match;
    files.push({ locale, file, bundleId });
  }

  return files;
}

function removeDeadKeysFromMessages(deadKeyEntries) {
  const deadByNamespace = new Map();
  for (const entry of deadKeyEntries) {
    if (!deadByNamespace.has(entry.namespace)) {
      deadByNamespace.set(entry.namespace, new Set());
    }
    deadByNamespace.get(entry.namespace).add(entry.key);
  }

  let removedCount = 0;

  for (const { file } of collectMessageFiles()) {
    if (!fs.existsSync(file)) continue;

    const messages = readJson(file);
    let changed = false;

    for (const [namespace, keys] of deadByNamespace.entries()) {
      if (!(namespace in messages)) continue;
      for (const key of keys) {
        const before = JSON.stringify(messages[namespace]);
        messages[namespace] = deleteLeafPath(messages[namespace], key);
        messages[namespace] = pruneEmptyObjects(messages[namespace]);
        if (JSON.stringify(messages[namespace]) !== before) {
          changed = true;
          removedCount += 1;
        }
      }
      if (
        messages[namespace] &&
        typeof messages[namespace] === "object" &&
        Object.keys(messages[namespace]).length === 0
      ) {
        delete messages[namespace];
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(file, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    }
  }

  return removedCount;
}

const namespaceMessages = new Map();

for (const locale of LOCALES) {
  const file = path.join(MESSAGES_ROOT, `${locale}.json`);
  if (!fs.existsSync(file)) continue;
  const messages = readJson(file);
  for (const [namespace, value] of Object.entries(messages)) {
    if (!namespaceMessages.has(namespace)) {
      namespaceMessages.set(namespace, new Set());
    }
    for (const leaf of collectLeafPaths(value)) {
      namespaceMessages.get(namespace).add(leaf);
    }
  }
}

for (const file of listFiles(MESSAGES_ROOT)) {
  const relativePath = path.relative(MESSAGES_ROOT, file).replace(/\\/g, "/");
  const match = relativePath.match(/^(.*)\/en\/page\.json$/);
  if (!match) continue;
  const messages = readJson(file);
  for (const [namespace, value] of Object.entries(messages)) {
    if (!namespaceMessages.has(namespace)) {
      namespaceMessages.set(namespace, new Set());
    }
    for (const leaf of collectLeafPaths(value)) {
      namespaceMessages.get(namespace).add(leaf);
    }
  }
}

const deadKeys = [];
const unreferencedNamespaces = [];

for (const [namespace, definedKeys] of [...namespaceMessages.entries()].sort()) {
  if (!hasNamespaceRef(namespace)) {
    unreferencedNamespaces.push({ namespace, keyCount: definedKeys.size });
    continue;
  }

  for (const key of [...definedKeys].sort()) {
    if (!isKeyReferenced(namespace, key)) {
      deadKeys.push({ namespace, key });
    }
  }
}

console.log("=== Unreferenced namespaces ===");
if (unreferencedNamespaces.length === 0) {
  console.log("(none)");
} else {
  for (const entry of unreferencedNamespaces) {
    console.log(`${entry.namespace} (${entry.keyCount} keys)`);
  }
}

console.log("\n=== Dead keys ===");
for (const entry of deadKeys) {
  console.log(`${entry.namespace}.${entry.key}`);
}
console.log(`\nTotal dead keys: ${deadKeys.length}`);

const shouldRemove = process.argv.includes("--remove");
if (shouldRemove) {
  const removedCount = removeDeadKeysFromMessages(deadKeys);
  console.log(`\nRemoved ${removedCount} dead key entries across message files.`);
}
