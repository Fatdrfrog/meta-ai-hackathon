import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const DEAD_CLASSIFIER_SCOPES = [
  "apps/web/src/lib/classifier",
  "apps/web/src/app/api/cron/classify",
  "apps/temporal-worker/src",
] as const;
const ACTIVE_LEARNING_SYMBOL = ["enqueue", "Low", "Confidence", "Sample"].join(
  ""
);
const ACTIVE_LEARNING_IMPORT = [
  "classifier",
  ["active", "learning"].join("-"),
].join("/");
const INTERNAL_LABEL_SYMBOLS = [
  ["resolve", "Stable", "Internal", "Labels"].join(""),
  ["internal", "Label", "Cache"].join(""),
  ["select", "Internal", "Label", "With", "Schema"].join(""),
] as const;
const CUSTOMER_STAGE_SYMBOL = [
  "record",
  "Customer",
  "Stage",
  "Snapshot",
  "For",
  "Conversation",
].join("");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: Dirent) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
    }
  );
}

const SCOPED_SOURCE_FILES = DEAD_CLASSIFIER_SCOPES.flatMap(scope =>
  sourceFiles(resolve(REPOSITORY_ROOT, scope))
);

function containsForbidden(source: string, forbidden: readonly string[]) {
  return forbidden.some(identifier => source.includes(identifier));
}

function matches(forbidden: readonly string[]): string[] {
  return SCOPED_SOURCE_FILES.filter(file => {
    const source = readFileSync(file, "utf8");
    return containsForbidden(source, forbidden);
  }).map(file => file.slice(REPOSITORY_ROOT.length + 1));
}

describe("dead classification paths", () => {
  it("has no active-learning producer, import, or owner file", () => {
    const retiredImportFixture = [
      "import retired from ",
      '"@/lib/classifier/',
      ["active", "learning"].join("-"),
      '"',
    ].join("");
    expect(
      containsForbidden(retiredImportFixture, [ACTIVE_LEARNING_IMPORT])
    ).toBe(true);
    expect(matches([ACTIVE_LEARNING_SYMBOL, ACTIVE_LEARNING_IMPORT])).toEqual(
      []
    );
    const ownerFileName = [["active", "learning"].join("-"), "ts"].join(".");
    expect(
      existsSync(
        resolve(REPOSITORY_ROOT, "apps/web/src/lib/classifier", ownerFileName)
      )
    ).toBe(false);
  });

  it("has no classifier-owned internal-label inference", () => {
    expect(matches(INTERNAL_LABEL_SYMBOLS)).toEqual([]);
  });

  it("has no classifier-owned customer-stage snapshot effect", () => {
    expect(matches([CUSTOMER_STAGE_SYMBOL])).toEqual([]);
  });

  it("keeps the reconciliation cron surface exact", () => {
    expect(
      readdirSync(
        resolve(REPOSITORY_ROOT, "apps/web/src/app/api/cron/classify"),
        { withFileTypes: true }
      )
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()
    ).toEqual(["route.test.ts", "route.ts"]);
  });
});
