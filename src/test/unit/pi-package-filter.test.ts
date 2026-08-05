// Headless tests for the marketplace "is this a Pi package?" filter
// (pi-package-filter.ts). The keyword match used to be a substring `includes("pi")`,
// so "api", "scipy", "compiler", "happy"… all falsely matched — these tests pin
// the tightened behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPiKeyword, isPiMarketplacePackage } from "../../pi-package-filter.js";

test("matchesPiKeyword: matches genuine pi keywords (case/space tolerant)", () => {
  for (const k of ["pi", "pi-coding-agent", "pi-web-access", "PI", " pi ", "Pi-Tool"]) {
    assert.equal(matchesPiKeyword(k), true, k);
  }
});

test("matchesPiKeyword: rejects substring false-positives", () => {
  for (const k of ["api", "scipy", "pip", "compiler", "happy", "pi.js", "raspberry-pi", ""]) {
    assert.equal(matchesPiKeyword(k), false, k);
  }
});

test("isPiMarketplacePackage: pi-prefixed or -pi- name", () => {
  assert.equal(isPiMarketplacePackage({ name: "pi-web-access" }), true);
  assert.equal(isPiMarketplacePackage({ name: "my-pi-tool" }), true);
  assert.equal(isPiMarketplacePackage({ name: "express" }), false);
});

test("isPiMarketplacePackage: a genuine pi keyword qualifies", () => {
  assert.equal(isPiMarketplacePackage({ name: "x", keywords: ["pi-coding-agent"] }), true);
  assert.equal(isPiMarketplacePackage({ name: "x", keywords: ["pi"] }), true);
});

test("isPiMarketplacePackage: pi-agent descriptions qualify", () => {
  assert.equal(isPiMarketplacePackage({ name: "x", description: "A Pi coding agent extension" }), true);
  assert.equal(isPiMarketplacePackage({ name: "x", description: "helper for the pi agent" }), true);
  assert.equal(isPiMarketplacePackage({ name: "x", description: "pi extension for diagnostics" }), true);
});

test("isPiMarketplacePackage: the old false-positive case is now rejected", () => {
  // name/desc unrelated, only a substring-"pi" keyword ("api") → must be false now.
  assert.equal(isPiMarketplacePackage({ name: "scipy", description: "scientific python", keywords: ["api", "science"] }), false);
  assert.equal(isPiMarketplacePackage({}), false);
});
