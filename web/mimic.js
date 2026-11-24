"use strict";
// Plant single-line diagram with machine pictures and live power flow.
// Pictures are drawn in a 64x64 box with currentColor so they follow the theme.

window.MACHINES = {
  // Power
  transformer: { group: "Power", label: "Transformer / incomer", svg: `<circle cx="32" cy="24" r="13"/><circle cx="32" cy="40" r="13"/><path d="M32 4v7M32 53v7"/>` },
  dg_set: { group: "Power", label: "DG set / generator", svg: `<circle cx="32" cy="32" r="22"/><path d="M40 24c-3-4-12-5-15 2s0 14 7 14c5 0 8-3 8-8h-8"/>` },
  capacitor: { group: "Power", label: "Capacitor bank / APFC", svg: `<path d="M32 4v20M32 40v20M14 24h36M14 40h36"/>` },
  // Coating lines
  cgl_line: { group: "Coating lines", label: "CGL line (galvanizing)", svg: `<circle cx="9" cy="18" r="6"/><path d="M15 18h7v22c0 7 18 7 18 0V12h9"/><circle cx="55" cy="18" r="6"/><path d="M16 34h30v22H16z"/><path d="M16 40h30" class="hot"/><text x="23" y="53" font-size="9" font-weight="700" stroke="none" fill="currentColor">GI</text>` },
  galvalume_line: { group: "Coating lines", label: "Galvalume line", svg: `<circle cx="9" cy="18" r="6"/><path d="M15 18h7v22c0 7 18 7 18 0V12h9"/><circle cx="55" cy="18" r="6"/><path d="M16 34h30v22H16z"/><path d="M16 40h30" class="hot"/><text x="21" y="53" font-size="9" font-weight="700" stroke="none" fill="currentColor">AZ</text>` },
  ccl_line: { group: "Coating lines", label: "CCL line (colour coating)", svg: `<circle cx="9" cy="32" r="6"/><path d="M15 32h44"/><circle cx="22" cy="40" r="4" class="hot"/><circle cx="22" cy="24" r="4"/><path d="M30 20h26v24H30z"/><path d="M35 52c2-3 4 3 6 0s4 3 6 0s4 3 6 0" class="hot"/>` },
  // Rolling and strip processing
  rolling_mill: { group: "Rolling and strip processing", label: "Hot rolling mill", svg: `<circle cx="32" cy="18" r="10"/><circle cx="32" cy="46" r="10"/><path d="M4 32h56" class="hot"/><path d="M10 8v48M54 8v48"/>` },
  cold_rolling_mill: { group: "Rolling and strip processing", label: "Cold rolling mill (CRM)", svg: `<circle cx="32" cy="11" r="7"/><circle cx="32" cy="25" r="5"/><circle cx="32" cy="39" r="5"/><circle cx="32" cy="53" r="7"/><path d="M4 32h56"/><path d="M18 2v60M46 2v60"/>` },
  pickling_line: { group: "Rolling and strip processing", label: "Pickling line", svg: `<circle cx="9" cy="14" r="6"/><path d="M15 14h4v20h40"/><path d="M8 26h16v24H8zM26 26h16v24H26zM44 26h16v24H44z"/><path d="M10 40h12M28 40h12M46 40h12" class="hot"/><circle cx="16" cy="46" r="1.5"/><circle cx="34" cy="45" r="1.5"/><circle cx="52" cy="46" r="1.5"/>` },
  annealing_furnace: { group: "Rolling and strip processing", label: "Annealing furnace", svg: `<path d="M14 54V26a18 18 0 0 1 36 0v28"/><path d="M8 54h48"/><circle cx="32" cy="44" r="6" class="hot"/><circle cx="32" cy="30" r="5" class="hot"/>` },
  // Finishing
  hr_slitter: { group: "Finishing", label: "HR slitter", svg: `<circle cx="13" cy="32" r="10" class="hot"/><circle cx="13" cy="32" r="3"/><path d="M23 32h10"/><circle cx="37" cy="24" r="5"/><circle cx="37" cy="40" r="5"/><path d="M42 26h18M42 32h18M42 38h18"/>` },
  cr_slitter: { group: "Finishing", label: "CR slitter", svg: `<circle cx="13" cy="32" r="10"/><circle cx="13" cy="32" r="6"/><circle cx="13" cy="32" r="2"/><path d="M23 32h10"/><circle cx="37" cy="24" r="5"/><circle cx="37" cy="40" r="5"/><path d="M42 27h18M42 30.5h18M42 34h18M42 37.5h18"/>` },
  trimming_line: { group: "Finishing", label: "Trimming line", svg: `<path d="M4 24h56M4 40h56"/><circle cx="32" cy="22" r="5"/><circle cx="32" cy="42" r="5"/><path d="M37 20c8 0 12-6 8-12M37 44c8 0 12 6 8 12" class="hot"/>` },
  cut_to_length: { group: "Finishing", label: "Cut-to-length line", svg: `<circle cx="9" cy="22" r="6"/><path d="M15 22h17"/><path d="M34 10v12M34 26v6" stroke-width="3"/><path d="M28 46h30M28 51h30M28 56h30"/>` },
  // Utilities
  utility: { group: "Utilities", label: "Utility", svg: `<path d="M4 28h18M42 28h18M22 20v16l20-16v16z"/><path d="M32 28V14M25 14h14"/><path d="M4 48h56"/><circle cx="32" cy="48" r="5"/>` },
  boiler: { group: "Utilities", label: "Boiler", svg: `<rect x="10" y="18" width="30" height="38" rx="5"/><path d="M46 56V8h8v48"/><path d="M40 26h6"/><path d="M25 48c-6-4-4-10 0-14c1 4 4 4 4 8c0-3 2-4 2-6c3 4 3 9-1 12" class="hot"/>` },
  lpg_yard: { group: "Utilities", label: "LPG yard", svg: `<path d="M12 12h32a7 7 0 0 1 0 14H12a7 7 0 0 1 0-14zM12 32h32a7 7 0 0 1 0 14H12a7 7 0 0 1 0-14z"/><path d="M16 46v10M40 46v10M8 56h40"/><path d="M56 34c-4-4-2-8 0-12c2 4 5 6 0 12" class="hot"/>` },
  etp: { group: "Utilities", label: "ETP (effluent treatment)", svg: `<path d="M6 26h44l-8 22H14z"/><path d="M28 26v14"/><path d="M42 48v8h16"/><path d="M50 6c-3 5-5 7-5 10a5 5 0 0 0 10 0c0-3-2-5-5-10z"/>` },
  ro_plant: { group: "Utilities", label: "RO plant", svg: `<rect x="6" y="12" width="44" height="10" rx="5"/><rect x="6" y="28" width="44" height="10" rx="5"/><path d="M14 38v16M42 38v16M8 54h40"/><path d="M50 17h6v16h-6"/><path d="M56 42c-2 3-3 4-3 6a3 3 0 0 0 6 0c0-2-1-3-3-6z"/>` },
  cooling_tower: { group: "Utilities", label: "Cooling tower", svg: `<path d="M16 58c5-14 5-30 0-44h32c-5 14-5 30 0 44z"/><path d="M24 10c-3-3 3-5 0-8M32 10c-3-3 3-5 0-8M40 10c-3-3 3-5 0-8"/>` },
  compressor: { group: "Utilities", label: "Air compressor", svg: `<rect x="6" y="30" width="38" height="20" rx="10"/><circle cx="50" cy="20" r="9"/><path d="M50 29v8h-6M14 50v6M36 50v6M24 30v-8h17"/>` },
  pump: { group: "Utilities", label: "Pump", svg: `<circle cx="28" cy="36" r="14"/><path d="M28 22V10h22M4 36h10M14 56h28M28 36l8-8"/>` },
  motor: { group: "Utilities", label: "Motor", svg: `<circle cx="28" cy="32" r="18"/><path d="M46 32h12M58 26v12"/><path d="M20 40V24l8 10l8-10v16"/>` },
  fan: { group: "Utilities", label: "Fan / blower / ID fan", svg: `<circle cx="32" cy="32" r="22"/><path d="M32 32c0-10 8-14 12-10s-2 10-12 10zM32 32c10 0 14 8 10 12s-10-2-10-12zM32 32c0 10-8 14-12 10s2-10 12-10zM32 32c-10 0-14-8-10-12s10 2 10 12z"/>` },
  oxygen_plant: { group: "Utilities", label: "Oxygen / gas plant", svg: `<rect x="8" y="6" width="12" height="50" rx="6"/><rect x="26" y="14" width="12" height="42" rx="6"/><rect x="44" y="30" width="12" height="26" rx="6"/><path d="M4 58h56"/>` },
  fume_extraction: { group: "Utilities", label: "Fume extraction / bag filter", svg: `<path d="M10 8h40v30l-10 14H20L10 38z"/><path d="M18 12v22M26 12v22M34 12v22M42 12v22"/><path d="M50 16h10M30 52v8"/>` },
  // Melting and casting
  induction_furnace: { group: "Melting and casting", label: "Induction furnace", svg: `<path d="M16 14h32l-4 40H20z"/><path d="M12 22h40M11 30h42M12 38h40M13 46h38" stroke-dasharray="3 3"/><path d="M22 14c3-6 7-6 10 0c3-6 7-6 10 0" class="hot"/>` },
  arc_furnace: { group: "Melting and casting", label: "Arc furnace (EAF)", svg: `<path d="M10 34h44v10c0 7-6 12-13 12H23c-7 0-13-5-13-12z"/><path d="M8 34c6-6 42-6 48 0"/><path d="M24 6v24M32 4v26M40 6v24"/><path d="M22 44h20" class="hot"/>` },
  ladle_furnace: { group: "Melting and casting", label: "Ladle furnace", svg: `<path d="M14 22h36l-5 32H19z"/><path d="M10 22h44"/><path d="M27 6v14M37 6v14"/><path d="M20 30h24" class="hot"/><path d="M8 28h6M50 28h6"/>` },
  caster: { group: "Melting and casting", label: "Continuous caster (CCM)", svg: `<path d="M18 6h28l-6 12H24z"/><path d="M28 18v10"/><path d="M28 28c0 16 8 24 28 24"/><path d="M32 28c0 13 6 19 24 19"/><path d="M24 34h-6M28 44l-5 4M38 52l-2 6" class="hot"/>` },
  reheating_furnace: { group: "Melting and casting", label: "Reheating furnace", svg: `<path d="M6 18h52v26H6z"/><path d="M48 18V6h6v12"/><path d="M12 32h40" stroke-width="5" class="hot"/><path d="M16 56c-3-3-1-6 1-8c1 3 3 4 1 8M30 56c-3-3-1-6 1-8c1 3 3 4 1 8M44 56c-3-3-1-6 1-8c1 3 3 4 1 8" class="hot"/>` },
  // Handling and buildings
  crane: { group: "Handling and buildings", label: "EOT crane", svg: `<path d="M4 10h56M8 10v44M56 10v44"/><rect x="24" y="10" width="16" height="8"/><path d="M32 18v22"/><path d="M26 40h12l-2 6c-1 4-6 4-7 0"/><path d="M4 54h8M52 54h8"/>` },
  workshop: { group: "Handling and buildings", label: "Workshop", svg: `<circle cx="24" cy="40" r="11" stroke-dasharray="4.5 3" stroke-width="5"/><circle cx="24" cy="40" r="4"/><path d="M36 28 50 14"/><path d="M47 9a8 8 0 0 0 9 10l-4-1-2-2-1-4z"/>` },
  lighting: { group: "Handling and buildings", label: "Lighting", svg: `<path d="M22 28a10 10 0 1 1 20 0c0 6-5 8-5 14H27c0-6-5-8-5-14z"/><path d="M27 48h10M28 54h8"/><path d="M32 4v4M14 12l3 3M50 12l-3 3"/>` },
  office: { group: "Handling and buildings", label: "Office / building", svg: `<path d="M12 56V14l20-8v50M32 22h20v34M6 56h52"/><path d="M18 22h6M18 30h6M18 38h6M38 30h8M38 38h8M38 46h8"/>` },
  feeder: { group: "Handling and buildings", label: "Other feeder", svg: `<rect x="12" y="8" width="40" height="48" rx="3"/><path d="M20 20h24M20 28h24M20 36h12"/><circle cx="40" cy="44" r="4"/>` },
};

