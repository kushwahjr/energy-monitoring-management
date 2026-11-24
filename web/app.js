"use strict";
// Energy Monitoring Management dashboard. Plain JavaScript, no build step, works offline on the plant LAN.

const S = { info: null, meters: [], timer: null, route: "" };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = k => (S.info && S.info.params[k]) || { label: k, unit: "" };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const CONN = { rs485: "RS485", ethernet: "Ethernet", gateway: "Gateway", simulator: "Simulator", cloud: "Cloud" };

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error("login"); }
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).detail || msg; } catch (_) {} throw new Error(msg); }
  return res.json();
}

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500); }

// ---------------- boot ----------------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try { S.info = await (await fetch("/api/info", { credentials: "same-origin" })).json(); }
  catch (e) { $("#view").innerHTML = `<p class="pad err">Cannot reach the logger server. Check that the plant PC is on and you are on the same network.</p>`; return; }
  $("#plantName").textContent = S.info.plant_name;
  $("#modeLine").textContent = S.info.mode === "cloud" ? "Cloud view, all plants" : "Plant logger";
  document.title = S.info.plant_name + "";
  if (S.info.login_required && !S.info.user) return showLogin();
  afterLogin();
}

function afterLogin() {
  const u = S.info.user;
  $("#logoutBtn").hidden = !S.info.login_required;
  $("#navSettings").hidden = !(S.info.mode === "plant" && u && u.role === "admin");
  window.addEventListener("hashchange", route);
  route();
}

function showLogin() {
  clearInterval(S.timer);
  $("#nav").hidden = true;
  $("#view").innerHTML = `<form class="login" id="loginForm"><div class="panel">
    <h1>Sign in</h1>
    <label class="f">Username<input name="username" autocomplete="username" required></label>
    <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" id="loginErr" hidden></p>
    <button class="primary">Sign in</button></div></form>`;
  $("#loginForm").onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(f)) });
    if (!r.ok) { const e = $("#loginErr"); e.hidden = false; e.textContent = "Wrong username or password."; return; }
    S.info = await (await fetch("/api/info")).json();
    $("#nav").hidden = false;
    afterLogin();
  };
}

$("#logoutBtn").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.hash = "#/"; location.reload(); };

function route() {
  clearInterval(S.timer);
  const h = location.hash.replace(/^#\/?/, "");
  const [name, arg] = h.split("/");
  S.route = name || "overview";
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.route === (S.route === "meter" ? "overview" : S.route)));
  const views = { overview: viewOverview, meter: () => viewMeter(decodeURIComponent(arg || "")), reports: viewReports, events: viewEvents, settings: () => viewSettings() };
  (views[S.route] || viewOverview)();
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

// ---------------- overview ----------------
async function viewOverview() {
  const v = $("#view");
  v.innerHTML = `<div id="ovAlarms"></div><div class="tiles" id="ovTiles"></div><div id="ovCards"></div>`;
  let todayRows = [];
  const loadToday = async () => { try { todayRows = (await api(`/api/reports/daily?start=${today()}`)).rows; } catch (_) {} };
  const draw = async () => {
    try { S.meters = (await api("/api/meters")).meters; } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; }
    if (S.route !== "overview") return;
    renderOverview(todayRows);
  };
  await loadToday(); await draw(); refreshInfo();
  let n = 0;
  S.timer = setInterval(async () => { if (++n % 12 === 0) { await loadToday(); refreshInfo(); } draw(); }, S.info.mode === "cloud" ? 15000 : 5000);
}

