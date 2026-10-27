const path = require("node:path");
const nextJest = require("next/jest");

// Next's compiler rewrites <style jsx> to imports of styled-jsx, which only
// next itself depends on; resolve it from there.
const styledJsxDir = path.dirname(
  require.resolve("styled-jsx/package.json", {
    paths: [path.dirname(require.resolve("next/package.json"))],
  })
);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  testEnvironment: "node", // Use node for RAG tests (no DOM needed)
  setupFiles: ["<rootDir>/jest.setup-env.js"],
  moduleNameMapper: {
    "^styled-jsx/(.*)$": `${styledJsxDir}/$1`,
    "^@/(.*)$": "<rootDir>/src/$1",
    "^marked$": "<rootDir>/jest.mocks/marked.js",
    "^server-only$": "<rootDir>/jest.mocks/empty.js",
    // next-intl 4 is ESM-only; suites may still override this with jest.mock.
    "^next-intl$": "<rootDir>/jest.mocks/next-intl.js",
  },
  testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  testPathIgnorePatterns: [
    // Playwright and database suites run on their own. Escaped absolute paths,
    // because a Windows <rootDir> puts unescaped backslashes into the pattern.
    ...["tests", "e2e"].map(dir =>
      escapeRegExp(path.join(__dirname, dir, path.sep))
    ),
    "[\\\\/]__tests__[\\\\/].*fixtures\\.[jt]s$",
  ],
  collectCoverageFrom: [
    "src/**/*.{js,jsx,ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/*.stories.{js,jsx,ts,tsx}",
    "!src/**/__tests__/**",
    "!src/**/*.test.{js,jsx,ts,tsx}",
    "!src/**/*.spec.{js,jsx,ts,tsx}",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);
