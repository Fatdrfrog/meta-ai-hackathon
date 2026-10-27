import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

describe("mongo errors", () => {
  it("detects Mongo duplicate key errors without local code copies", () => {
    expect(isMongoDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isMongoDuplicateKeyError({ code: "11000" })).toBe(true);
    expect(isMongoDuplicateKeyError({ codeName: "DuplicateKey" })).toBe(true);
    expect(isMongoDuplicateKeyError({ code: 42 })).toBe(false);
    expect(isMongoDuplicateKeyError(null)).toBe(false);
  });
});
