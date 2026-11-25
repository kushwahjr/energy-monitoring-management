"use strict";
// Plant single-line diagram, drawn panel by panel (HT panel, DG panel, PCCs ...), with live power flow:
// current runs along the cables as glowing pulses (more and faster when the load is higher),
// breakers open and close, a bus with no supply goes dark, and DG sets crank, idle and run.
// Grid power and DG power have their own colours so you can see at a glance what runs on DG.

(function () {
  const fmt = v => (v == null || isNaN(v) ? "–" : fmtNum(v, Math.abs(v) >= 100 ? 0 : 1));
  const pfTxt = v => (v.pf != null ? fmtNum(Math.abs(v.pf), 2) : "–");
  const r1 = n => Math.round(n * 10) / 10;
  const pathOf = pts => "M" + pts.map(p => `${r1(p[0])} ${r1(p[1])}`).join("L");
  const lenOf = pts => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  window.fmtDur = s => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
  };

  // ---------- what each meter says about its circuit ----------
  function elec(m) {
    const v = m.values || {};
    const live = !!m.online && ((v.v_ln || 0) > 50 || (v.v_ll || 0) > 90);
    const kva = Math.abs(v.kva != null ? v.kva : v.kw || 0);
    const rated = m.contract_kva || null;
    const load = rated ? Math.min(1.2, kva / rated) : Math.min(1, kva / 1500);
    let dg = null;
    if (m.is_dg) {
      const hz = v.hz || 0;
      dg = !m.online ? "nodata" : !live && hz < 1 ? "off" : hz < 47 || (v.v_ln || 240) < 200 ? "cranking" : rated && kva / rated < 0.05 ? "idle" : "loaded";
    }
    const flowing = m.is_dg ? dg === "loaded" : live && kva > 1;
    return { live, kva, load, flowing, dg, nodata: !m.online, alarm: !!(m.online && m.alarms && m.alarms.length) };
  }

  // ---------- panels, incomers, feeders and the links between panels ----------
  function topo(meters, panels) {
    const byId = Object.fromEntries(meters.map(m => [m.id, m]));
    const seen = [];
    for (const m of meters) if (!seen.includes(m.panel || "")) seen.push(m.panel || "");
    const order = [...panels.map(p => p.id).filter(id => seen.includes(id)), ...seen.filter(id => !panels.some(p => p.id === id))];
    const P = {};
    for (const id of order) {
      const p = panels.find(x => x.id === id);
      P[id] = { id, name: p ? p.name : id || (order.length > 1 ? "Other meters" : "Main bus"), voltage: p ? p.voltage : "", note: p ? p.note : "", inc: [], fdr: [] };
    }
    for (const m of meters) {
      const isInc = m.position ? m.position === "incomer" : m.is_main;
      P[m.panel || ""][isInc ? "inc" : "fdr"].push({ m });
    }
    const dgIds = new Set(meters.filter(m => m.is_dg).map(m => m.id));
    const dgPanels = new Set(meters.filter(m => m.is_dg && m.panel).map(m => m.panel));
    const dgSourced = m => m.is_dg || dgPanels.has(m.fed_from) || dgIds.has(m.fed_from);
    // an incomer fed straight from another panel's bus, with no meter on that panel's outgoing feeder:
    // draw it on the source panel too, as an outgoing feeder, so the link is visible from both ends
    for (const q of Object.values(P)) {
      for (const x of q.inc) {
        const f = x.m.fed_from;
        if (f && P[f] && f !== q.id && !P[f].fdr.some(y => y.m.feeds === q.id)) P[f].fdr.push({ m: x.m, ghost: true, to: q.id });
      }
    }
    const from = m => {
      const f = m.fed_from;
      if (f && byId[f]) return byId[f].name + (byId[f].panel && byId[f].panel !== m.panel && P[byId[f].panel] ? `, ${P[byId[f].panel].name}` : "");
      if (f && P[f]) return P[f].name;
      const pn = panels.find(x => x.id === f);
      if (pn) return pn.name;
      if (f) return "";  // a meter this person can't see
      if (m.is_dg) return "";
      return f || (m.is_main ? "Grid supply" : "");
    };
    return { P, order, byId, dgSourced, dgPanels, from };
  }

  // ---------- live state of every bus and branch ----------
  function compute(T) {
    const E = {};
    for (const m of Object.values(T.byId)) E[m.id] = elec(m);
    const out = { E, panel: {}, inc: {} };
    for (const id of T.order) {
      const p = T.P[id];
      const isDgPanel = T.dgPanels.has(id);
      let live = false, src = isDgPanel ? "dg" : "grid";
      for (const x of p.inc) {
        const e = E[x.m.id];
        const closed = e.flowing || (e.live && !x.m.is_dg && p.inc.length === 1);
        out.inc[x.m.id] = closed;
        if (closed && e.live) { live = true; if (T.dgSourced(x.m)) src = "dg"; }
      }
      if (!p.inc.length) live = p.fdr.some(x => E[x.m.id].live);
      const busy = live && (p.inc.some(x => E[x.m.id].flowing) || p.fdr.some(x => E[x.m.id].flowing));
      const dgs = p.inc.filter(x => x.m.is_dg).map(x => E[x.m.id].dg);
      out.panel[id] = { live, src, st: !live ? "dead" : busy ? "flow" : "idle", dgs };
    }
    return out;
  }

  function segState(e, nodata) {
    if (nodata) return "nodata";
    return e.flowing ? "flow" : e.live ? "idle" : "dead";
  }

  function particles(d, len, load) {
    const l = Math.max(0.08, Math.min(1, load));
    const n = Math.max(1, Math.min(8, Math.round((len / 55) * (0.35 + l))));
    const dur = Math.max(0.5, len / (35 + 190 * l));
    let s = "";
    for (let i = 0; i < n; i++) {
      s += `<g class="pt"><ellipse class="pt-tail" cx="-7" rx="10" ry="2.8"/><circle class="pt-core" r="2.3"/>` +
        `<animateMotion dur="${dur.toFixed(2)}s" begin="${(-(i * dur) / n).toFixed(2)}s" repeatCount="indefinite" rotate="auto" path="${d}"/></g>`;
    }
    return s;
  }

  const breaker = (k, x, y, horiz) => `<g class="brk" data-brk="${k}" transform="translate(${r1(x)} ${r1(y)})${horiz ? " rotate(-90)" : ""}">
    <circle class="tm" cy="-10" r="2.6"/><circle class="tm" cy="10" r="2.6"/><path class="blade" d="M0 10V-10"/>
    <g class="arc"><path d="M0 -14l-4 -6M0 -14l5 -5M0 -14l0 -8M-3 -12l-7 1M3 -12l7 2"/></g></g>`;

  function wireSvg(w) {
    return `<g class="w" data-w="${w.k}">${w.segs.map((s, i) => `<g class="sg" data-s="${i}"><path class="c0" d="${s}"/><path class="c1" d="${s}"/></g>`).join("")}
      <g class="pts"></g></g>`;
  }

  // ---------- one panel's drawing ----------
  function layout(T, p, w, phone) {
    const L = { wires: [], cards: [], bus: null, h: 0, svg: "" };
    const nInc = p.inc.length, nF = p.fdr.length;
    let s = "";
    if (!phone) {
      let busY = 22;
      if (nInc) {
        busY = 172;
        const cw = w / nInc;
        p.inc.forEach((x, i) => {
          const cx = cw * (i + 0.5) - Math.max(0, Math.min(cw / 2 - 34, 116));
          const pts = [[cx, 2], [cx, busY - 5]];
          const k = "i:" + x.m.id;
          L.wires.push({ k, x, inc: true, d: pathOf(pts), len: lenOf(pts), segs: [pathOf([[cx, 2], [cx, busY - 48]]), pathOf([[cx, busY - 28], [cx, busY - 5]])] });
          s += wireSvg(L.wires.at(-1)) + breaker(k, cx, busY - 38);
          const fw = Math.min(cw - (cx - cw * i) - 14, 300);
          L.cards.push({ k, x, inc: true });
          s += `<foreignObject x="${r1(cx + 14)}" y="6" width="${r1(fw)}" height="${busY - 52}" data-c="${k}"><a class="node inc-node"></a></foreignObject>`;
        });
      }
      const cols = Math.max(1, Math.min(nF || 1, Math.floor(w / 158)));
      const colW = w / cols, rowH = 222, rows = Math.ceil(nF / cols);
      let busD = `M10 ${busY}H${w - 10}`;
      for (let r = 1; r < rows; r++) {
        const y0 = busY + r * rowH, last = Math.min(cols, nF - r * cols);
        busD += `M10 ${busY + (r - 1) * rowH}V${y0}H${r1(colW * (last - 0.5) + 10)}`;
      }
      L.bus = busD;
      s = `<g class="bus" data-bus="${esc(p.id)}"><path class="b0" d="${busD}"/><path class="b1" d="${busD}"/><path class="b2" d="${busD}"/></g>
        <text class="bus-lbl" x="${w - 14}" y="${busY - 10}" text-anchor="end">${esc(p.voltage || "")}</text>
        <text class="bus-dead" x="${w / 2}" y="${busY + 4}" text-anchor="middle">NO SUPPLY</text>` + s;
      p.fdr.forEach((x, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const cx = colW * (c + 0.5), y0 = busY + r * rowH;
        const pts = [[cx, y0 + 4], [cx, y0 + 52]];
        const k = (x.ghost ? "g:" : "f:") + x.m.id;
        L.wires.push({ k, x, d: pathOf(pts), len: lenOf(pts), segs: [pathOf([[cx, y0 + 4], [cx, y0 + 16]]), pathOf([[cx, y0 + 36], [cx, y0 + 52]])] });
        s += wireSvg(L.wires.at(-1)) + breaker(k, cx, y0 + 26);
        L.cards.push({ k, x });
        s += `<foreignObject x="${r1(cx - colW / 2 + 6)}" y="${y0 + 52}" width="${r1(colW - 12)}" height="${rowH - 58}" data-c="${k}"><a class="node"></a></foreignObject>`;
      });
      L.h = busY + Math.max(1, rows) * rowH - (nF ? 2 : 150);
      if (!nF) L.h = busY + 16;
    } else {
      // phone: the bus runs down the left; incomers come in from the right, feeders go out to the right
      const bx = 18, rowH = 106, all = [...p.inc.map(x => ({ ...x, inc: true })), ...p.fdr];
      all.forEach((x, i) => {
        const y = i * rowH + 6, yc = y + 40;
        const k = (x.inc ? "i:" : x.ghost ? "g:" : "f:") + x.m.id;
        const a = [bx + 58, yc], b = [bx + 4, yc];
        const pts = x.inc ? [a, b] : [b, a];
        L.wires.push({ k, x, inc: !!x.inc, d: pathOf(pts), len: lenOf(pts), segs: x.inc ? [pathOf([a, [bx + 41, yc]]), pathOf([[bx + 21, yc], b])] : [pathOf([b, [bx + 21, yc]]), pathOf([[bx + 41, yc], a])] });
        s += wireSvg(L.wires.at(-1)) + breaker(k, bx + 31, yc, true);
        L.cards.push({ k, x, inc: !!x.inc });
        s += `<foreignObject x="${bx + 58}" y="${y}" width="${w - bx - 60}" height="${rowH - 8}" data-c="${k}"><a class="node row-node${x.inc ? " inc-node" : ""}"></a></foreignObject>`;
      });
      const h = Math.max(1, all.length) * rowH;
      L.bus = `M${bx} 8V${h - 12}`;
      s = `<g class="bus" data-bus="${esc(p.id)}"><path class="b0" d="${L.bus}"/><path class="b1" d="${L.bus}"/><path class="b2" d="${L.bus}"/></g>` + s;
      L.h = h;
    }
    L.svg = `<svg class="sld" viewBox="0 0 ${r1(w)} ${r1(L.h)}" width="100%" height="${r1(L.h)}" role="img" aria-label="${esc(p.name)} single-line diagram">${s}</svg>`;
    return L;
  }

  // ---------- the DG set picture: engine, cooling fan, alternator and exhaust ----------
  window.dgArt = (size = 56) => `<svg class="dgart" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
    <g class="dg-body"><rect x="4" y="27" width="38" height="25" rx="3"/><rect x="42" y="31" width="16" height="17" rx="3"/><path d="M47 31v17M53 31v17"/>
    <path d="M30 27V9h6v18"/><path d="M2 56h60M8 52v4M54 52v4"/>
    <g class="rotor"><circle cx="17" cy="39.5" r="8"/><path d="M17 31.5v16M9 39.5h16M11.3 33.8l11.4 11.4M22.7 33.8 11.3 45.2"/></g></g>
    <circle class="puff p1" cx="33" cy="6" r="3"/><circle class="puff p2" cx="33" cy="6" r="3"/><circle class="puff p3" cx="33" cy="6" r="3"/>
  </svg>`;

  // ---------- the cards ----------
  function cardHtml(T, C, c) {
    const m = c.x.m, e = C.E[m.id], v = m.values || {}, t = (T.today || {})[m.id];
    const flag = e.alarm ? `<i class="flag" title="${esc(m.alarms.join("; "))}">!</i>` : "";
    const kw = e.nodata ? "–" : fmt(v.kw);
    if (c.x.ghost || (c.x.m.feeds && !c.inc)) {
      const to = c.x.ghost ? T.P[c.x.to] : T.P[m.feeds];
      if (c.x.ghost) {
        const pill = `<span class="pill p-${segState(e, e.nodata)} src-dg">${e.flowing ? "Supplying" : e.live ? "Breaker open" : "Off"}</span>`;
        if (T.phone) return `<div class="pic">${machineIcon("pcc_panel", 40)}</div><div><b class="nm">To ${esc(to ? to.name : "")}</b><span class="sub">via ${esc(m.name)}</span>${pill}</div><span class="big">${e.flowing ? kw : "0"}<small>kW</small></span>`;
        return `<div class="pic">${machineIcon("pcc_panel", 52)}</div><b class="nm">To ${esc(to ? to.name : "")}</b>
          <span class="big">${e.flowing ? kw : "0"}<small>kW</small></span><span class="sub">via ${esc(m.name)}</span>${pill}`;
      }
    }
    if (m.is_dg) {
      const st = e.dg, since = m.running_since;
      const txt = { off: "Stopped", cranking: "Cranking…", idle: "Running, no load", loaded: "On load", nodata: "No data" }[st];
      const pct = e.kva && m.contract_kva ? (e.kva / m.contract_kva) * 100 : null;
      return `<div class="pic dg-pic dg-${st}">${dgArt(T.phone ? 44 : 58)}${flag}</div><div class="dg-txt"><b class="nm">${esc(m.name)}</b>
        <span class="big">${st === "loaded" ? kw : st === "off" ? "Off" : fmtNum(v.hz || 0, 1)}<small>${st === "loaded" ? "kW" : st === "off" ? "" : "Hz"}</small></span>
        <span class="sub">${st === "off" || st === "nodata" ? `${m.contract_kva ? fmtNum(m.contract_kva, 0) + " kVA set" : "Standby"}` : `${fmt(v.v_ll)} V · ${fmtNum(v.hz || 0, 1)} Hz${pct != null && st === "loaded" ? ` · ${fmtNum(pct, 0)}% load` : ""}`}</span>
        <span class="pill p-${st === "loaded" ? "flow" : st === "off" ? "dead" : st === "nodata" ? "nodata" : "idle"} src-dg">${txt}${since && st !== "off" ? ` <span class="tmr" data-since="${since}"></span>` : ""}</span></div>`;
    }
    const pic = m.picture_url || m.machine ? machinePic(m, T.phone ? 40 : c.inc ? 50 : 56) : machineIcon(c.inc ? (m.fed_from ? "pcc_panel" : "grid") : guessMachine(m), T.phone ? 40 : c.inc ? 50 : 56);
    const closed = c.inc ? C.inc[m.id] : e.live;
    const pill = e.nodata ? ["nodata", m.error ? "No data" : "No data"] : !e.live ? ["dead", c.inc ? "No supply" : "No power"] :
      c.inc && !closed ? ["idle", "Breaker open, supply ready"] : e.flowing ? ["flow", c.inc ? "On load" : "Running"] : ["idle", c.inc ? "No load" : "Idle"];
    const pct = m.contract_kva && v.kva != null ? Math.min(1, v.kva / m.contract_kva) : null;
    const src = (c.inc && T.dgSourced(m)) || (!c.inc && C.panel[m.panel || ""] && C.panel[m.panel || ""].src === "dg") ? "dg" : "grid";
    if (c.inc) {
      const from = T.from(m);
      return `<div class="pic">${pic}${flag}</div><div class="inc-txt"><b class="nm">${esc(m.name)}</b>${from ? `<span class="from">from ${esc(from)}</span>` : ""}
        <span class="big">${kw}<small>kW</small></span><span class="sub">${e.nodata ? esc(m.error || "No data") : `${fmt(v.kva)} kVA · PF ${pfTxt(v)}`}</span>
        <span class="pill p-${pill[0]} src-${src}">${pill[1]}</span></div>`;
    }
    const to = m.feeds && T.P[m.feeds] ? `<span class="to" data-goto="${esc(m.feeds)}">to ${esc(T.P[m.feeds].name)} ↓</span>` : "";
    if (T.phone) {
      return `<div class="pic">${pic}${flag}</div><div><b class="nm">${esc(m.name)}</b>${to}<span class="sub">${e.nodata ? esc(m.error || "No data") : `PF ${pfTxt(v)} · ${t ? fmtNum(t.kwh, 0) : "–"} kWh today`}</span>
        <span class="pill p-${pill[0]} src-${src}">${pill[1]}</span></div><span class="big">${e.nodata ? "–" : kw}<small>${e.nodata ? "" : "kW"}</small></span>`;
    }
    return `<div class="pic">${pic}${flag}</div><b class="nm">${esc(m.name)}</b>${to}
      <span class="big">${e.nodata ? "–" : kw}<small>${e.nodata ? "" : "kW"}</small></span>
      <span class="sub">${e.nodata ? esc(m.error || "No data") : `PF ${pfTxt(v)} · ${t ? fmtNum(t.kwh, 0) : "–"} kWh today`}</span>
      ${pct != null ? `<span class="ld" title="${fmtNum(pct * 100, 0)}% of ${m.contract_kva} kVA"><i style="width:${pct * 100}%"></i></span>` : ""}
      <span class="pill p-${pill[0]} src-${src}">${pill[1]}</span>`;
  }

  function headHtml(T, C, p) {
    const ps = C.panel[p.id];
    const dgPanel = T.dgPanels.has(p.id);
    const starting = ps.dgs.some(d => d === "cranking" || d === "idle");
    const src = !ps.live ? (dgPanel ? (starting ? ["dg", "DG sets starting"] : ["dead", "Standby, DG sets off"]) : ["dead", "No supply"]) : ps.src === "dg" ? ["dg", dgPanel ? "DG sets running" : "On DG supply"] : ["grid", "On grid supply"];
    let sync = "";
    if (dgPanel && ps.dgs.some(d => d === "cranking" || d === "idle" || d === "loaded")) {
      const locked = ps.dgs.includes("loaded");
      sync = `<span class="sync ${locked ? "locked" : ""}" title="Synchroscope"><svg viewBox="0 0 32 32" width="26" height="26"><circle cx="16" cy="16" r="13"/><path d="M16 3v4"/><g class="needle"><path d="M16 16V5"/></g><circle cx="16" cy="16" r="2"/></svg>${locked ? "In sync, breakers closed" : "Synchronising"}</span>`;
    }
    return `<div><h3>${esc(p.name)}${p.voltage ? ` <small>${esc(p.voltage)}</small>` : ""}</h3>${p.note ? `<p class="pnote">${esc(p.note)}</p>` : ""}</div>
      <div class="spacer"></div>${sync}<span class="src-badge sb-${src[0]}"><i></i>${src[1]}</span>`;
  }

  function apply(el, T, C) {
    const st = el._plant;
    for (const w of st.wires) {
      const g = w.g, m = T.byId[w.x.m.id] || w.x.m, e = C.E[m.id];
      const ps = C.panel[w.panelId];
      const src = w.inc ? (T.dgSourced(m) ? "dg" : "grid") : w.x.ghost ? "dg" : ps.src;
      let s0, s1, closed;
      if (w.inc) {
        closed = C.inc[m.id];
        s0 = segState(e, e.nodata);                       // source side of the breaker
        s1 = e.nodata ? "nodata" : closed && e.flowing ? "flow" : ps.live ? "idle" : "dead";
      } else {
        closed = w.x.ghost ? C.inc[m.id] : !e.nodata;
        s0 = ps.live ? (e.flowing && closed ? "flow" : "idle") : "dead";
        s1 = e.nodata ? "nodata" : closed ? segState(e, false) : "dead";
        if (w.x.ghost && !closed) s1 = "dead";
      }
      const flow = closed && e.flowing && !e.nodata;
      g.setAttribute("class", `w src-${src}${e.alarm ? " alarm" : ""}`);
      w.segEls[0].setAttribute("class", `sg st-${s0}`);
      w.segEls[1].setAttribute("class", `sg st-${s1}`);
      const bucket = flow ? Math.min(10, Math.round(e.load * 10)) : -1;
      if (bucket !== w.bucket) { w.pts.innerHTML = flow ? particles(w.d, w.len, e.load) : ""; w.bucket = bucket; }
      if (w.closed !== undefined && w.closed !== closed) {
        w.brk.classList.add("sparking");
        setTimeout(() => w.brk.classList.remove("sparking"), 700);
      }
      w.closed = closed;
      w.brk.classList.toggle("open", !closed);
      w.brk.setAttribute("data-st", s0);
    }
    for (const c of st.cards) {
      // the picture and the numbers update separately, so running animations (DG fan, exhaust) don't restart
      const fresh = { ...c, x: { ...c.x, m: T.byId[c.x.m.id] || c.x.m } };  // the layout is kept, the readings are new
      const html = cardHtml(T, C, fresh), cut = html.indexOf("</div>") + 6;
      const pic = html.slice(0, cut), txt = html.slice(cut);
      if (!c.ps) { c.a.innerHTML = `<span class="slot"></span><span class="slot"></span>`; [c.ps, c.ts] = c.a.children; }
      if (pic !== c.pic) { c.ps.innerHTML = pic; c.pic = pic; }
      if (txt !== c.txt) { c.ts.innerHTML = txt; c.txt = txt; c.ts.querySelectorAll(".tmr[data-since]").forEach(t => (t.textContent = fmtDur(Date.now() / 1000 - +t.dataset.since))); }
      const e = C.E[c.x.m.id];
      c.a.className = `node ${c.a.classList.contains("row-node") ? "row-node " : ""}${c.inc ? "inc-node " : ""}${c.x.ghost ? "ghost " : ""}node-${e.nodata ? "off" : e.alarm ? "alarm" : "on"}${!e.live && !e.nodata ? " dead" : ""}`;
    }
    for (const p of st.panels) {
      const ps = C.panel[p.id];
      p.bus.setAttribute("class", `bus st-${ps.st} src-${ps.src}`);
      p.sec.className = `pnl pnl-${ps.st} src-${ps.src}`;
      const h = headHtml(T, C, T.P[p.id]);
      if (h !== p.headHtml) { p.head.innerHTML = h; p.headHtml = h; }
    }
  }

  // el: container; meters: /api/meters list; today: {meter_id: daily row}; panels: [{id,name,voltage,note}]
  window.drawPlant = function (el, meters, today, panels = []) {
    meters = meters.filter(m => m.enabled);
    const W = Math.max(300, el.clientWidth || 900);
    const phone = W < 640;
    const T = topo(meters, panels);
    T.today = today;
    T.phone = phone;
    const sig = [W, phone, panels.map(p => p.id + p.name).join(","), meters.map(m => [m.id, m.panel, m.position, m.fed_from, m.feeds, m.name, m.machine, m.picture_url].join(":")).join("|")].join("#");
    if (!el._plant || el._plant.sig !== sig) {
      const parts = [], st = { sig, wires: [], cards: [], panels: [] };
      const lays = {};
      for (const id of T.order) {
        const p = T.P[id];
        lays[id] = layout(T, p, W - (phone ? 4 : 28), phone);
        parts.push(`<section class="pnl" id="pnl-${esc(id || "main")}" data-pnl="${esc(id)}"><header class="pnl-head"></header><div class="pnl-body">${lays[id].svg}</div></section>`);
      }
      el.innerHTML = `<div class="plant">${parts.join("")}</div>`;
      for (const id of T.order) {
        const sec = el.querySelector(`[data-pnl="${CSS.escape(id)}"]`);
        st.panels.push({ id, sec, head: sec.querySelector(".pnl-head"), bus: sec.querySelector(".bus") });
        for (const w of lays[id].wires) {
          const g = sec.querySelector(`[data-w="${CSS.escape(w.k)}"]`);
          st.wires.push({ ...w, panelId: id, g, segEls: g.querySelectorAll(".sg"), pts: g.querySelector(".pts"), brk: sec.querySelector(`[data-brk="${CSS.escape(w.k)}"]`) });
        }
        for (const c of lays[id].cards) {
          const a = sec.querySelector(`[data-c="${CSS.escape(c.k)}"] a`);
          a.href = `#/meter/${encodeURIComponent(c.x.m.id)}`;
          a.setAttribute("aria-label", c.x.m.name);
          st.cards.push({ ...c, a });
        }
      }
      el.onclick = ev => {
        const t = ev.target.closest("[data-goto]");
        if (!t) return;
        ev.preventDefault();
        const s = el.querySelector(`[data-pnl="${CSS.escape(t.dataset.goto)}"]`);
        if (s) { s.scrollIntoView({ behavior: "smooth", block: "start" }); s.classList.add("flash"); setTimeout(() => s.classList.remove("flash"), 1200); }
      };
      el._plant = st;
    }
    const C = compute(T);
    apply(el, T, C);
    return { T, C };
  };

  // live timers on DG cards and the power cut banner
  setInterval(() => document.querySelectorAll(".tmr[data-since]").forEach(t => (t.textContent = fmtDur(Date.now() / 1000 - +t.dataset.since))), 1000);
})();
