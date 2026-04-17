import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, utcStamp, fmtDuration, pad, loadPackageVersion } from "../../src/util.ts";

test("slugify: lowercases ascii", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("slugify: collapses runs of non-alnum into single dash", () => {
  assert.equal(slugify("a   b___c!!!d"), "a-b-c-d");
});

test("slugify: strips leading and trailing dashes", () => {
  assert.equal(slugify("---abc---"), "abc");
});

test("slugify: caps at 64 chars", () => {
  const s = slugify("a".repeat(200));
  assert.equal(s.length, 64);
  assert.equal(s, "a".repeat(64));
});

test("slugify: unicode/punctuation becomes dashes", () => {
  // The implementation only matches /[a-z0-9]/ so accents are stripped to dashes.
  assert.equal(slugify("café-déjà-vu"), "caf-d-j-vu");
});

test("slugify: empty input returns empty string", () => {
  assert.equal(slugify(""), "");
});

test("slugify: input that is only separators returns empty string", () => {
  assert.equal(slugify("---!!!---"), "");
});

test("utcStamp: deterministic with fixed Date", () => {
  const d = new Date("2026-04-17T19:23:45.123Z");
  assert.equal(utcStamp(d), "2026-04-17T19-23-45Z");
});

test("fmtDuration: ms under one second", () => {
  assert.equal(fmtDuration(0), "0ms");
  assert.equal(fmtDuration(999), "999ms");
});

test("fmtDuration: seconds with one decimal under a minute", () => {
  assert.equal(fmtDuration(1000), "1.0s");
  assert.equal(fmtDuration(12_345), "12.3s");
});

test("fmtDuration: minutes/seconds at and above 60s", () => {
  assert.equal(fmtDuration(60_000), "1m00s");
  assert.equal(fmtDuration(125_000), "2m05s");
});

test("pad: right-pads with spaces when shorter", () => {
  assert.equal(pad("hi", 5), "hi   ");
});

test("pad: returns input unchanged when equal/longer than length", () => {
  assert.equal(pad("hello", 5), "hello");
  assert.equal(pad("hellooo", 3), "hellooo");
});

test("loadPackageVersion: reads a non-empty semver from package.json", () => {
  const v = loadPackageVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});
