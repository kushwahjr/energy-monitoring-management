// Small dependency-free SVG line chart (works offline on the plant network).
// points: [[unixSeconds, avg, min, max], ...]
window.lineChart = function (el, points, opts = {}) {
  const W = el.clientWidth || 600, H = el.clientHeight || 300;
  const m = { l: 52, r: 12, t: 12, b: 26 };
  const NS = "http://www.w3.org/2000/svg";
  el.innerHTML = "";
  if (!points.length) { el.innerHTML = '<p class="muted pad">No data in this period yet.</p>'; return; }
  const xs = points.map(p => p[0]);
  let lo = Math.min(...points.map(p => p[2] ?? p[1])), hi = Math.max(...points.map(p => p[3] ?? p[1]));
  if (opts.limit != null) { lo = Math.min(lo, opts.limit); hi = Math.max(hi, opts.limit); }
  if (opts.zero && lo > 0) lo = 0;
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06; hi += pad; if (!(opts.zero && lo === 0)) lo -= pad;
  const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
  const X = t => m.l + (t - x0) / (x1 - x0) * (W - m.l - m.r);
  const Y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; svg.appendChild(n); return n; };

  // y grid
  const step = niceStep((hi - lo) / 5);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    add("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: "gridline" });
    add("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "axis" }, fmtNum(v, Math.max(0, -Math.floor(Math.log10(step)))));
  }
  // x labels
  const span = x1 - x0, n = Math.max(2, Math.floor((W - m.l - m.r) / 90));
  for (let i = 0; i <= n; i++) {
    const t = x0 + span * i / n, d = new Date(t * 1000);
    const label = span > 2 * 86400 ? d.toLocaleDateString([], { day: "2-digit", month: "short" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    add("text", { x: X(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === n ? "end" : "middle", class: "axis" }, label);
  }
  // min/max band, then average line; break the line across gaps in the data
  const gap = opts.gap || Infinity;
  let band = "", line = "", prev = null, segStart = 0;
  const segs = [];
  points.forEach((p, i) => { if (prev && p[0] - prev[0] > gap) { segs.push(points.slice(segStart, i)); segStart = i; } prev = p; });
  segs.push(points.slice(segStart));
  for (const s of segs) {
    if (s[0][2] != null && s.length > 1) band += "M" + s.map(p => `${X(p[0])},${Y(p[3])}`).join("L") + "L" + s.slice().reverse().map(p => `${X(p[0])},${Y(p[2])}`).join("L") + "Z";
    line += "M" + s.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L");
  }
  if (band) add("path", { d: band, class: "band" });
  add("path", { d: line, class: "line" });
  if (opts.limit != null) add("line", { x1: m.l, x2: W - m.r, y1: Y(opts.limit), y2: Y(opts.limit), class: "limit" });

  // hover
  const cursor = add("line", { y1: m.t, y2: H - m.b, class: "cursor", visibility: "hidden" });
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true;
  el.appendChild(svg); el.appendChild(tip);
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const t = x0 + (px * W / r.width - m.l) / (W - m.l - m.r) * (x1 - x0);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    cursor.setAttribute("x1", X(best[0])); cursor.setAttribute("x2", X(best[0])); cursor.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${new Date(best[0] * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}  ${fmtNum(best[1])} ${opts.unit || ""}`;
    const left = X(best[0]) * r.width / W;
    tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + "px";
    tip.style.top = "0px";
  };
  svg.addEventListener("mousemove", move); svg.addEventListener("touchmove", move, { passive: true });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; cursor.setAttribute("visibility", "hidden"); });

  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
};

window.fmtNum = function (v, d) {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v);
  if (d == null) d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
};