function renderOverview(todayRows) {
  const ms = S.meters.filter(m => m.enabled);
  const on = ms.filter(m => m.online);
  // Plant totals come from meters marked "main incomer"; without any, all meters are added up.
  const mains = ms.filter(m => m.is_main), basis = mains.length ? mains : ms, basisIds = new Set(basis.map(m => m.id));
  const sum = k => basis.filter(m => m.online).reduce((a, m) => a + (m.values[k] || 0), 0);
  const kw = sum("kw"), kva = sum("kva");
  const kwhToday = todayRows.filter(r => basisIds.has(r.meter_id)).reduce((a, r) => a + r.kwh, 0);
  const basisNote = mains.length ? (mains.length === 1 ? mains[0].name : `${mains.length} main incomers`) : "sum of all meters";
  const md = todayRows.reduce((a, r) => Math.max(a, r.md_kva || 0), 0);
  const alarms = ms.flatMap(m => m.alarms.map(a => `${m.name}: ${a}`)).concat(ms.filter(m => !m.online).map(m => `${m.name}: offline${m.error ? " (" + m.error + ")" : ""}`));
  $("#ovAlarms").innerHTML = alarms.length ? `<div class="alarms"><b>${alarms.length} active alarm${alarms.length > 1 ? "s" : ""}</b><ul>${alarms.slice(0, 8).map(a => `<li>${esc(a)}</li>`).join("")}</ul>${alarms.length > 8 ? `<a href="#/events">See all</a>` : ""}</div>` : "";
  $("#ovTiles").innerHTML = [
    ["Plant load now", fmtNum(kw), "kW", `${fmtNum(kva)} kVA, ${basisNote}`],
    ["Power factor", kva ? fmtNum(kw / kva, 3) : "–", "", basisNote],
    ["Energy today", fmtNum(kwhToday, 0), "kWh", `since midnight, ${basisNote}`],
    ["Highest demand today", fmtNum(md, 0), "kVA", `${S.info.demand_block_minutes}-min block, any one meter`],
    ["Meters online", `${on.length}/${ms.length}`, "", on.length < ms.length ? "check offline meters" : "all reporting"],
  ].map(([k, v, u, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div><div class="sub">${esc(s)}</div></div>`).join("");

  // group by plant (cloud) then area
  const groups = {};
  for (const m of ms) { const g = (S.info.mode === "cloud" ? m.plant_name + " · " : "") + (m.area || "Other"); (groups[g] = groups[g] || []).push(m); }
  const byMeter = Object.fromEntries(todayRows.map(r => [r.meter_id, r]));
  $("#ovCards").innerHTML = Object.entries(groups).map(([g, list]) => `<h2>${esc(g)}</h2><div class="cards">${list.map(m => meterCard(m, byMeter[m.id])).join("")}</div>`).join("") ||
    `<p class="pad muted">No meters set up yet. ${S.info.mode === "plant" ? 'Add them on the <a href="#/settings">Settings</a> page.' : "Waiting for a plant PC to send data."}</p>`;
}

function meterCard(m, t) {
  const v = m.values, load = m.contract_kva && v.kva != null ? Math.min(100, v.kva / m.contract_kva * 100) : null;
  const status = !m.online ? `<span class="badge bad">Offline</span>` : m.alarms.length ? `<span class="badge warn">Alarm</span>` : `<span class="badge ok">Online</span>`;
  return `<a class="card${m.alarms.length || !m.online ? " alarm" : ""}" href="#/meter/${encodeURIComponent(m.id)}">
    <div class="head"><div><div class="name">${esc(m.name)}</div><div class="muted" style="font-size:12px">${CONN[m.connection] || ""}</div></div>${status}</div>
    <div class="big">${fmtNum(v.kw)}<small> kW</small></div>
    <div class="grid num">
      <div><span>kVA</span>${fmtNum(v.kva)}</div><div><span>PF</span>${fmtNum(v.pf, 3)}</div>
      <div><span>Volt</span>${fmtNum(v.v_ll ?? v.v_ln, 0)}</div><div><span>Amp</span>${fmtNum(v.i_avg, 0)}</div>
      <div><span>Today kWh</span>${t ? fmtNum(t.kwh, 0) : "–"}</div><div><span>MD kVA</span>${t ? fmtNum(t.md_kva, 0) : "–"}</div>
      <div><span>Hz</span>${fmtNum(v.hz, 2)}</div><div><span>THD V</span>${fmtNum(v.thd_v, 1)}</div>
    </div>
    ${load != null ? `<div class="bar" title="${fmtNum(load, 0)}% of ${m.contract_kva} kVA"><i style="width:${load}%"></i></div>` : ""}
  </a>`;
}

// ---------------- one meter ----------------
async function viewMeter(id) {
  const v = $("#view");
  const st = { param: "kw", hours: 24 };
  v.innerHTML = `<p><a href="#/">← Overview</a></p><div id="mHead"></div>
    <div class="panel"><div class="row" style="margin-bottom:8px">
      <select id="mParam"></select><div class="spacer"></div>
      <div class="seg" id="mRange">${[[1, "1 h"], [6, "6 h"], [24, "24 h"], [168, "7 days"], [720, "30 days"]].map(([h, l]) => `<button data-h="${h}" class="${h === 24 ? "on" : ""}">${l}</button>`).join("")}</div>
    </div><div class="chart" id="mChart"></div></div>
    <h2>Live values</h2><div class="params" id="mParams"></div>
    <h2>Last 7 days</h2><div class="table-wrap" id="mDaily"></div>`;
  const drawHead = async () => {
    try { S.meters = (await api("/api/meters")).meters; } catch (_) { return; }
    const m = S.meters.find(x => x.id === id);
    if (!m) { v.innerHTML = `<p class="pad">Meter not found. <a href="#/">Back</a></p>`; return; }
    $("#mHead").innerHTML = `<div class="row"><h1>${esc(m.name)}</h1>${m.online ? `<span class="badge ok">Online</span>` : `<span class="badge bad">Offline</span>`}
      <span class="badge plain">${esc(m.area)}</span><span class="badge plain">${CONN[m.connection] || ""}</span>
      ${m.last_seen ? `<span class="muted" style="font-size:13px">updated ${new Date(m.last_seen * 1000).toLocaleTimeString()}</span>` : ""}</div>
      ${m.error ? `<p class="err">${esc(m.error)}</p>` : ""}${m.alarms.length ? `<div class="alarms">${m.alarms.map(esc).join("<br>")}</div>` : ""}`;
    const keys = Object.keys(S.info.params).filter(k => m.values[k] != null);
    $("#mParams").innerHTML = keys.map(k => `<div class="tile"><div class="k">${esc(P(k).label)}</div><div class="v" style="font-size:20px">${fmtNum(m.values[k], k === "pf" ? 3 : undefined)}<small>${esc(P(k).unit)}</small></div></div>`).join("") || `<p class="muted">No live values.</p>`;
    const sel = $("#mParam");
    if (!sel.options.length) {
      const all = keys.length ? keys : ["kw"];
      sel.innerHTML = all.map(k => `<option value="${k}">${esc(P(k).label)}${P(k).unit ? " (" + esc(P(k).unit) + ")" : ""}</option>`).join("");
      sel.value = all.includes("kw") ? "kw" : all[0]; st.param = sel.value;
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
  if (!rows.length) return `<p class="pad muted">No data for these dates.</p>`;
  const name = id => (S.meters.find(m => m.id === id) || {}).name || id;
  const tot = { kwh: 0, kvah: 0, kvarh: 0, md: 0 };
  rows.forEach(r => { tot.kwh += r.kwh; tot.kvah += r.kvah; tot.kvarh += r.kvarh; tot.md = Math.max(tot.md, r.md_kva || 0); });
  return `<table><thead><tr><th>Date</th>${withMeter ? "<th>Meter</th>" : ""}<th class="n">kWh</th><th class="n">kVAh</th><th class="n">kVArh</th>
    <th class="n">Avg PF</th><th class="n">Max demand kVA</th><th class="n">at</th><th class="n">Peak kW</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${r.date}</td>${withMeter ? `<td>${esc(name(r.meter_id))}</td>` : ""}<td class="n">${fmtNum(r.kwh, 1)}</td><td class="n">${fmtNum(r.kvah, 1)}</td>
      <td class="n">${fmtNum(r.kvarh, 1)}</td><td class="n">${fmtNum(r.avg_pf, 3)}</td><td class="n">${fmtNum(r.md_kva, 1)}</td><td class="n">${r.md_kva_at || ""}</td><td class="n">${fmtNum(r.peak_kw, 1)}</td></tr>`).join("")}
    <tr class="total"><td>Total</td>${withMeter ? "<td></td>" : ""}<td class="n">${fmtNum(tot.kwh, 1)}</td><td class="n">${fmtNum(tot.kvah, 1)}</td><td class="n">${fmtNum(tot.kvarh, 1)}</td>
      <td class="n">${tot.kvah ? fmtNum(tot.kwh / tot.kvah, 3) : "–"}</td><td class="n">${fmtNum(tot.md, 1)}</td><td></td><td></td></tr></tbody></table>`;
}

async function viewReports() {
  if (!S.meters.length) { try { S.meters = (await api("/api/meters")).meters; } catch (_) { return; } }
  const v = $("#view");
  v.innerHTML = `<h1>Energy reports</h1>
    <div class="panel"><div class="form">
      <label class="f">From<input type="date" id="rStart" value="${daysAgo(6)}"></label>
      <label class="f">To<input type="date" id="rEnd" value="${today()}"></label>
      <label class="f">Meter<select id="rMeter"><option value="">All meters</option>${S.meters.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></label>
      <label class="f">Show<select id="rGroup"><option value="day">Each day, each meter</option><option value="meter">Total per meter</option></select></label>
    </div><div class="row" style="margin-top:12px">
      <button class="primary" id="rRun">Show report</button><div class="spacer"></div>
      <button id="rCsvDaily">Download daily CSV</button><button id="rCsvRaw">Download all readings CSV</button>
    </div><p class="hint">Max demand is the highest average kVA over ${S.info.demand_block_minutes}-minute blocks. Times are in ${esc(S.info.timezone)}. CSV files open in Excel.</p></div>
    <div class="table-wrap" id="rOut" style="margin-top:12px"></div>`;
  const q = () => `start=${$("#rStart").value}&end=${$("#rEnd").value}${$("#rMeter").value ? "&meters=" + encodeURIComponent($("#rMeter").value) : ""}`;
  const run = async () => {
    $("#rOut").innerHTML = `<p class="pad muted">Working…</p>`;
    try {
      const r = await api(`/api/reports/daily?${q()}`);
      let rows = r.rows;
      if ($("#rGroup").value === "meter") {
        const agg = {};
        for (const x of rows) {
          const a = agg[x.meter_id] = agg[x.meter_id] || { ...x, date: `${r.start} → ${r.end}`, kwh: 0, kvah: 0, kvarh: 0, md_kva: 0, peak_kw: 0 };
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
  v.innerHTML = `<h1>Alarms and events</h1><div class="row" style="margin-bottom:10px"><div class="seg" id="eRange">
    ${[[24, "24 h"], [72, "3 days"], [168, "7 days"], [720, "30 days"]].map(([h, l]) => `<button data-h="${h}" class="${h === 72 ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="table-wrap" id="eOut"></div>`;
  const name = id => (S.meters.find(m => m.id === id) || {}).name || id;
  const load = async h => {
    const r = await api(`/api/events?hours=${h}`);
    $("#eOut").innerHTML = r.events.length ? `<table><thead><tr><th>Time</th><th>Meter</th><th>Event</th><th>State</th></tr></thead><tbody>
      ${r.events.map(e => `<tr><td>${new Date(e.ts * 1000).toLocaleString()}</td><td>${esc(name(e.meter_id))}</td><td>${esc(e.message)}</td>
      <td>${e.active ? `<span class="badge bad">Raised</span>` : `<span class="badge ok">Cleared</span>`}</td></tr>`).join("")}</tbody></table>` : `<p class="pad muted">No alarms in this period.</p>`;
  };
  $("#eRange").onclick = e => { const b = e.target.closest("button"); if (!b) return; $("#eRange").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); load(+b.dataset.h); };
  load(72);
}

// ---------------- settings (plant PC, admin) ----------------
async function viewSettings(preloaded) {
  const v = $("#view");
  let data = preloaded;
  if (!data) { try { data = await api("/api/settings"); } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; } }
  const cfg = data.config;
  cfg.ports = cfg.ports || {}; cfg.meters = cfg.meters || []; cfg.profiles = cfg.profiles || {}; cfg.cloud_sync = cfg.cloud_sync || { url: "", api_key: "", sync_seconds: 30 };
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
    <div class="row"><b>${esc(m.name || m.id || "New meter")}</b><div class="spacer"></div><span class="hint" data-test-out></span>
      <button data-test="${i}">Test reading</button><button class="danger ghost" data-del-meter="${i}">Remove</button></div>
    <div class="form">
      <label class="f">Meter ID<input data-k="id" value="${esc(m.id || "")}" placeholder="eaf1"></label>
      <label class="f">Name<input data-k="name" value="${esc(m.name || "")}"></label>
      <label class="f">Area<input data-k="area" value="${esc(m.area || "")}" placeholder="Melt Shop"></label>
      <label class="f">Connection<select data-k="port">${Object.keys(cfg.ports).map(p => `<option ${m.port === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label class="f">Meter model<select data-k="profile">${profileNames().map(p => `<option value="${esc(p)}" ${m.profile === p ? "selected" : ""}>${esc(modelLabel(p))}</option>`).join("")}</select></label>
      <label class="f">Modbus address (slave ID)<input data-k="unit_id" type="number" min="1" max="247" value="${m.unit_id ?? 1}"></label>
      <label class="f">Contract demand kVA<input data-k="contract_kva" type="number" value="${m.contract_kva ?? ""}"></label>
      <label class="f">Main incomer?<select data-k="is_main"><option value="false">No, a feeder</option><option value="true" ${m.is_main ? "selected" : ""}>Yes, count in plant total</option></select></label>
      <label class="f">Logging<select data-k="enabled"><option value="true" ${m.enabled !== false ? "selected" : ""}>On</option><option value="false" ${m.enabled === false ? "selected" : ""}>Off</option></select></label>
    </div>
    <details style="margin-top:8px"><summary>Alarm limits</summary><div class="form" style="margin-top:8px">
      ${[["pf_min", "PF below"], ["kva_max", "kVA above"], ["kw_max", "kW above"], ["v_ln_min", "Voltage L-N below"], ["v_ln_max", "Voltage L-N above"], ["i_max", "Current above (A)"], ["thd_v_max", "Voltage THD above (%)"]]
        .map(([k, l]) => `<label class="f">${l}<input data-a="${k}" type="number" step="any" value="${(m.alarms || {})[k] ?? ""}"></label>`).join("")}
    </div></details></div>`;

  v.innerHTML = `<h1>Settings</h1>
    <div class="panel"><div class="form">
      <label class="f">Plant name<input id="sPlant" value="${esc(cfg.plant_name || "")}"></label>
      <label class="f">Plant ID (for cloud)<input id="sPlantId" value="${esc(cfg.plant_id || "plant1")}"></label>
      <label class="f">Read meters every (s)<input id="sPoll" type="number" min="1" value="${cfg.poll_seconds ?? 5}"></label>
      <label class="f">Save to log every (s)<input id="sLog" type="number" min="1" value="${cfg.log_seconds ?? 60}"></label>
      <label class="f">Demand block (min)<input id="sBlock" type="number" min="1" value="${cfg.demand_block_minutes ?? 15}"></label>
    </div><p class="hint">Readings are averaged between saves. Energy (kWh) always stores the latest meter register.</p></div>
    <h2>Connections</h2><p class="hint">One entry per RS485 port, per Ethernet meter, or per gateway. Several meters can share one RS485 port or gateway, each with its own Modbus address.</p>
    <div id="sPorts">${Object.entries(cfg.ports).map(([n, p]) => portForm(n, p)).join("")}</div>
    <div class="row"><input id="sNewPort" placeholder="New connection name, e.g. rs485_com4"><button id="sAddPort">Add connection</button></div>
    <h2>Meters</h2><div id="sMeters">${cfg.meters.map(meterForm).join("")}</div>
    <button id="sAddMeter">Add meter</button>
    <h2>Meter models (register maps)</h2>
    <details><summary>Built-in models and where each register map came from</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Model</th><th>Source</th><th>Notes</th></tr></thead><tbody>
      ${Object.entries(data.library_profiles).filter(([, d]) => d.brand).map(([n, d]) => `<tr><td style="white-space:normal">${esc(modelLabel(n))}</td><td style="white-space:normal">${esc(d.source || "")}</td><td style="white-space:normal">${esc(d.notes || "")}</td></tr>`).join("")}
    </tbody></table></div></details>
    <p class="hint">Templates are placeholders; add your model's addresses from its Modbus manual below, as JSON. Example: {"my_meter": {"register_type": "holding", "word_order": "big", "registers": {"kw": {"address": 3060, "type": "float32"}}}}</p>
    <textarea id="sProfiles" rows="8">${esc(JSON.stringify(cfg.profiles, null, 2))}</textarea>
    <h2>Cloud sync</h2><div class="panel"><div class="form">
      <label class="f">Cloud server address<input id="sCloudUrl" value="${esc(cfg.cloud_sync.url || "")}" placeholder="https://energy.yourcompany.com"></label>
      <label class="f">Plant key<input id="sCloudKey" value="${esc(cfg.cloud_sync.api_key || "")}" placeholder="from the cloud server's ingest_keys"></label>
      <label class="f">Send every (s)<input id="sCloudEvery" type="number" min="5" value="${cfg.cloud_sync.sync_seconds ?? 30}"></label>
    </div><p class="hint">Leave the address empty to keep data on this PC only. If the internet drops, data waits here and is sent when it is back.</p></div>
    <div class="row" style="margin:16px 0 40px"><button class="primary" id="sSave">Save and restart logging</button><span class="err" id="sErr"></span></div>`;

  const showFor = el => { const kind = $("[data-k=kind]", el).value; el.querySelectorAll("[data-for]").forEach(f => (f.hidden = !f.dataset.for.split(" ").includes(kind))); };
  v.querySelectorAll("[data-port]").forEach(el => { showFor(el); $("[data-k=kind]", el).onchange = () => showFor(el); });

  const readPorts = () => {
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
  const readProfiles = () => { const t = $("#sProfiles").value.trim(); return t ? JSON.parse(t) : {}; };
  const collect = () => ({
    ...cfg, plant_name: $("#sPlant").value, plant_id: $("#sPlantId").value, poll_seconds: +$("#sPoll").value, log_seconds: +$("#sLog").value,
    demand_block_minutes: +$("#sBlock").value, ports: readPorts(), meters: [...v.querySelectorAll("[data-meter]")].map(readMeter), profiles: readProfiles(),
    cloud_sync: { url: $("#sCloudUrl").value.trim(), api_key: $("#sCloudKey").value.trim(), sync_seconds: +$("#sCloudEvery").value },
  });
  // re-draw the page with unsaved edits kept in memory
  const fakeLoad = keep => { keep.config = cfg; viewSettings(keep); };

  $("#sAddPort").onclick = () => { const n = $("#sNewPort").value.trim().replace(/\s+/g, "_"); if (!n) return toast("Type a name for the connection first."); Object.assign(cfg, collect()); cfg.ports[n] = { kind: "rs485", serial_port: "", baudrate: 9600, parity: "N", stopbits: 1 }; fakeLoad(data); };
  v.querySelectorAll("[data-del-port]").forEach(b => (b.onclick = () => { Object.assign(cfg, collect()); delete cfg.ports[b.dataset.delPort]; fakeLoad(data); }));
  $("#sAddMeter").onclick = () => { try { Object.assign(cfg, collect()); } catch (e) { return toast(e.message); } cfg.meters.push({ id: "", name: "", area: "", port: Object.keys(cfg.ports)[0], profile: profileNames()[0], unit_id: 1, enabled: true, alarms: {} }); fakeLoad(data); };
  v.querySelectorAll("[data-del-meter]").forEach(b => (b.onclick = () => { Object.assign(cfg, collect()); cfg.meters.splice(+b.dataset.delMeter, 1); fakeLoad(data); }));
  v.querySelectorAll("[data-test]").forEach(b => (b.onclick = async () => {
    const el = b.closest("[data-meter]"), out = $("[data-test-out]", el);
    out.textContent = "Reading…"; out.className = "hint";
    try {
      const r = await api("/api/settings/test-meter", { method: "POST", body: JSON.stringify({ meter: { ...readMeter(el), enabled: true }, ports: readPorts(), profiles: readProfiles() }) });
      if (r.ok) { out.className = "hint"; out.style.color = "var(--ok)"; out.textContent = `OK: ${fmtNum(r.values.kw)} kW, ${fmtNum(r.values.v_ln ?? r.values.v_ll, 0)} V, PF ${fmtNum(r.values.pf, 3)}, ${fmtNum(r.values.hz, 2)} Hz`; if (r.hint) { out.style.color = "var(--warn)"; out.textContent += ". " + r.hint; } }
      else { out.className = "err"; out.textContent = r.error; }
    } catch (e) { out.className = "err"; out.textContent = e.message; }
  }));
  $("#sSave").onclick = async () => {
    $("#sErr").textContent = "";
    let body;
    try { body = collect(); } catch (e) { $("#sErr").textContent = "Meter models JSON: " + e.message; return; }
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ config: body }) }); toast("Saved. Logging restarted with the new settings."); refreshInfo(); }
    catch (e) { $("#sErr").textContent = e.message; }
  };
}

boot();
