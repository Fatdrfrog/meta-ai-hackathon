/**
 * @jest-environment node
 */

import { resolveQwenImageSize } from "./qwen-image-config";

describe("qwen-image-config", () => {
  it("maps Studio aspect ratios to Qwen 2.0 sizes", () => {
    expect(resolveQwenImageSize("9:16")).toBe("1536*2688");
    expect(resolveQwenImageSize("16:9")).toBe("2688*1536");
    expect(resolveQwenImageSize("1:1")).toBe("2048*2048");
    expect(resolveQwenImageSize("4:3")).toBe("2368*1728");
    expect(resolveQwenImageSize("3:4")).toBe("1728*2368");
    expect(resolveQwenImageSize("unknown")).toBe("1536*2688");
  });
});
