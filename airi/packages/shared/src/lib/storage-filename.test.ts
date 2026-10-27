import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeStorageFilename } from "./storage-filename";

test("sanitizeStorageFilename keeps safe names and replaces unsafe characters", () => {
  assert.equal(
    sanitizeStorageFilename("photo_01.final-v2.png", "x"),
    "photo_01.final-v2.png",
  );
  assert.equal(
    sanitizeStorageFilename("my photo (1).jpg", "x"),
    "my-photo-1-.jpg",
  );
  assert.equal(sanitizeStorageFilename("a///b   c.txt", "x"), "a-b-c.txt");
  assert.equal(sanitizeStorageFilename("--a--b--", "x"), "-a-b-");
});

test("sanitizeStorageFilename maps Unicode to dashes without ever emptying the name", () => {
  assert.equal(sanitizeStorageFilename("Сәлем.mp4", "x"), "-.mp4");
  assert.equal(sanitizeStorageFilename("🌍", "x"), "-");
  assert.equal(sanitizeStorageFilename("你好 world.ogg", "x"), "-world.ogg");
});

test("sanitizeStorageFilename returns the fallback as given only for empty input", () => {
  assert.equal(sanitizeStorageFilename("", "file-1.bin"), "file-1.bin");
  assert.equal(sanitizeStorageFilename(null, "source.mp4"), "source.mp4");
  assert.equal(sanitizeStorageFilename(undefined, "a b"), "a b");
  assert.equal(sanitizeStorageFilename(" ", "x"), "-");
});

test("sanitizeStorageFilename caps the cleaned name at 120 characters", () => {
  assert.equal(sanitizeStorageFilename("a".repeat(200), "x"), "a".repeat(120));
  assert.equal(
    sanitizeStorageFilename("a".repeat(119) + "é.png", "x"),
    "a".repeat(119) + "-",
  );
  assert.equal(sanitizeStorageFilename("é".repeat(300), "x"), "-");
});
