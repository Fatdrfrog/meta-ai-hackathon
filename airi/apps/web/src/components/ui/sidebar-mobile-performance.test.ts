import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("mobile sidebar performance styling", () => {
  it("uses a shorter transform animation for the mobile knowledge-base drawer", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/ui/sidebar.tsx"),
      "utf8"
    );

    expect(source).toContain("data-[state=open]:duration-150");
    expect(source).toContain("data-[state=closed]:duration-150");
    expect(source).toContain("will-change-transform");
  });
});
