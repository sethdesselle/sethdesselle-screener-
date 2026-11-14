/* Stock Screener: loads data/stocks.json (written by the GitHub Action) and renders the screener. */
(() => {
  "use strict";

  // ------------------------------------------------------------ storage (never required)
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ss." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ss." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ------------------------------------------------------------ state
  let stocks = [];
  let tier1hist = [];          // data/tier1-history.json: [{date, names:[{symbol,class,rank}]}]
  let tier1 = null;            // data/tier1.json (written by the daily Claude task)
  let history = null;          // loaded lazily for charts
  let historyPromise = null;
  const favs = new Set(store.get("favs", []));
  const state = {
    preset: store.get("preset", "all"),
    sort: store.get("sort", { key: "marketCap", dir: "desc" }),
    q: "",
    f: store.get("filters", {}),
    tab: store.get("tab", "screener"),
  };

  // ------------------------------------------------------------ formatting
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const money = (x) => !isNum(x) ? "–" : (Math.abs(x) >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 0 }) : x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(x) < 1 ? 4 : 2 }));
  const fix = (x, d = 1) => isNum(x) ? x.toFixed(d) : "–";
  const pct = (x, d = 2) => isNum(x) ? (x > 0 ? "+" : "") + x.toFixed(d) + "%" : "–";
  const dirCls = (x) => !isNum(x) ? "" : x > 0 ? "up" : x < 0 ? "down" : "";
  const big = (x) => {
    if (!isNum(x)) return "–";
    const a = Math.abs(x);
    if (a >= 1e12) return (x / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return (x / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return (x / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (x / 1e3).toFixed(0) + "K";
    return String(Math.round(x));
  };
  const daysUntil = (iso) => iso ? Math.round((new Date(iso + "T00:00:00") - new Date(new Date().toDateString())) / 864e5) : null;

  // ------------------------------------------------------------ screens
  const PRESETS = [
    { id: "all", label: "All" },
    { id: "tier1", label: "Tier 1 picks", test: (s) => s.t1 && s.t1.class !== "not_qualified" },
    { id: "fav", label: "★ Favorites", test: (s) => favs.has(s.symbol) },
    { id: "gainers", label: "Top gainers", test: (s) => s.changePct > 0, sort: { key: "changePct", dir: "desc" } },
    { id: "losers", label: "Top losers", test: (s) => s.changePct < 0, sort: { key: "changePct", dir: "asc" } },
    { id: "volume", label: "Unusual volume", test: (s) => s.relVolume >= 2, sort: { key: "relVolume", dir: "desc" } },
    { id: "high", label: "Near 52-wk high", test: (s) => s.fromHigh >= -5, sort: { key: "fromHigh", dir: "desc" } },
    { id: "low", label: "Near 52-wk low", test: (s) => isNum(s.fromLow) && s.fromLow <= 10, sort: { key: "fromLow", dir: "asc" } },
    { id: "uptrend", label: "Uptrend", test: (s) => s.price > s.sma50 && s.sma50 > s.sma200 },
    { id: "downtrend", label: "Downtrend", test: (s) => s.price < s.sma50 && s.sma50 < s.sma200 },
    { id: "oversold", label: "Oversold (RSI < 30)", test: (s) => s.rsi < 30, sort: { key: "rsi", dir: "asc" } },
    { id: "overbought", label: "Overbought (RSI > 70)", test: (s) => s.rsi > 70, sort: { key: "rsi", dir: "desc" } },
    { id: "value", label: "Low P/E (< 15)", test: (s) => s.pe > 0 && s.pe < 15, sort: { key: "pe", dir: "asc" } },
    { id: "dividend", label: "Dividend ≥ 3%", test: (s) => s.dividendYield >= 3, sort: { key: "dividendYield", dir: "desc" } },
    { id: "earnings", label: "Earnings ≤ 14 days", test: (s) => { const d = daysUntil(s.earningsDate); return d != null && d >= 0 && d <= 14; }, sort: { key: "earningsDate", dir: "asc" } },
    { id: "upside", label: "Analyst upside > 20%", test: (s) => s.upside > 20, sort: { key: "upside", dir: "desc" } },
  ];

  // ------------------------------------------------------------ columns
  const COLS = [
    { key: "symbol", label: "Symbol", cls: "l", cell: (s) => `<div class="sym"><button class="star ${favs.has(s.symbol) ? "on" : ""}" data-fav="${esc(s.symbol)}" aria-label="Favorite ${esc(s.symbol)}">★</button><div><b>${esc(s.symbol)}</b>${t1Badge(s)}${restrictedTag(s.symbol)}<span class="nm">${esc(s.name)}</span></div></div>` },
    { key: "price", label: "Price", desk: true, cell: (s) => money(s.price) },
    { key: "changePct", label: "Day", desk: true, cell: (s) => `<span class="pill ${dirCls(s.changePct) || "flat"}">${pct(s.changePct)}</span>` },
    { key: "perfM1", label: "30-day", sortable: false, cell: (s) => sparkSvg(s.spark) },
    { key: "price", label: "", mobile: true, sortable: false, cell: (s) => `<div class="price-cell"><b>${money(s.price)}</b><span class="pill ${dirCls(s.changePct) || "flat"}">${pct(s.changePct)}</span></div>` },
    { key: "relVolume", label: "Vol (rel)", desk: true, cell: (s) => `${big(s.volume)} <span class="muted">${isNum(s.relVolume) ? fix(s.relVolume, 1) + "×" : ""}</span>` },
    { key: "marketCap", label: "Mkt cap", desk: true, cell: (s) => big(s.marketCap) },
    { key: "pe", label: "P/E", desk: true, cell: (s) => s.pe > 0 ? fix(s.pe, 1) : "–" },
    { key: "perfM1", label: "1M", desk: true, cell: (s) => `<span class="${dirCls(s.perfM1)}">${pct(s.perfM1, 1)}</span>` },
    { key: "perfYtd", label: "YTD", desk: true, cell: (s) => `<span class="${dirCls(s.perfYtd)}">${pct(s.perfYtd, 1)}</span>` },
    { key: "fromHigh", label: "52-wk range", desk: true, cell: rangeCell },
    { key: "rsi", label: "RSI", desk: true, cell: (s) => `<span class="${s.rsi > 70 ? "rsi-hot" : s.rsi < 30 ? "rsi-cold" : ""}">${fix(s.rsi, 0)}</span>` },
    { key: "dividendYield", label: "Div %", desk: true, cell: (s) => s.dividendYield ? fix(s.dividendYield, 2) : "–" },
  ];

  const SORTS = [
    ["marketCap", "desc", "Market cap"], ["changePct", "desc", "Day % (best)"], ["changePct", "asc", "Day % (worst)"],
    ["symbol", "asc", "Symbol A–Z"], ["relVolume", "desc", "Relative volume"], ["perfM1", "desc", "1-month %"],
    ["perfYtd", "desc", "YTD %"], ["fromHigh", "desc", "Closest to 52-wk high"], ["rsi", "asc", "RSI (low first)"],
    ["pe", "asc", "P/E (low first)"], ["dividendYield", "desc", "Dividend yield"], ["upside", "desc", "Analyst upside"],
  ];

  function rangeCell(s) {
    if (!isNum(s.high52) || !isNum(s.low52) || s.high52 === s.low52) return "–";
    const p = Math.max(0, Math.min(100, (s.price - s.low52) / (s.high52 - s.low52) * 100));
    return `<span class="bar52" title="Low ${money(s.low52)} · High ${money(s.high52)}"><i style="left:${p.toFixed(1)}%"></i></span> <span class="muted">${pct(s.fromHigh, 0)}</span>`;
  }

  function sparkSvg(arr) {
    const pts = (arr || []).filter(isNum);
    if (pts.length < 2) return "";
    const w = 84, h = 28, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    const d = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(" ");
    const color = pts[pts.length - 1] >= pts[0] ? "var(--up)" : "var(--down)";
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }


  // ------------------------------------------------------------ Tier 1
  // Holdings you've restricted from new capital (recommendation text only; nothing is executed).
  const RESTRICTED = { STRL: "No new capital", KTOS: "No new capital", KRMN: "No new capital", CLS: "No new capital", MSTR: "No new call purchases" };
  const restrictedTag = (sym) => RESTRICTED[sym] ? ` <span class="t1pill restricted" title="Your rule">${esc(RESTRICTED[sym])}</span>` : "";
  const T1_LABEL = { strict: "Tier 1 BUY", approaching: "Approaching", not_qualified: "Not qualified" };
  function t1Move(n) {
    const prev = tier1hist.filter((h) => h.date < (tier1 && tier1.asOf)).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!prev) return "";
    const p = (prev.names || []).find((x) => x.symbol === n.symbol);
    if (!p) return ' <span class="mv new">NEW</span>';
    if (p.class === "approaching" && n.class === "strict") return ' <span class="mv up">▲ upgraded</span>';
    if (p.class === "strict" && n.class === "approaching") return ' <span class="mv down">▼ downgraded</span>';
    return "";
  }
  function t1Dropped() {
    const prev = tier1hist.filter((h) => h.date < (tier1 && tier1.asOf)).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!prev) return [];
    const now = new Set(((tier1 && tier1.names) || []).map((n) => n.symbol));
    return (prev.names || []).filter((p) => !now.has(p.symbol)).map((p) => p.symbol);
  }
  function earnBadge(s) {
    const d = s ? daysUntil(s.earningsDate) : null;
    return d != null && d >= 0 && d <= 21 ? ` <span class="t1pill earn">Earnings ${d === 0 ? "today" : "in " + d + "d"}</span>` : "";
  }
  function t1Badge(s) {
    return s.t1 && s.t1.class !== "not_qualified" ? ` <span class="t1pill ${esc(s.t1.class)}">${s.t1.class === "strict" ? "T1" : "T1~"}</span>` : "";
  }
  const t1Rows = () => (tier1 && tier1.names || []).filter((n) => n.class !== "not_qualified")
    .sort((a, b) => (a.class === b.class ? (a.rank || 99) - (b.rank || 99) : a.class === "strict" ? -1 : 1));

  const bizDaysSince = (iso) => {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00"), end = new Date(new Date().toDateString());
    let n = 0;
    while (d < end) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  };

  function zoneState(n, price) {
    const z = n.entryZone;
    if (!z || !isNum(z.low) || !isNum(z.high) || !isNum(price)) return null;
    if (price >= z.low && price <= z.high) return { cls: "in", text: "In entry zone" };
    if (price > z.high && price <= z.high * 1.03) return { cls: "near", text: "Near entry zone" };
    if (price < z.low) return { cls: "below", text: "Below entry zone" };
    return null;
  }
  const zoneTag = (n, price) => { const z = zoneState(n, price); return z ? ` <span class="t1pill zone ${z.cls}" title="Suggested zone $${money(n.entryZone.low)}-$${money(n.entryZone.high)}">${z.text}</span>` : ""; };

  const buyBelow = (n) => {
    if (isNum(n.buyBelow)) return n.buyBelow;
    const k = ((n.fairValueDetail || {}).methods || []).filter((m) => !m.trimmed && isNum(m.value)).map((m) => m.value);
    return k.length >= 3 ? Math.min(...k) : null;
  };
  function verdict(n, price) {
    const bb = buyBelow(n);
    if (!isNum(bb) || !isNum(price)) return { cls: "flat", text: "No fair value yet", sub: "Not enough verified data to value it." };
    const d = (1 - price / n.fairValue) * 100, need = `Would be a buy at $${money(bb)} or lower (${fix((1 - bb / price) * 100, 0)}% below today).`;
    if (price <= bb) return { cls: "up", text: "Cheap on every measure", sub: `In the buy range, ${fix(d, 0)}% below fair value.` };
    if (d >= 3) return { cls: "near", text: "A little cheap, not cheap enough", sub: need };
    if (d > -10) return { cls: "flat", text: "About fairly priced", sub: need };
    return { cls: "down", text: `Expensive: ${fix(-d, 0)}% above fair value`, sub: need };
  }
  function fvBar(n, price) {
    if (!isNum(n.fairValue) || !isNum(price) || n.fairValue <= 0) return "";
    const bb = buyBelow(n), max = Math.max(n.fairValue, price) * 1.15, w = (v) => (v / max * 100).toFixed(1);
    return `<div class="fv3"><div><span class="k">Price now</span><b>$${money(price)}</b></div><div><span class="k">Fair value</span><b>$${money(n.fairValue)}</b></div><div><span class="k">Buy at or below</span><b class="up">$${money(bb)}</b></div></div>
      <div class="fv"><div class="fv-track"><i class="fv-buy" style="width:${w(bb)}%"></i><b class="fv-mark" style="left:${w(n.fairValue)}%"></b><b class="fv-dot" style="left:${w(price)}%"></b></div>
      <div class="fv-lbl"><span><i class="lg buy"></i>buy range</span><span><i class="lg fair"></i>fair value</span><span><i class="lg now"></i>price now</span></div></div>`;
  }

  function fvDetail(n) {
    const d = n.fairValueDetail;
    if (!d || !Array.isArray(d.methods) || !d.methods.length) return "";
    const rows = d.methods.map((m) => `<tr><td class="l">${esc(m.name)}</td><td class="l">${esc(m.assumption || "")}</td><td>${isNum(m.value) ? "$" + money(m.value) : "–"}</td><td>${m.trimmed ? "trimmed" : isNum(m.weight) ? fix(m.weight, 0) + "%" : "–"}</td></tr>`).join("");
    const range = isNum(d.low) && isNum(d.high) ? `Range across methods $${money(d.low)} to $${money(d.high)}.` : "";
    const bb = [isNum(d.bear) ? `Bear $${money(d.bear)}` : null, isNum(d.bull) ? `Bull $${money(d.bull)}` : null].filter(Boolean).join(" · ");
    const sc = n.strictChecks, ck = (ok, txt) => `<li class="${ok ? "up" : "down"}">${ok ? "✓" : "✗"} ${txt}</li>`;
    const checks = sc ? `<ul class="chk">${ck(sc.allMethods ?? sc.discount, "Price is below every valuation method" + (isNum(buyBelow(n)) ? ` (lowest is $${money(buyBelow(n))})` : ""))}${ck(sc.rewardRisk, "Reward:risk ≥ 2:1" + (isNum(n.rewardRisk) ? ` (${fix(n.rewardRisk, 1)}:1)` : ""))}</ul>` : "";
    const hc = isNum(d.composite) && n.haircutPct ? `<p>Composite $${money(d.composite)} less ${fix(n.haircutPct || 0, 0)}% risk haircut = <b>$${money(n.fairValue)}</b>.</p>` : "";
    return `<details class="tech"><summary>How fair value is worked out</summary>${checks}${hc}
      <table class="perf"><thead><tr><th class="l">Method</th><th class="l">Assumption</th><th>Value</th><th>Weight</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted">${[range, bb, d.note ? esc(d.note) : ""].filter(Boolean).join(" ")}</p></details>`;
  }

  function techBlock(n, s) {
    const t = n.tech || {};
    const pick = (a, b) => (isNum(a) ? a : isNum(b) ? b : null);
    const rsi = pick(t.rsi, s && s.rsi), fromLow = pick(t.fromLowPct, s && s.fromLow), vol = pick(t.volVsAvg, s && s.relVolume);
    const price = s && isNum(s.price) ? s.price : n.price;
    const ma = (v, label) => (s && isNum(s[v]) && isNum(price) ? `${label}: ${price > s[v] ? '<span class="up">above</span>' : '<span class="down">below</span>'}` : null);
    const items = [
      ["RSI (14d)", isNum(rsi) ? fix(rsi, 0) : null], ["RSI (weekly)", isNum(t.rsiWeekly) ? fix(t.rsiWeekly, 0) : null],
      ["MACD", t.macd ? esc(t.macd) : null], ["ATR %", isNum(t.atrPct) ? fix(t.atrPct, 1) + "%" : null],
      ["Above 52-wk low", isNum(fromLow) ? "+" + fix(fromLow, 0) + "%" : null], ["Volume vs avg", isNum(vol) ? fix(vol, 1) + "×" : null],
      ["50-day avg", ma("sma50", "")], ["200-day avg", ma("sma200", "")],
    ].filter(([, v]) => v).map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
    if (!items && !t.staging) return "";
    return `<details class="tech"><summary>Entry timing <span class="muted">(timing only, not part of the Tier 1 score)</span></summary>
      <div class="stats">${items}</div>${t.staging ? `<p>${esc(t.staging)}</p>` : ""}</details>`;
  }

  function t1Facts(n) {
    const f = [["Rev growth", isNum(n.revGrowth) ? fix(n.revGrowth, 0) + "%" : null], ["Fwd P/E", isNum(n.fwdPE) ? fix(n.fwdPE, 1) : null],
      ["FCF yield", isNum(n.fcfYield) ? fix(n.fcfYield, 1) + "%" : null], ["ROIC", isNum(n.roic) ? fix(n.roic, 0) + "%" : null],
      ["Fair value", isNum(n.fairValue) ? "$" + money(n.fairValue) : null], ["Discount", isNum(n.discountPct) ? fix(n.discountPct, 0) + "%" : null],
      ["Reward:risk", isNum(n.rewardRisk) ? fix(n.rewardRisk, 1) + ":1" : null], ["Implied return/yr", isNum(n.impliedReturnPct) ? fix(n.impliedReturnPct, 1) + "%" : null]];
    return f.filter(([, v]) => v).map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  }
  const t1Sources = (n) => (n.sources || []).filter((x) => /^https?:/.test(x.url || ""))
    .map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || "Source")} ↗</a>`).join(" ");

  function t1Detail(n) {
    return `<div class="t1-top"><span class="t1pill ${esc(n.class)}">${T1_LABEL[n.class] || ""}</span>${restrictedTag(n.symbol)} <span class="muted">as of ${esc(n.priceDate || "")}</span></div>
      <p>${esc(n.reason)}</p>
      <div class="stats">${t1Facts(n)}</div>
      ${fvBar(n, (stocks.find((x) => x.symbol === n.symbol) || {}).price ?? n.price)}
      ${fvDetail(n)}
      ${n.entry ? `<p><b>Entry timing:</b> ${esc(n.entry)}</p>` : ""}
      ${techBlock(n, stocks.find((x) => x.symbol === n.symbol))}
      ${n.upgrade ? `<p><b>What would upgrade it:</b> ${esc(n.upgrade)}</p>` : ""}
      <p class="d-links">${t1Sources(n)}</p>`;
  }

  function renderTier1() {
    const rows = t1Rows();
    const cnt = $("#t1-count");
    cnt.hidden = !rows.length; cnt.textContent = rows.length;
    if (!tier1) {
      $("#t1-head").innerHTML = "";
      $("#t1-list").innerHTML = '<div class="empty"><b>No Tier 1 data yet</b>The daily Tier 1 screen writes data/tier1.json each morning.</div>';
      $("#t1-foot").textContent = "";
      return;
    }
    const sm = tier1.summary || {};
    const age = bizDaysSince(tier1.asOf);
    const stale = !tier1.test && age != null && age >= 2 ? `<div class="t1-stale">⚠ These picks are from ${esc(tier1.asOf)} (${age} trading days ago). A daily run may have failed; treat them as out of date.</div>` : "";
    const rep = /^https?:\/\//.test(tier1.reportUrl || "") ? `<p><a class="btn small" href="${esc(tier1.reportUrl)}" target="_blank" rel="noopener">Full daily report ↗</a></p>` : "";
    $("#t1-head").innerHTML = `${stale}<h2>Tier 1 screen</h2>${rep}
      <p class="muted">${tier1.test ? "<b>Test data.</b> " : ""}As of ${esc(tier1.asOf || "")} · ${esc(sm.screened ?? "?")} screened · <span class="up">${sm.strict ?? 0} Tier 1 BUY</span> · ${sm.approaching ?? 0} approaching</p>
      ${sm.note ? `<p class="muted">${esc(sm.note)}</p>` : ""}`;
    $("#t1-list").innerHTML = rows.length ? rows.map((n) => {
      const s = stocks.find((x) => x.symbol === n.symbol);
      const price = s && isNum(s.price) ? s.price : n.price;
      return `<article class="t1-card" ${s ? `data-open="${esc(n.symbol)}"` : ""}>
        <div class="t1-card-head"><div><b class="t1-sym">${esc(n.symbol)}</b> <span class="t1pill ${esc(n.class)}">${T1_LABEL[n.class]}</span>${t1Move(n)}${restrictedTag(n.symbol)}${earnBadge(s)}${zoneTag(n, s && isNum(s.price) ? s.price : n.price)}
          <span class="nm">${esc(s ? s.name : "")}</span></div>
          <div class="t1-price"><b>$${money(price)}</b>${s ? ` <span class="pill ${dirCls(s.changePct) || "flat"}">${pct(s.changePct)}</span>` : ""}</div></div>
        ${(() => { const v = verdict(n, price); return `<p class="verdict ${v.cls}"><b>${v.text}</b><span>${v.sub}</span></p>`; })()}
        ${fvBar(n, price)}
        <p>${esc(n.reason)}</p>
        <details class="tech more"><summary>More detail</summary>
          <div class="stats">${t1Facts(n)}</div>
          ${n.entry ? `<p class="muted"><b>Entry timing:</b> ${esc(n.entry)}${n.entryZone ? ` (zone $${money(n.entryZone.low)}-$${money(n.entryZone.high)})` : ""}</p>` : ""}
          ${n.upgrade ? `<p class="muted"><b>What would upgrade it:</b> ${esc(n.upgrade)}</p>` : ""}
          ${fvDetail(n)}
          ${techBlock(n, s)}
          <p class="d-links">${t1Sources(n)}</p></details></article>`;
    }).join("") : '<div class="empty"><b>No qualifying names today</b>Nothing cleared Strict or Approaching Tier 1. Names are never forced.</div>';
    renderChanges();
    renderBannerAndHistory();
    $("#t1-foot").textContent = "For information only, not financial advice. Nothing here executes trades or changes your watchlist.";
  }

  function renderBannerAndHistory() {
    const strict = ((tier1 && tier1.names) || []).filter((n) => n.class === "strict");
    $("#t1-banner").innerHTML = strict.length ? `<div class="t1-banner">★ Tier 1 BUY today: <b>${strict.map((n) => esc(n.symbol)).join(", ")}</b></div>` : "";
    const dropped = t1Dropped();
    if (dropped.length) $("#t1-head").insertAdjacentHTML("beforeend", `<p class="muted">Dropped off since last run: ${dropped.map(esc).join(", ")}</p>`);
    const hist = [...tier1hist].sort((a, b) => b.date.localeCompare(a.date));
    $("#t1-hist").hidden = !hist.length;
    const first = {};
    [...tier1hist].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => (e.names || []).forEach((n) => { if (!first[n.symbol] && isNum(n.price)) first[n.symbol] = { date: e.date, price: n.price, cls: n.class }; }));
    const nowSet = new Set(((tier1 && tier1.names) || []).map((n) => n.symbol));
    const perf = Object.entries(first).map(([sym, f]) => {
      const s = stocks.find((x) => x.symbol === sym);
      return { sym, f, now: s && isNum(s.price) ? s.price : null, active: nowSet.has(sym) };
    }).sort((a, b) => a.f.date.localeCompare(b.f.date) || a.sym.localeCompare(b.sym));
    const perfHtml = perf.length ? `<h4 class="perf-h">Since first picked <span class="muted">(price when first listed vs now)</span></h4>
      <table class="perf"><thead><tr><th class="l">Name</th><th>First</th><th>Then</th><th>Now</th><th>Change</th></tr></thead><tbody>${perf.map((p) => {
        const ch = p.now != null ? (p.now / p.f.price - 1) * 100 : null;
        return `<tr><td class="l"><b>${esc(p.sym)}</b>${p.active ? "" : ' <span class="muted">(dropped)</span>'}</td><td>${esc(p.f.date.slice(5))}</td><td>$${money(p.f.price)}</td><td>${p.now != null ? "$" + money(p.now) : "–"}</td><td class="${dirCls(ch)}">${pct(ch, 1)}</td></tr>`;
      }).join("")}</tbody></table>` : "";
    $("#t1-hist-body").innerHTML = perfHtml + hist.map((h) => `<div class="hist-row"><b>${esc(h.date)}</b> ` +
      ((h.names || []).length ? h.names.map((n) => `<span class="t1pill ${esc(n.class)}">${esc(n.symbol)}</span>`).join(" ") : '<span class="muted">no qualifying names</span>') + "</div>").join("");
  }

  let dismissed = new Set(store.get("dismissed", []));
  function renderChanges() {
    const w = (tier1 && tier1.watchlist) || {};
    const allAdds = w.adds || [], allRems = w.removes || [];
    const keyOf = (kind, x) => kind + ":" + x.symbol;
    const adds = allAdds.filter((x) => !dismissed.has(keyOf("A", x))), rems = allRems.filter((x) => !dismissed.has(keyOf("R", x)));
    const hiddenN = allAdds.length + allRems.length - adds.length - rems.length;
    const item = (kind) => (x) => `<li><b>${esc(x.symbol)}</b>${x.name ? ` <span class="muted">${esc(x.name)}</span>` : ""}${x.confidence ? ` <span class="t1pill">${esc(x.confidence)}</span>` : ""}<br>${esc(x.reason)}<br><button class="link-btn" data-dismiss="${esc(keyOf(kind, x))}">Dismiss</button></li>`;
    $("#t1-changes").innerHTML = (adds.length || rems.length || hiddenN) ? `<h3>Suggested list changes <span class="muted">(recommendations only)</span></h3>
      ${adds.length ? `<h4 class="up">Consider adding</h4><ul class="chg">${adds.map(item("A")).join("")}</ul>` : ""}
      ${rems.length ? `<h4 class="down">Consider removing</h4><ul class="chg">${rems.map(item("R")).join("")}</ul>` : ""}
      ${hiddenN ? `<p class="muted">${hiddenN} dismissed (this browser only; the daily run may suggest them again) <button class="link-btn" data-undismiss="1">Show again</button></p>` : ""}` : "";
  }

  const TABS = ["screener", "tier1", "earnings", "positions"];
  function setTab(tab) {
    state.tab = TABS.includes(tab) ? tab : "screener";
    store.set("tab", state.tab);
    TABS.forEach((t) => { const el = $("#view-" + t); if (el) el.hidden = t !== state.tab; });
    document.querySelectorAll("#tabs .tab").forEach((b) => { const on = b.dataset.tab === state.tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
    if (state.tab === "earnings") renderEarnings();
    if (state.tab === "positions") renderPositions();
  }

  // ------------------------------------------------------------ earnings calendar
  function renderEarnings() {
    const rows = stocks.filter((s) => { const d = daysUntil(s.earningsDate); return d != null && d >= 0 && d <= 75; })
      .sort((a, b) => a.earningsDate.localeCompare(b.earningsDate) || a.symbol.localeCompare(b.symbol));
    const box = $("#earn-list");
    if (!rows.length) { box.innerHTML = '<div class="empty"><b>No upcoming earnings dates</b>Dates appear once the data has loaded.</div>'; return; }
    let last = "";
    box.innerHTML = rows.map((s) => {
      const d = daysUntil(s.earningsDate);
      const head = s.earningsDate !== last ? `<h3 class="earn-day">${new Date(s.earningsDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} <span class="muted">${d === 0 ? "today" : "in " + d + "d"}</span></h3>` : "";
      last = s.earningsDate;
      return head + `<div class="earn-row" data-open="${esc(s.symbol)}"><b>${esc(s.symbol)}</b>${t1Badge(s)}${restrictedTag(s.symbol)} <span class="nm">${esc(s.name)}</span><span class="earn-px">$${money(s.price)} <span class="pill ${dirCls(s.changePct) || "flat"}">${pct(s.changePct)}</span></span></div>`;
    }).join("");
  }

  // ------------------------------------------------------------ positions
  const CORE = new Set(["SPYM", "QQQM", "VOO", "SCHD", "SCHG", "SPMO", "VXF", "FXAIX", "FSPGX", "FBGRX", "FIDRX", "WQTM", "SPAXX"]);
  let positions = store.get("positions", []);
  function renderPositions() {
    const rows = positions.map((p) => {
      const s = stocks.find((x) => x.symbol === p.sym);
      const value = isNum(p.manual) && p.manual > 0 ? p.manual : isNum(p.qty) && s && isNum(s.price) ? p.qty * s.price : null;
      return { ...p, s, value, core: CORE.has(p.sym) || (s && s.type === "ETF") };
    });
    const total = rows.reduce((a, r) => a + (r.value || 0), 0);
    $("#pos-summary").textContent = rows.length ? `Total entered: $${money(total)}. Weights are a share of what you've entered here.` : "";
    $("#pos-empty").hidden = rows.length > 0;
    const secs = {}, inds = {};
    rows.forEach((r) => {
      if (!r.value) return;
      const sec = r.core ? "Core funds / ETFs" : (r.s && r.s.sector) || "Unknown";
      (secs[sec] = secs[sec] || { v: 0, syms: [] }).v += r.value; secs[sec].syms.push(r.sym);
      const ind = r.core ? null : r.s && r.s.industry;
      if (ind) (inds[ind] = inds[ind] || []).push(r.sym);
    });
    const secRows = Object.entries(secs).sort((a, b) => b[1].v - a[1].v);
    const overlap = Object.entries(inds).filter(([, v]) => v.length > 1);
    $("#pos-sectors").innerHTML = secRows.length ? `<h3 class="sec-h">By sector</h3>` + secRows.map(([k, v]) => {
      const w = total ? v.v / total * 100 : 0;
      return `<div class="sec-row"><span>${esc(k)} <span class="muted">${esc(v.syms.join(", "))}</span></span><span class="sec-bar"><i style="width:${w.toFixed(1)}%"></i></span><b>${fix(w, 0)}%</b></div>`;
    }).join("") + (overlap.length ? `<p class="muted"><b>Overlap check:</b> ${overlap.map(([k, v]) => `${esc(v.join(" + "))} (${esc(k)})`).join("; ")}. Same-industry holdings may need a replacement comparison.</p>` : "") : "";
    $("#pos-body").innerHTML = rows.sort((a, b) => (b.value || 0) - (a.value || 0)).map((r) => {
      const w = total && r.value ? r.value / total * 100 : null;
      let status = '<span class="muted">no price</span>';
      if (r.core) status = '<span class="muted">Core (exempt)</span>';
      else if (w != null) status = w >= 10 ? '<span class="down">At/over 10%</span>' : w >= 5 ? '<span class="up">5-9% range</span>' : '<span class="muted">Under 5%</span>';
      return `<tr><td class="l"><b>${esc(r.sym)}</b>${restrictedTag(r.sym)}${r.s ? `<span class="nm">${esc(r.s.name)}</span>` : ""}</td><td>${r.value != null ? "$" + money(r.value) : "–"}</td><td>${w != null ? fix(w, 1) + "%" : "–"}</td><td class="l">${status}</td><td><button class="btn ghost small" data-rm="${esc(r.sym)}" aria-label="Remove ${esc(r.sym)}">✕</button></td></tr>`;
    }).join("");
  }
  function bindPositions() {
    $("#pos-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target), sym = String(f.get("sym") || "").trim().toUpperCase().replace(/^\$/, "").replace(/^([A-Z]{1,5})\.([A-Z])$/, "$1-$2");
      const qty = parseFloat(f.get("qty")), manual = parseFloat(f.get("manual"));
      if (!sym || (!(qty > 0) && !(manual > 0))) return;
      positions = positions.filter((p) => p.sym !== sym).concat([{ sym, qty: qty > 0 ? qty : null, manual: manual > 0 ? manual : null }]);
      store.set("positions", positions); e.target.reset(); renderPositions();
    });
    $("#pos-body").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]"); if (!b) return;
      positions = positions.filter((p) => p.sym !== b.dataset.rm); store.set("positions", positions); renderPositions();
    });
    $("#earn-list").addEventListener("click", (e) => { const c = e.target.closest("[data-open]"); if (c) openDetail(c.dataset.open); });
  }

  // ------------------------------------------------------------ data
  async function loadTier1() {
    try {
      const r = await fetch("data/tier1.json?t=" + Date.now(), { cache: "no-store" });
      tier1 = r.ok ? await r.json() : null;
    } catch { tier1 = null; }
    try {
      const r = await fetch("data/tier1-history.json?t=" + Date.now(), { cache: "no-store" });
      tier1hist = r.ok ? await r.json() : [];
      if (!Array.isArray(tier1hist)) tier1hist = [];
    } catch { tier1hist = []; }
  }

  async function load() {
    $("#reload").classList.add("spin");
    try {
      const res = await fetch("data/stocks.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 404 ? "nodata" : "HTTP " + res.status);
      const data = await res.json();
      await loadTier1();
      const t1map = Object.fromEntries(((tier1 && tier1.names) || []).map((n) => [n.symbol, n]));
      stocks = (data.stocks || []).map((s) => ({
        ...s,
        t1: t1map[s.symbol] || null,
        upside: isNum(s.targetPrice) && isNum(s.price) && s.price ? (s.targetPrice / s.price - 1) * 100 : null,
      }));
      history = null; historyPromise = null;
      const when = new Date(data.updated);
      $("#updated").textContent = `${stocks.length} stocks · updated ${when.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
      $("#missing").textContent = data.missing?.length ? ` No data found for: ${data.missing.join(", ")} (check the symbols in stocks.txt).` : "";
      fillSectors();
      render();
    } catch (e) {
      stocks = [];
      $("#updated").textContent = "No data yet";
      $("#summary").innerHTML = "";
      $("#grid-body").innerHTML = "";
      showEmpty(e.message === "nodata"
        ? "<b>No stock data yet</b>The updater (GitHub Action) hasn't run yet. It runs automatically after you edit stocks.txt, hourly during market hours, or from the Actions tab → “Update stock data” → Run workflow."
        : `<b>Couldn't load data</b>${esc(e.message)}`);
    } finally {
      $("#reload").classList.remove("spin");
    }
  }

  function loadHistory() {
    if (!historyPromise) {
      historyPromise = fetch("data/history.json?t=" + Date.now(), { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((h) => (history = h))
        .catch(() => null);
    }
    return historyPromise;
  }

  // ------------------------------------------------------------ filtering
  function fillSectors() {
    const sel = $("#filters select[name=sector]");
    const sectors = [...new Set(stocks.map((s) => s.sector).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">Any</option>` + sectors.map((s) => `<option>${esc(s)}</option>`).join("");
    sel.value = state.f.sector || "";
  }

  function activeFilterCount() {
    return Object.values(state.f).filter((v) => v !== "" && v !== false && v != null).length;
  }

  function passesFilters(s) {
    const f = state.f, n = (k) => (f[k] === "" || f[k] == null ? null : Number(f[k]));
    const lim = [
      ["priceMin", (v) => s.price >= v], ["priceMax", (v) => s.price <= v], ["capMin", (v) => s.marketCap >= v],
      ["peMax", (v) => s.pe > 0 && s.pe <= v], ["chgMin", (v) => s.changePct >= v], ["chgMax", (v) => s.changePct <= v],
      ["rsiMin", (v) => s.rsi >= v], ["rsiMax", (v) => s.rsi <= v], ["divMin", (v) => (s.dividendYield || 0) >= v],
      ["rvolMin", (v) => s.relVolume >= v],
    ];
    for (const [k, test] of lim) { const v = n(k); if (v != null && !isNaN(v) && !test(v)) return false; }
    if (f.sector && s.sector !== f.sector) return false;
    if (f.above50 && !(s.price > s.sma50)) return false;
    if (f.above200 && !(s.price > s.sma200)) return false;
    return true;
  }

  function visible() {
    const preset = PRESETS.find((p) => p.id === state.preset) || PRESETS[0];
    const q = state.q.trim().toLowerCase();
    const list = stocks.filter((s) =>
      (!preset.test || preset.test(s)) && passesFilters(s) &&
      (!q || s.symbol.toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q) ||
        (s.sector || "").toLowerCase().includes(q) || (s.industry || "").toLowerCase().includes(q)));
    const { key, dir } = state.sort, m = dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const x = a[key], y = b[key];
      const xm = x == null || x === "", ym = y == null || y === "";
      if (xm || ym) return xm && ym ? 0 : xm ? 1 : -1;   // missing values always last
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * m;
    });
  }

  // ------------------------------------------------------------ render
  function render() {
    renderTier1();
    if (state.tab === "earnings") renderEarnings();
    if (state.tab === "positions") renderPositions();
    renderPresets();
    renderSummary();
    const fc = activeFilterCount();
    $("#filter-count").hidden = !fc;
    $("#filter-count").textContent = fc;

    const rows = visible();
    $("#result-count").textContent = `${rows.length} of ${stocks.length} stocks`;

    $("#grid-head").innerHTML = COLS.map((c, i) => {
      if (c.mobile) return "";
      const sortable = c.sortable !== false;
      const on = sortable && state.sort.key === c.key;
      return `<th data-col="${i}" class="${c.cls || ""} ${c.desk ? "desk" : ""} ${sortable ? "" : "nosort"} ${on ? "sorted " + state.sort.dir : ""}">${c.label}</th>`;
    }).join("");

    // Render in chunks so very long lists stay smooth.
    const body = $("#grid-body");
    body.innerHTML = "";
    const rowHtml = (s) => `<tr data-sym="${esc(s.symbol)}">` + COLS.map((c) =>
      `<td class="${c.cls || ""} ${c.desk ? "desk" : ""} ${c.mobile ? "mobile-only" : ""}">${c.cell(s)}</td>`).join("") + "</tr>";
    const CHUNK = 200;
    body.insertAdjacentHTML("beforeend", rows.slice(0, CHUNK).map(rowHtml).join(""));
    let i = CHUNK;
    const more = () => {
      if (i >= rows.length) return;
      body.insertAdjacentHTML("beforeend", rows.slice(i, i + CHUNK).map(rowHtml).join(""));
      i += CHUNK;
      requestAnimationFrame(more);
    };
    requestAnimationFrame(more);

    if (!rows.length && stocks.length) {
      showEmpty(state.preset === "fav" && !favs.size
        ? "<b>No favorites yet</b>Tap the ☆ next to a stock to add it here."
        : "<b>No stocks match</b>Try a different screen or clear your filters.");
    } else {
      $("#empty").hidden = true;
    }
  }

  function showEmpty(html) { const e = $("#empty"); e.innerHTML = html; e.hidden = false; }

  function renderPresets() {
    $("#presets").innerHTML = PRESETS.map((p) => {
      const count = p.test ? stocks.filter(p.test).length : stocks.length;
      return `<button class="chip ${p.id === state.preset ? "on" : ""}" data-preset="${p.id}" role="tab" aria-selected="${p.id === state.preset}">${esc(p.label)} <span class="muted">${count}</span></button>`;
    }).join("");
    const on = $("#presets .chip.on");
    if (on && on.scrollIntoView && !renderPresets.done) { on.scrollIntoView({ inline: "center", block: "nearest" }); renderPresets.done = true; }
  }

  function renderSummary() {
    if (!stocks.length) { $("#summary").innerHTML = ""; return; }
    const withChg = stocks.filter((s) => isNum(s.changePct));
    const up = withChg.filter((s) => s.changePct > 0).length, down = withChg.filter((s) => s.changePct < 0).length;
    const avg = withChg.reduce((a, s) => a + s.changePct, 0) / (withChg.length || 1);
    const sorted = [...withChg].sort((a, b) => b.changePct - a.changePct);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const card = (k, v, s, attrs = "") => `<div class="card ${attrs ? "clickable" : ""}" ${attrs}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    $("#summary").innerHTML =
      card("Up / Down today", `<span class="up">${up}</span> <span class="muted">/</span> <span class="down">${down}</span>`,
        `<div class="breadth"><i style="width:${(up / ((up + down) || 1) * 100).toFixed(1)}%"></i></div>`) +
      card("Average move", `<span class="${dirCls(avg)}">${pct(avg)}</span>`, `<span class="muted">across your list</span>`) +
      (best ? card("Best today", esc(best.symbol), `<span class="up">${pct(best.changePct)}</span> <span class="muted">${esc(best.name)}</span>`, `data-open="${esc(best.symbol)}"`) : "") +
      (worst ? card("Worst today", esc(worst.symbol), `<span class="down">${pct(worst.changePct)}</span> <span class="muted">${esc(worst.name)}</span>`, `data-open="${esc(worst.symbol)}"`) : "");
  }

  // ------------------------------------------------------------ detail view
  let detailSym = null, detailRange = 0;

  async function openDetail(sym) {
    const s = stocks.find((x) => x.symbol === sym);
    if (!s) return;
    detailSym = sym;
    $("#d-title").textContent = s.symbol;
    $("#d-sub").textContent = [s.name, s.sector, s.industry].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
    $("#d-price").textContent = (s.currency && s.currency !== "USD" ? s.currency + " " : "$") + money(s.price);
    $("#d-change").className = dirCls(s.changePct);
    $("#d-change").textContent = `${isNum(s.change) ? (s.change > 0 ? "+" : "") + money(s.change) : ""} (${pct(s.changePct)}) today`;
    $("#d-fav").classList.toggle("on", favs.has(sym));
    $("#d-yahoo").href = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
    $("#d-news").href = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/news`;

    const ed = daysUntil(s.earningsDate);
    const trend = (a, b) => (isNum(a) && isNum(b) ? (a > b ? '<span class="up">above</span>' : '<span class="down">below</span>') : "");
    const stats = [
      ["Market cap", big(s.marketCap)], ["P/E (trailing)", s.pe > 0 ? fix(s.pe, 1) : "–"], ["P/E (forward)", s.forwardPe > 0 ? fix(s.forwardPe, 1) : "–"],
      ["EPS", money(s.eps)], ["Dividend yield", s.dividendYield ? fix(s.dividendYield, 2) + "%" : "–"], ["Beta", fix(s.beta, 2)],
      ["Volume", big(s.volume)], ["Avg volume (20d)", big(s.avgVolume)], ["Relative volume", isNum(s.relVolume) ? fix(s.relVolume, 2) + "×" : "–"],
      ["52-wk high", `${money(s.high52)} <span class="muted">${pct(s.fromHigh, 1)}</span>`], ["52-wk low", `${money(s.low52)} <span class="muted">${pct(s.fromLow, 1)}</span>`],
      ["RSI (14)", fix(s.rsi, 0)],
      ["50-day avg", `${money(s.sma50)} ${trend(s.price, s.sma50)}`], ["200-day avg", `${money(s.sma200)} ${trend(s.price, s.sma200)}`],
      ["1 week", `<span class="${dirCls(s.perfW1)}">${pct(s.perfW1, 1)}</span>`], ["1 month", `<span class="${dirCls(s.perfM1)}">${pct(s.perfM1, 1)}</span>`],
      ["3 months", `<span class="${dirCls(s.perfM3)}">${pct(s.perfM3, 1)}</span>`], ["6 months", `<span class="${dirCls(s.perfM6)}">${pct(s.perfM6, 1)}</span>`],
      ["YTD", `<span class="${dirCls(s.perfYtd)}">${pct(s.perfYtd, 1)}</span>`], ["1 year", `<span class="${dirCls(s.perfY1)}">${pct(s.perfY1, 1)}</span>`],
      ["Analyst target", isNum(s.targetPrice) ? `${money(s.targetPrice)} <span class="${dirCls(s.upside)}">${pct(s.upside, 0)}</span>` : "–"],
      ["Analyst rating", s.rating && s.rating !== "none" ? esc(s.rating.replace(/_/g, " ")) + (s.analysts ? ` <span class="muted">(${s.analysts})</span>` : "") : "–"],
      ["Next earnings", s.earningsDate ? `${esc(s.earningsDate)}${ed != null && ed >= 0 ? ` <span class="muted">in ${ed}d</span>` : ""}` : "–"],
    ];
    $("#d-stats").innerHTML = stats.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

    const box = $("#d-t1");
    box.hidden = !s.t1;
    box.innerHTML = s.t1 ? t1Detail(s.t1) : "";

    const dlg = $("#detail");
    if (!dlg.open) dlg.showModal();
    drawChart();
    await loadHistory();
    if (detailSym === sym) drawChart();
  }

  function drawChart() {
    const box = $("#d-chart");
    const s = stocks.find((x) => x.symbol === detailSym);
    let dates, closes;
    if (history && history.closes && history.closes[detailSym]) {
      dates = history.dates; closes = history.closes[detailSym];
    } else if (historyPromise && !history) {
      box.innerHTML = '<p class="muted">Loading chart…</p>'; return;
    } else if (s && s.spark) {
      closes = s.spark; dates = closes.map(() => "");
    } else { box.innerHTML = '<p class="muted">No chart data</p>'; return; }

    let pts = dates.map((d, i) => ({ d, v: closes[i] })).filter((p) => isNum(p.v));
    if (detailRange) pts = pts.slice(-detailRange);
    if (pts.length < 2) { box.innerHTML = '<p class="muted">No chart data</p>'; return; }

    const W = box.clientWidth || 600, H = box.clientHeight || 220, pad = { t: 22, b: 18, l: 4, r: 46 };
    const vals = pts.map((p) => p.v), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const upTrend = vals[vals.length - 1] >= vals[0], color = upTrend ? "var(--up)" : "var(--down)";
    const chg = (vals[vals.length - 1] / vals[0] - 1) * 100;
    const grid = [max, (max + min) / 2, min].map((v) =>
      `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" stroke-dasharray="3 4"/>` +
      `<text x="${W - pad.r + 6}" y="${y(v) + 4}" font-size="11" fill="var(--muted)">${money(v)}</text>`).join("");
    box.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        ${grid}
        <polygon points="${x(0)},${H - pad.b} ${line} ${x(pts.length - 1)},${H - pad.b}" fill="url(#fill)"/>
        <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
        <text x="${pad.l}" y="12" font-size="12" fill="${color}" font-weight="600">${pct(chg)} over period</text>
        <text x="${pad.l}" y="${H - 2}" font-size="11" fill="var(--muted)">${esc(pts[0].d)}</text>
        <text x="${W - pad.r}" y="${H - 2}" font-size="11" fill="var(--muted)" text-anchor="end">${esc(pts[pts.length - 1].d)}</text>
        <g id="hover" style="display:none"><line id="hl" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--muted)"/><circle id="hc" r="4" fill="${color}" stroke="var(--panel)" stroke-width="2"/></g>
      </svg><div class="tip" hidden></div>`;
    const svg = box.querySelector("svg"), tip = box.querySelector(".tip"), g = svg.querySelector("#hover");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - pad.l) / (W - pad.l - pad.r) * (pts.length - 1))));
      const p = pts[i];
      g.style.display = "";
      svg.querySelector("#hl").setAttribute("x1", x(i)); svg.querySelector("#hl").setAttribute("x2", x(i));
      svg.querySelector("#hc").setAttribute("cx", x(i)); svg.querySelector("#hc").setAttribute("cy", y(p.v));
      tip.hidden = false;
      tip.textContent = `${p.d ? p.d + " · " : ""}${money(p.v)}`;
      tip.style.left = Math.max(50, Math.min(r.width - 50, x(i) / W * r.width)) + "px";
    };
    const leave = () => { g.style.display = "none"; tip.hidden = true; };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", leave);
  }

  // ------------------------------------------------------------ actions
  function toggleFav(sym) {
    favs.has(sym) ? favs.delete(sym) : favs.add(sym);
    store.set("favs", [...favs]);
    document.querySelectorAll(`[data-fav="${CSS.escape(sym)}"]`).forEach((b) => b.classList.toggle("on", favs.has(sym)));
    if (detailSym === sym) $("#d-fav").classList.toggle("on", favs.has(sym));
    if (state.preset === "fav") render(); else renderPresets();
  }

  function setPreset(id) {
    state.preset = id;
    const p = PRESETS.find((x) => x.id === id);
    if (p && p.sort) state.sort = { ...p.sort };
    store.set("preset", id); store.set("sort", state.sort);
    syncSortSelect();
    render();
  }

  function syncSortSelect() {
    const sel = $("#sort-select"), v = state.sort.key + ":" + state.sort.dir;
    if (![...sel.options].some((o) => o.value === v)) {
      const o = document.createElement("option"); o.value = v; o.textContent = "Custom"; sel.appendChild(o);
    }
    sel.value = v;
  }

  function exportCsv() {
    const fields = ["symbol", "name", "sector", "industry", "price", "change", "changePct", "volume", "relVolume", "marketCap", "pe", "forwardPe",
      "dividendYield", "beta", "rsi", "sma50", "sma200", "high52", "low52", "fromHigh", "perfW1", "perfM1", "perfM3", "perfM6", "perfYtd", "perfY1",
      "targetPrice", "rating", "earningsDate"];
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [fields.join(",")].concat(visible().map((s) => fields.map((f) => q(s[f])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `screener-${state.preset}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------ events
  function bind() {
    $("#sort-select").innerHTML = SORTS.map(([k, d, l]) => `<option value="${k}:${d}">${l}</option>`).join("");
    syncSortSelect();

    $("#presets").addEventListener("click", (e) => { const b = e.target.closest("[data-preset]"); if (b) setPreset(b.dataset.preset); });
    $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
    $("#t1-changes").addEventListener("click", (e) => {
      const d = e.target.closest("[data-dismiss]"), u = e.target.closest("[data-undismiss]");
      if (d) dismissed.add(d.dataset.dismiss); else if (u) dismissed = new Set(); else return;
      store.set("dismissed", [...dismissed]); renderChanges();
    });
    $("#t1-list").addEventListener("click", (e) => { if (e.target.closest("a, .tech")) return; const c = e.target.closest("[data-open]"); if (c) openDetail(c.dataset.open); });
    bindPositions();
    setTab(state.tab);
    $("#summary").addEventListener("click", (e) => { const c = e.target.closest("[data-open]"); if (c) openDetail(c.dataset.open); });

    let t;
    $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; render(); }, 120); });

    $("#grid-head").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th) return;
      const c = COLS[+th.dataset.col]; if (c.sortable === false) return;
      state.sort = state.sort.key === c.key
        ? { key: c.key, dir: state.sort.dir === "asc" ? "desc" : "asc" }
        : { key: c.key, dir: c.key === "symbol" || c.key === "pe" ? "asc" : "desc" };
      store.set("sort", state.sort); syncSortSelect(); render();
    });
    $("#sort-select").addEventListener("change", (e) => {
      const [key, dir] = e.target.value.split(":"); state.sort = { key, dir }; store.set("sort", state.sort); render();
    });

    $("#grid-body").addEventListener("click", (e) => {
      const fav = e.target.closest("[data-fav]");
      if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
      const tr = e.target.closest("tr[data-sym]"); if (tr) openDetail(tr.dataset.sym);
    });

    // filters
    const form = $("#filters");
    const fillForm = () => [...form.elements].forEach((el) => {
      if (!el.name) return;
      if (el.type === "checkbox") el.checked = !!state.f[el.name]; else el.value = state.f[el.name] ?? "";
    });
    fillForm();
    form.addEventListener("input", () => {
      state.f = {};
      [...form.elements].forEach((el) => { if (el.name) state.f[el.name] = el.type === "checkbox" ? el.checked : el.value; });
      store.set("filters", state.f); render();
    });
    form.addEventListener("submit", (e) => e.preventDefault());
    $("#filters-reset").addEventListener("click", () => { state.f = {}; store.set("filters", {}); fillForm(); render(); });
    $("#filters-toggle").addEventListener("click", (e) => {
      form.hidden = !form.hidden; e.currentTarget.setAttribute("aria-expanded", String(!form.hidden));
    });
    if (activeFilterCount()) { form.hidden = false; $("#filters-toggle").setAttribute("aria-expanded", "true"); }

    $("#export").addEventListener("click", exportCsv);
    $("#reload").addEventListener("click", load);

    // detail dialog
    const dlg = $("#detail");
    $("#d-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // tap outside
    dlg.addEventListener("close", () => { detailSym = null; });
    $("#d-fav").addEventListener("click", () => detailSym && toggleFav(detailSym));
    $("#d-ranges").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-r]"); if (!b) return;
      detailRange = +b.dataset.r;
      $("#d-ranges").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      drawChart();
    });
    window.addEventListener("resize", () => { if (detailSym) drawChart(); });

    // keep data fresh while the page is open
    setInterval(load, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  }

  bind();
  load();
})();
