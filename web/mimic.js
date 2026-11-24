"use strict";
// Plant single-line diagram with machine pictures and live power flow.
// Pictures are drawn in a 64x64 box with currentColor so they follow the theme.

window.MACHINES = {
  transformer: { label: "Transformer", svg: `<circle cx="32" cy="24" r="13"/><circle cx="32" cy="40" r="13"/><path d="M32 4v7M32 53v7"/>` },
  induction_furnace: { label: "Induction furnace", svg: `<path d="M16 14h32l-4 40H20z"/><path d="M12 22h40M11 30h42M12 38h40M13 46h38" stroke-dasharray="3 3"/><path d="M22 14c3-6 7-6 10 0c3-6 7-6 10 0" class="hot"/>` },
  arc_furnace: { label: "Arc furnace (EAF)", svg: `<path d="M10 34h44v10c0 7-6 12-13 12H23c-7 0-13-5-13-12z"/><path d="M8 34c6-6 42-6 48 0"/><path d="M24 6v24M32 4v26M40 6v24"/><path d="M22 44h20" class="hot"/>` },
  ladle_furnace: { label: "Ladle furnace", svg: `<path d="M14 22h36l-5 32H19z"/><path d="M10 22h44"/><path d="M27 6v14M37 6v14"/><path d="M20 30h24" class="hot"/><path d="M8 28h6M50 28h6"/>` },
  rolling_mill: { label: "Rolling mill", svg: `<circle cx="32" cy="18" r="10"/><circle cx="32" cy="46" r="10"/><path d="M4 32h56" class="hot"/><path d="M10 8v48M54 8v48"/>` },
  compressor: { label: "Air compressor", svg: `<rect x="6" y="30" width="38" height="20" rx="10"/><circle cx="50" cy="20" r="9"/><path d="M50 29v8h-6M14 50v6M36 50v6M24 30v-8h17"/>` },
  motor: { label: "Motor / pump", svg: `<circle cx="28" cy="32" r="18"/><path d="M46 32h12M58 26v12"/><path d="M20 40V24l8 10l8-10v16"/>` },
  fan: { label: "Fan / blower / ID fan", svg: `<circle cx="32" cy="32" r="22"/><path d="M32 32c0-10 8-14 12-10s-2 10-12 10zM32 32c10 0 14 8 10 12s-10-2-10-12zM32 32c0 10-8 14-12 10s2-10 12-10zM32 32c-10 0-14-8-10-12s10 2 10 12z"/>` },
  crane: { label: "EOT crane", svg: `<path d="M4 10h56M8 10v44M56 10v44"/><rect x="24" y="10" width="16" height="8"/><path d="M32 18v22"/><path d="M26 40h12l-2 6c-1 4-6 4-7 0" /><path d="M4 54h8M52 54h8"/>` },
  caster: { label: "Continuous caster (CCM)", svg: `<path d="M18 6h28l-6 12H24z" /><path d="M28 18v10"/><path d="M28 28c0 16 8 24 28 24" /><path d="M32 28c0 13 6 19 24 19" /><path d="M24 34h-6M28 44l-5 4M38 52l-2 6" class="hot"/>` },
  dg_set: { label: "DG set / generator", svg: `<circle cx="32" cy="32" r="22"/><path d="M40 24c-3-4-12-5-15 2s0 14 7 14c5 0 8-3 8-8h-8"/>` },
  capacitor: { label: "Capacitor bank / APFC", svg: `<path d="M32 4v20M32 40v20M14 24h36M14 40h36"/>` },
  lighting: { label: "Lighting / utilities", svg: `<path d="M22 28a10 10 0 1 1 20 0c0 6-5 8-5 14H27c0-6-5-8-5-14z"/><path d="M27 48h10M28 54h8"/><path d="M32 4v4M14 12l3 3M50 12l-3 3"/>` },
  office: { label: "Office / building", svg: `<path d="M12 56V14l20-8v50M32 22h20v34M6 56h52"/><path d="M18 22h6M18 30h6M18 38h6M38 30h8M38 38h8M38 46h8"/>` },
  feeder: { label: "Other feeder", svg: `<rect x="12" y="8" width="40" height="48" rx="3"/><path d="M20 20h24M20 28h24M20 36h12"/><circle cx="40" cy="44" r="4"/>` },
};

