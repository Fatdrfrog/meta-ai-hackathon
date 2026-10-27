import { fnv1a32 } from "./fnv1a";

const UTF16_FNV1A_VECTORS = [
  { value: "", hash: 2166136261, shard64: 5 },
  { value: "a", hash: 3826002220, shard64: 44 },
  { value: "abc", hash: 440920331, shard64: 11 },
  { value: "507f1f77bcf86cd799439011", hash: 2201264063, shard64: 63 },
  { value: "message:abc123", hash: 402732698, shard64: 26 },
  { value: "🙂", hash: 2368824094, shard64: 30 },
] as const;

describe("fnv1a32", () => {
  it.each(UTF16_FNV1A_VECTORS)(
    "hashes the UTF-16 input $value to its stable unsigned 32-bit vector",
    ({ value, hash, shard64 }) => {
      expect(fnv1a32(value)).toBe(hash);
      expect(fnv1a32(value) % 64).toBe(shard64);
    }
  );
});
