import { test } from "node:test";
import assert from "node:assert/strict";
import { sumTo } from "./sum.js";

test("sumTo(0) is 0", () => assert.equal(sumTo(0), 0));
test("sumTo(1) is 1", () => assert.equal(sumTo(1), 1));
test("sumTo(5) is 15", () => assert.equal(sumTo(5), 15));
test("sumTo(10) is 55", () => assert.equal(sumTo(10), 55));
test("sumTo(-3) is 0", () => assert.equal(sumTo(-3), 0));
