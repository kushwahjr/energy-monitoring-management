"use strict";
// Energy Monitoring Management dashboard. Plain JavaScript, no build step, works offline on the plant LAN.

const S = { repTok: 0, info: null, meters: [], timer: null, route: "", today: {}, settingsTab: "branding" };
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
  if (S.info.setup_needed && !S.info.user) return showLogin();
  if (S.info.setup_needed && S.info.setup_here) return showSetup();
  if (!S.info.user) return showLogin();
  afterLogin();
}

const can = page => !S.info.user || (S.info.user.pages || []).includes(page);

function afterLogin() {
  const u = S.info.user;
  $("#rail").hidden = false;
  $("#logoutBtn").hidden = !S.info.login_required;
  $("#navSettings").hidden = !(u && u.role === "admin");
  document.querySelectorAll("#nav [data-page]").forEach(a => (a.hidden = !can(a.dataset.page)));
  $("#navDg").hidden = $("#navDg").hidden || S.info.has_dg === false;
  const chip = $("#meChip");
  chip.hidden = !(u && S.info.login_required);
  if (u) chip.innerHTML = `<span class="av">${esc((u.name || u.username || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase())}</span><span><b>${esc(u.name || u.username)}</b><small>${esc(u.designation || (u.role === "admin" ? "Admin" : "Viewer"))}</small></span>`;
  chip.onclick = changePassword;
  window.removeEventListener("hashchange", route);
  window.addEventListener("hashchange", route);
  route();
}

function changePassword() {
  const box = document.createElement("div");
  box.className = "picker-back";
  box.innerHTML = `<form class="picker small-dlg" id="pwForm"><div class="row picker-top"><h2>${esc(S.info.user.name || S.info.user.username)}</h2><div class="spacer"></div><button type="button" class="ghost" id="pwX" aria-label="Close">✕</button></div>
    <div class="picker-body"><p class="hint">${esc(S.info.user.designation || "")} · signed in as ${esc(S.info.user.username)}</p>
    <label class="f">Current password<input type="password" name="old" autocomplete="current-password" required></label>
    <label class="f">New password (8 or more characters)<input type="password" name="new" autocomplete="new-password" minlength="8" required></label>
    <div class="row" style="margin-top:14px"><button class="primary">Change password</button><div class="spacer"></div><button type="button" class="ghost" id="pwOut">Sign out</button></div></div></form>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.onclick = e => { if (e.target === box) close(); };
  $("#pwX").onclick = close;
  $("#pwOut").onclick = () => $("#logoutBtn").click();
  $("#pwForm").onsubmit = async e => {
    e.preventDefault();
    try { await api("/api/me/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); toast("Password changed."); close(); }
    catch (err) { toast(err.message); }
  };
}

const LOGIN_ART = `<svg class="login-art" viewBox="0 0 600 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs><linearGradient id="lgSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
  <rect width="600" height="320" fill="url(#lgSky)"/>
  ${[60, 230, 400, 570].map(x => `<g class="pylon" transform="translate(${x} 80)"><path d="M0 0 -26 220M0 0 26 220M-30 40h60M-40 70h80M-20 120h40M-17 40 17 70M17 40-17 70M-12 120 22 220M12 120-22 220"/></g>`).join("")}
  ${[[-30, 40], [30, 40], [-40, 70], [40, 70]].map(([dx, dy], i) => `<path class="line" d="M${60 + dx} ${80 + dy}Q${145} ${80 + dy + 30} ${230 + dx} ${80 + dy}Q${315} ${80 + dy + 30} ${400 + dx} ${80 + dy}Q${485} ${80 + dy + 30} ${570 + dx} ${80 + dy}"/>
     <path class="spark" style="animation-delay:${-i * .7}s" d="M${60 + dx} ${80 + dy}Q${145} ${80 + dy + 30} ${230 + dx} ${80 + dy}Q${315} ${80 + dy + 30} ${400 + dx} ${80 + dy}Q${485} ${80 + dy + 30} ${570 + dx} ${80 + dy}"/>`).join("")}
</svg>`;

function loginShell(inner) {
  const b = S.info.branding || {};
  return `<div class="login-wrap"><div class="login-hero">${LOGIN_ART}<div class="login-hero-text"><span class="kicker">Energy Monitoring Management</span><h1>${esc(b.company_name || "Energy Monitoring")}</h1><p>${esc(S.info.plant_name || "")}</p></div></div>
    <div class="login-card"><div class="brand">${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="" style="max-height:52px;max-width:200px">` : `<span class="logo">${'<svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true"><path d="M36 6 16 36h14l-4 22 22-32H34z" fill="currentColor"/></svg>'}</span>`}</div>${inner}</div></div>`;
}

function showSetup() {
  clearInterval(S.timer);
  $("#rail").hidden = true;
  $("#view").innerHTML = loginShell(`<form id="setupForm"><h2>Create the admin account</h2>
    <p class="hint">First time on this PC. This person can add other users, set what each one sees, and change settings. After this, everyone signs in.</p>
    <label class="f">Full name<input name="name" required autocomplete="name"></label>
    <label class="f">Designation<input name="designation" placeholder="HOD Electrical" list="desigList"></label>
    <label class="f">User ID<input name="username" required pattern="(?:[A-Za-z0-9._]|-){3,32}" autocomplete="username" placeholder="e.g. electrical.hod"></label>
    <label class="f">Password (8 or more characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <label class="f">Password again<input name="password2" type="password" minlength="8" required autocomplete="new-password"></label>
    <p class="err" id="setupErr" hidden></p><button class="primary wide">Create and sign in</button></form>${DESIG_LIST}`);
  $("#setupForm").onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target)), err = $("#setupErr");
    if (d.password !== d.password2) { err.hidden = false; err.textContent = "The two passwords are different."; return; }
    const r = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
    if (!r.ok) { err.hidden = false; err.textContent = (await r.json()).detail || "Could not create the account."; return; }
    S.info = await (await fetch("/api/info")).json(); applyBranding(); afterLogin();
  };
}

const DESIGNATIONS = ["Plant Head", "HOD Electrical", "Electrical Engineer", "Shift Engineer", "Shift In-charge", "Production Manager", "Maintenance Engineer", "Energy Manager", "Operator", "Management", "Auditor"];
const DESIG_LIST = `<datalist id="desigList">${DESIGNATIONS.map(d => `<option value="${d}">`).join("")}</datalist>`;

