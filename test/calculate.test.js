const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

global.window = {};
require("../pricing-calculator.js");
const { calculate, defaultSelection } = window.PricingCalculator;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "pricing.json"), "utf8"));

function sel(overrides) {
  const s = defaultSelection(cfg);
  return Object.assign(s, overrides, { options: Object.assign(s.options, overrides.options || {}) });
}

test("default: Base, 5 pages, monthly Maintenance", () => {
  const r = calculate(cfg, sel({}));
  assert.strictEqual(r.oneTime, 1600);
  assert.strictEqual(r.recurring, 69);
});

test("yearly care plan gives 3 months free and a capped website discount", () => {
  const r = calculate(cfg, sel({ billing: "yearly" }));
  assert.strictEqual(r.recurring, 69 * 9);
  assert.strictEqual(r.oneTime, 1600 - 150); // 10% would be 160, capped at 150
});

test("Advanced + 2 extra languages + 2-week delivery, no care plan", () => {
  const r = calculate(cfg, sel({ tier: "advanced", plan: "none", options: { languages: "3", delivery: "2w" } }));
  // (2500 + 4×200 + 200) × 1.20
  assert.strictEqual(r.oneTime, 4200);
  assert.strictEqual(r.recurring, null);
});

test("yearly Hosting discount is 5%, max CHF 30", () => {
  const r = calculate(cfg, sel({ plan: "hosting", billing: "yearly", quantity: 1 }));
  assert.strictEqual(r.oneTime, 970); // 5% would be 50, capped at 30
  assert.strictEqual(r.recurring, 225);
});
