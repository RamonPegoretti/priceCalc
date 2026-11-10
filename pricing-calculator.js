/*!
 * Pricing Calculator v2 — embeddable, dependency-free widget.
 *
 * Usage (config from a URL):
 *   <div data-pricing-calculator data-config="/pricing.json"></div>
 *   <script src="pricing-calculator.js" defer></script>
 *
 * Usage (inline config):
 *   <div data-pricing-calculator>
 *     <script type="application/json">{ ...config... }</script>
 *   </div>
 *
 * Usage (JavaScript):
 *   PricingCalculator.mount(element, config)  -> { getState, setConfig, destroy }
 *
 * Every change fires "pricecalc:change" on the host element with
 * { oneTime, recurring, currency, billing, breakdown, selection } in event.detail.
 *
 * All prices in the config are written in the base currency (the first entry
 * of `currencies`, or `currency`). Other currencies are converted with `rate`.
 */
(function (global) {
  "use strict";

  // ---------- pricing engine (pure, no DOM) ----------

  function find(list, id) {
    return (list || []).filter(function (x) { return x.id === id; })[0];
  }
  function pickDefault(list) {
    return (list || []).filter(function (x) { return x.default; })[0] || (list || [])[0];
  }

  function currencyList(cfg) {
    if (cfg.currencies && cfg.currencies.length) return cfg.currencies;
    return [{ code: cfg.currency || "USD", locale: cfg.locale || "en-US", rate: 1 }];
  }

  function defaultSelection(cfg) {
    var sel = { tier: null, quantity: null, options: {}, addons: {}, billing: null, plan: null, coupon: "", currency: null };
    var t = pickDefault(cfg.tiers); if (t) sel.tier = t.id;
    if (cfg.quantity) sel.quantity = cfg.quantity.default != null ? cfg.quantity.default : (cfg.quantity.min || 1);
    (cfg.options || []).forEach(function (o) { sel.options[o.id] = pickDefault(o.choices).id; });
    (cfg.addons || []).forEach(function (a) { sel.addons[a.id] = !!a.default; });
    var b = pickDefault(cfg.billing); if (b) sel.billing = b.id;
    if (cfg.recurring) {
      var p = pickDefault(cfg.recurring.plans);
      sel.plan = cfg.recurring.allowNone && cfg.recurring.noneDefault ? "none" : (p ? p.id : "none");
    }
    sel.currency = (pickDefault(currencyList(cfg)) || {}).code;
    return sel;
  }

  function matches(when, sel) {
    if (!when) return true;
    return Object.keys(when).every(function (k) {
      var v = k === "plan" || k === "billing" || k === "tier" ? sel[k] : sel.options[k];
      return Array.isArray(when[k]) ? when[k].indexOf(v) >= 0 : when[k] === v;
    });
  }

  /**
   * One-time part, in order:
   *   1. tier base price
   *   2. quantity beyond "included" × unit price (both can be set per tier)
   *   3. fixed-price options and add-ons (add-ons can be per unit)
   *   4. percentage surcharges from options/add-ons, on the subtotal so far
   *   5. volume discount, conditional discounts (e.g. "yearly care plan"), coupon
   *   6. minimum price
   * Recurring part: selected plan's monthly price × billing multiplier
   * (e.g. yearly = 9 → three months free).
   * Without a `recurring` block, the billing multiplier applies to the whole total.
   * Amounts are returned in the base currency.
   */
  function calculate(cfg, sel) {
    var lines = [];
    var qty = sel.quantity != null ? Number(sel.quantity) : 1;
    var tier = find(cfg.tiers, sel.tier);
    var subtotal = 0;

    if (tier) {
      subtotal += tier.price || 0;
      lines.push({ label: tier.label, amount: tier.price || 0 });
    } else if (cfg.basePrice) {
      subtotal += cfg.basePrice;
      lines.push({ label: cfg.basePriceLabel || "Base price", amount: cfg.basePrice });
    }

    if (cfg.quantity) {
      var q = cfg.quantity;
      var included = tier && tier.included != null ? tier.included : (q.included || 0);
      var unit = tier && tier.unitPrice != null ? tier.unitPrice : (q.unitPrice || 0);
      var extra = Math.max(0, qty - included);
      if (extra > 0 && unit) {
        subtotal += extra * unit;
        lines.push({ label: extra + " × " + (extra === 1 ? (q.unitLabel || "unit") : (q.unitLabelPlural || q.unitLabel || "units")), amount: extra * unit, unit: unit });
      }
    }

    var percents = [];
    function applyItem(label, item) {
      if (item.percent) percents.push({ label: label, percent: item.percent });
      var price = item.price || 0;
      if (item.perUnit) price *= qty;
      if (price) { subtotal += price; lines.push({ label: label, amount: price }); }
    }
    (cfg.options || []).forEach(function (o) {
      var c = find(o.choices, sel.options[o.id]);
      if (c && (c.price || c.percent)) applyItem((o.summaryLabel || o.label) + ": " + c.label, c);
    });
    (cfg.addons || []).forEach(function (a) { if (sel.addons[a.id]) applyItem(a.label, a); });

    var base = subtotal;
    percents.forEach(function (p) {
      var amt = base * p.percent / 100;
      subtotal += amt;
      lines.push({ label: p.label + " (" + (p.percent > 0 ? "+" : "") + p.percent + "%)", amount: amt });
    });

    function discount(label, percent, max) {
      var d = -subtotal * percent / 100;
      var capped = max != null && -d > max;
      if (capped) d = -max;
      subtotal += d;
      lines.push({ label: label + (capped ? " (max)" : " (−" + percent + "%)"), amount: d, discount: true });
    }

    if (cfg.volumeDiscounts && cfg.quantity) {
      var vd = cfg.volumeDiscounts
        .filter(function (d) { return qty >= d.minQuantity; })
        .sort(function (a, b) { return b.minQuantity - a.minQuantity; })[0];
      if (vd) discount(vd.label || "Volume discount", vd.percent);
    }

    (cfg.conditionalDiscounts || []).forEach(function (cd) {
      if (matches(cd.when, sel)) discount(cd.label || "Discount", cd.percent, cd.max);
    });

    var couponApplied = null;
    if (sel.coupon && cfg.coupons) {
      var code = String(sel.coupon).trim().toUpperCase();
      var cp = cfg.coupons.filter(function (c) { return String(c.code).toUpperCase() === code; })[0];
      if (cp) {
        var cAmt = cp.percent ? -subtotal * cp.percent / 100 : -(cp.amount || 0);
        cAmt = Math.max(cAmt, -subtotal);
        subtotal += cAmt;
        couponApplied = cp.code;
        lines.push({ label: "Coupon " + cp.code, amount: cAmt, discount: true });
      }
    }

    var floored = false;
    if (cfg.minimumPrice && subtotal < cfg.minimumPrice) { subtotal = cfg.minimumPrice; floored = true; }

    var billing = find(cfg.billing, sel.billing) || null;
    var mult = billing && billing.multiplier ? billing.multiplier : 1;
    var oneTime = subtotal;
    var recurring = null, recurringLines = [], plan = null;

    if (cfg.recurring) {
      plan = find(cfg.recurring.plans, sel.plan) || null;
      if (plan) {
        var monthly = plan.price || 0;
        recurring = monthly * mult;
        recurringLines.push({ label: plan.label, amount: monthly * (billing && billing.listMultiplier || mult) });
        if (billing && billing.listMultiplier && billing.listMultiplier !== mult) {
          recurringLines.push({ label: billing.savingLabel || "Yearly saving", amount: recurring - monthly * billing.listMultiplier, discount: true });
        }
      }
    } else if (mult !== 1) {
      oneTime = subtotal * mult;
    }

    return {
      oneTime: oneTime,
      recurring: recurring,
      monthlyEquivalent: recurring != null ? recurring / (billing && billing.months || 1) : null,
      plan: plan,
      billing: billing,
      lines: lines,
      recurringLines: recurringLines,
      couponApplied: couponApplied,
      couponInvalid: !!(sel.coupon && !couponApplied),
      floored: floored
    };
  }

  // ---------- rendering ----------

  var CSS = [
    ":host{all:initial;display:block;font-family:var(--pc-font,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);color:var(--pc-text,#1a1a1a)}",
    "*{box-sizing:border-box}",
    ".pc{background:var(--pc-bg,#fff);border:1px solid var(--pc-border,#e3e3e8);border-radius:var(--pc-radius,14px);padding:24px;max-width:var(--pc-max-width,600px);margin:0 auto}",
    ".head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:0 0 20px}",
    "h3{margin:0 0 4px;font-size:1.25rem}",
    "h4{margin:28px 0 4px;font-size:1.05rem;padding-top:20px;border-top:1px solid var(--pc-border,#e3e3e8)}",
    ".sub{margin:0;color:var(--pc-muted,#666);font-size:.95rem}",
    ".sec{margin:0 0 20px}",
    ".lbl{display:block;font-weight:600;font-size:.9rem;margin:0 0 8px}",
    ".seg{display:flex;flex-wrap:wrap;gap:6px;background:var(--pc-soft,#f3f3f6);padding:4px;border-radius:10px}",
    ".seg button{flex:1 1 0;min-width:64px;border:0;background:transparent;padding:8px 6px;border-radius:8px;font:inherit;font-size:.9rem;cursor:pointer;color:inherit;white-space:nowrap}",
    ".seg button[aria-pressed=true]{background:var(--pc-bg,#fff);box-shadow:0 1px 3px rgba(0,0,0,.12);font-weight:600}",
    ".seg button small{display:block;font-size:.75rem;color:var(--pc-muted,#666);font-weight:400}",
    ".cur{flex:0 0 auto}.cur button{flex:0 0 auto;padding:5px 10px;font-size:.8rem}",
    ".badge{display:inline-block;margin-left:6px;font-size:.7rem;padding:2px 6px;border-radius:99px;background:var(--pc-accent,#4f46e5);color:var(--pc-accent-text,#fff);font-weight:600}",
    ".tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}",
    ".tier{display:flex;flex-direction:column;justify-content:flex-start;text-align:left;border:2px solid var(--pc-border,#e3e3e8);background:var(--pc-bg,#fff);border-radius:12px;padding:12px;cursor:pointer;font:inherit;color:inherit}",
    ".tier[aria-pressed=true]{border-color:var(--pc-accent,#4f46e5);background:var(--pc-accent-soft,#eef2ff)}",
    ".tier b{display:block;font-size:.95rem}.tier span{display:block;font-size:.85rem;color:var(--pc-muted,#666);margin-top:2px}",
    ".tier ul{margin:6px 0 0;padding-left:16px;font-size:.8rem;color:var(--pc-muted,#666)}",
    ".tier .p{color:inherit;font-weight:600;margin-top:auto;padding-top:6px}",
    ".qty{display:flex;align-items:center;gap:12px}",
    ".qty input[type=range]{flex:1;accent-color:var(--pc-accent,#4f46e5)}",
    ".qty input[type=number]{width:80px;padding:6px 8px;border:1px solid var(--pc-border,#e3e3e8);border-radius:8px;font:inherit}",
    ".hint{font-size:.8rem;color:var(--pc-muted,#666);margin-top:6px}",
    "select,.coupon input{width:100%;padding:9px 10px;border:1px solid var(--pc-border,#e3e3e8);border-radius:8px;font:inherit;background:var(--pc-bg,#fff);color:inherit}",
    ".add{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--pc-soft,#f3f3f6);cursor:pointer}",
    ".add:first-of-type{border-top:0}",
    ".add input{margin-top:3px;accent-color:var(--pc-accent,#4f46e5);width:16px;height:16px}",
    ".add .t{flex:1}.add .t small{display:block;color:var(--pc-muted,#666)}",
    ".add .p{font-size:.9rem;color:var(--pc-muted,#666);white-space:nowrap}",
    ".coupon{display:flex;gap:8px}.msg{font-size:.8rem;margin-top:6px}",
    ".err{color:#c0392b}.ok{color:#1e8e3e}",
    ".sum{border-top:1px solid var(--pc-border,#e3e3e8);padding-top:16px;margin-top:8px}",
    ".bd{list-style:none;padding:0;margin:0 0 8px;font-size:.88rem;color:var(--pc-muted,#666)}",
    ".bd li{display:flex;justify-content:space-between;gap:12px;padding:3px 0}.bd .disc{color:#1e8e3e}",
    ".tot{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px}",
    ".tot .k{font-weight:600}.tot .k small{display:block;font-weight:400;font-size:.8rem;color:var(--pc-muted,#666)}",
    ".tot .v{font-size:1.75rem;font-weight:700;letter-spacing:-.02em;white-space:nowrap}.tot .s{font-size:.95rem;color:var(--pc-muted,#666);font-weight:500}",
    ".note{font-size:.8rem;color:var(--pc-muted,#666);margin-top:4px}",
    ".cta{display:block;width:100%;text-align:center;margin-top:16px;padding:12px;border:0;border-radius:10px;background:var(--pc-accent,#4f46e5);color:var(--pc-accent-text,#fff);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}",
    ".cta:hover{filter:brightness(1.08)}"
  ].join("");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mount(host, config) {
    var cfg = config;
    var sel = defaultSelection(cfg);
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var fmtCache = {};

    function cur() { return find(currencyList(cfg).map(function (c) { c.id = c.code; return c; }), sel.currency) || currencyList(cfg)[0]; }
    // Convert a base-currency amount into the selected currency, rounded.
    function conv(n) {
      var c = cur(), step = c.roundTo || cfg.roundTo || 1;
      return Math.round(n * (c.rate || 1) / step) * step;
    }
    function money(n) {
      var c = cur();
      if (!fmtCache[c.code]) {
        var d = cfg.decimals != null ? cfg.decimals : 0;
        fmtCache[c.code] = new Intl.NumberFormat(c.locale || cfg.locale || "en-US", { style: "currency", currency: c.code, maximumFractionDigits: d, minimumFractionDigits: d });
      }
      var v = conv(n);
      return (v < 0 ? "−" : "") + fmtCache[c.code].format(Math.abs(v));
    }
    function priceTag(item) {
      if (item.percent) return (item.percent > 0 ? "+" : "") + item.percent + "%";
      if (!item.price) return cfg.includedLabel || "Included";
      return "+" + money(item.price) + (item.perUnit ? " / " + esc(item.perUnitLabel || (cfg.quantity && cfg.quantity.unitLabel) || "unit") : "");
    }

    function applyTheme() {
      var t = cfg.theme || {};
      var map = { accent: "--pc-accent", accentText: "--pc-accent-text", accentSoft: "--pc-accent-soft", background: "--pc-bg", text: "--pc-text", muted: "--pc-muted", border: "--pc-border", soft: "--pc-soft", radius: "--pc-radius", font: "--pc-font", maxWidth: "--pc-max-width" };
      Object.keys(map).forEach(function (k) { if (t[k]) host.style.setProperty(map[k], t[k]); });
      fmtCache = {};
    }

    function tierCard(attr, t, priceText) {
      var h = '<button type="button" class="tier" ' + attr + '="' + esc(t.id) + '" aria-pressed="' + ((attr === "data-tier" ? sel.tier : sel.plan) === t.id) + '"><b>' + esc(t.label) + '</b>';
      if (t.description) h += '<span>' + esc(t.description) + '</span>';
      if (t.features && t.features.length) h += '<ul>' + t.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join("") + '</ul>';
      return h + '<span class="p">' + priceText + '</span></button>';
    }

    function render() {
      var h = '<style>' + CSS + '</style><div class="pc" part="container"><div class="head"><div>';
      if (cfg.title) h += '<h3>' + esc(cfg.title) + '</h3>';
      if (cfg.subtitle) h += '<p class="sub">' + esc(cfg.subtitle) + '</p>';
      h += '</div>';
      var cl = currencyList(cfg);
      if (cl.length > 1 && cfg.showCurrencySwitcher !== false) {
        h += '<div class="seg cur" role="group" aria-label="Currency">';
        cl.forEach(function (c) { h += '<button type="button" data-currency="' + esc(c.code) + '" aria-pressed="' + (sel.currency === c.code) + '">' + esc(c.code) + '</button>'; });
        h += '</div>';
      }
      h += '</div>';

      if (!cfg.recurring) h += billingToggle();

      if (cfg.tiers && cfg.tiers.length) {
        h += '<div class="sec"><span class="lbl">' + esc(cfg.tiersLabel || "Plan") + '</span><div class="tiers">';
        cfg.tiers.forEach(function (t) {
          var extra = t.unitPrice && cfg.quantity ? '<br><small style="font-weight:400">+' + money(t.unitPrice) + ' / ' + esc(cfg.quantity.unitLabel || "unit") + '</small>' : "";
          h += tierCard("data-tier", t, money(t.price || 0) + extra);
        });
        h += '</div></div>';
      }

      if (cfg.quantity) {
        var q = cfg.quantity;
        h += '<div class="sec"><label class="lbl" for="pc-q">' + esc(q.label || "Quantity") + '</label><div class="qty">' +
          '<input type="range" id="pc-q" min="' + (q.min || 1) + '" max="' + (q.max || 100) + '" step="' + (q.step || 1) + '" value="' + sel.quantity + '" data-qty>' +
          '<input type="number" aria-label="' + esc(q.label || "Quantity") + '" min="' + (q.min || 1) + '" max="' + (q.max || 100) + '" step="' + (q.step || 1) + '" value="' + sel.quantity + '" data-qty></div>' +
          (q.hint ? '<div class="hint">' + esc(q.hint) + '</div>' : '') + '</div>';
      }

      (cfg.options || []).forEach(function (o) {
        h += '<div class="sec"><label class="lbl" for="pc-o-' + esc(o.id) + '">' + esc(o.label) + '</label>';
        if (o.display === "buttons") {
          h += '<div class="seg" role="group" aria-label="' + esc(o.label) + '">';
          o.choices.forEach(function (c) {
            h += '<button type="button" data-option="' + esc(o.id) + '" data-choice="' + esc(c.id) + '" aria-pressed="' + (sel.options[o.id] === c.id) + '">' + esc(c.label) +
              (o.showPrices !== false ? '<small>' + ((c.price || c.percent) ? priceTag(c) : esc(o.zeroLabel || "")) + '</small>' : '') + '</button>';
          });
          h += '</div>';
        } else {
          h += '<select id="pc-o-' + esc(o.id) + '" data-option="' + esc(o.id) + '">';
          o.choices.forEach(function (c) {
            var tag = (c.price || c.percent) ? " (" + priceTag(c) + ")" : "";
            h += '<option value="' + esc(c.id) + '"' + (sel.options[o.id] === c.id ? " selected" : "") + '>' + esc(c.label + tag) + '</option>';
          });
          h += '</select>';
        }
        if (o.hint) h += '<div class="hint">' + esc(o.hint) + '</div>';
        h += '</div>';
      });

      if (cfg.addons && cfg.addons.length) {
        h += '<div class="sec"><span class="lbl">' + esc(cfg.addonsLabel || "Add-ons") + '</span>';
        cfg.addons.forEach(function (a) {
          h += '<label class="add"><input type="checkbox" data-addon="' + esc(a.id) + '"' + (sel.addons[a.id] ? " checked" : "") + '>' +
            '<span class="t">' + esc(a.label) + (a.description ? '<small>' + esc(a.description) + '</small>' : '') + '</span>' +
            '<span class="p">' + priceTag(a) + '</span></label>';
        });
        h += '</div>';
      }

      if (cfg.recurring) {
        var r = cfg.recurring;
        h += '<h4>' + esc(r.title || "Care plan") + '</h4>';
        if (r.subtitle) h += '<p class="sub" style="margin-bottom:14px">' + esc(r.subtitle) + '</p>';
        h += billingToggle();
        h += '<div class="sec"><div class="tiers">';
        r.plans.forEach(function (p) { h += tierCard("data-plan", p, money(p.price || 0) + '<small style="font-weight:400"> ' + esc(r.perMonthLabel || "/ month") + '</small>'); });
        if (r.allowNone) h += tierCard("data-plan", { id: "none", label: r.noneLabel || "No plan", description: r.noneDescription }, "—");
        h += '</div></div>';
      }

      if (cfg.coupons && cfg.coupons.length) {
        h += '<div class="sec"><label class="lbl" for="pc-c">Coupon code</label><div class="coupon"><input id="pc-c" data-coupon placeholder="Enter code" value="' + esc(sel.coupon) + '"></div><div class="msg" data-coupon-msg></div></div>';
      }

      h += '<div class="sum" aria-live="polite" data-summary></div></div>';
      root.innerHTML = h;
      updateSummary();
    }

    function billingToggle() {
      if (!cfg.billing || cfg.billing.length < 2) return "";
      var h = '<div class="sec"><div class="seg" role="group" aria-label="Billing">';
      cfg.billing.forEach(function (b) {
        h += '<button type="button" data-billing="' + esc(b.id) + '" aria-pressed="' + (sel.billing === b.id) + '">' + esc(b.label) + (b.badge ? '<span class="badge">' + esc(b.badge) + '</span>' : '') + '</button>';
      });
      return h + '</div></div>';
    }

    function list(lines) {
      if (cfg.showBreakdown === false || !lines.length) return "";
      return '<ul class="bd">' + lines.map(function (l) {
        return '<li class="' + (l.discount ? "disc" : "") + '"><span>' + esc(l.label) + '</span><span>' + money(l.amount) + '</span></li>';
      }).join("") + '</ul>';
    }

    function updateSummary() {
      var r = calculate(cfg, sel);
      var b = r.billing;
      var s = list(r.lines);
      if (cfg.recurring) {
        s += '<div class="tot"><span class="k">' + esc(cfg.oneTimeLabel || "Website") + '<small>' + esc(cfg.oneTimeSuffix || "one-time") + '</small></span><span class="v">' + money(r.oneTime) + '</span></div>';
        if (r.recurring != null) {
          s += list(r.recurringLines);
          s += '<div class="tot"><span class="k">' + esc(cfg.recurring.title || "Care plan") + '<small>' + esc(b && b.label || "") + '</small></span><span class="v">' + money(r.recurring) + (b && b.suffix ? '<span class="s">' + esc(b.suffix) + '</span>' : '') + '</span></div>';
          if (b && b.months && b.months !== 1 && b.showEquivalent) s += '<div class="note">' + esc(b.showEquivalent.replace("{amount}", money(r.monthlyEquivalent))) + '</div>';
        }
      } else {
        s += '<div class="tot"><span class="k">' + esc(cfg.totalLabel || "Total") + '</span><span class="v">' + money(r.oneTime) + (b && b.suffix ? '<span class="s">' + esc(b.suffix) + '</span>' : '') + '</span></div>';
      }
      if (r.floored) s += '<div class="note">Minimum order ' + money(cfg.minimumPrice) + '</div>';
      if (cfg.note) s += '<div class="note">' + esc(cfg.note) + '</div>';
      if (cfg.cta) {
        if (cfg.cta.url) {
          s += '<a class="cta" part="cta" href="' + esc(buildUrl(cfg.cta.url, r)) + '"' + (cfg.cta.newTab ? ' target="_blank" rel="noopener"' : '') + '>' + esc(cfg.cta.label || "Get started") + '</a>';
        } else {
          s += '<button type="button" class="cta" part="cta" data-cta>' + esc(cfg.cta.label || "Get started") + '</button>';
        }
      }
      root.querySelector("[data-summary]").innerHTML = s;

      var msg = root.querySelector("[data-coupon-msg]");
      if (msg) {
        msg.className = "msg " + (r.couponApplied ? "ok" : r.couponInvalid ? "err" : "");
        msg.textContent = r.couponApplied ? "Code applied" : r.couponInvalid ? "That code isn't valid" : "";
      }
      host.dispatchEvent(new CustomEvent("pricecalc:change", { bubbles: true, detail: detail(r) }));
    }

    function detail(r) {
      return {
        oneTime: conv(r.oneTime),
        recurring: r.recurring != null ? conv(r.recurring) : null,
        total: conv(r.oneTime),
        currency: cur().code,
        billing: r.billing && r.billing.id,
        plan: r.plan && r.plan.id,
        breakdown: r.lines.concat(r.recurringLines).map(function (l) { return { label: l.label, amount: conv(l.amount), discount: !!l.discount }; }),
        selection: JSON.parse(JSON.stringify(sel))
      };
    }

    function buildUrl(url, r) {
      var d = detail(r), params = [];
      if (sel.tier) params.push(["plan", sel.tier]);
      if (sel.quantity != null && cfg.quantity) params.push(["qty", sel.quantity]);
      Object.keys(sel.options).forEach(function (k) { params.push([k, sel.options[k]]); });
      var on = Object.keys(sel.addons).filter(function (k) { return sel.addons[k]; });
      if (on.length) params.push(["addons", on.join(",")]);
      if (sel.plan) params.push(["care", sel.plan]);
      if (sel.billing) params.push(["billing", sel.billing]);
      if (r.couponApplied) params.push(["coupon", r.couponApplied]);
      params.push(["currency", d.currency], ["total", d.oneTime]);
      if (d.recurring != null) params.push(["recurring", d.recurring]);
      return url + (url.indexOf("?") >= 0 ? "&" : "?") + params.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&");
    }

    function onClick(e) {
      var t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.currency) { sel.currency = t.dataset.currency; render(); }
      else if (t.dataset.billing) { sel.billing = t.dataset.billing; render(); }
      else if (t.dataset.tier) { sel.tier = t.dataset.tier; render(); }
      else if (t.dataset.plan) { sel.plan = t.dataset.plan; render(); }
      else if (t.dataset.option) { sel.options[t.dataset.option] = t.dataset.choice; render(); }
      else if (t.hasAttribute("data-cta")) {
        var d = detail(calculate(cfg, sel));
        host.dispatchEvent(new CustomEvent("pricecalc:submit", { bubbles: true, detail: d }));
        if (cfg.cta && typeof global[cfg.cta.callback] === "function") global[cfg.cta.callback](d);
      }
    }
    function onInput(e) {
      var t = e.target;
      if (t.hasAttribute("data-qty")) {
        var q = cfg.quantity, v = Number(t.value);
        if (isNaN(v) || t.value === "") return;
        v = Math.min(q.max || 100, Math.max(q.min || 1, v));
        sel.quantity = v;
        root.querySelectorAll("[data-qty]").forEach(function (el) { if (el !== t) el.value = v; });
        updateSummary();
      } else if (t.dataset.option) { sel.options[t.dataset.option] = t.value; updateSummary(); }
      else if (t.dataset.addon) { sel.addons[t.dataset.addon] = t.checked; updateSummary(); }
      else if (t.hasAttribute("data-coupon")) { sel.coupon = t.value; updateSummary(); }
    }

    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    applyTheme();
    render();

    return {
      getState: function () { return detail(calculate(cfg, sel)); },
      setCurrency: function (code) { sel.currency = code; render(); },
      setConfig: function (c) { cfg = c; sel = defaultSelection(cfg); applyTheme(); render(); },
      destroy: function () { root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onInput); root.innerHTML = ""; }
    };
  }

  function autoMount() {
    var els = document.querySelectorAll("[data-pricing-calculator]:not([data-pc-mounted])");
    Array.prototype.forEach.call(els, function (el) {
      el.setAttribute("data-pc-mounted", "");
      var inline = el.querySelector('script[type="application/json"]');
      var go = function (c) {
        if (el.dataset.currency) c.defaultCurrency = el.dataset.currency;
        el._pricingCalculator = mount(el, c);
        if (c.defaultCurrency) el._pricingCalculator.setCurrency(c.defaultCurrency);
      };
      if (inline) {
        try { go(JSON.parse(inline.textContent)); }
        catch (err) { console.error("[pricing-calculator] Invalid inline JSON config", err); }
      } else if (el.dataset.config) {
        fetch(el.dataset.config).then(function (r) { return r.json(); }).then(go)
          .catch(function (err) { console.error("[pricing-calculator] Could not load config " + el.dataset.config, err); });
      }
    });
  }

  global.PricingCalculator = { mount: mount, calculate: calculate, defaultSelection: defaultSelection, autoMount: autoMount };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
    else autoMount();
  }
})(typeof window !== "undefined" ? window : this);