function showLogin() {
  clearInterval(S.timer);
  $("#rail").hidden = true;
  if (S.info.setup_needed && !S.info.setup_here) {
    $("#view").innerHTML = loginShell(`<h2>Not set up yet</h2><p class="hint">The first admin account has to be created on the plant PC itself. Open this app there, then come back and sign in.</p>`);
    return;
  }
  $("#view").innerHTML = loginShell(`<form id="loginForm"><h2>Sign in</h2><p class="hint">Use the user ID and password your admin gave you.</p>
    <label class="f">User ID<input name="username" autocomplete="username" required autocapitalize="none"></label>
    <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" id="loginErr" hidden></p>
    <button class="primary wide">Sign in</button></form>`);
  $("#loginForm").onsubmit = async ev => {
    ev.preventDefault();
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(ev.target))) });
    if (!r.ok) { const e = $("#loginErr"); e.hidden = false; e.textContent = "Wrong user ID or password."; return; }
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
  const views = { overview: viewOverview, meter: () => viewMeter(decodeURIComponent(arg || "")), reports: viewReports, insights: viewInsights, dg: viewDG, users: viewUsers, events: viewEvents, settings: () => viewSettings() };
  const pageOf = { overview: "plant", meter: "plant", insights: "insights", dg: "dg", reports: "reports", events: "alarms" };
  if (pageOf[S.route] && !can(pageOf[S.route])) {
    const first = ["plant", "dg", "insights", "reports", "alarms"].find(can);
    const to = { plant: "#/", dg: "#/dg", insights: "#/insights", reports: "#/reports", alarms: "#/events" }[first];
    if (to && location.hash !== to) { location.hash = to; return; }
  }
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
const BOLT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>`;

async function viewOverview() {
  const v = $("#view");
  const admin = S.info.user && S.info.user.role === "admin";
  v.innerHTML = `<div id="cutBanner"></div><div class="readouts" id="ovRead"></div>
    <section class="mimic-panel"><div class="mimic-head"><h2>${S.info.mode === "cloud" ? "All plants" : "Plant power"}</h2>
      <div class="legend"><span class="l-on">Grid power</span><span class="l-dg">DG power</span><span class="l-dead">No supply</span><span class="l-alarm">Alarm</span><span class="l-off">No data</span></div>
      ${S.info.demo && admin ? `<button class="gridsw" id="gridSw" title="Demo only: cut or restore the grid supply"><span class="plate"><span class="lever"></span></span><span class="lbl"><b>GRID ON</b><small>Demo power cut switch</small></span></button>` : ""}</div>
      <div id="ovMimic"></div></section>
    <h2>Active alarms</h2><div id="ovAlarms"></div>`;
  S.ov = { gridLive: null, cutAt: S.info.cut_since || null, restoredAt: null };
  const loadToday = async () => { try { S.today = Object.fromEntries((await api(`/api/reports/daily?start=${today()}`)).rows.map(r => [r.meter_id, r])); } catch (_) {} };
  const draw = async () => {
    try { S.meters = (await api("/api/meters")).meters; } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; }
    if (S.route !== "overview") return;
    renderOverview();
  };
  S.ovDraw = draw;
  const sw = $("#gridSw");
  if (sw) sw.onclick = async () => {
    const on = sw.classList.contains("off");
    sw.classList.toggle("off", !on);
    try {
      const r = await api("/api/demo/grid", { method: "POST", body: JSON.stringify({ on }) });
      S.info.grid_on = r.grid_on; S.info.cut_since = r.cut_since;
      toast(on ? "Grid supply restored. PCCs change back to the transformers, DGs cool down and stop." : "Grid supply cut. Watch the DGs start and the PCCs change over.");
      setTimeout(draw, 350);
    } catch (e) { toast(e.message); }
  };
  await loadToday(); await draw(); refreshInfo();
  let n = 0;
  const every = S.info.mode === "cloud" ? 15000 : S.info.demo ? 2000 : 5000;
  S.timer = setInterval(async () => { if (++n % Math.round(60000 / every) === 0) { await loadToday(); refreshInfo(); } draw(); }, every);
  let rt; window.onresize = () => { clearTimeout(rt); rt = setTimeout(renderOverview, 150); };
}

function powerFx(kind) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const fx = document.createElement("div");
  fx.className = "bolt-fx" + (kind === "restore" ? " restore" : "");
  if (kind === "cut") {
    fx.innerHTML = `<svg viewBox="0 0 100 300" preserveAspectRatio="none"><path d="M58 0 40 92l22 6-30 92 20 4-26 106"/><path d="M40 92 18 130M62 98l20 40" style="stroke-width:3"/></svg>`;
    document.body.classList.add("blackout");
    setTimeout(() => document.body.classList.remove("blackout"), 1300);
  }
  document.body.appendChild(fx);
  setTimeout(() => fx.remove(), 1400);
}

function renderOverview() {
  if (!$("#ovMimic")) return;
  const ms = S.meters.filter(m => m.enabled);
  const live = m => m.online && ((m.values.v_ln || 0) > 50 || (m.values.v_ll || 0) > 90);
  // someone who sees only some panels gets totals from the incomers of those panels
  const incs = ms.filter(m => m.position === "incomer" && !m.is_dg);
  const dgFed = m => ms.some(d => d.is_dg && (d.panel === m.fed_from || d.id === m.fed_from)) || /dg/i.test(m.fed_from || "");
  let mains = ms.filter(m => m.is_main);
  if (!mains.length) mains = incs;
  const grids = mains.filter(m => !m.is_dg && !dgFed(m)), dgs = ms.filter(m => m.is_dg);
  const basis = mains.length ? mains : ms, ids = new Set(basis.map(m => m.id));
  const on = basis.filter(m => m.online);
  const sum = (list, k) => list.reduce((a, m) => a + (m.values[k] || 0), 0);
  const kw = sum(on, "kw"), kva = sum(on, "kva");
  const gridOn = grids.filter(m => m.online);
  const pf = sum(gridOn, "kva") ? sum(gridOn, "kw") / sum(gridOn, "kva") : kva ? kw / kva : null;
  const rows = Object.values(S.today).filter(r => ids.has(r.meter_id));
  const kwh = rows.reduce((a, r) => a + r.kwh, 0);
  const gridIds = new Set(grids.map(m => m.id));
  const md = Object.values(S.today).filter(r => gridIds.has(r.meter_id)).reduce((a, r) => Math.max(a, r.md_kva || 0), 0);
  const contract = grids.reduce((a, m) => a + (m.contract_kva || 0), 0);
  const mdPct = contract ? md / contract : null;
  const runningDgs = dgs.filter(m => live(m));
  const gridLive = grids.length ? grids.some(live) : null;
  const pfMin = 0.9;
  const supply = gridLive === false ? (runningDgs.length ? ["dg", `DG sets`, `${runningDgs.length} of ${dgs.length} running`] : ["bad", "No supply", "grid failed"])
    : runningDgs.length ? ["dg", "Grid + DG", `${runningDgs.length} DG running`] : ["", "Grid", grids.length === 1 ? esc(grids[0].name) : `${grids.length} incomers`];
  $("#ovRead").innerHTML = `
    <div class="readout ${supply[0] === "bad" ? "bad" : ""}"><div class="k">Supply</div><div class="v" style="${supply[0] === "dg" ? "color:var(--dg-c)" : ""}">${supply[1]}</div><div class="s">${supply[2]}</div></div>
    <div class="readout"><div class="k">Plant load</div><div class="v">${fmtNum(kw, 0)}<small>kW</small></div><div class="s">${fmtNum(kva, 0)} kVA${dgs.length ? ", grid + DG" : ""}</div></div>
    <div class="readout ${pf != null && pf < pfMin ? "warn" : ""}"><div class="k">Power factor</div><div class="v">${pf != null ? fmtNum(pf, 3) : "–"}</div><div class="s">${pf != null && pf < pfMin ? "Low, check capacitor banks" : "at the grid incomer"}</div></div>
    <div class="readout"><div class="k">Energy today</div><div class="v">${fmtNum(kwh, 0)}<small>kWh</small></div><div class="s">since midnight</div></div>
    <div class="readout ${mdPct > 0.95 ? "bad" : mdPct > 0.85 ? "warn" : ""}"><div class="k">Max demand today</div><div class="v">${fmtNum(md, 0)}<small>kVA</small></div>
      <div class="s">${contract ? `${fmtNum(mdPct * 100, 0)}% of ${fmtNum(contract, 0)} kVA contract` : `${S.info.demand_block_minutes}-minute average`}</div>
      ${contract ? `<div class="meterbar ${mdPct > 0.95 ? "bad" : mdPct > 0.85 ? "warn" : ""}"><i style="width:${Math.min(100, mdPct * 100)}%"></i></div>` : ""}</div>`;

  // power cut: banner with a running timer, a flash when it happens, a green bar when it comes back
  const o = S.ov || (S.ov = {});
  if (gridLive !== null) {
    if (o.gridLive === true && !gridLive) { o.cutAt = S.info.cut_since || Date.now() / 1000; powerFx("cut"); }
    if (o.gridLive === false && gridLive) { o.restoredAt = Date.now() / 1000; o.lastCut = Date.now() / 1000 - (o.cutAt || Date.now() / 1000); o.cutAt = null; powerFx("restore"); }
    if (!gridLive && !o.cutAt) o.cutAt = S.info.cut_since || Date.now() / 1000;
    o.gridLive = gridLive;
  }
  const sw = $("#gridSw");
  if (sw && !sw.matches(":active")) {
    const off = gridLive === false;
    sw.classList.toggle("off", off);
    sw.querySelector("b").textContent = off ? "GRID OFF" : "GRID ON";
    sw.querySelector("small").textContent = off ? "Click to restore supply" : "Demo: click to cut supply";
  }
  const cb = $("#cutBanner");
  if (gridLive === false) {
    const dgOnLoad = runningDgs.filter(m => (m.values.kw || 0) > 20);
    const onDg = ms.filter(m => m.position === "incomer" && !m.is_dg && (m.values.kw || 0) > 1 && dgs.some(d => d.panel === m.fed_from || d.id === m.fed_from));
    const what = dgOnLoad.length ? `${dgOnLoad.map(m => esc(m.name)).join(", ")} on load. ${onDg.length ? `Running on DG: ${onDg.map(m => esc(m.panel ? ((S.info.panels || []).find(p => p.id === m.panel) || {}).name || m.panel : m.name)).join(", ")}.` : ""}`
      : runningDgs.length ? "DG sets started, synchronising…" : dgs.length ? "Waiting for the DG sets to start…" : "";
    cb.innerHTML = `<div class="cut-banner ${dgOnLoad.length ? "on-dg" : ""}">${BOLT}<div><b>Grid power cut</b><small>${what || "Logged with start time. The stop time is logged when power returns."}</small></div><span class="tmr" data-since="${o.cutAt}">${fmtDur(Date.now() / 1000 - o.cutAt)}</span></div>`;
  } else if (o.restoredAt && Date.now() / 1000 - o.restoredAt < 60) {
    cb.innerHTML = `<div class="cut-banner restored">${BOLT}<div><b>Grid power restored</b><small>The cut lasted ${fmtDur(o.lastCut || 0)}. ${dgs.length ? "PCCs change back to the transformers; the DG sets cool down for about a minute and stop." : ""} It is in the DG page and Alarms.</small></div></div>`;
  } else cb.innerHTML = "";

  if (!ms.length) {
    $("#ovMimic").innerHTML = `<p class="pad muted">No meters yet. ${S.info.mode === "plant" ? 'Add them in <a href="#/settings">Settings</a>.' : "Waiting for a plant PC to send data."}</p>`;
  } else if (S.info.mode === "cloud") {
    const plants = {};
    for (const m of ms) (plants[m.plant_id] = plants[m.plant_id] || []).push(m);
    const sig = Object.keys(plants).join(",");
    if ($("#ovMimic").dataset.sig !== sig) {
      $("#ovMimic").dataset.sig = sig;
      $("#ovMimic").innerHTML = Object.entries(plants).map(([id, list]) => `<h3 class="muted" style="margin:10px 6px 6px">${esc(list[0].plant_name)}</h3><div data-plant="${esc(id)}"></div>`).join("");
    }
    for (const [id, list] of Object.entries(plants)) drawPlant($(`[data-plant="${CSS.escape(id)}"]`), list, S.today, S.info.panels || []);
  } else {
    drawPlant($("#ovMimic"), ms, S.today, S.info.panels || []);
  }

  const al = alarmsOf(ms.filter(m => !(m.is_dg && !live(m) && m.online)));
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
    const canEdit = S.info.mode === "plant" && S.info.user && S.info.user.role === "admin";
    if ($("#mEdit") && $("#mEdit").contains(document.activeElement)) return m; // don't redraw while typing
    $("#mHead").innerHTML = `<div class="meter-head ${stt}"><${canEdit ? `button class="pic pic-edit" id="mPic" title="Change picture" aria-label="Change picture"` : `div class="pic"`}>${machinePic(m, 64)}${canEdit ? `<span class="pic-pen">Change</span>` : ""}</${canEdit ? "button" : "div"}>
      <div class="grow"><div id="mEdit" hidden class="row"><input id="mName" value="${esc(m.name)}" aria-label="Machine name" maxlength="60"><input id="mArea" value="${esc(m.area || "")}" placeholder="Area" aria-label="Area" maxlength="60"><button class="primary" id="mSave">Save</button><button class="ghost" id="mCancel">Cancel</button></div>
      <div class="row" id="mTitle"><h1>${esc(m.name)}</h1>${canEdit ? `<button class="ghost small" id="mRename">Rename</button>` : ""}</div><div class="sub">${esc([kind.label, m.area, CONN[m.connection]].filter(Boolean).join(", "))}</div>
      <div class="row" style="margin-top:6px">${m.online ? (m.alarms.length ? `<span class="badge bad">${esc(m.alarms.join("; "))}</span>` : `<span class="badge ok">Running normally</span>`) : `<span class="badge bad">${esc(m.error || "No data")}</span>`}
      ${m.last_seen ? `<span class="hint">updated ${new Date(m.last_seen * 1000).toLocaleTimeString()}</span>` : ""}</div></div></div>`;
    if (canEdit) {
      $("#mPic").onclick = () => pickMachine({ meter: m, current: m.machine, title: `Picture for ${m.name}`,
        onPick: async key => { await api(`/api/machines/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ machine: key }) }); toast("Picture changed."); drawHead(); },
        onUpload: () => { toast("Picture saved."); drawHead(); } });
      $("#mRename").onclick = () => { $("#mEdit").hidden = false; $("#mTitle").hidden = true; $("#mName").focus(); $("#mName").select(); };
      $("#mCancel").onclick = () => { $("#mEdit").hidden = true; $("#mTitle").hidden = false; };
      const save = async () => {
        try { await api(`/api/machines/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ name: $("#mName").value, area: $("#mArea").value }) }); document.activeElement.blur(); toast("Name saved."); drawHead(); }
        catch (e) { toast(e.message); }
      };
      $("#mSave").onclick = save;
      $("#mEdit").onkeydown = e => { if (e.key === "Enter") save(); if (e.key === "Escape") $("#mCancel").click(); };
    }
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

// The saved meter's uploaded picture applies while editing it in Settings.
function liveMeter(m) {
  const saved = m.id && S.meters.find(x => x.id === m.id);
  return saved && saved.picture_url ? { ...m, picture_url: saved.picture_url } : m;
}

// ---------------- machine picture picker ----------------
// opts: { current, meter (saved meter from /api/meters, enables "your own picture"), title, onPick(key), onUpload(url) }
function pickMachine(opts) {
  const old = $("#picker"); if (old) old.remove();
  const groups = {};
  Object.entries(MACHINES).forEach(([k, d]) => (groups[d.group || "Other"] ||= []).push([k, d]));
  const m = opts.meter;
  const box = document.createElement("div");
  box.id = "picker"; box.className = "picker-back";
  box.innerHTML = `<div class="picker" role="dialog" aria-modal="true" aria-label="Choose a picture">
    <div class="row picker-top"><h2>${esc(opts.title || "Choose a picture")}</h2><div class="spacer"></div>
      <input type="search" id="pkFind" placeholder="Search, e.g. slitter" aria-label="Search pictures"><button class="ghost" id="pkClose" aria-label="Close">✕</button></div>
    <div class="picker-body">
      ${m ? `<div class="pk-group"><h3>Your own picture</h3><div class="pk-grid">
        ${m.picture_url ? `<button class="pk on" data-own="keep"><span class="pk-pic">${machinePic(m, 56)}</span><span>Uploaded picture</span></button>` : ""}
        <label class="pk pk-up"><input type="file" id="pkFile" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden><span class="pk-pic pk-plus">+</span><span>${m.picture_url ? "Upload a different one" : "Upload a photo or drawing"}</span></label>
        ${m.picture_url ? `<button class="pk" data-own="remove"><span class="pk-pic pk-plus">↺</span><span>Remove my picture</span></button>` : ""}
      </div><p class="hint">PNG, JPG, SVG or WebP under 1 MB. A square photo of the machine works best.</p></div>` : ""}
      <div class="pk-group"><h3>Automatic</h3><div class="pk-grid"><button class="pk ${!opts.current && !(m && m.picture_url) ? "on" : ""}" data-key=""><span class="pk-pic">${machineIcon(guessMachine({ name: (m && m.name) || opts.name || "", area: (m && m.area) || "" }), 56)}</span><span>Pick from the name</span></button></div></div>
      ${Object.entries(groups).map(([g, list]) => `<div class="pk-group"><h3>${esc(g)}</h3><div class="pk-grid">
        ${list.map(([k, d]) => `<button class="pk ${opts.current === k && !(m && m.picture_url) ? "on" : ""}" data-key="${k}" data-find="${esc((d.label + " " + k + " " + g).toLowerCase())}"><span class="pk-pic">${machineIcon(k, 56)}</span><span>${esc(d.label)}</span></button>`).join("")}
      </div></div>`).join("")}
    </div></div>`;
  document.body.appendChild(box);
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  box.onclick = e => { if (e.target === box) close(); };
  $("#pkClose").onclick = close;
  $("#pkFind").oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    box.querySelectorAll("[data-find]").forEach(b => (b.hidden = !!q && !b.dataset.find.includes(q)));
    box.querySelectorAll(".pk-group").forEach(g => (g.hidden = !!q && ![...g.querySelectorAll("[data-find]")].some(b => !b.hidden)));
  };
  box.querySelectorAll("[data-key]").forEach(b => (b.onclick = async () => {
    try {
      if (m && m.picture_url) await api(`/api/machines/${encodeURIComponent(m.id)}/picture`, { method: "POST", body: JSON.stringify({ remove: true }) });
      await opts.onPick(b.dataset.key); close();
    } catch (e) { toast(e.message); }
  }));
  const own = async body => {
    try { const r = await api(`/api/machines/${encodeURIComponent(m.id)}/picture`, { method: "POST", body: JSON.stringify(body) }); close(); opts.onUpload && opts.onUpload(r.picture_url); }
    catch (e) { toast(e.message); }
  };
  box.querySelectorAll("[data-own]").forEach(b => (b.onclick = () => (b.dataset.own === "keep" ? close() : own({ remove: true }))));
  if ($("#pkFile")) $("#pkFile").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 1_000_000) return toast("That picture is over 1 MB. Save a smaller version and try again.");
    const r = new FileReader(); r.onload = () => own({ data_url: r.result }); r.readAsDataURL(f);
  };
  if (matchMedia("(pointer: fine)").matches) setTimeout(() => $("#pkFind").focus(), 0); // no pop-up keyboard on phones
}

// ---------------- insights (analysis and advice) ----------------
const SEV = { high: ["bad", "Act now"], medium: ["warn", "Worth fixing"], low: ["info", "Opportunity"], good: ["ok", "Good"] };

// Small, safe Markdown subset for Claude's answers: paragraphs, bullet lists, **bold**.
function mdLite(t) {
  const lines = esc(t).split(/\n/);
  let html = "", list = false;
  for (const raw of lines) {
    const l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const m = l.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (m) { if (!list) { html += "<ul>"; list = true; } html += `<li>${m[1]}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    if (l.trim()) html += `<p>${l.replace(/^#+\s*/, "")}</p>`;
  }
  return html + (list ? "</ul>" : "");
}

async function viewInsights() {
  const v = $("#view");
  const admin = S.info.user && S.info.user.role === "admin";
  v.innerHTML = `<h1>Insights</h1><p class="lede">What the last 7 days of meter data say, and what to do about it. Updated every few minutes.</p><div id="iBody"><p class="muted">Analysing…</p></div>`;
  let a;
  try { a = await api("/api/insights"); } catch (e) { $("#iBody").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (!S.meters.length) { try { S.meters = (await api("/api/meters")).meters; } catch (_) {} }
  const t = a.tariff, cur = t.currency, sm = a.summary;
  const byName = Object.fromEntries(S.meters.map(m => [m.name, m]));
  const money = x => x == null ? "" : cur + Math.round(x).toLocaleString("en-IN");
  const todo = a.insights.filter(x => x.severity !== "good"), good = a.insights.filter(x => x.severity === "good");
  const feeders = a.machines.filter(m => !m.main_incomer && m.kwh_per_day);
  const fTotal = feeders.reduce((s, m) => s + m.kwh_per_day, 0) || 1;
  const main = a.machines.find(m => m.main_incomer && m.hourly_avg_kw) || a.machines.find(m => m.hourly_avg_kw);
  const inPeak = h => (t.peak_hours || []).some(([x, y]) => x <= y ? h >= x && h < y : h >= x || h < y);
  const hours = main ? Array.from({ length: 24 }, (_, h) => main.hourly_avg_kw[h] ?? null) : [];
  const hMax = Math.max(1, ...hours.filter(x => x != null));
  const asks = ["Which machine should I fix first, and why?", "How can I cut my maximum demand?", "Is the CGL line using more energy than it should?", "Make a 30-day energy saving plan for my team"];

  const card = x => {
    const m = byName[x.meter_name];
    return `<article class="insight sev-${SEV[x.severity][0]}">
      <div class="ins-pic">${m ? machinePic(m, 44) : machineIcon(x.machine || "feeder", 44)}</div>
      <div class="ins-main"><div class="row ins-tags"><span class="badge ${SEV[x.severity][0]}">${SEV[x.severity][1]}</span><span class="hint">${esc(x.category)}${x.meter_name ? " · " + esc(x.meter_name) : ""}</span></div>
        <h3>${esc(x.title)}</h3><p>${esc(x.detail)}</p>
        <p class="ins-do"><b>What to do:</b> ${esc(x.action)}</p></div>
      ${x.saving_month ? `<div class="ins-save"><small>Worth about</small><b>${money(x.saving_month)}</b><small>a month</small></div>` : ""}
    </article>`;
  };

  $("#iBody").innerHTML = `
    <section class="readouts ins-sum">
      <div class="readout"><div class="k">Possible saving</div><div class="v accent">${esc(sm.possible_saving_text || money(0))}</div><div class="s">a month, if all the advice below is followed</div></div>
      <div class="readout"><div class="k">Things to fix</div><div class="v">${sm.findings}</div><div class="s">${todo.filter(x => x.severity === "high").length} need action now</div></div>
      <div class="readout"><div class="k">Energy per day</div><div class="v">${fmtNum(sm.kwh_per_day, 0)}<small>kWh</small></div><div class="s">average, ${esc(a.period.from)} to ${esc(a.period.to)}</div></div>
      <div class="readout"><div class="k">Energy cost per day</div><div class="v">${money(sm.cost_per_day)}</div><div class="s">at ${cur}${t.energy_rate} per ${t.billing === "kvah" ? "kVAh" : "kWh"}</div></div>
    </section>

    <section class="panel ask">
      <div class="row"><h2 style="margin:0">Ask Claude about your plant</h2>${a.ai_enabled ? `<span class="badge ok">On</span>` : `<span class="badge">Off</span>`}</div>
      ${a.ai_enabled ? `<p class="hint">Claude reads this week's numbers for every machine (daily totals and hourly averages, not raw readings) and answers in plain words.</p>
        <div class="chips">${asks.map(q => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <form id="askForm" class="row ask-row"><input id="askQ" placeholder="Ask anything, e.g. why did energy go up on Tuesday?" maxlength="1000" aria-label="Question"><button class="primary" id="askBtn">Ask</button></form>
        <div id="askOut"></div>`
      : `<p class="hint">The advice on this page works offline. Switch on Claude to also ask questions in your own words, like "how do I cut my maximum demand?". It needs an internet connection and a Claude API key from console.anthropic.com; this week's summary numbers are sent with each question.</p>
        ${admin ? `<form id="aiForm" class="row ask-row"><input id="aiKey" type="password" placeholder="Paste Claude API key (sk-ant-…)" autocomplete="off" aria-label="Claude API key"><button class="primary">Switch on</button></form>` : `<p class="hint">Ask an admin to switch it on.</p>`}`}
    </section>

    <h2>Advice</h2>
    ${todo.length ? todo.map(card).join("") : `<p class="panel pad">No problems found in the last 7 days. Good work.</p>`}

    <div class="ins-grid">
      ${main ? `<section class="panel"><h2 style="margin-top:0">Plant load by hour</h2><p class="hint">Average kW at ${esc(main.name)} for each hour of the day. Shaded hours are the peak tariff window.</p>
        <div class="hbars">${hours.map((x, h) => `<div class="hb ${inPeak(h) ? "peak" : ""}" title="${h}:00, ${fmtNum(x, 0)} kW"><i style="height:${x == null ? 0 : Math.max(2, x / hMax * 100)}%"></i><span>${h % 3 === 0 ? h : ""}</span></div>`).join("")}</div></section>` : ""}
      ${feeders.length ? `<section class="panel"><h2 style="margin-top:0">Where the energy goes</h2><p class="hint">Share of daily kWh by machine, this week.</p>
        <div class="share">${feeders.sort((x, y) => y.kwh_per_day - x.kwh_per_day).map(m => {
          const ch = m.kwh_per_day_prev_week ? (m.kwh_per_day - m.kwh_per_day_prev_week) / m.kwh_per_day_prev_week * 100 : null;
          return `<div class="sh"><span>${esc(m.name)}</span><div class="bar"><i style="width:${m.kwh_per_day / fTotal * 100}%"></i></div><b>${fmtNum(m.kwh_per_day, 0)}</b><small class="${ch > 10 ? "up" : ""}">${ch == null ? "" : (ch > 0 ? "+" : "") + ch.toFixed(0) + "%"}</small></div>`;
        }).join("")}</div></section>` : ""}
    </div>

    ${good.length ? `<h2>Going well</h2>${good.map(card).join("")}` : ""}

    ${admin ? `<details class="panel tariff"><summary><b>Your tariff</b> <span class="hint">(used for the money figures)</span></summary>
      <div class="form" style="margin-top:12px">
        <label class="f">Billed on<select id="tBill"><option value="kvah" ${t.billing === "kvah" ? "selected" : ""}>kVAh</option><option value="kwh" ${t.billing === "kwh" ? "selected" : ""}>kWh</option></select></label>
        <label class="f">Energy rate (${esc(cur)} per unit)<input id="tRate" type="number" step="0.01" value="${t.energy_rate}"></label>
        <label class="f">Demand charge (${esc(cur)} per kVA a month)<input id="tDem" type="number" step="1" value="${t.demand_rate}"></label>
        <label class="f">Target power factor<input id="tPf" type="number" step="0.01" min="0.8" max="1" value="${t.pf_target}"></label>
        <label class="f">Peak hours (e.g. 18-22, 6-9)<input id="tPeak" value="${esc((t.peak_hours || []).map(p => p.join("-")).join(", "))}"></label>
        <label class="f">Peak surcharge (${esc(cur)} per unit)<input id="tExtra" type="number" step="0.01" value="${t.peak_extra}"></label>
        <label class="f">Currency symbol<input id="tCur" value="${esc(cur)}" maxlength="4"></label>
      </div>
      <div class="row" style="margin-top:12px"><button class="primary" id="tSave">Save tariff</button>${a.ai_enabled ? `<div class="spacer"></div><button class="ghost danger" id="aiOff">Switch off Claude</button>` : ""}</div>
    </details>` : ""}`;

  const ask = async q => {
    if (!q.trim()) return;
    $("#askQ").value = q; $("#askBtn").disabled = true;
    $("#askOut").innerHTML = `<div class="answer"><p class="muted">Claude is reading your plant data…</p></div>`;
    try { const r = await api("/api/insights/ask", { method: "POST", body: JSON.stringify({ question: q }) }); $("#askOut").innerHTML = `<div class="answer"><div class="q">${esc(q)}</div>${mdLite(r.answer)}<p class="hint">Check figures against the meters before acting on them.</p></div>`; }
    catch (e) { $("#askOut").innerHTML = `<div class="answer"><p class="err">${esc(e.message)}</p></div>`; }
    $("#askBtn").disabled = false;
  };
  if ($("#askForm")) {
    $("#askForm").onsubmit = e => { e.preventDefault(); ask($("#askQ").value); };
    v.querySelectorAll("[data-q]").forEach(b => (b.onclick = () => ask(b.dataset.q)));
  }
  if ($("#aiForm")) $("#aiForm").onsubmit = async e => {
    e.preventDefault();
    const k = $("#aiKey").value.trim(); if (!k) return toast("Paste the API key first.");
    try { await api("/api/ai", { method: "PUT", body: JSON.stringify({ api_key: k }) }); toast("Claude switched on."); refreshInfo(); viewInsights(); } catch (err) { toast(err.message); }
  };
  if ($("#aiOff")) $("#aiOff").onclick = async () => { await api("/api/ai", { method: "PUT", body: JSON.stringify({ api_key: "" }) }); toast("Claude switched off."); viewInsights(); };
  if ($("#tSave")) $("#tSave").onclick = async () => {
    const peak = $("#tPeak").value.split(",").map(x => x.trim()).filter(Boolean).map(x => x.split("-").map(Number));
    if (peak.some(p => p.length !== 2 || p.some(isNaN))) return toast("Write peak hours like 18-22, or 6-9, 18-22.");
    try {
      await api("/api/tariff", { method: "PUT", body: JSON.stringify({ billing: $("#tBill").value, energy_rate: $("#tRate").value, demand_rate: $("#tDem").value,
        pf_target: $("#tPf").value, peak_hours: peak, peak_extra: $("#tExtra").value, currency: $("#tCur").value }) });
      toast("Tariff saved."); viewInsights();
    } catch (err) { toast(err.message); }
  };
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
      <label class="f">Show<select id="rGroup"><option value="day">Each day, each machine</option><option value="meter">Total per machine</option><option value="shift">Shift-wise, plant totals</option><option value="shiftm">Shift-wise, each machine</option></select></label>
    </div><div class="row" style="margin-top:14px">
      <button class="primary" id="rRun">Show report</button><div class="spacer"></div>
      <button id="rCsvDaily">Download daily report (Excel)</button><button id="rCsvRaw">Download every reading (Excel)</button>
    </div><p class="hint">Max demand is the highest average kVA over ${S.info.demand_block_minutes}-minute blocks. Times are in ${esc(S.info.timezone)}.</p></div>
    <div class="table-wrap" id="rOut" style="margin-top:14px"></div>`;
  const q = () => `start=${$("#rStart").value}&end=${$("#rEnd").value}${$("#rMeter").value ? "&meters=" + encodeURIComponent($("#rMeter").value) : ""}`;
  const run = async () => {
    $("#rOut").innerHTML = `<p class="pad muted">Working…</p>`;
    const tok = ++S.repTok;
    if ($("#rGroup").value.startsWith("shift")) return runShift(tok);
    try {
      const r = await api(`/api/reports/daily?${q()}`);
      if (tok !== S.repTok) return;  // a newer report was asked for
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
  let shiftData = null;
  const name = id => (S.meters.find(m => m.id === id) || {}).name || id;
  const runShift = async tok => {
    let got;
    try { got = await api(`/api/reports/shifts?${q()}`); if (tok !== S.repTok) return; shiftData = got; } catch (e) {
      $("#rOut").innerHTML = `<p class="pad err">${esc(e.message)}${S.info.user && S.info.user.role === "admin" ? ` <a href="#/settings" onclick="S.settingsTab='shifts'">Set shifts</a>` : ""}</p>`; return;
    }
    const r = shiftData, perMachine = $("#rGroup").value === "shiftm";
    const mains = new Set(S.meters.filter(m => m.is_main).map(m => m.id)), grids = new Set(S.meters.filter(m => m.is_main && !m.is_dg).map(m => m.id));
    const one = $("#rMeter").value;
    const ex = Object.fromEntries(r.shift_extra.map(x => [x.date + "|" + x.shift, x]));
    const shiftTime = Object.fromEntries(r.shifts.map(x => [x.name, `${x.start}–${x.end}`]));
    if (perMachine || one) {
      $("#rOut").innerHTML = `<table><thead><tr><th>Date</th><th>Shift</th><th>Machine</th><th class="n">kWh</th><th class="n">kVAh</th><th class="n">Avg PF</th><th class="n">Max demand kVA</th><th class="n">at</th><th class="n">Peak kW</th></tr></thead><tbody>
        ${r.rows.map(x => `<tr><td>${x.date}</td><td><b>${esc(x.shift)}</b> <small class="muted">${shiftTime[x.shift] || ""}</small></td><td>${esc(name(x.meter_id))}</td><td class="n">${fmtNum(x.kwh, 1)}</td><td class="n">${fmtNum(x.kvah, 1)}</td><td class="n">${fmtNum(x.avg_pf, 3)}</td><td class="n">${fmtNum(x.md_kva, 1)}</td><td class="n">${x.md_kva_at || ""}</td><td class="n">${fmtNum(x.peak_kw, 1)}</td></tr>`).join("")}</tbody></table>`;
      return;
    }
    // plant totals per shift: grid incomer(s) + DG
    const agg = {};
    for (const x of r.rows) {
      if (mains.size && !mains.has(x.meter_id)) continue;
      const k = x.date + "|" + x.shift;
      const a = agg[k] = agg[k] || { date: x.date, shift: x.shift, kwh: 0, kvah: 0, grid_kwh: 0, md: 0, md_at: "", peak: 0 };
      a.kwh += x.kwh; a.kvah += x.kvah; a.peak = Math.max(a.peak, x.peak_kw || 0);
      if (grids.has(x.meter_id) || !mains.size) { a.grid_kwh += x.kwh; if ((x.md_kva || 0) > a.md) { a.md = x.md_kva; a.md_at = x.md_kva_at; } }
    }
    const list = Object.values(agg).sort((a, b) => a.date.localeCompare(b.date) || r.shifts.findIndex(s => s.name === a.shift) - r.shifts.findIndex(s => s.name === b.shift));
    const tot = {}; // per shift name over the whole range
    for (const a of list) { const e = ex[a.date + "|" + a.shift] || {}; const t = tot[a.shift] = tot[a.shift] || { kwh: 0, grid: 0, dg_s: 0, dg_kwh: 0, fuel: 0, cuts: 0, cut_s: 0, md: 0, n: 0 };
      t.kwh += a.kwh; t.grid += a.grid_kwh; t.dg_s += e.dg_seconds || 0; t.dg_kwh += e.dg_kwh || 0; t.fuel += e.dg_fuel_l || 0; t.cuts += e.cuts || 0; t.cut_s += e.cut_seconds || 0; t.md = Math.max(t.md, a.md); t.n++; }
    const maxK = Math.max(1, ...Object.values(tot).map(t => t.kwh / t.n));
    $("#rOut").innerHTML = `<div class="shift-sum">${r.shifts.map(sh => { const t = tot[sh.name]; return t ? `<div class="readout"><div class="k">Shift ${esc(sh.name)} <small>${sh.start}–${sh.end}</small></div><div class="v">${fmtNum(t.kwh / t.n, 0)}<small>kWh / shift</small></div>
        <div class="meterbar"><i style="width:${(t.kwh / t.n / maxK) * 100}%"></i></div><div class="s">${fmtNum(t.kwh, 0)} kWh in ${t.n} shifts · max demand ${fmtNum(t.md, 0)} kVA${t.cuts ? ` · ${t.cuts} power cuts, DG ${hrs(t.dg_s)} h` : ""}</div></div>` : ""; }).join("")}</div>
      <table><thead><tr><th>Date</th><th>Shift</th><th class="n">Total kWh</th><th class="n">Grid kWh</th><th class="n">DG kWh</th><th class="n">Avg PF</th><th class="n">Max demand kVA</th><th class="n">at</th><th class="n">DG run h</th><th class="n">Diesel L</th><th class="n">Power cuts</th></tr></thead><tbody>
      ${list.map(a => { const e = ex[a.date + "|" + a.shift] || {}; return `<tr><td>${a.date}</td><td><b>${esc(a.shift)}</b> <small class="muted">${shiftTime[a.shift] || ""}</small></td><td class="n">${fmtNum(a.kwh, 0)}</td><td class="n">${fmtNum(a.grid_kwh, 0)}</td><td class="n">${fmtNum(a.kwh - a.grid_kwh, 0)}</td>
        <td class="n">${a.kvah ? fmtNum(a.kwh / a.kvah, 3) : "–"}</td><td class="n">${fmtNum(a.md, 0)}</td><td class="n">${a.md_at || ""}</td><td class="n">${e.dg_seconds ? hrs(e.dg_seconds) : "–"}</td><td class="n">${e.dg_fuel_l ? fmtNum(e.dg_fuel_l, 0) : "–"}</td>
        <td class="n">${e.cuts ? `${e.cuts} <small class="muted">(${fmtDur(e.cut_seconds || 0)})</small>` : "–"}</td></tr>`; }).join("")}</tbody></table>`;
    shiftData.list = list; shiftData.ex = ex;
  };
  $("#rRun").onclick = run;
  $("#rGroup").onchange = run;
  $("#rCsvDaily").onclick = () => {
    if (!$("#rGroup").value.startsWith("shift") || !shiftData) return (location.href = `/api/export.csv?kind=daily&${q()}`);
    if ($("#rGroup").value === "shiftm" || $("#rMeter").value) return csvDownload(`shift-report-${shiftData.start}-${shiftData.end}.csv`, [["Date", "Shift", "Machine", "kWh", "kVAh", "Avg PF", "Max demand kVA", "at", "Peak kW"], ...shiftData.rows.map(x => [x.date, x.shift, name(x.meter_id), x.kwh.toFixed(1), x.kvah.toFixed(1), x.avg_pf != null ? x.avg_pf.toFixed(3) : "", x.md_kva != null ? x.md_kva.toFixed(1) : "", x.md_kva_at, x.peak_kw != null ? x.peak_kw.toFixed(1) : ""])]);
    csvDownload(`shift-report-${shiftData.start}-${shiftData.end}.csv`, [["Date", "Shift", "Total kWh", "Grid kWh", "DG kWh", "Avg PF", "Max demand kVA", "at", "DG run h", "Diesel L", "Power cuts", "Cut minutes"],
      ...shiftData.list.map(a => { const e = shiftData.ex[a.date + "|" + a.shift] || {}; return [a.date, a.shift, a.kwh.toFixed(0), a.grid_kwh.toFixed(0), (a.kwh - a.grid_kwh).toFixed(0), a.kvah ? (a.kwh / a.kvah).toFixed(3) : "", a.md.toFixed(0), a.md_at, ((e.dg_seconds || 0) / 3600).toFixed(2), (e.dg_fuel_l || 0).toFixed(0), e.cuts || 0, ((e.cut_seconds || 0) / 60).toFixed(1)]; })]);
  };
  $("#rCsvRaw").onclick = () => (location.href = `/api/export.csv?kind=readings&${q()}`);
  run();
}

// ---------------- DG sets ----------------
const csvDownload = (name, rows) => {
  const txt = rows.map(r => r.map(c => { const v = c == null ? "" : String(c); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + txt], { type: "text/csv" }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
const hrs = s => (s == null ? "–" : fmtNum(s / 3600, s < 36000 ? 2 : 1));
const tsTxt = t => (t ? new Date(t * 1000).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");

async function viewDG() {
  const v = $("#view");
  const admin = S.info.user && S.info.user.role === "admin";
  S.dgDays = S.dgDays || 30;
  v.innerHTML = `<h1>DG sets</h1><p class="lede">Live status, start and stop times, run hours, energy generated and diesel used, worked out from the DG meters. Every grid power cut is logged too.</p>
    <div id="dgLive" class="dg-grid"></div>
    <div class="row" style="margin:22px 0 10px;gap:10px;flex-wrap:wrap"><h2 style="margin:0">History</h2><div class="seg" id="dgRange">${[[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]].map(([d, l]) => `<button data-d="${d}" class="${d === S.dgDays ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="spacer"></div><button id="dgCsv">Download run log (Excel)</button>${admin ? `<button id="dgSet">Fuel and hour meter settings</button>` : ""}</div>
    <div class="readouts" id="dgSum"></div>
    <h2>Run hours per day</h2><div class="panel" id="dgDaily"></div>
    <h2>Power cuts</h2><div class="table-wrap" id="dgCuts"></div>
    <h2>Run log</h2><div class="table-wrap" id="dgRuns"></div>`;
  let data = null, built = "";
  const live = () => {
    const el = $("#dgLive");
    if (!el || !data) return;
    if (!data.dgs.length) { el.innerHTML = `<p class="muted">No DG meter yet. In Settings, give the DG's meter the picture "DG set / generator".</p>`; return; }
    const sig = data.dgs.map(d => d.id).join();
    if (built !== sig) {
      el.innerHTML = data.dgs.map(d => `<section class="dg-card" data-dg="${esc(d.id)}"><div class="dg-pic dg-off" data-art>${dgArt(96)}</div><div class="dg-info" data-info></div></section>`).join("");
      built = sig;
    }
    for (const d of data.dgs) {
      const card = el.querySelector(`[data-dg="${CSS.escape(d.id)}"]`), vv = d.values || {};
      const st = d.status !== "running" ? (d.status === "offline" ? "nodata" : "off") : (vv.hz || 0) < 47 ? "cranking" : (d.load_pct || 0) < 5 ? "idle" : "loaded";
      $("[data-art]", card).className = `dg-pic dg-${st}`;
      card.className = `dg-card dgc-${st}`;
      const label = { off: "Stopped", nodata: "No data", cranking: "Cranking", idle: "Running, no load", loaded: "Running on load" }[st];
      $("[data-info]", card).innerHTML = `<div class="row" style="gap:10px;align-items:baseline"><h3>${esc(d.name)}</h3><span class="muted">${d.rated_kva ? fmtNum(d.rated_kva, 0) + " kVA" : ""}</span></div>
        <div class="dg-state"><span class="pill p-${st === "loaded" ? "flow" : st === "off" ? "" : st === "nodata" ? "nodata" : "idle"} src-dg">${label}</span>
          ${d.since ? `<span class="dg-timer">for <b class="tmr" data-since="${d.since}">${fmtDur(Date.now() / 1000 - d.since)}</b></span><span class="muted">since ${tsTxt(d.since)}</span>` : d.last_stop ? `<span class="muted">Last stopped ${tsTxt(d.last_stop)}</span>` : ""}</div>
        <dl class="dg-kv">
          <div><dt>Load</dt><dd>${d.status === "running" ? `${fmtNum(vv.kw || 0, 0)} <small>kW</small>` : "–"}</dd></div>
          <div><dt>Load %</dt><dd>${d.load_pct != null ? `${fmtNum(d.load_pct, 0)}<small>%</small>` : "–"}</dd></div>
          <div><dt>Voltage</dt><dd>${d.status === "running" ? `${fmtNum(vv.v_ll || (vv.v_ln || 0) * 1.732, 0)} <small>V</small>` : "–"}</dd></div>
          <div><dt>Frequency</dt><dd>${d.status === "running" ? `${fmtNum(vv.hz || 0, 2)} <small>Hz</small>` : "–"}</dd></div>
          <div><dt>Run today</dt><dd>${fmtDur(d.today.seconds || 0)}</dd></div>
          <div><dt>Energy today</dt><dd>${fmtNum(d.today.kwh || 0, 0)} <small>kWh</small></dd></div>
          <div><dt>Diesel today (est.)</dt><dd>${fmtNum(d.today.fuel_l || 0, 0)} <small>L</small></dd></div>
          <div><dt>Starts today</dt><dd>${d.today.starts || 0}</dd></div>
          <div><dt>Last start</dt><dd class="sm">${tsTxt(d.last_start)}</dd></div>
          <div><dt>Last stop</dt><dd class="sm">${d.since ? "running now" : tsTxt(d.last_stop)}</dd></div>
          <div><dt>Total run hours</dt><dd>${fmtNum(d.run_hours_total, 1)} <small>h</small></dd></div>
        </dl>${d.error && d.status === "offline" ? `<p class="err">${esc(d.error)}</p>` : ""}`;
    }
  };
  const history = () => {
    const f = data.fuel, P = data.dgs.reduce((a, d) => ({ s: a.s + d.period.seconds, k: a.k + d.period.kwh, l: a.l + d.period.fuel_l, n: a.n + d.period.starts }), { s: 0, k: 0, l: 0, n: 0 });
    const cuts = data.power_cuts, cutS = cuts.reduce((a, c) => a + (c.seconds || 0), 0);
    $("#dgSum").innerHTML = `
      <div class="readout"><div class="k">Run hours</div><div class="v">${hrs(P.s)}<small>h</small></div><div class="s">all DG sets, ${P.n} starts</div></div>
      <div class="readout"><div class="k">Energy from DG</div><div class="v">${fmtNum(P.k, 0)}<small>kWh</small></div><div class="s">last ${data.days} days</div></div>
      <div class="readout"><div class="k">Diesel used (est.)</div><div class="v">${fmtNum(P.l, 0)}<small>L</small></div><div class="s">≈ ₹${fmtNum(P.l * f.diesel_price, 0)} at ₹${fmtNum(f.diesel_price, 0)}/L</div></div>
      <div class="readout"><div class="k">DG cost per unit</div><div class="v">${P.k ? "₹" + fmtNum((P.l * f.diesel_price) / P.k, 1) : "–"}</div><div class="s">diesel only, per kWh</div></div>
      <div class="readout"><div class="k">Power cuts</div><div class="v">${cuts.length}</div><div class="s">${fmtDur(cutS)} without grid in total</div></div>`;
    // run hours per day, one bar per DG
    const days = Object.keys(data.daily).sort().slice(-Math.min(data.days, 31));
    const max = Math.max(1, ...days.map(dy => Math.max(...Object.values(data.daily[dy]).map(x => x.seconds))));
    $("#dgDaily").innerHTML = days.length ? `<div class="dgbars">${days.map(dy => `<div class="dgday" title="${dy}"><div class="bars">${data.dgs.map(d => {
      const x = data.daily[dy][d.id]; return `<i style="height:${x ? Math.max(2, (x.seconds / max) * 100) : 0}%" title="${esc(d.name)}: ${x ? hrs(x.seconds) + " h, " + fmtNum(x.kwh, 0) + " kWh, " + x.starts + " starts" : "not run"}"></i>`; }).join("")}</div><span>${dy.slice(8)}</span></div>`).join("")}</div>
      <p class="hint">Highest day: ${hrs(max)} h. Hover a bar for run hours, kWh and starts. ${data.dgs.length > 1 ? data.dgs.map((d, i) => `<span class="dgkey k${i}">${esc(d.name)}</span>`).join(" ") : ""}</p>` : `<p class="muted">The DG sets have not run in this period.</p>`;
    $("#dgCuts").innerHTML = cuts.length ? `<table><thead><tr><th>Power cut at</th><th>Power back at</th><th class="n">Duration</th><th class="n">DG on in</th></tr></thead><tbody>
      ${cuts.map(c => `<tr><td>${c.start_text}</td><td>${c.end_text || `<span class="badge bad">Still off</span>`}</td><td class="n">${c.seconds != null ? fmtDur(c.seconds) : `<span class="tmr" data-since="${c.start}"></span>`}</td><td class="n">${c.dg_start_s != null ? c.dg_start_s + " s" : "–"}</td></tr>`).join("")}</tbody></table>`
      : `<p class="pad muted">No grid power cuts in this period.</p>`;
    $("#dgRuns").innerHTML = data.runs.length ? `<table><thead><tr><th>DG</th><th>Started</th><th>Stopped</th><th class="n">Run time</th><th class="n">kWh</th><th class="n">Avg kW</th><th class="n">Max kW</th><th class="n">Avg load</th><th class="n">Diesel L (est.)</th><th class="n">Cost ₹</th></tr></thead><tbody>
      ${data.runs.map(r => `<tr><td>${esc(r.name)}</td><td>${r.start_text}</td><td>${r.ongoing ? `<span class="badge ok">Running</span>` : r.end_text}</td><td class="n">${fmtDur(r.seconds)}</td><td class="n">${fmtNum(r.kwh, 0)}</td>
      <td class="n">${fmtNum(r.avg_kw, 0)}</td><td class="n">${fmtNum(r.max_kw, 0)}</td><td class="n">${r.avg_load_pct != null ? fmtNum(r.avg_load_pct, 0) + "%" : "–"}</td><td class="n">${fmtNum(r.fuel_l, 1)}</td><td class="n">${fmtNum(r.fuel_cost, 0)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="pad muted">No DG runs in this period.</p>`;
    document.querySelectorAll("#dgCuts .tmr").forEach(t => (t.textContent = fmtDur(Date.now() / 1000 - +t.dataset.since)));
  };
  const load = async (full = true) => {
    try { data = await api(`/api/dg?days=${S.dgDays}`); } catch (e) { if (e.message !== "login" && $("#dgLive")) $("#dgLive").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (S.route !== "dg") return;
    live(); if (full) history();
  };
  $("#dgRange").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.dgDays = +b.dataset.d; $("#dgRange").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); load(); };
  $("#dgCsv").onclick = () => data && csvDownload(`dg-run-log-${today()}.csv`, [["DG", "Started", "Stopped", "Run time (h)", "kWh", "Avg kW", "Max kW", "Avg load %", "Diesel L (est.)", "Cost Rs"],
    ...data.runs.map(r => [r.name, r.start_text, r.ongoing ? "running" : r.end_text, (r.seconds / 3600).toFixed(2), r.kwh, r.avg_kw, r.max_kw, r.avg_load_pct, r.fuel_l, r.fuel_cost]),
    [], ["Power cut at", "Power back at", "Duration (min)", "DG on in (s)"], ...data.power_cuts.map(c => [c.start_text, c.end_text || "still off", c.seconds != null ? (c.seconds / 60).toFixed(1) : "", c.dg_start_s])]);
  if (admin) $("#dgSet").onclick = () => data && dgSettings(data, () => load());
  await load();
  let n = 0;
  S.timer = setInterval(() => load(++n % 6 === 0), S.info.demo ? 4000 : 10000);
}

function dgSettings(data, done) {
  const f = data.fuel, box = document.createElement("div");
  box.className = "picker-back";
  box.innerHTML = `<form class="picker small-dlg" id="dgForm" style="width:min(560px,100%)"><div class="row picker-top"><h2>Fuel and hour meter</h2><div class="spacer"></div><button type="button" class="ghost" id="dgX" aria-label="Close">✕</button></div>
    <div class="picker-body"><p class="hint">Diesel is estimated from run time and kWh with the usual generator fuel line: litres per hour = idle part × rated kW + part per kWh × output. Set the numbers from your DG's fuel log or OEM sheet for better figures.</p>
    <div class="form"><label class="f">Diesel price ₹/L<input name="diesel_price" type="number" step="0.01" value="${f.diesel_price}"></label>
    <label class="f">Idle part, L/h per rated kW<input name="idle_l_per_h_per_kw" type="number" step="0.0001" value="${f.idle_l_per_h_per_kw}"></label>
    <label class="f">Part per kWh, L/kWh<input name="l_per_kwh" type="number" step="0.001" value="${f.l_per_kwh}"></label></div>
    <h3 style="margin-top:18px">Engine hour meter</h3><p class="hint">Type what the DG's own hour meter shows now, so total run hours match it. Hours run from now on are added automatically.</p>
    <div class="form">${data.dgs.map(d => `<label class="f">${esc(d.name)} hour meter now<input type="number" step="0.1" data-hm="${esc(d.id)}" data-logged="${d.run_hours_total - d.hour_meter_offset}" value="${d.run_hours_total}"></label>`).join("")}</div>
    <p class="err" id="dgErr"></p><div class="row"><button class="primary">Save</button></div></div></form>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.onclick = e => { if (e.target === box) close(); };
  $("#dgX").onclick = close;
  $("#dgForm").onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target)), hm = {};
    box.querySelectorAll("[data-hm]").forEach(i => (hm[i.dataset.hm] = Math.max(0, +i.value - +i.dataset.logged)));
    try { await api("/api/dg/settings", { method: "PUT", body: JSON.stringify({ ...Object.fromEntries(Object.entries(fd).map(([k, x]) => [k, +x])), hour_meter_offset: hm }) }); toast("Saved."); close(); done(); }
    catch (err) { $("#dgErr").textContent = err.message; }
  };
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

// ---------------- users and access ----------------
const PAGE_LABEL = { plant: "Plant", dg: "DG sets", insights: "Insights", reports: "Reports", alarms: "Alarms" };
function viewUsers() { S.settingsTab = "users"; viewSettings(); }

async function usersTab(el) {
  let d;
  try { d = await api("/api/users"); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const pname = id => (d.panels.find(p => p.id === id) || {}).name || id;
  el.innerHTML = `<p class="lede">Only people with an account can open this app. For each person, choose what they can see: which pages and which panels' machines. Admins see everything and can change settings.</p>
    <div class="row" style="margin-bottom:12px"><button class="primary" id="uAdd">Add a person</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Designation</th><th>User ID</th><th>Access</th><th>Can see</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${d.users.map(u => `<tr class="${u.active ? "" : "muted"}"><td><b>${esc(u.name || "–")}</b>${u.phone ? `<br><small class="muted">${esc(u.phone)}</small>` : ""}</td><td>${esc(u.designation || "–")}</td><td>${esc(u.username)}</td>
      <td>${u.role === "admin" ? `<span class="badge ok">Admin</span>` : `<span class="badge">Viewer</span>`}${u.active ? "" : ` <span class="badge bad">Blocked</span>`}</td>
      <td style="white-space:normal;max-width:340px">${u.role === "admin" ? "Everything" : `${u.pages.map(p => PAGE_LABEL[p] || p).join(", ")}<br><small class="muted">${u.panels.length ? "Panels: " + u.panels.map(pname).map(esc).join(", ") : "All panels"}</small>`}</td>
      <td>${u.last_login ? tsTxt(u.last_login) : "never"}</td><td><button data-edit="${esc(u.username)}">Edit</button></td></tr>`).join("")}</tbody></table></div>`;
  const form = u => {
    const box = document.createElement("div");
    box.className = "picker-back";
    const isNew = !u;
    u = u || { role: "viewer", pages: ["plant", "dg", "reports", "alarms"], panels: [], active: true };
    box.innerHTML = `<form class="picker" id="uForm" style="height:auto;max-height:92vh;width:min(640px,100%)"><div class="row picker-top"><h2>${isNew ? "Add a person" : esc(u.name || u.username)}</h2><div class="spacer"></div><button type="button" class="ghost" id="uX" aria-label="Close">✕</button></div>
      <div class="picker-body"><div class="form" style="margin-top:12px">
        <label class="f">Full name<input name="name" value="${esc(u.name || "")}" required></label>
        <label class="f">Designation<input name="designation" value="${esc(u.designation || "")}" list="desigList" placeholder="Shift Engineer"></label>
        <label class="f">Phone<input name="phone" value="${esc(u.phone || "")}" inputmode="tel"></label>
        <label class="f">User ID<input name="username" value="${esc(u.username || "")}" ${isNew ? "" : "readonly"} required pattern="(?:[A-Za-z0-9._]|-){3,32}" autocapitalize="none"></label>
        <label class="f">${isNew ? "Password" : "New password (leave empty to keep)"}<input name="password" type="password" minlength="8" ${isNew ? "required" : ""} autocomplete="new-password"></label>
        <label class="f">Access<select name="role"><option value="viewer">Viewer (sees data only)</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin (sees all, changes settings)</option></select></label>
      </div>
      <div id="uScope" ${u.role === "admin" ? "hidden" : ""}>
        <h3>Pages</h3><div class="chips">${d.pages.map(p => `<label class="chk"><input type="checkbox" name="pages" value="${p}" ${u.pages.includes(p) ? "checked" : ""}>${PAGE_LABEL[p] || p}</label>`).join("")}</div>
        <h3>Panels</h3><p class="hint">Leave all unticked to show every panel. Tick panels to show only the machines on them, for example only the CCL line PCC for the CCL in-charge.</p>
        <div class="chips">${d.panels.map(p => `<label class="chk"><input type="checkbox" name="panels" value="${esc(p.id)}" ${u.panels.includes(p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("") || `<span class="muted">No panels set up yet.</span>`}</div>
      </div>
      <label class="chk" style="margin-top:14px"><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Account active (untick to block sign-in)</label>
      <p class="err" id="uErr"></p>
      <div class="row" style="margin-top:8px"><button class="primary">${isNew ? "Add" : "Save"}</button><div class="spacer"></div>${isNew || u.username === S.info.user.username ? "" : `<button type="button" class="danger ghost" id="uDel">Remove this person</button>`}</div>
      </div></form>${DESIG_LIST}`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.onclick = e => { if (e.target === box) close(); };
    $("#uX").onclick = close;
    $("[name=role]", box).onchange = e => ($("#uScope").hidden = e.target.value === "admin");
    if ($("#uDel")) $("#uDel").onclick = async () => {
      if ($("#uDel").dataset.sure !== "1") { $("#uDel").dataset.sure = "1"; $("#uDel").textContent = "Click again to remove"; return; }
      try { await api(`/api/users/${encodeURIComponent(u.username)}`, { method: "DELETE" }); close(); toast("Removed."); usersTab(el); } catch (err) { $("#uErr").textContent = err.message; }
    };
    $("#uForm").onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get("name"), designation: fd.get("designation"), phone: fd.get("phone"), role: fd.get("role"), pages: fd.getAll("pages"), panels: fd.getAll("panels"), active: fd.get("active") === "on" };
      if (fd.get("password")) body.password = fd.get("password");
      if (body.role === "viewer" && !body.pages.length) { $("#uErr").textContent = "Tick at least one page."; return; }
      try {
        if (isNew) await api("/api/users", { method: "POST", body: JSON.stringify({ ...body, username: fd.get("username") }) });
        else await api(`/api/users/${encodeURIComponent(u.username)}`, { method: "PUT", body: JSON.stringify(body) });
        close(); toast(isNew ? `Added. Give ${body.name || "them"} the user ID and password.` : "Saved."); usersTab(el);
      } catch (err) { $("#uErr").textContent = err.message; }
    };
  };
  $("#uAdd").onclick = () => form(null);
  el.querySelectorAll("[data-edit]").forEach(b => (b.onclick = () => form(d.users.find(u => u.username === b.dataset.edit))));
}

// ---------------- shifts ----------------
const SHIFT_PRESETS = {
  "3 shifts of 8 h": [["A", "06:00", "14:00"], ["B", "14:00", "22:00"], ["C", "22:00", "06:00"]],
  "2 shifts of 12 h": [["Day", "08:00", "20:00"], ["Night", "20:00", "08:00"]],
  "General + 2 shifts": [["A", "06:00", "14:00"], ["General", "09:00", "18:00"], ["B", "14:00", "22:00"]],
};
async function shiftsTab(el) {
  let sh;
  try { sh = (await api("/api/shifts")).shifts; } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const draw = () => {
    el.innerHTML = `<p class="lede">Set your shifts. Reports then show energy, maximum demand, power factor, DG hours and power cuts for each shift separately. A night shift that runs past midnight belongs to the day it starts.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px"><span class="hint">Start from:</span>${Object.keys(SHIFT_PRESETS).map(k => `<button data-pre="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      <div class="table-wrap"><table class="shift-tbl"><thead><tr><th>Shift name</th><th>Starts</th><th>Ends</th><th>Hours</th><th></th></tr></thead><tbody>
      ${sh.map((x, i) => {
        const [a, b] = [x.start, x.end].map(t => { const [h, m] = (t || "0:0").split(":"); return +h * 60 + +m; });
        return `<tr data-i="${i}"><td><input data-f="name" value="${esc(x.name)}" maxlength="20"></td><td><input type="time" data-f="start" value="${esc(x.start)}"></td><td><input type="time" data-f="end" value="${esc(x.end)}"></td><td class="n">${fmtNum((((b - a) + 1440) % 1440 || 1440) / 60, 1)}</td><td><button class="ghost danger" data-del="${i}">Remove</button></td></tr>`;
      }).join("") || `<tr><td colspan="5" class="muted">No shifts yet.</td></tr>`}</tbody></table></div>
      <div class="row" style="margin-top:12px"><button id="shAdd">Add shift</button><div class="spacer"></div><span class="err" id="shErr"></span><button class="primary" id="shSave">Save shifts</button></div>`;
    const read = () => { sh = [...el.querySelectorAll("tr[data-i]")].map(tr => Object.fromEntries([...tr.querySelectorAll("[data-f]")].map(i => [i.dataset.f, i.value.trim()]))); };
    el.querySelectorAll("[data-f]").forEach(i => (i.onchange = () => { read(); draw(); }));
    el.querySelectorAll("[data-pre]").forEach(b => (b.onclick = () => { sh = SHIFT_PRESETS[b.dataset.pre].map(([name, start, end]) => ({ name, start, end })); draw(); }));
    el.querySelectorAll("[data-del]").forEach(b => (b.onclick = () => { read(); sh.splice(+b.dataset.del, 1); draw(); }));
    $("#shAdd").onclick = () => { read(); const last = sh.at(-1); sh.push({ name: String.fromCharCode(65 + sh.length), start: last ? last.end : "06:00", end: last ? last.start : "14:00" }); draw(); };
    $("#shSave").onclick = async () => {
      read();
      try { sh = (await api("/api/shifts", { method: "PUT", body: JSON.stringify({ shifts: sh }) })).shifts; toast("Shifts saved. See them in Reports, Shift-wise."); draw(); }
      catch (e) { $("#shErr").textContent = e.message; }
    };
  };
  draw();
}

async function viewSettings(preloaded) {
  const v = $("#view");
  let data = preloaded;
  if (!data) { try { data = await api("/api/settings"); } catch (e) { if (e.message !== "login") v.innerHTML = `<p class="pad err">${esc(e.message)}</p>`; return; } }
  const cfg = data.config;
  cfg.ports = cfg.ports || {}; cfg.meters = cfg.meters || []; cfg.profiles = cfg.profiles || {}; cfg.cloud_sync = cfg.cloud_sync || { url: "", api_key: "", sync_seconds: 30 };
  const plant = S.info.mode === "plant";
  const tabs = plant ? [["branding", "Branding"], ["users", "Users and access"], ["shifts", "Shifts"], ["layout", "Plant layout (panels)"], ["meters", "Machines and meters"], ["logging", "Logging and cloud"]]
    : [["branding", "Branding"], ["users", "Users and access"], ["shifts", "Shifts"]];
  const ownSave = ["branding", "users", "shifts"];
  cfg.panels = cfg.panels || [];
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
      <label class="f" data-for="rs485">Serial port (COM)<input data-k="serial_port" list="serialPortList" value="${esc(p.serial_port || "")}" placeholder="COM3 or /dev/ttyUSB0"></label>
      <label class="f" data-for="rs485">Baud rate<select data-k="baudrate">${[2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b => `<option ${+(p.baudrate || 9600) === b ? "selected" : ""}>${b}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485">Parity<select data-k="parity">${[["N", "None"], ["E", "Even"], ["O", "Odd"]].map(([k, l]) => `<option value="${k}" ${(p.parity || "N") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485">Stop bits<select data-k="stopbits">${[1, 2].map(b => `<option ${+(p.stopbits || 1) === b ? "selected" : ""}>${b}</option>`).join("")}</select></label>
      <label class="f" data-for="rs485 ethernet gateway">Timeout (s)<input data-k="timeout" type="number" step="0.1" value="${p.timeout ?? 2}"></label>
    </div></div>`;

  const meterForm = (m, i, _, prof = m.profile || (cfg.ports[m.port] && cfg.ports[m.port].kind === "simulator" ? "simulated" : "")) => `<div class="settings-item" data-meter="${i}">
    <div class="row"><span data-pic>${machinePic(liveMeter(m), 36)}</span><b>${esc(m.name || m.id || "New machine")}</b>${isDemo(m) ? `<span class="tag">Demo</span>` : ""}<div class="spacer"></div>
      <button data-test="${i}">Test reading</button><button class="danger ghost" data-del-meter="${i}">Remove</button></div>
    <div class="test-out" data-test-out hidden></div>
    <div class="form">
      <label class="f">Name<input data-k="name" value="${esc(m.name || "")}" placeholder="Induction Furnace 1"></label>
      <label class="f">Picture on diagram<input type="hidden" data-k="machine" value="${esc(m.machine || "")}"><button type="button" class="pick-btn" data-pick>${esc(m.machine && MACHINES[m.machine] ? MACHINES[m.machine].label : "Pick from the name")}</button></label>
      <label class="f">Area<input data-k="area" value="${esc(m.area || "")}" placeholder="Melt Shop"></label>
      <label class="f">Meter ID<input data-k="id" value="${esc(m.id || "")}" placeholder="eaf1"></label>
      <label class="f">Connection<select data-k="port">${Object.keys(cfg.ports).map(p => `<option ${m.port === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label class="f">Meter model<select data-k="profile">${prof ? "" : `<option value="" selected>Choose the meter model…</option>`}${profileNames().map(p => `<option value="${esc(p)}" ${prof === p ? "selected" : ""}>${esc(modelLabel(p))}</option>`).join("")}</select></label>
      <label class="f">Modbus address (slave ID)<input data-k="unit_id" type="number" min="1" max="247" value="${m.unit_id ?? 1}"></label>
      <label class="f">Contract demand kVA<input data-k="contract_kva" type="number" value="${m.contract_kva ?? ""}"></label>
      <label class="f">Panel<select data-k="panel"><option value="">Main bus</option>${cfg.panels.map(p => `<option value="${esc(p.id)}" ${m.panel === p.id ? "selected" : ""}>${esc(p.name || p.id)}</option>`).join("")}</select></label>
      <label class="f">Position on panel<select data-k="position"><option value="feeder">Outgoing feeder (below the bus)</option><option value="incomer" ${(m.position || (m.is_main ? "incomer" : "")) === "incomer" ? "selected" : ""}>Incomer (above the bus)</option></select></label>
      <label class="f">Plant total<select data-k="is_main"><option value="false">Not counted (avoids double counting)</option><option value="true" ${m.is_main ? "selected" : ""}>Counted (main grid incomer or DG)</option></select></label>
      <label class="f">Incomer fed from<select data-k="fed_from"><option value="">Grid / not set</option>${cfg.panels.map(p => `<option value="${esc(p.id)}" ${m.fed_from === p.id ? "selected" : ""}>${esc(p.name || p.id)} bus</option>`).join("")}${cfg.meters.filter(x => x.id && x.id !== m.id).map(x => `<option value="${esc(x.id)}" ${m.fed_from === x.id ? "selected" : ""}>${esc(x.name || x.id)}</option>`).join("")}</select></label>
      <label class="f">Feeder supplies panel<select data-k="feeds"><option value="">None (a machine)</option>${cfg.panels.map(p => `<option value="${esc(p.id)}" ${m.feeds === p.id ? "selected" : ""}>${esc(p.name || p.id)}</option>`).join("")}</select></label>
      <label class="f">Logging<select data-k="enabled"><option value="true" ${m.enabled !== false ? "selected" : ""}>On</option><option value="false" ${m.enabled === false ? "selected" : ""}>Off</option></select></label>
    </div>
    <details style="margin-top:10px"><summary>Alarm limits</summary><div class="form" style="margin-top:8px">
      ${[["pf_min", "PF below"], ["kva_max", "kVA above"], ["kw_max", "kW above"], ["v_ln_min", "Voltage L-N below"], ["v_ln_max", "Voltage L-N above"], ["i_max", "Current above (A)"], ["thd_v_max", "Voltage THD above (%)"]]
        .map(([k, l]) => `<label class="f">${l}<input data-a="${k}" type="number" step="any" value="${(m.alarms || {})[k] ?? ""}"></label>`).join("")}
    </div></details></div>`;

  const isDemo = m => (cfg.ports[m.port] && cfg.ports[m.port].kind === "simulator") || (m.enabled === false && /_example$/.test(m.id || ""));
  const demoCount = cfg.meters.filter(isDemo).length;
  const metersTab = () => `<p class="lede">Each machine is one meter. Machines appear on the plant diagram in this order.</p>
    ${demoCount ? `<div class="panel demo-box"><b>${demoCount} demo machine${demoCount > 1 ? "s" : ""} with simulated meters</b>
      <p class="hint">Before connecting your real meters, remove the demo machines so plant totals, reports and Insights show only real data.
      Their made-up history goes too. Your panels, branding, users and shifts stay.</p>
      <div class="row"><button class="danger" id="sRemoveDemo">Remove demo machines</button><span class="err" id="sDemoErr"></span></div></div>` : ""}
    <div id="sMeters">${cfg.meters.map(meterForm).join("")}</div>
    <button id="sAddMeter">Add machine</button>
    <h2>Connections</h2><p class="hint">One entry per RS485 port, Ethernet meter or gateway. Several meters can share one RS485 line or gateway, each with its own Modbus address.</p>
    <div class="row" style="margin-bottom:10px"><span class="hint" id="sPortsFound">Looking for serial ports on this PC…</span><button class="ghost" id="sFindPorts">Look again</button></div>
    <datalist id="serialPortList"></datalist>
    <div id="sPorts">${Object.entries(cfg.ports).map(([n, p]) => portForm(n, p)).join("")}</div>
    <div class="row"><input id="sNewPort" placeholder="New connection name, e.g. rs485_com4"><button id="sAddPort">Add connection</button></div>
    <h2>Meter models</h2>
    <details><summary>Built-in models and where each register map came from</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Model</th><th>Source</th><th>Notes</th></tr></thead><tbody>
      ${Object.entries(data.library_profiles).filter(([, d]) => d.brand).map(([n, d]) => `<tr><td style="white-space:normal">${esc(modelLabel(n))}</td><td style="white-space:normal">${esc(d.source || "")}</td><td style="white-space:normal">${esc(d.notes || "")}</td></tr>`).join("")}
    </tbody></table></div></details>
    <p class="hint">To add another model, paste its register map from the meter's Modbus manual as JSON. Example: {"my_meter": {"register_type": "holding", "word_order": "big", "registers": {"kw": {"address": 3060, "type": "float32"}}}}</p>
    <textarea id="sProfiles" rows="6">${esc(JSON.stringify(cfg.profiles, null, 2))}</textarea>`;

  const layoutTab = () => `<p class="lede">The panels of your single-line diagram, top to bottom: for example the HT panel, the DG panel, then each PCC. Then, under Machines and meters, put each meter on its panel as an incomer or a feeder.</p>
    <div id="sPanels">${cfg.panels.map((p, i) => `<div class="settings-item" data-panel="${i}"><div class="row"><b>${esc(p.name || p.id || "New panel")}</b><div class="spacer"></div>
      <button class="ghost" data-up="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button class="ghost" data-down="${i}" ${i < cfg.panels.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button><button class="danger ghost" data-del-panel="${i}">Remove</button></div>
      <div class="form"><label class="f">Panel ID<input data-p="id" value="${esc(p.id || "")}" placeholder="pcc_ccl"></label><label class="f">Name<input data-p="name" value="${esc(p.name || "")}" placeholder="CCL line PCC"></label>
      <label class="f">Voltage<input data-p="voltage" value="${esc(p.voltage || "")}" placeholder="433 V"></label><label class="f" style="grid-column:span 2">Note<input data-p="note" value="${esc(p.note || "")}"></label></div></div>`).join("")}</div>
    <button id="sAddPanel">Add panel</button>`;

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
    <div id="tabBody">${tab === "branding" ? brandingTab(cfg) : tab === "users" || tab === "shifts" ? `<p class="muted">Loading…</p>` : tab === "meters" ? metersTab() : tab === "layout" ? layoutTab() : loggingTab()}</div>
    ${!ownSave.includes(tab) ? `<div class="row" style="margin:20px 0 40px"><button class="primary" id="sSave">Save and restart logging</button><span class="err" id="sErr"></span></div>` : ""}`;

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
    m.id = (m.id || "").trim() || (m.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
    m.unit_id = +m.unit_id || 1; m.enabled = m.enabled === "true"; m.is_main = m.is_main === "true"; m.contract_kva = m.contract_kva === "" ? null : +m.contract_kva;
    el.querySelectorAll("[data-a]").forEach(i => { if (i.value !== "") m.alarms[i.dataset.a] = +i.value; });
    return m;
  };
  const readProfiles = () => { if (!$("#sProfiles")) return cfg.profiles; const t = $("#sProfiles").value.trim(); return t ? JSON.parse(t) : {}; };
  const collect = () => {
    const out = { ...cfg, ports: readPorts(), profiles: readProfiles() };
    if ($("#sMeters")) out.meters = [...v.querySelectorAll("[data-meter]")].map(readMeter);
    if ($("#sPanels")) out.panels = [...v.querySelectorAll("[data-panel]")].map(el => Object.fromEntries([...el.querySelectorAll("[data-p]")].map(i => [i.dataset.p, i.value.trim()])));
    if ($("#sPoll")) Object.assign(out, { plant_id: $("#sPlantId").value, poll_seconds: +$("#sPoll").value, log_seconds: +$("#sLog").value, demand_block_minutes: +$("#sBlock").value,
      cloud_sync: { url: $("#sCloudUrl").value.trim(), api_key: $("#sCloudKey").value.trim(), sync_seconds: +$("#sCloudEvery").value } });
    return out;
  };
  const keep = () => { try { Object.assign(cfg, collect()); return true; } catch (e) { toast("Meter models JSON: " + e.message); return false; } };
  const redraw = () => { data.config = cfg; viewSettings(data); };

  v.querySelectorAll("[data-tab]").forEach(b => (b.onclick = () => { if (!ownSave.includes(tab) && !keep()) return; S.settingsTab = b.dataset.tab; redraw(); }));
  if (tab === "branding") return wireBranding();
  if (tab === "users") return usersTab($("#tabBody"));
  if (tab === "shifts") return shiftsTab($("#tabBody"));
  if (tab === "layout") {
    $("#sAddPanel").onclick = () => { if (!keep()) return; cfg.panels.push({ id: "panel" + (cfg.panels.length + 1), name: "", voltage: "", note: "" }); redraw(); };
    const mv = (i, d) => { if (!keep()) return; const [x] = cfg.panels.splice(i, 1); cfg.panels.splice(i + d, 0, x); redraw(); };
    v.querySelectorAll("[data-up]").forEach(b => (b.onclick = () => mv(+b.dataset.up, -1)));
    v.querySelectorAll("[data-down]").forEach(b => (b.onclick = () => mv(+b.dataset.down, 1)));
    v.querySelectorAll("[data-del-panel]").forEach(b => (b.onclick = () => { if (!keep()) return; cfg.panels.splice(+b.dataset.delPanel, 1); redraw(); }));
  }

  if (tab === "meters") {
    const showFor = el => { const kind = $("[data-k=kind]", el).value; el.querySelectorAll("[data-for]").forEach(f => (f.hidden = !f.dataset.for.split(" ").includes(kind))); };
    v.querySelectorAll("[data-port]").forEach(el => { showFor(el); $("[data-k=kind]", el).onchange = () => showFor(el); });
    v.querySelectorAll("[data-meter]").forEach(el => {
      const upd = () => {
        const m = readMeter(el);
        $("[data-pic]", el).innerHTML = machinePic(liveMeter(m), 36);
        $("[data-pick]", el).textContent = (m.machine && MACHINES[m.machine] ? MACHINES[m.machine].label : "Pick from the name");
      };
      $("[data-k=name]", el).oninput = upd;
      $("[data-pick]", el).onclick = () => {
        const m = readMeter(el), saved = S.meters.find(x => x.id === m.id && x.id);
        pickMachine({ current: m.machine, name: m.name, title: `Picture for ${m.name || "this machine"}`,
          meter: saved ? { ...saved, name: m.name || saved.name } : null,
          onPick: key => { $("[data-k=machine]", el).value = key; if (saved) saved.picture_url = null; upd(); },
          onUpload: url => { if (saved) saved.picture_url = url; upd(); } });
      };
    });
    $("#sAddPort").onclick = () => { const n = $("#sNewPort").value.trim().replace(/\s+/g, "_"); if (!n) return toast("Type a name for the connection first."); if (!keep()) return; cfg.ports[n] = { kind: "rs485", serial_port: (S.serialPorts || []).find(x => x.usb)?.device || "", baudrate: 9600, parity: "N", stopbits: 1, timeout: 1 }; redraw(); };
    v.querySelectorAll("[data-del-port]").forEach(b => (b.onclick = () => { if (!keep()) return; delete cfg.ports[b.dataset.delPort]; redraw(); }));
    $("#sAddMeter").onclick = () => { if (!keep()) return; if (!Object.keys(cfg.ports).length) return toast("Add a connection first, under Connections below."); cfg.meters.push({ id: "", name: "", area: "", port: Object.keys(cfg.ports).find(n => cfg.ports[n].kind !== "simulator") || Object.keys(cfg.ports)[0], profile: "", unit_id: 1, enabled: true, alarms: {} }); redraw(); };
    v.querySelectorAll("[data-del-meter]").forEach(b => (b.onclick = () => { if (!keep()) return; cfg.meters.splice(+b.dataset.delMeter, 1); redraw(); }));
    const findPorts = async () => {
      const el = $("#sPortsFound");
      if (!el) return;
      try {
        S.serialPorts = (await api("/api/settings/serial-ports")).ports;
        $("#serialPortList").innerHTML = S.serialPorts.map(x => `<option value="${esc(x.device)}">${esc(x.description || x.device)}</option>`).join("");
        el.textContent = S.serialPorts.length ? "Serial ports on this PC: " + S.serialPorts.map(x => x.device + (x.description && x.description !== x.device ? ` (${x.description})` : "")).join(", ")
          : "No serial ports found on this PC. Plug in the USB-RS485 converter (install its driver if Windows asks), then press Look again.";
      } catch (e) { el.textContent = e.message; }
    };
    findPorts();
    $("#sFindPorts").onclick = findPorts;
    if ($("#sRemoveDemo")) $("#sRemoveDemo").onclick = async () => {
      const b = $("#sRemoveDemo");
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = `Press again to remove ${demoCount} demo machine${demoCount > 1 ? "s" : ""}`; return; }
      b.disabled = true;
      try {
        await api("/api/settings/remove-demo", { method: "POST", body: "{}" });
        toast("Demo machines removed. Now add your real meter with Add machine.");
        refreshInfo();
        data = await api("/api/settings"); S.settingsTab = "meters"; viewSettings(data);
      } catch (e) { b.disabled = false; $("#sDemoErr").textContent = e.message; }
    };
    const PL = S.info.params || {};
    v.querySelectorAll("[data-test]").forEach(b => (b.onclick = async () => {
      const el = b.closest("[data-meter]"), out = $("[data-test-out]", el);
      out.hidden = false; out.className = "test-out"; out.textContent = "Reading the meter…";
      try {
        const r = await api("/api/settings/test-meter", { method: "POST", body: JSON.stringify({ meter: { ...readMeter(el), enabled: true }, ports: readPorts(), profiles: readProfiles() }) });
        if (!r.ok) { out.className = "test-out bad"; out.innerHTML = `<b>Not working.</b> ${esc(r.error)}`; return; }
        const x = r.values, f = (k, d, u) => (x[k] != null ? `<span><small>${esc((PL[k] || {}).label || k)}</small>${fmtNum(x[k], d)} ${u}</span>` : "");
        out.className = "test-out " + (r.hint ? "warn" : "ok");
        out.innerHTML = `<b>${r.hint ? "The meter answered, but check this." : "Working. Compare these numbers with the meter's own display."}</b>
          <div class="test-vals">${f("v_ln", 1, "V")}${x.v_ln == null ? f("v_ll", 1, "V") : ""}${f("i_avg", 1, "A")}${f("kw", 2, "kW")}${f("kva", 2, "kVA")}${f("pf", 3, "")}${f("hz", 2, "Hz")}${f("kwh", 1, "kWh")}${f("kvah", 1, "kVAh")}</div>
          ${r.hint ? `<p>${esc(r.hint)}</p>` : ""}
          ${r.skipped && r.skipped.length ? `<p class="hint">Not available on this meter: ${r.skipped.map(k => esc((PL[k] || {}).label || k)).join(", ")}. The rest is logged normally.</p>` : ""}
          ${r.fix ? `<button class="primary" data-fix>Use this word order</button>` : ""}`;
        if (r.fix) $("[data-fix]", out).onclick = () => {
          if (!keep()) return;
          const base = cfg.profiles[r.fix.profile] || data.library_profiles[r.fix.profile] || {};
          cfg.profiles[r.fix.profile] = { ...base, word_order: r.fix.word_order };
          redraw();
          toast("Word order changed for this meter model. Press Save and restart logging.");
        };
      } catch (e) { out.className = "test-out bad"; out.textContent = e.message; }
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
