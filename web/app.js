"use strict";
// Energy Monitoring Management dashboard. Plain JavaScript, no build step, works offline on the plant LAN.

const S = { info: null, meters: [], timer: null, route: "", today: {}, settingsTab: "branding" };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = k => (S.info && S.info.params[k]) || { label: k, unit: "" };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const CONN = { rs485: "RS485", ethernet: "Ethernet", gateway: "Gateway", simulator: "Simulator", cloud: "Cloud" };
const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error("login"); }
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).detail || msg; } catch (_) {} throw new Error(msg); }
  return res.json();
}

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500); }

// ---------------- branding ----------------
function applyBranding() {
  const b = (S.info && S.info.branding) || {};
  const root = document.documentElement;
  root.style.setProperty("--accent", b.accent || "#ff7a1a");
  root.dataset.theme = store.get("theme") || b.theme || "dark";
  $("#companyName").textContent = b.company_name || "Energy Monitoring";
  $("#plantName").textContent = S.info.plant_name || "";
  $("#brandLogo").closest(".brand").classList.toggle("has-logo", !!b.logo_url);
  $("#brandLogo").innerHTML = b.logo_url
    ? `<img src="${esc(b.logo_url)}" alt="${esc(b.company_name || "Company logo")}">`
    : `<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true"><path d="M36 6 16 36h14l-4 22 22-32H34z" fill="currentColor"/></svg>`;
  document.title = (b.company_name ? b.company_name + " · " : "") + "Energy Monitoring";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--rail").trim() || "#171a1f";
}

$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme;
  const dark = cur === "dark" || (cur === "auto" && !matchMedia("(prefers-color-scheme: light)").matches);
  store.set("theme", dark ? "light" : "dark");
  applyBranding();
  if (S.route === "overview" || S.route === "meter") route();
};

setInterval(() => { const c = $("#clock"); if (c) c.textContent = new Date().toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }, 1000);

// ---------------- boot ----------------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try { S.info = await (await fetch("/api/info", { credentials: "same-origin" })).json(); }
  catch (e) { $("#view").innerHTML = `<p class="pad err">Can't reach the logging PC. Check that it is switched on and that this device is on the plant network.</p>`; return; }
  applyBranding();
  if (S.info.login_required && !S.info.user) return showLogin();
  afterLogin();
}

function afterLogin() {
  const u = S.info.user;
  $("#rail").hidden = false;
  $("#logoutBtn").hidden = !S.info.login_required;
  $("#navSettings").hidden = !(u && u.role === "admin");
  window.addEventListener("hashchange", route);
  route();
}

