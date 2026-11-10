# priceCalc

Website and care plan price calculator. A static site (no build step) that deploys to Vercel as-is, plus an embeddable widget you can drop into other sites.

## Files

- `index.html`: the page
- `pricing.json`: all prices, plans, discounts and currencies. Edit this to change prices
- `pricing-calculator.js`: the widget (no dependencies)
- `test/`: price calculation tests, run with `npm test`

## Run locally

```
npm start   # serves on http://localhost:3000
npm test
```

## Deploy

Import the repo in Vercel. Framework preset: Other. No build command, output directory is the repo root.

## The widget

One dependency-free script (`pricing-calculator.js`, ~20 KB) that renders a live price calculator from a JSON config. Styles are isolated in Shadow DOM, so it won't clash with your site's CSS (and your CSS won't break it).



## Embed

**Config file** (easiest when several sites share the script):

```html
<div data-pricing-calculator data-config="/pricing.json"></div>
<script src="/js/pricing-calculator.js" defer></script>
```

**Inline config** (works in WordPress / Webflow / Shopify "custom HTML" blocks):

```html
<div data-pricing-calculator>
  <script type="application/json">{ "title": "…", "tiers": [ … ] }</script>
</div>
<script src="https://your-cdn/pricing-calculator.js" defer></script>
```

**JavaScript / React:**

```js
const calc = PricingCalculator.mount(document.getElementById("calc"), config);
calc.getState();        // { total, breakdown, selection, … }
calc.setConfig(other);  // swap config
calc.destroy();
```

## Config reference

| Key | What it does |
|---|---|
| `title`, `subtitle`, `note`, `totalLabel` | Text |
| `currencies[]` | `{ code, locale, rate, roundTo, default }`. All prices are written in the first/base currency; others are converted by `rate`. Shows a switcher unless `showCurrencySwitcher: false`. Force one per page with `data-currency="EUR"` on the div |
| `currency`, `locale`, `decimals` | Single-currency shortcut and number formatting |
| `tiers[]` | `{ id, label, description, price, included, unitPrice, default }`. `included`/`unitPrice` override the quantity settings per tier |
| `basePrice` | Use instead of tiers for a single fixed base |
| `quantity` | `{ label, unitLabel, min, max, step, default, included, unitPrice }` slider + number box |
| `options[]` | `{ id, label, display: "select" \| "buttons", choices: [{ id, label, price \| percent, default }] }` |
| `addons[]` | Checkboxes: `{ id, label, description, price \| percent, perUnit, perUnitLabel, default }` |
| `recurring` | Care plan section: `{ title, subtitle, plans: [{ id, label, price (per month), features[] }], allowNone, noneLabel }`. Shown as a second total |
| `billing[]` | `{ id, label, suffix, multiplier, listMultiplier, months, badge, savingLabel, showEquivalent: "That's {amount} per month" }`. Yearly with 3 months free = `multiplier: 9, listMultiplier: 12, months: 12`. Applies to the care plan when `recurring` exists, otherwise to the whole total |
| `conditionalDiscounts[]` | `{ when: { plan, billing, tier, <optionId> }, percent, max, label }` (`max` caps the discount in base currency) discount on the one-time price when all conditions match |
| `volumeDiscounts[]` | `{ minQuantity, percent, label }` (highest matching applies) |
| `coupons[]` | `{ code, percent }` or `{ code, amount }` |
| `minimumPrice` | Floor for the total |
| `showBreakdown` | `false` hides the line items |
| `cta` | `{ label, url, newTab }` links with the selection in the query string, or `{ label, callback: "fnName" }` calls `window.fnName(detail)` |
| `theme` | `accent, accentText, accentSoft, background, text, muted, border, soft, radius, font, maxWidth` |

### Calculation order

One-time: tier price → extra units × unit price → fixed options/add-ons (e.g. delivery fee) → % surcharges (e.g. languages) → volume discount → conditional discounts → coupon → minimum price.

Recurring: plan monthly price × billing multiplier.

## Events

- `pricecalc:change` fires on every change with `event.detail = { oneTime, recurring, currency, plan, billing, breakdown, selection }`. Good for analytics or filling a hidden form field.
- `pricecalc:submit` fires when a CTA without a `url` is clicked.

## Note on coupons

Coupon codes live in the public config, so anyone can read them. Treat the widget as an estimate and validate final prices server-side (checkout, invoice) if that matters.