window.machineIcon = function (key, size = 40, extraClass = "") {
  const m = MACHINES[key] || MACHINES.feeder;
  return `<svg class="mach ${extraClass}" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${m.svg}</svg>`;
};

// A machine's own uploaded picture if it has one, else its drawing.
window.machinePic = function (m, size = 40) {
  if (m.picture_url) return `<img class="mach-img" src="${esc(m.picture_url)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
  return machineIcon(guessMachine(m), size);
};

// Guess a picture from the meter's name when none is chosen yet.
window.guessMachine = function (m) {
  if (m.machine && MACHINES[m.machine]) return m.machine;
  const n = (m.name + " " + (m.area || "")).toLowerCase();
  const rules = [[/hr ?slit/, "hr_slitter"], [/cr ?slit|slitter/, "cr_slitter"], [/trim/, "trimming_line"], [/\bctl\b|cut.?to.?length|shear/, "cut_to_length"],
    [/galvalume|\baz\b/, "galvalume_line"], [/\bcgl\b|galvani/, "cgl_line"], [/\bccl\b|colou?r ?coat|ppgi/, "ccl_line"], [/pickl/, "pickling_line"],
    [/\bcrm\b|cold roll/, "cold_rolling_mill"], [/reheat/, "reheating_furnace"], [/anneal|\bbaf\b/, "annealing_furnace"],
    [/\betp\b|effluent/, "etp"], [/\bro\b|reverse osmosis|\bdm\b/, "ro_plant"], [/boiler/, "boiler"], [/lpg|gas yard/, "lpg_yard"],
    [/cooling tower/, "cooling_tower"], [/oxygen|nitrogen|\basu\b/, "oxygen_plant"], [/fume|bag ?filter|\bfes\b|dust/, "fume_extraction"],
    [/workshop/, "workshop"], [/utilit/, "utility"],
    [/incom|transformer|33 ?kv|11 ?kv|\bhv\b|main/, "transformer"], [/induction|\bifm\b/, "induction_furnace"], [/\beaf\b|arc/, "arc_furnace"],
    [/ladle|\blrf\b|\blf\b/, "ladle_furnace"], [/rolling|mill|stand/, "rolling_mill"], [/compress/, "compressor"], [/fan|blower/, "fan"],
    [/crane|eot/, "crane"], [/ccm|caster|casting/, "caster"], [/\bdg\b|generator|genset/, "dg_set"], [/capacitor|apfc/, "capacitor"],
    [/light/, "lighting"], [/office|admin|building/, "office"], [/pump/, "pump"], [/motor/, "motor"]];
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
        svg += `<foreignObject x="${x - 36}" y="36" width="${Math.min(300, mw / 2 + 120)}" height="72">${link(m, `<div class="inc">${machinePic(m, 56)}<div><b>${esc(m.name)}</b><span class="big">${fmt(m.values.kw)}<small>kW</small></span><span>${fmt(m.values.kva)} kVA · PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 3) : "–"}</span></div></div>`)}</foreignObject>`;
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
        <div class="pic">${machinePic(m, 58)}${m.alarms.length ? `<i class="flag" title="${esc(m.alarms.join("; "))}">!</i>` : ""}</div>
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
      svg += `<foreignObject x="${bx + 14}" y="${y}" width="${W - bx - 18}" height="86">${link(m, `<div class="inc">${machinePic(m, 48)}<div><b>${esc(m.name)}</b><span class="big">${fmt(m.values.kw)}<small>kW</small></span><span>${fmt(m.values.kva)} kVA · PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 3) : "–"}</span></div></div>`)}</foreignObject>`;
    });
    if (feeders.length) svg += `<rect class="bus" x="${bx - 4}" y="${top - 6}" width="8" height="${feeders.length * rowH - rowH / 2 + 8}" rx="2"/>`;
    feeders.forEach((m, i) => {
      const y = top + i * rowH, t = today[m.id];
      svg += `<g class="st-${state(m)}"><path class="wire" d="M${bx} ${y + 36}H${bx + 34}"/><path class="flow" style="--spd:${speed(m)}s" d="M${bx} ${y + 36}H${bx + 34}"/></g>`;
      svg += `<foreignObject x="${bx + 34}" y="${y}" width="${W - bx - 38}" height="${rowH - 8}">${link(m, `<div class="row-node">
        <div class="pic">${machinePic(m, 46)}${m.alarms.length ? `<i class="flag">!</i>` : ""}</div>
        <div><b class="nm">${esc(m.name)}</b><span class="sub">${m.online ? `PF ${m.values.pf != null ? fmtNum(Math.abs(m.values.pf), 2) : "–"} · ${t ? fmtNum(t.kwh, 0) : "–"} kWh today` : esc(m.error || "No data")}</span></div>
        <span class="big">${m.online ? fmt(m.values.kw) : "Off"}<small>${m.online ? "kW" : ""}</small></span></div>`)}</foreignObject>`;
    });
    svg += `</svg>`;
  }
  el.innerHTML = svg;
};