function showLogin() {
  clearInterval(S.timer);
  $("#rail").hidden = true;
  const b = S.info.branding || {};
  $("#view").innerHTML = `<form class="login" id="loginForm"><div class="panel">
    <div class="brand">${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="" style="max-height:48px;max-width:180px">` : ""}<span class="names"><b>${esc(b.company_name || "Energy Monitoring")}</b><small>${esc(S.info.plant_name || "")}</small></span></div>
    <label class="f">Username<input name="username" autocomplete="username" required></label>
    <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" id="loginErr" hidden></p>
    <button class="primary">Sign in</button></div></form>`;
  $("#loginForm").onsubmit = async ev => {
    ev.preventDefault();
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(ev.target))) });
    if (!r.ok) { const e = $("#loginErr"); e.hidden = false; e.textContent = "Wrong username or password."; return; }
    S.info = await (await fetch("/api/info")).json();
    applyBranding();
    afterLogin();
  };
}

$("#logoutBtn").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.hash = "#/"; location.reload(); };

function route() {
  clearInterval(S.timer);
  window.onresize = null;
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  S.route = name || "overview";
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.route === (S.route === "meter" ? "overview" : S.route)));
  const views = { overview: viewOverview, meter: () => viewMeter(decodeURIComponent(arg || "")), reports: viewReports, events: viewEvents, settings: () => viewSettings() };
  (views[S.route] || viewOverview)();
  window.scrollTo(0, 0);
}

function syncBadge() {
  const b = $("#syncBadge"), s = S.info && S.info.cloud_sync;
  if (!s) { b.hidden = true; return; }
  b.hidden = false;
  if (s.last_error) { b.className = "badge bad"; b.textContent = `Cloud sync failing, ${s.backlog} waiting`; b.title = s.last_error; }
  else if (s.last_ok) { b.className = "badge ok"; b.textContent = "Cloud synced"; b.title = "Last sync " + new Date(s.last_ok * 1000).toLocaleTimeString(); }
  else { b.className = "badge"; b.textContent = "Cloud sync starting"; }
}

async function refreshInfo() { try { S.info = { ...S.info, ...(await (await fetch("/api/info")).json()) }; syncBadge(); } catch (_) {} }

function alarmsOf(ms) {
  return ms.filter(m => m.enabled).flatMap(m => (m.online ? m.alarms.map(a => ({ m, text: a, kind: "alarm" })) : [{ m, text: m.error ? `No data: ${m.error}` : "No data", kind: "off" }]));
}
function setAlarmCount(n) { const e = $("#alarmCount"); e.hidden = !n; e.textContent = n; }

// ---------------- plant overview ----------------
async function viewOverview() {
  const v = $("#view");
  v.innerHTML = `<div class="readouts" id="ovRead"></div>
    <section class="mimic-panel"><div class="mimic-head"><h2>${S.info.mode === "cloud" ? "All plants" : "Plant power"}</h2>
      <div class="legend"><span class="l-on">Running</span><span class="l-alarm">Alarm</span><span class="l-off">No data</span></div></div>
      <div id="ovMimic"></div></section>
    <h2>Active alarms</h2><div id="ovAlarms"></div>`;
  const loadToday = async () => { try { S.today = Object.fromEntries((await api(`/api/reports/daily?start=${today()}`)).rows.map(r => [r.meter_id, r])); } catch (_) {} };
  const draw = async () => {
    try { S.meters = (await api("/api/meters")).meters; } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; }
    if (S.route !== "overview") return;
    renderOverview();
  };
  await loadToday(); await draw(); refreshInfo();
  let n = 0;
  S.timer = setInterval(async () => { if (++n % 12 === 0) { await loadToday(); refreshInfo(); } draw(); }, S.info.mode === "cloud" ? 15000 : 5000);
  let rt; window.onresize = () => { clearTimeout(rt); rt = setTimeout(renderOverview, 150); };
}

function renderOverview() {
  if (!$("#ovMimic")) return;
  const ms = S.meters.filter(m => m.enabled);
  const mains = ms.filter(m => m.is_main), basis = mains.length ? mains : ms, ids = new Set(basis.map(m => m.id));
  const on = basis.filter(m => m.online);
  const sum = k => on.reduce((a, m) => a + (m.values[k] || 0), 0);
  const kw = sum("kw"), kva = sum("kva"), pf = kva ? kw / kva : null;
  const rows = Object.values(S.today).filter(r => ids.has(r.meter_id));
  const kwh = rows.reduce((a, r) => a + r.kwh, 0);
  const md = rows.reduce((a, r) => Math.max(a, r.md_kva || 0), 0);
  const contract = mains.reduce((a, m) => a + (m.contract_kva || 0), 0);
  const mdPct = contract ? md / contract : null;
  const basisNote = mains.length ? (mains.length === 1 ? `at ${mains[0].name}` : `${mains.length} incomers`) : "all meters added";
  const pfMin = 0.9;
  $("#ovRead").innerHTML = `
    <div class="readout"><div class="k">Plant load</div><div class="v">${fmtNum(kw, 0)}<small>kW</small></div><div class="s">${fmtNum(kva, 0)} kVA, ${esc(basisNote)}</div></div>
    <div class="readout ${pf != null && pf < pfMin ? "warn" : ""}"><div class="k">Power factor</div><div class="v">${pf != null ? fmtNum(pf, 3) : "–"}</div><div class="s">${pf != null && pf < pfMin ? "Low, check capacitor banks" : "kW ÷ kVA"}</div></div>
    <div class="readout"><div class="k">Energy today</div><div class="v">${fmtNum(kwh, 0)}<small>kWh</small></div><div class="s">since midnight</div></div>
    <div class="readout ${mdPct > 0.95 ? "bad" : mdPct > 0.85 ? "warn" : ""}"><div class="k">Max demand today</div><div class="v">${fmtNum(md, 0)}<small>kVA</small></div>
      <div class="s">${contract ? `${fmtNum(mdPct * 100, 0)}% of ${fmtNum(contract, 0)} kVA contract` : `${S.info.demand_block_minutes}-minute average`}</div>
      ${contract ? `<div class="meterbar ${mdPct > 0.95 ? "bad" : mdPct > 0.85 ? "warn" : ""}"><i style="width:${Math.min(100, mdPct * 100)}%"></i></div>` : ""}</div>`;

  if (!ms.length) {
    $("#ovMimic").innerHTML = `<p class="pad muted">No meters yet. ${S.info.mode === "plant" ? 'Add them in <a href="#/settings">Settings</a>.' : "Waiting for a plant PC to send data."}</p>`;
  } else if (S.info.mode === "cloud") {
    // one diagram per plant
    const plants = {};
    for (const m of ms) (plants[m.plant_id] = plants[m.plant_id] || []).push(m);
    $("#ovMimic").innerHTML = Object.entries(plants).map(([id, list]) => `<h3 class="muted" style="margin:10px 6px 0">${esc(list[0].plant_name)}</h3><div data-plant="${esc(id)}"></div>`).join("");
    for (const [id, list] of Object.entries(plants)) drawMimic($(`[data-plant="${CSS.escape(id)}"]`), list, S.today, { supplyLabel: "Grid supply" });
  } else {
    drawMimic($("#ovMimic"), ms, S.today, { supplyLabel: "Grid supply" });
  }

  const al = alarmsOf(ms);
  setAlarmCount(al.length);
  $("#ovAlarms").innerHTML = al.length
    ? `<ul class="alarm-list">${al.map(a => `<li><span class="dot ${a.kind === "off" ? "off" : ""}"></span><a href="#/meter/${encodeURIComponent(a.m.id)}"><b>${esc(a.m.name)}</b></a><span>${esc(a.text)}</span></li>`).join("")}</ul>`
    : `<p class="all-clear">All meters are reporting and no limits are crossed.</p>`;
}

// ---------------- one machine ----------------
const GROUPS = [
  ["Power", ["kw", "kva", "kvar", "pf", "hz"]],
  ["Voltage", ["v_ln", "v_ll", "v1", "v2", "v3", "thd_v"]],
  ["Current", ["i_avg", "i1", "i2", "i3", "thd_i"]],
  ["Energy counters", ["kwh", "kvah", "kvarh"]],
];

async function viewMeter(id) {
  const v = $("#view");
  const st = { param: "kw", hours: 24 };
  v.innerHTML = `<a class="back" href="#/">‹ Plant</a><div id="mHead"></div>
    <div class="panel"><div class="row" style="margin-bottom:8px">
      <select id="mParam" aria-label="Value to chart"></select><div class="spacer"></div>
      <div class="seg" id="mRange">${[[1, "1 h"], [6, "6 h"], [24, "24 h"], [168, "7 days"], [720, "30 days"]].map(([h, l]) => `<button data-h="${h}" class="${h === 24 ? "on" : ""}">${l}</button>`).join("")}</div>
    </div><div class="chart" id="mChart"></div></div>
    <div class="groups" id="mParams"></div>
    <h2>Last 7 days</h2><div class="table-wrap" id="mDaily"></div>`;
  const drawHead = async () => {
    try { S.meters = (await api("/api/meters")).meters; } catch (_) { return; }
    const m = S.meters.find(x => x.id === id);
    if (!m) { v.innerHTML = `<p class="pad">This meter isn't set up any more. <a href="#/">Back to the plant</a></p>`; return; }
    const stt = !m.online ? "off" : m.alarms.length ? "alarm" : "on";
    const kind = MACHINES[guessMachine(m)];
    $("#mHead").innerHTML = `<div class="meter-head ${stt}"><div class="pic">${machineIcon(guessMachine(m), 64)}</div>
      <div><h1>${esc(m.name)}</h1><div class="sub">${esc([kind.label, m.area, CONN[m.connection]].filter(Boolean).join(", "))}</div>
      <div class="row" style="margin-top:6px">${m.online ? (m.alarms.length ? `<span class="badge bad">${esc(m.alarms.join("; "))}</span>` : `<span class="badge ok">Running normally</span>`) : `<span class="badge bad">${esc(m.error || "No data")}</span>`}
      ${m.last_seen ? `<span class="hint">updated ${new Date(m.last_seen * 1000).toLocaleTimeString()}</span>` : ""}</div></div></div>`;
    $("#mParams").innerHTML = GROUPS.map(([g, keys]) => {
      const ks = keys.filter(k => m.values[k] != null);
      return ks.length ? `<div class="group"><h3>${g}</h3><dl>${ks.map(k => `<dt>${esc(P(k).label)}</dt><dd>${fmtNum(m.values[k], k === "pf" ? 3 : undefined)}<small>${esc(P(k).unit)}</small></dd>`).join("")}</dl></div>` : "";
    }).join("") || `<p class="muted">No live values yet.</p>`;
    const sel = $("#mParam");
    if (!sel.options.length) {
      const all = Object.keys(S.info.params).filter(k => m.values[k] != null);
      const list = all.length ? all : ["kw"];
      sel.innerHTML = list.map(k => `<option value="${k}">${esc(P(k).label)}${P(k).unit ? " (" + esc(P(k).unit) + ")" : ""}</option>`).join("");
      sel.value = list.includes("kw") ? "kw" : list[0]; st.param = sel.value;
    }
    return m;
  };
  const drawChart = async () => {
    const d = await api(`/api/history?meter=${encodeURIComponent(id)}&param=${st.param}&hours=${st.hours}`);
    const m = S.meters.find(x => x.id === id) || {};
    lineChart($("#mChart"), d.points, { unit: P(st.param).unit, zero: ["kw", "kva", "kvar", "i_avg", "i1", "i2", "i3"].includes(st.param),
      limit: st.param === "kva" ? m.contract_kva : null, gap: Math.max(S.info.log_seconds * 5, st.hours * 3600 / 600 * 3) });
  };
  const drawDaily = async () => {
    const r = await api(`/api/reports/daily?start=${daysAgo(6)}&end=${today()}&meters=${encodeURIComponent(id)}`);
    $("#mDaily").innerHTML = dailyTable(r.rows, false);
  };
  const m = await drawHead();
  if (!m) return;
  $("#mParam").onchange = e => { st.param = e.target.value; drawChart(); };
  $("#mRange").onclick = e => { const b = e.target.closest("button"); if (!b) return; st.hours = +b.dataset.h; $("#mRange").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); drawChart(); };
  drawChart(); drawDaily();
  let n = 0;
  S.timer = setInterval(() => { drawHead(); if (++n % 6 === 0) drawChart(); }, S.info.mode === "cloud" ? 15000 : 5000);
  window.onresize = () => S.route === "meter" && drawChart();
}

