import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("temporal worker does not use static named imports from web aliases", () => {
  const srcDir = path.resolve(process.cwd(), "src");
  const offenders: string[] = [];
  const importPattern =
    /import\s+(?!type\b)([^;]*?)\s+from\s+["'](@\/(?:lib|models)\/[^"']+)["'];/g;

  for (const filePath of collectTypeScriptFiles(srcDir)) {
    const source = fs.readFileSync(filePath, "utf8");
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(source))) {
      const clause = (match[1] || "").trim();
      if (!clause.startsWith("{") && !clause.includes(", {")) continue;

      const line = source.slice(0, match.index).split(/\r?\n/).length;
      offenders.push(
        `${path.relative(process.cwd(), filePath)}:${line} imports ${match[2]} as ${clause.replace(/\s+/g, " ")}`,
      );
    }
  }

  assert.deepEqual(offenders, []);
});

test("temporal worker imports WhatsApp message processor from runtime package", () => {
  const srcDir = path.resolve(process.cwd(), "src");
  const offenders: string[] = [];
  const forbiddenPattern =
    /["']@\/lib\/whatsapp\/message-processor["']|["'][^"']*apps\/web\/src\/lib\/whatsapp\/message-processor["']/g;

  for (const filePath of collectTypeScriptFiles(srcDir)) {
    const source = fs.readFileSync(filePath, "utf8");
    let match: RegExpExecArray | null;
    while ((match = forbiddenPattern.exec(source))) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      offenders.push(`${path.relative(process.cwd(), filePath)}:${line}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("customer status intent persistence uses the namespace/default runtime adapter", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src/whatsapp-webhook-runtime-dependencies.ts"),
    "utf8",
  );
  const namespaceImport = source.match(
    /import\s+\*\s+as\s+(\w+)\s+from\s+["']@\/lib\/customer-webhook-intents["'];/,
  );
  assert.ok(namespaceImport, "customer webhook intents must use a namespace import");
  const resolvedModule = source.match(
    new RegExp(`const\\s+(\\w+)\\s*=\\s*getRuntimeModule\\(${namespaceImport[1]}\\);`),
  );
  assert.ok(resolvedModule, "resolve the CommonJS default export before using the builder");
  assert.match(
    source,
    new RegExp(`customerWebhookIntent:\\s*${resolvedModule[1]}\\.buildCustomerStatusWebhookIntent\\(params\\)`),
  );
});

test("WhatsApp intake paths share one plan gate bound to company limits", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src/whatsapp-webhook-runtime-dependencies.ts"),
    "utf8",
  );
  const gate = source.match(
    /const\s+(\w+)\s*=\s*createWhatsAppIntakePlanGate\(\{\s*readPlan:\s*readWhatsAppIntakeCompanyPlan,?\s*\}\);/,
  );
  assert.ok(gate, "bind the gate to the company-limits plan read");
  // The new-conversation cap must reach every processWhatsAppMessage caller.
  assert.match(
    source,
    new RegExp(
      `processSharedWhatsAppMessage\\(\\{\\s*\\.\\.\\.params,[^}]*getNewConversationPlanSkip:\\s*${gate[1]}\\.getNewConversationSkip,`,
    ),
  );
  // Live messages, echoes and history all use the trial-expired intake lock.
  assert.equal(
    source.match(
      new RegExp(
        `getWhatsAppIntakePlanSkip:\\s*${gate[1]}\\.getIntakeSkip,`,
        "g",
      ),
    )?.length,
    3,
  );
});