window.machineIcon = function (key, size = 40, extraClass = "") {
  const m = MACHINES[key] || MACHINES.feeder;
  return `<svg class="mach ${extraClass}" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${m.svg}</svg>`;
};

// Guess a picture from the meter's name when none is chosen yet.
window.guessMachine = function (m) {
  if (m.machine && MACHINES[m.machine]) return m.machine;
  const n = (m.name + " " + (m.area || "")).toLowerCase();
  const rules = [[/incom|transformer|33 ?kv|11 ?kv|hv|main/, "transformer"], [/induction|ifm|\bif\b/, "induction_furnace"], [/eaf|arc/, "arc_furnace"],
    [/ladle|lrf|\blf\b/, "ladle_furnace"], [/rolling|mill|stand/, "rolling_mill"], [/compress/, "compressor"], [/fan|blower/, "fan"],
    [/crane|eot/, "crane"], [/ccm|caster|casting/, "caster"], [/dg|generator|genset/, "dg_set"], [/capacitor|apfc/, "capacitor"],
    [/light|utility|utilities/, "lighting"], [/office|admin|building/, "office"], [/pump|motor/, "motor"]];
  for (const [re, k] of rules) if (re.test(n)) return k;
  return "feeder";
};

// Draws the diagram. meters: list from /api/meters. today: {meter_id: dailyRow}.
window.drawMimic = function (el, meters, today, opts = {}) {
  const W = el.clientWidth || 900;
  const vertical = W < 640;
  const mains = meters.filter(m => m.is_main && m.enabled);
  const feeders = meters.filter(m => !m.is_main && m.enabled);
  const fmt = v => (v == null || isNaN(v) ? "–" : fmtNum(v, Math.abs(v) >= 100 ? 0 : 1));
  const state = m => (!m.online ? "off" : m.alarms.length ? "alarm" : "on");
  const loadPct = m => (m.contract_kva && m.values.kva != null ? Math.min(1, m.values.kva / m.contract_kva) : null);
  // flow speed: busier feeders move faster (seconds per dash cycle)
  const speed = m => { const p = loadPct(m) ?? Math.min(1, (m.values.kw || 0) / 1500); return Math.max(0.5, 3 - 2.5 * p).toFixed(2); };
  const link = (m, inner) => `<a href="#/meter/${encodeURIComponent(m.id)}" class="node node-${state(m)}" aria-label="${esc(m.name)}">${inner}</a>`;

  let svg = "";
  if (!vertical) {
    const cols = Math.max(1, Math.min(feeders.length, Math.floor((W - 40) / 150)));
    const rows = Math.ceil(feeders.length / cols) || 1;
    const colW = (W - 40) / cols;
    const top = mains.length ? 150 : 40;
    const rowH = 190;
    const H = top + rows * rowH + 10;
    svg += `<svg class="mimic" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Plant power diagram">`;
    // supply and incomers
    const busY = top;
    if (mains.length) {
      const mw = (W - 40) / mains.length;
      mains.forEach((m, i) => {
        const x = 20 + mw * (i + 0.5);
        svg += `<g class="st-${state(m)}"><path class="wire" d="M${x} 8V40"/><path class="flow" style="--spd:${speed(m)}s" d="M${x} 8V40"/>`;
        svg += `<path class="wire" d="M${x} 104V${busY}"/><path class="flow" style="--spd:${speed(m)}s" d="M${x} 104V${busY}"/></g>`;
        svg += `<foreignObject x="${x - 36}" y="36" width="${Math.min(300, mw / 2 + 120)}" height="72">${link(m, `<div class="inc">${machineIcon(guessMachine(m), 56)}<div><b>${esc(m.name)}</b><span class="big">${fmt(m.values.kw)}<small>kW</small></span><span>${fmt(m.values.kva)} kVA · PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 3) : "–"}</span></div></div>`)}</foreignObject>`;
      });
      svg += `<text class="grid-lbl" x="${20 + mw / 2 + 10}" y="18">${esc(opts.supplyLabel || "Grid supply")}</text>`;
    }
    svg += `<rect class="bus" x="14" y="${busY - 4}" width="${W - 28}" height="8" rx="2"/>`;
    feeders.forEach((m, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = 20 + colW * (c + 0.5);
      const y0 = busY + r * rowH;
      const pct = loadPct(m);
      if (r > 0) svg += `<path class="wire faint" d="M${x} ${busY}V${y0}"/>`;
      svg += `<g class="st-${state(m)}"><path class="wire" d="M${x} ${y0 + 4}V${y0 + 40}"/><path class="flow" style="--spd:${speed(m)}s" d="M${x} ${y0 + 4}V${y0 + 40}"/>`;
      svg += `<rect class="brk" x="${x - 6}" y="${y0 + 18}" width="12" height="12"/></g>`;
      const t = today[m.id];
      svg += `<foreignObject x="${x - colW / 2 + 6}" y="${y0 + 40}" width="${colW - 12}" height="${rowH - 46}">${link(m, `
        <div class="pic">${machineIcon(guessMachine(m), 58)}${m.alarms.length ? `<i class="flag" title="${esc(m.alarms.join("; "))}">!</i>` : ""}</div>
        <b class="nm">${esc(m.name)}</b>
        <span class="big">${m.online ? fmt(m.values.kw) : "Off"}<small>${m.online ? "kW" : "line"}</small></span>
        <span class="sub">${m.online ? `PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 2) : "–"} · ${t ? fmtNum(t.kwh, 0) : "–"} kWh today` : esc(m.error || "No data")}</span>
        ${pct != null ? `<span class="ld" title="${fmtNum(pct * 100, 0)}% of ${m.contract_kva} kVA"><i style="width:${pct * 100}%"></i></span>` : ""}`)}</foreignObject>`;
    });
    svg += `</svg>`;
  } else {
    // phone: bus runs down the left, machines branch to the right
    const rowH = 92, top = mains.length ? mains.length * 100 + 16 : 16;
    const H = top + feeders.length * rowH + 10, bx = 22;
    svg += `<svg class="mimic" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Plant power diagram">`;
    mains.forEach((m, i) => {
      const y = 8 + i * 100;
      svg += `<g class="st-${state(m)}"><path class="wire" d="M${bx} ${y}V${y + 92}"/><path class="flow" style="--spd:${speed(m)}s" d="M${bx} ${y}V${y + 92}"/></g>`;
      svg += `<foreignObject x="${bx + 14}" y="${y}" width="${W - bx - 18}" height="86">${link(m, `<div class="inc">${machineIcon(guessMachine(m), 48)}<div><b>${esc(m.name)}</b><span class="big">${fmt(m.values.kw)}<small>kW</small></span><span>${fmt(m.values.kva)} kVA · PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 3) : "–"}</span></div></div>`)}</foreignObject>`;
    });
    if (feeders.length) svg += `<rect class="bus" x="${bx - 4}" y="${top - 6}" width="8" height="${feeders.length * rowH - rowH / 2 + 8}" rx="2"/>`;
    feeders.forEach((m, i) => {
      const y = top + i * rowH, t = today[m.id];
      svg += `<g class="st-${state(m)}"><path class="wire" d="M${bx} ${y + 36}H${bx + 34}"/><path class="flow" style="--spd:${speed(m)}s" d="M${bx} ${y + 36}H${bx + 34}"/></g>`;
      svg += `<foreignObject x="${bx + 34}" y="${y}" width="${W - bx - 38}" height="${rowH - 8}">${link(m, `<div class="row-node">
        <div class="pic">${machineIcon(guessMachine(m), 46)}${m.alarms.length ? `<i class="flag">!</i>` : ""}</div>
        <div><b class="nm">${esc(m.name)}</b><span class="sub">${m.online ? `PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 2) : "–"} · ${t ? fmtNum(t.kwh, 0) : "–"} kWh today` : esc(m.error || "No data")}</span></div>
        <span class="big">${m.online ? fmt(m.values.kw) : "Off"}<small>${m.online ? "kW" : ""}</small></span></div>`)}</foreignObject>`;
    });
    svg += `</svg>`;
  }
  el.innerHTML = svg;
};