// ---------------- reports ----------------
function dailyTable(rows, withMeter = true) {
  if (!rows.length) return `<p class="pad muted">No readings for these dates.</p>`;
  const name = id => (S.meters.find(m => m.id === id) || {}).name || id;
  const tot = { kwh: 0, kvah: 0, kvarh: 0, md: 0 };
  rows.forEach(r => { tot.kwh += r.kwh; tot.kvah += r.kvah; tot.kvarh += r.kvarh; tot.md = Math.max(tot.md, r.md_kva || 0); });
  return `<table><thead><tr><th>Date</th>${withMeter ? "<th>Machine</th>" : ""}<th class="n">kWh</th><th class="n">kVAh</th><th class="n">kVArh</th>
    <th class="n">Avg PF</th><th class="n">Max demand kVA</th><th class="n">at</th><th class="n">Peak kW</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${r.date}</td>${withMeter ? `<td>${esc(name(r.meter_id))}</td>` : ""}<td class="n">${fmtNum(r.kwh, 1)}</td><td class="n">${fmtNum(r.kvah, 1)}</td>
      <td class="n">${fmtNum(r.kvarh, 1)}</td><td class="n">${fmtNum(r.avg_pf, 3)}</td><td class="n">${fmtNum(r.md_kva, 1)}</td><td class="n">${r.md_kva_at || ""}</td><td class="n">${fmtNum(r.peak_kw, 1)}</td></tr>`).join("")}
    <tr class="total"><td>Total</td>${withMeter ? "<td></td>" : ""}<td class="n">${fmtNum(tot.kwh, 1)}</td><td class="n">${fmtNum(tot.kvah, 1)}</td><td class="n">${fmtNum(tot.kvarh, 1)}</td>
      <td class="n">${tot.kvah ? fmtNum(tot.kwh / tot.kvah, 3) : "–"}</td><td class="n">${fmtNum(tot.md, 1)}</td><td></td><td></td></tr></tbody></table>`;
}

async function viewReports() {
  if (!S.meters.length) { try { S.meters = (await api("/api/meters")).meters; } catch (_) { return; } }
  const v = $("#view");
  v.innerHTML = `<h1>Energy reports</h1><p class="lede">Daily consumption, maximum demand and power factor for each machine.</p>
    <div class="panel"><div class="form">
      <label class="f">From<input type="date" id="rStart" value="${daysAgo(6)}"></label>
      <label class="f">To<input type="date" id="rEnd" value="${today()}"></label>
      <label class="f">Machine<select id="rMeter"><option value="">All machines</option>${S.meters.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></label>
      <label class="f">Show<select id="rGroup"><option value="day">Each day, each machine</option><option value="meter">Total per machine</option></select></label>
    </div><div class="row" style="margin-top:14px">
      <button class="primary" id="rRun">Show report</button><div class="spacer"></div>
      <button id="rCsvDaily">Download daily report (Excel)</button><button id="rCsvRaw">Download every reading (Excel)</button>
    </div><p class="hint">Max demand is the highest average kVA over ${S.info.demand_block_minutes}-minute blocks. Times are in ${esc(S.info.timezone)}.</p></div>
    <div class="table-wrap" id="rOut" style="margin-top:14px"></div>`;
  const q = () => `start=${$("#rStart").value}&end=${$("#rEnd").value}${$("#rMeter").value ? "&meters=" + encodeURIComponent($("#rMeter").value) : ""}`;
  const run = async () => {
    $("#rOut").innerHTML = `<p class="pad muted">Working…</p>`;
    try {
      const r = await api(`/api/reports/daily?${q()}`);
      let rows = r.rows;
      if ($("#rGroup").value === "meter") {
        const agg = {};
        for (const x of rows) {
          const a = agg[x.meter_id] = agg[x.meter_id] || { ...x, date: `${r.start} to ${r.end}`, kwh: 0, kvah: 0, kvarh: 0, md_kva: 0, peak_kw: 0 };
          a.kwh += x.kwh; a.kvah += x.kvah; a.kvarh += x.kvarh; a.peak_kw = Math.max(a.peak_kw, x.peak_kw || 0);
          if ((x.md_kva || 0) > a.md_kva) { a.md_kva = x.md_kva; a.md_kva_at = `${x.date.slice(5)} ${x.md_kva_at}`; }
        }
        rows = Object.values(agg).map(a => ({ ...a, avg_pf: a.kvah ? a.kwh / a.kvah : a.avg_pf }));
      }
      $("#rOut").innerHTML = dailyTable(rows);
    } catch (e) { $("#rOut").innerHTML = `<p class="pad err">${esc(e.message)}</p>`; }
  };
  $("#rRun").onclick = run;
  $("#rCsvDaily").onclick = () => (location.href = `/api/export.csv?kind=daily&${q()}`);
  $("#rCsvRaw").onclick = () => (location.href = `/api/export.csv?kind=readings&${q()}`);
  run();
}

// ---------------- alarms / events ----------------
async function viewEvents() {
  if (!S.meters.length) { try { S.meters = (await api("/api/meters")).meters; } catch (_) { return; } }
  const v = $("#view");
  v.innerHTML = `<h1>Alarms</h1><p class="lede">Every limit crossed and every meter that stopped answering, with when it cleared.</p>
    <div class="row" style="margin-bottom:12px"><div class="seg" id="eRange">
    ${[[24, "24 h"], [72, "3 days"], [168, "7 days"], [720, "30 days"]].map(([h, l]) => `<button data-h="${h}" class="${h === 72 ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="table-wrap" id="eOut"></div>`;
  const name = id => (S.meters.find(m => m.id === id) || {}).name || id;
  const load = async h => {
    const r = await api(`/api/events?hours=${h}`);
    $("#eOut").innerHTML = r.events.length ? `<table><thead><tr><th>Time</th><th>Machine</th><th>What happened</th><th>State</th></tr></thead><tbody>
      ${r.events.map(e => `<tr><td>${new Date(e.ts * 1000).toLocaleString()}</td><td>${esc(name(e.meter_id))}</td><td>${esc(e.message)}</td>
      <td>${e.active ? `<span class="badge bad">Raised</span>` : `<span class="badge ok">Cleared</span>`}</td></tr>`).join("")}</tbody></table>` : `<p class="pad muted">No alarms in this period.</p>`;
  };
  $("#eRange").onclick = e => { const b = e.target.closest("button"); if (!b) return; $("#eRange").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); load(+b.dataset.h); };
  load(72);
}

// ---------------- settings ----------------
const SWATCHES = ["#ff7a1a", "#e8b100", "#2f9bff", "#19a974", "#8b5cf6", "#00a3a3", "#7c8796"];

function brandingTab(cfg) {
  const b = S.info.branding || {};
  return `<p class="lede">How the app looks for everyone: your company name, logo and colour.</p>
    <div class="brand-preview" id="bPreview"></div>
    <div class="form" style="margin-top:16px">
      <label class="f">Company name<input id="bCompany" value="${esc(b.company_name || "")}" placeholder="Your company"></label>
      <label class="f">Plant name<input id="bPlant" value="${esc(S.info.plant_name || "")}"></label>
      <label class="f">Screen<select id="bTheme">${[["dark", "Dark (control room)"], ["light", "Light (office)"], ["auto", "Follow the device"]].map(([k, l]) => `<option value="${k}" ${b.theme === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    </div>
    <h2>Company colour</h2><p class="hint">Used for live power on the diagram, charts and buttons. Red stays reserved for alarms.</p>
    <div class="swatches" id="bSw">${SWATCHES.map(c => `<button style="background:${c}" data-c="${c}" title="${c}" aria-label="Colour ${c}" class="${(b.accent || "#ff7a1a") === c ? "on" : ""}"></button>`).join("")}
      <input type="color" id="bAccent" value="${esc(b.accent || "#ff7a1a")}" aria-label="Any colour"></div>
    <h2>Logo</h2>
    <label class="logo-drop" id="bDrop"><input type="file" id="bFile" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden>
      Drop your logo here, or click to choose a file. PNG, JPG, SVG or WebP, under 1 MB. A wide logo on a transparent background works best.</label>
    <div class="row" style="margin-top:10px">${b.logo_url ? `<button class="danger ghost" id="bRemove">Remove logo</button>` : ""}</div>
    <div class="row" style="margin:20px 0 40px"><button class="primary" id="bSave">Save branding</button><span class="err" id="bErr"></span></div>`;
}

function wireBranding() {
  const preview = () => {
    const b = S.info.branding || {};
    $("#bPreview").innerHTML = `${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="">` : `<span style="color:${esc($("#bAccent").value)}">${machineIcon("feeder", 40)}</span>`}
      <div class="names" style="display:flex;flex-direction:column"><b style="font:600 20px var(--num)">${esc($("#bCompany").value || "Your company")}</b><small class="muted">${esc($("#bPlant").value)}</small></div>
      <span class="spacer"></span><button class="primary" style="background:${esc($("#bAccent").value)};border-color:${esc($("#bAccent").value)}" tabindex="-1">Sample button</button>`;
  };
  preview();
  ["#bCompany", "#bPlant"].forEach(s => ($(s).oninput = preview));
  $("#bAccent").oninput = () => { document.documentElement.style.setProperty("--accent", $("#bAccent").value); $("#bSw").querySelectorAll("button").forEach(x => x.classList.remove("on")); preview(); };
  $("#bSw").onclick = e => { const b = e.target.closest("button[data-c]"); if (!b) return; $("#bAccent").value = b.dataset.c; $("#bAccent").oninput(); b.classList.add("on"); };
  const upload = async file => {
    if (!file) return;
    if (file.size > 1_000_000) return toast("That logo is over 1 MB. Save a smaller version and try again.");
    const data_url = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
    try { S.info.branding = await api("/api/branding/logo", { method: "POST", body: JSON.stringify({ data_url }) }); applyBranding(); preview(); toast("Logo uploaded."); viewSettings(); }
    catch (e) { toast(e.message); }
  };
  $("#bFile").onchange = e => upload(e.target.files[0]);
  const drop = $("#bDrop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files[0]); };
  if ($("#bRemove")) $("#bRemove").onclick = async () => { S.info.branding = await api("/api/branding/logo", { method: "POST", body: JSON.stringify({ remove: true }) }); applyBranding(); viewSettings(); };
  $("#bSave").onclick = async () => {
    $("#bErr").textContent = "";
    try {
      S.info.branding = await api("/api/branding", { method: "PUT", body: JSON.stringify({ company_name: $("#bCompany").value, plant_name: $("#bPlant").value, accent: $("#bAccent").value, theme: $("#bTheme").value }) });
      S.info.plant_name = $("#bPlant").value || S.info.plant_name;
      store.set("theme", "");
      applyBranding(); toast("Branding saved.");
    } catch (e) { $("#bErr").textContent = e.message; }
  };
}

async function viewSettings(preloaded) {
  const v = $("#view");
  let data = preloaded;
  if (!data) { try { data = await api("/api/settings"); } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; } }
  const cfg = data.config;
  cfg.ports = cfg.ports || {}; cfg.meters = cfg.meters || []; cfg.profiles = cfg.profiles || {}; cfg.cloud_sync = cfg.cloud_sync || { url: "", api_key: "", sync_seconds: 30 };
  const plant = S.info.mode === "plant";
  const tabs = plant ? [["branding", "Branding"], ["meters", "Machines and meters"], ["logging", "Logging and cloud"]] : [["branding", "Branding"]];
  if (!tabs.some(t => t[0] === S.settingsTab)) S.settingsTab = "branding";

  const STATUS = { manufacturer_checked: "", manufacturer_checked_tcp: "", partly_checked: " (check energy)", manufacturer_partly_checked: " (check energy)", third_party: " (not yet confirmed)" };
  const modelLabel = p => {
    if (p === "simulated") return "Simulated meter";
    const d = data.library_profiles[p];
    if (!d || !d.brand) return p;
    return `${d.brand} ${(d.models || []).map(x => x.replace(/ \(.*\)$/, "")).join(", ")}${STATUS[d.status] ?? ""}`;
  };
  const profileNames = () => ["simulated", ...new Set([...Object.keys(data.library_profiles), ...Object.keys(cfg.profiles)])];

  const portForm = (name, p) => `<div class="settings-item" data-port="${esc(name)}">
    <div class="row"><b>${esc(name)}</b><div class="spacer"></div><button class="danger ghost" data-del-port="${esc(name)}">Remove</button></div>
    <div class="form">
      <label class="f">Connection<select data-k="kind">${["rs485", "ethernet", "gateway", "simulator"].map(k => `<option value="${k}" ${p.kind === k || (k === "rs485" && p.kind === "rtu") || (k === "ethernet" && p.kind === "tcp") ? "selected" : ""}>${CONN[k]}</option>`).join("")}</select></label>
      <label class="f" data-for="ethernet gateway">IP address<input data-k="host" value="${esc(p.host || "")}" placeholder="192.168.1.50"></label>
      <label class="f" data-for="ethernet gateway">TCP port<input data-k="port" type="number" value="${p.port ?? 502}"></label>
      <label class="f" data-for="gateway">Gateway type<select data-k="framing"><option value="tcp" ${p.framing !== "rtu" ? "selected" : ""}>Modbus TCP gateway</option><option value="rtu" ${p.framing === "rtu" ? "selected" : ""}>Transparent (RTU over TCP)</option></select></label>
      <label class="f" data-for="rs485">Serial port<input data-k="serial_port" value="${esc(p.serial_port || "")}" placeholder="COM3 or /dev/ttyUSB0"></label>
      <label class="f" data-for="rs485">Baud rate<select data-k="baudrate">${[2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b => `<option ${+(p.baudrate || 9600) === b ? "selected" : ""}>${b}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485">Parity<select data-k="parity">${[["N", "None"], ["E", "Even"], ["O", "Odd"]].map(([k, l]) => `<option value="${k}" ${(p.parity || "N") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485">Stop bits<select data-k="stopbits">${[1, 2].map(b => `<option ${+(p.stopbits || 1) === b ? "selected" : ""}>${b}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485 ethernet gateway">Timeout (s)<input data-k="timeout" type="number" step="0.1" value="${p.timeout ?? 2}"></label>
    </div></div>`;

  const meterForm = (m, i) => `<div class="settings-item" data-meter="${i}">
    <div class="row"><span data-pic>${machineIcon(guessMachine(m), 36)}</span><b>${esc(m.name || m.id || "New machine")}</b><div class="spacer"></div><span class="hint" data-test-out></span>
      <button data-test="${i}">Test reading</button><button class="danger ghost" data-del-meter="${i}">Remove</button></div>
    <div class="form">
      <label class="f">Name<input data-k="name" value="${esc(m.name || "")}" placeholder="Induction Furnace 1"></label>
      <label class="f">Picture on diagram<select data-k="machine"><option value="">Pick from the name</option>${Object.entries(MACHINES).map(([k, d]) => `<option value="${k}" ${m.machine === k ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select></label>
      <label class="f">Area<input data-k="area" value="${esc(m.area || "")}" placeholder="Melt Shop"></label>
      <label class="f">Meter ID<input data-k="id" value="${esc(m.id || "")}" placeholder="eaf1"></label>
      <label class="f">Connection<select data-k="port">${Object.keys(cfg.ports).map(p => `<option ${m.port === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label class="f">Meter model<select data-k="profile">${profileNames().map(p => `<option value="${esc(p)}" ${m.profile === p ? "selected" : ""}>${esc(modelLabel(p))}</option>`).join("")}</select></label>
      <label class="f">Modbus address (slave ID)<input data-k="unit_id" type="number" min="1" max="247" value="${m.unit_id ?? 1}"></label>
      <label class="f">Contract demand kVA<input data-k="contract_kva" type="number" value="${m.contract_kva ?? ""}"></label>
      <label class="f">Position on diagram<select data-k="is_main"><option value="false">Feeder (below the busbar)</option><option value="true" ${m.is_main ? "selected" : ""}>Main incomer (counts in plant total)</option></select></label>
      <label class="f">Logging<select data-k="enabled"><option value="true" ${m.enabled !== false ? "selected" : ""}>On</option><option value="false" ${m.enabled === false ? "selected" : ""}>Off</option></select></label>
    </div>
    <details style="margin-top:10px"><summary>Alarm limits</summary><div class="form" style="margin-top:8px">
      ${[["pf_min", "PF below"], ["kva_max", "kVA above"], ["kw_max", "kW above"], ["v_ln_min", "Voltage L-N below"], ["v_ln_max", "Voltage L-N above"], ["i_max", "Current above (A)"], ["thd_v_max", "Voltage THD above (%)"]]
        .map(([k, l]) => `<label class="f">${l}<input data-a="${k}" type="number" step="any" value="${(m.alarms || {})[k] ?? ""}"></label>`).join("")}
    </div></details></div>`;

  const metersTab = () => `<p class="lede">Each machine is one meter. Machines appear on the plant diagram in this order.</p>
    <div id="sMeters">${cfg.meters.map(meterForm).join("")}</div>
    <button id="sAddMeter">Add machine</button>
    <h2>Connections</h2><p class="hint">One entry per RS485 port, Ethernet meter or gateway. Several meters can share one RS485 line or gateway, each with its own Modbus address.</p>
    <div id="sPorts">${Object.entries(cfg.ports).map(([n, p]) => portForm(n, p)).join("")}</div>
    <div class="row"><input id="sNewPort" placeholder="New connection name, e.g. rs485_com4"><button id="sAddPort">Add connection</button></div>
    <h2>Meter models</h2>
    <details><summary>Built-in models and where each register map came from</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Model</th><th>Source</th><th>Notes</th></tr></thead><tbody>
      ${Object.entries(data.library_profiles).filter(([, d]) => d.brand).map(([n, d]) => `<tr><td style="white-space:normal">${esc(modelLabel(n))}</td><td style="white-space:normal">${esc(d.source || "")}</td><td style="white-space:normal">${esc(d.notes || "")}</td></tr>`).join("")}
    </tbody></table></div></details>
    <p class="hint">To add another model, paste its register map from the meter's Modbus manual as JSON. Example: {"my_meter": {"register_type": "holding", "word_order": "big", "registers": {"kw": {"address": 3060, "type": "float32"}}}}</p>
    <textarea id="sProfiles" rows="6">${esc(JSON.stringify(cfg.profiles, null, 2))}</textarea>`;

  const loggingTab = () => `<div class="panel"><div class="form">
      <label class="f">Plant ID (for cloud)<input id="sPlantId" value="${esc(cfg.plant_id || "plant1")}"></label>
      <label class="f">Read meters every (s)<input id="sPoll" type="number" min="1" value="${cfg.poll_seconds ?? 5}"></label>
      <label class="f">Save to log every (s)<input id="sLog" type="number" min="1" value="${cfg.log_seconds ?? 60}"></label>
      <label class="f">Demand block (min)<input id="sBlock" type="number" min="1" value="${cfg.demand_block_minutes ?? 15}"></label>
    </div><p class="hint">Readings are averaged between saves. Energy counters always store the latest meter value.</p></div>
    <h2>Cloud sync</h2><div class="panel"><div class="form">
      <label class="f">Cloud server address<input id="sCloudUrl" value="${esc(cfg.cloud_sync.url || "")}" placeholder="https://energy.yourcompany.com"></label>
      <label class="f">Plant key<input id="sCloudKey" value="${esc(cfg.cloud_sync.api_key || "")}" placeholder="from the cloud server"></label>
      <label class="f">Send every (s)<input id="sCloudEvery" type="number" min="5" value="${cfg.cloud_sync.sync_seconds ?? 30}"></label>
    </div><p class="hint">Leave the address empty to keep data on this PC only. If the internet drops, data waits here and is sent when it's back.</p></div>`;

  // Fields of tabs that are not on screen keep their in-memory values.
  const tab = S.settingsTab;
  v.innerHTML = `<h1>Settings</h1>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${k === tab ? "on" : ""}" aria-selected="${k === tab}">${l}</button>`).join("")}</div>
    <div id="tabBody">${tab === "branding" ? brandingTab(cfg) : tab === "meters" ? metersTab() : loggingTab()}</div>
    ${tab !== "branding" ? `<div class="row" style="margin:20px 0 40px"><button class="primary" id="sSave">Save and restart logging</button><span class="err" id="sErr"></span></div>` : ""}`;

  const readPorts = () => {
    if (!$("#sPorts")) return cfg.ports;
    const out = {};
    v.querySelectorAll("[data-port]").forEach(el => {
      const p = {}; el.querySelectorAll("[data-k]").forEach(i => { if (!i.closest("[data-for]") || !i.closest("[data-for]").hidden || i.dataset.k === "kind") p[i.dataset.k] = i.value; });
      for (const k of ["port", "baudrate", "stopbits", "timeout"]) if (p[k] != null) p[k] = +p[k];
      out[el.dataset.port] = p;
    });
    return out;
  };
  const readMeter = el => {
    const m = { alarms: {} };
    el.querySelectorAll("[data-k]").forEach(i => (m[i.dataset.k] = i.value));
    m.unit_id = +m.unit_id || 1; m.enabled = m.enabled === "true"; m.is_main = m.is_main === "true"; m.contract_kva = m.contract_kva === "" ? null : +m.contract_kva;
    el.querySelectorAll("[data-a]").forEach(i => { if (i.value !== "") m.alarms[i.dataset.a] = +i.value; });
    return m;
  };
  const readProfiles = () => { if (!$("#sProfiles")) return cfg.profiles; const t = $("#sProfiles").value.trim(); return t ? JSON.parse(t) : {}; };
  const collect = () => {
    const out = { ...cfg, ports: readPorts(), profiles: readProfiles() };
    if ($("#sMeters")) out.meters = [...v.querySelectorAll("[data-meter]")].map(readMeter);
    if ($("#sPoll")) Object.assign(out, { plant_id: $("#sPlantId").value, poll_seconds: +$("#sPoll").value, log_seconds: +$("#sLog").value, demand_block_minutes: +$("#sBlock").value,
      cloud_sync: { url: $("#sCloudUrl").value.trim(), api_key: $("#sCloudKey").value.trim(), sync_seconds: +$("#sCloudEvery").value } });
    return out;
  };
  const keep = () => { try { Object.assign(cfg, collect()); return true; } catch (e) { toast("Meter models JSON: " + e.message); return false; } };
  const redraw = () => { data.config = cfg; viewSettings(data); };

  v.querySelectorAll("[data-tab]").forEach(b => (b.onclick = () => { if (tab !== "branding" && !keep()) return; S.settingsTab = b.dataset.tab; redraw(); }));
  if (tab === "branding") return wireBranding();

  if (tab === "meters") {
    const showFor = el => { const kind = $("[data-k=kind]", el).value; el.querySelectorAll("[data-for]").forEach(f => (f.hidden = !f.dataset.for.split(" ").includes(kind))); };
    v.querySelectorAll("[data-port]").forEach(el => { showFor(el); $("[data-k=kind]", el).onchange = () => showFor(el); });
    v.querySelectorAll("[data-meter]").forEach(el => {
      const upd = () => { const m = readMeter(el); $("[data-pic]", el).innerHTML = machineIcon(guessMachine(m), 36); };
      $("[data-k=machine]", el).onchange = upd; $("[data-k=name]", el).oninput = upd;
    });
    $("#sAddPort").onclick = () => { const n = $("#sNewPort").value.trim().replace(/\s+/g, "_"); if (!n) return toast("Type a name for the connection first."); if (!keep()) return; cfg.ports[n] = { kind: "rs485", serial_port: "", baudrate: 9600, parity: "N", stopbits: 1 }; redraw(); };
    v.querySelectorAll("[data-del-port]").forEach(b => (b.onclick = () => { if (!keep()) return; delete cfg.ports[b.dataset.delPort]; redraw(); }));
    $("#sAddMeter").onclick = () => { if (!keep()) return; cfg.meters.push({ id: "", name: "", area: "", port: Object.keys(cfg.ports)[0], profile: profileNames()[0], unit_id: 1, enabled: true, alarms: {} }); redraw(); };
    v.querySelectorAll("[data-del-meter]").forEach(b => (b.onclick = () => { if (!keep()) return; cfg.meters.splice(+b.dataset.delMeter, 1); redraw(); }));
    v.querySelectorAll("[data-test]").forEach(b => (b.onclick = async () => {
      const el = b.closest("[data-meter]"), out = $("[data-test-out]", el);
      out.textContent = "Reading…"; out.className = "hint"; out.style.color = "";
      try {
        const r = await api("/api/settings/test-meter", { method: "POST", body: JSON.stringify({ meter: { ...readMeter(el), enabled: true }, ports: readPorts(), profiles: readProfiles() }) });
        if (r.ok) { out.style.color = "var(--ok)"; out.textContent = `OK: ${fmtNum(r.values.kw)} kW, ${fmtNum(r.values.v_ln ?? r.values.v_ll, 0)} V, PF ${fmtNum(r.values.pf, 3)}, ${fmtNum(r.values.hz, 2)} Hz`; if (r.hint) { out.style.color = "var(--warn)"; out.textContent += ". " + r.hint; } }
        else { out.className = "err"; out.textContent = r.error; }
      } catch (e) { out.className = "err"; out.textContent = e.message; }
    }));
  }
  $("#sSave").onclick = async () => {
    $("#sErr").textContent = "";
    let body;
    try { body = collect(); } catch (e) { $("#sErr").textContent = "Meter models JSON: " + e.message; return; }
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ config: body }) }); Object.assign(cfg, body); toast("Saved. Logging restarted with the new settings."); refreshInfo(); }
    catch (e) { $("#sErr").textContent = e.message; }
  };
}

boot();
