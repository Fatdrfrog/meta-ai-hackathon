import fs from "node:fs";
import path from "node:path";

describe("workspace AI allowance translations", () => {
  it.each(["en", "ru", "kz"])(
    "keeps %s lifetime allowance and own-key policy visible",
    locale => {
      const root = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), "messages", `${locale}.json`),
          "utf8"
        )
      );
      const integration = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "messages",
            "settings",
            "integrations",
            locale,
            "page.json"
          ),
          "utf8"
        )
      );
      const allowance = root.AppSidebar.limits.textAi;
      expect(allowance.remaining).toContain("{remaining}");
      expect(allowance.remaining).toContain("{limit}");
      // The included allowance is per company lifetime and never resets.
      expect(allowance).not.toHaveProperty("reset");
      for (const key of [
        "loading",
        "unavailable",
        "shared",
        "lifetime",
        "customerReady",
        "customerActive",
        "exhausted",
        "spendLimit",
        "connect",
      ]) {
        expect(typeof allowance[key]).toBe("string");
        expect(allowance[key].length).toBeGreaterThan(5);
      }
      expect(integration.GoogleAIIntegration.capabilitiesDescription).toContain(
        "500"
      );
      expect(integration.GoogleAIIntegration.capabilitiesDescription).toContain(
        "Pro"
      );
    }
  );
});
