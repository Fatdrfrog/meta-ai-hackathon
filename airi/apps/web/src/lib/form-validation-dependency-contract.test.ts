import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Version = readonly [major: number, minor: number, patch: number];

const ZOD_V4_CORE_EXPORT_MINIMUM: Version = [3, 25, 0];

function readWebDependencyRange(dependency: string): string {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const range = packageJson.dependencies?.[dependency];

  if (!range) {
    throw new Error(`Missing web dependency: ${dependency}`);
  }

  return range;
}

function readMinimumVersion(range: string): Version {
  const match = range.match(/^(?:\^|~)?(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(`Unsupported dependency range: ${range}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

describe("form validation dependency contract", () => {
  it("only allows Zod versions that expose zod/v4/core for Hook Form resolvers", () => {
    const zodRange = readWebDependencyRange("zod");

    expect(
      compareVersions(readMinimumVersion(zodRange), ZOD_V4_CORE_EXPORT_MINIMUM)
    ).toBeGreaterThanOrEqual(0);
    expect(() => require.resolve("zod/v4/core")).not.toThrow();
  });

  it("links Zod beside Hook Form resolvers instead of relying on hoisting", () => {
    const resolverPackageDirectory = dirname(
      require.resolve("@hookform/resolvers/package.json")
    );
    const resolverDependencyDirectory = resolve(
      resolverPackageDirectory,
      "..",
      ".."
    );

    expect(existsSync(join(resolverDependencyDirectory, "zod"))).toBe(true);
  });
});
