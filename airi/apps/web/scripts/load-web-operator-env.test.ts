import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

it("loads app-first env fallbacks with native quoting while preserving external values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airi-mongo-env-"));
  const apps = path.join(root, "apps");
  const app = path.join(apps, "web");
  fs.mkdirSync(apps);
  fs.mkdirSync(app);
  const files = [
    [
      path.join(app, ".env.local"),
      'AIRI_TEST_EXTERNAL=file\nAIRI_TEST_APP_LOCAL=app-local\nexport AIRI_TEST_QUOTED="# literal" # outside comment',
    ],
    [path.join(app, ".env"), "AIRI_TEST_APP_LOCAL=wrong\nAIRI_TEST_APP=app"],
    [
      path.join(root, ".env.local"),
      "AIRI_TEST_APP=wrong\nAIRI_TEST_ROOT_LOCAL=root-local",
    ],
    [
      path.join(root, ".env"),
      "AIRI_TEST_ROOT_LOCAL=wrong\nAIRI_TEST_ROOT=root",
    ],
  ];
  try {
    for (const [file, content] of files) fs.writeFileSync(file, content);
    const helper = pathToFileURL(
      path.resolve(__dirname, "load-web-operator-env.ts")
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      const { loadWebOperatorEnv } = await import(${JSON.stringify(helper)});
      loadWebOperatorEnv();
      console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AIRI_TEST_')))));
    `,
      ],
      { cwd: app, env: { AIRI_TEST_EXTERNAL: "external" }, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      AIRI_TEST_EXTERNAL: "external",
      AIRI_TEST_APP_LOCAL: "app-local",
      AIRI_TEST_QUOTED: "# literal",
      AIRI_TEST_APP: "app",
      AIRI_TEST_ROOT_LOCAL: "root-local",
      AIRI_TEST_ROOT: "root",
    });
  } finally {
    for (const [file] of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(app);
    fs.rmdirSync(apps);
    fs.rmdirSync(root);
  }
});
