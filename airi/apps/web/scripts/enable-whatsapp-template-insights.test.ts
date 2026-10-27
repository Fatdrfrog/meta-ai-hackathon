import packageJson from "../package.json";
import { parseArgs } from "./enable-whatsapp-template-insights";

// Both scripts import server-only modules, which throw without this condition.
it.each([
  [
    "operator:whatsapp-template-insights",
    "scripts/enable-whatsapp-template-insights.ts",
  ],
  [
    "backfill:whatsapp-campaign-costs",
    "scripts/backfill-whatsapp-campaign-costs.ts",
  ],
])(
  "the %s package script runs with the react-server condition",
  (name, file) => {
    expect((packageJson.scripts as Record<string, string>)[name]).toBe(
      `tsx --conditions=react-server ${file}`
    );
  }
);

describe("enable-whatsapp-template-insights arguments", () => {
  it("dry-runs by default and may list every workspace", () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      workspaceId: null,
      sourceId: null,
      afterSourceId: null,
      limit: 50,
    });
    expect(parseArgs(["--limit=500", "--after-source-id=s9"])).toMatchObject({
      apply: false,
      afterSourceId: "s9",
      limit: 200,
    });
  });

  it.each([
    [["--apply"]],
    [["--apply", "--workspace-id=w1"]],
    [["--apply", "--limit=1"]],
    [["--apply", "--source-id="]],
  ])("refuses an irreversible apply without one reviewed source (%j)", argv => {
    expect(() => parseArgs(argv)).toThrow("--apply requires --source-id");
  });

  it("applies to exactly the named source", () => {
    expect(
      parseArgs(["--workspace-id=w1", "--source-id=s1", "--apply"])
    ).toMatchObject({ apply: true, workspaceId: "w1", sourceId: "s1" });
    expect(parseArgs(["--apply", "--dry-run"])).toMatchObject({
      apply: false,
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--all"])).toThrow("Unknown argument: --all");
  });
});
