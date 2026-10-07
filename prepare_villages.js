/*
 * prepare_villages.js
 * Converts the Survey of India village-boundary GeoJSON files (EPSG:7755, ~1 GB in total)
 * into small, compact files that the web tool can load on demand (data/villages/*.json).
 *
 * Usage:   node prepare_villages.js <input_dir_with_GeoJSON_files> <output_dir>
 * Example: node prepare_villages.js ./raw data/villages
 *
 * - reprojects EPSG:7755 (WGS 84 / India NSF LCC) -> WGS84 lon/lat
 * - simplifies boundaries (TOL metres), keeps only the fields the tool needs
 * - writes one compact JSON per State + data/villages/index.json
 */
const fs = require('fs'), path = require('path'), readline = require('readline');
const TOL = 12;               // simplification tolerance in metres
const Q = 1e5;                // coordinates stored as integers in 1e-5 degree (~1.1 m)

/* ---- inverse Lambert Conformal Conic (2SP), WGS84 ---- */
const A = 6378137, F = 1 / 298.257223563, E = Math.sqrt(F * (2 - F));
const rad = Math.PI / 180;
const lat1 = 12.472955 * rad, lat2 = 35.172805 * rad, lat0 = 24 * rad, lon0 = 80 * rad, X0 = 4e6, Y0 = 4e6;
const mm = p => Math.cos(p) / Math.sqrt(1 - E * E * Math.sin(p) ** 2);
const tt = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - E * Math.sin(p)) / (1 + E * Math.sin(p)), E / 2);
const N = (Math.log(mm(lat1)) - Math.log(mm(lat2))) / (Math.log(tt(lat1)) - Math.log(tt(lat2)));
const FF = mm(lat1) / (N * Math.pow(tt(lat1), N));
const R0 = A * FF * Math.pow(tt(lat0), N);
function inv(x, y) {
  const xp = x - X0, yp = R0 - (y - Y0);
  const rho = Math.sign(N) * Math.hypot(xp, yp);
  const t = Math.pow(rho / (A * FF), 1 / N);
  const th = Math.atan2(Math.sign(N) * xp, Math.sign(N) * yp);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) phi = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi)), E / 2));
  return [(th / N + lon0) / rad, phi / rad];
}

/* ---- Douglas-Peucker (iterative) on projected metres ---- */
function dp(pts, tol) {
  const n = pts.length; if (n <= 4) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]], t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = pts[s], [x2, y2] = pts[e], dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d;
      if (L === 0) d = (px - x1) ** 2 + (py - y1) ** 2;
      else { let u = ((px - x1) * dx + (py - y1) * dy) / L; u = u < 0 ? 0 : u > 1 ? 1 : u;
             d = (px - x1 - u * dx) ** 2 + (py - y1 - u * dy) ** 2; }
      if (d > md) { md = d; mi = i; }
    }
    if (md > t2) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function ringOut(ring, isOuter) {
  let pts = ring.map(p => [p[0], p[1]]);
  // split closed ring in two halves so DP doesn't collapse it
  const half = Math.floor(pts.length / 2);
  let s = pts.length > 8 ? dp(pts.slice(0, half + 1), TOL).slice(0, -1).concat(dp(pts.slice(half), TOL)) : pts;
  if (s.length < 4) { if (!isOuter) return null; s = pts; }
  if (s.length > 3 * 1 && s.length < 4) return null;
  const out = []; let px = 0, py = 0, first = true, last = null;
  for (const p of s) {
    const [lo, la] = inv(p[0], p[1]);
    const qx = Math.round(lo * Q), qy = Math.round(la * Q);
    if (last && last[0] === qx && last[1] === qy) continue;
    last = [qx, qy];
    if (first) { out.push(qx, qy); first = false; } else out.push(qx - px, qy - py);
    px = qx; py = qy;
  }
  return out.length >= 8 ? out : (isOuter ? out : null);
}

async function convert(file, outDir) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
  const dist = new Map(), sub = new Map(), villages = [];
  let stateName = '', bb = [1e9, 1e9, -1e9, -1e9];
  const idx = (m, k) => { if (!m.has(k)) m.set(k, m.size); return m.get(k); };
  for await (let line of rl) {
    line = line.trim();
    if (!line.startsWith('{ "type": "Feature"') && !line.startsWith('{"type":"Feature"')) continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    const f = JSON.parse(line), P = {};
    for (const k in f.properties) P[k.trim()] = f.properties[k];
    const g = f.geometry; if (!g) continue;
    stateName = stateName || String(P.state_name || '').trim();
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let vb = [1e9, 1e9, -1e9, -1e9];
    const geom = [];
    for (const poly of polys) {
      const rings = [];
      poly.forEach((r, i) => { const o = ringOut(r, i === 0); if (o) rings.push(o); });
      if (rings.length) geom.push(rings);
    }
    if (!geom.length) continue;
    // bbox in quantised units
    for (const rings of geom) for (const r of rings) {
      let x = 0, y = 0;
      for (let i = 0; i < r.length; i += 2) {
        x = i === 0 ? r[0] : x + r[i]; y = i === 0 ? r[1] : y + r[i + 1];
        if (x < vb[0]) vb[0] = x; if (x > vb[2]) vb[2] = x; if (y < vb[1]) vb[1] = y; if (y > vb[3]) vb[3] = y;
      }
    }
    bb = [Math.min(bb[0], vb[0]), Math.min(bb[1], vb[1]), Math.max(bb[2], vb[2]), Math.max(bb[3], vb[3])];
    const str = v => String(v == null ? '' : v).trim();
    const num = v => (isFinite(+v) ? Math.round(+v) : 0);
    const di = idx(dist, str(P.district)), bi = idx(sub, str(P.block) || str(P.subdistric));
    villages.push([str(P.village), str(P.vlcode), di, bi, num(P.total_population_village), num(P.total_households),
                   num(P.shape_area), vb, geom]);
  }
  const code = path.basename(file).toLowerCase().match(/vb_soi_([a-z]+)/)[1];
  const out = { state: stateName, d: [...dist.keys()], b: [...sub.keys()], v: villages };
  fs.mkdirSync(outDir, { recursive: true });
  const fn = path.join(outDir, code + '.json');
  fs.writeFileSync(fn, JSON.stringify(out));
  const size = fs.statSync(fn).size;
  console.log(code, stateName, villages.length, 'villages', (size / 1e6).toFixed(1) + ' MB');
  return { code, state: stateName, file: code + '.json', n: villages.length, bbox: bb.map(v => v / Q), size };
}

(async () => {
  const [inDir, outDir] = process.argv.slice(2);
  if (!inDir || !outDir) { console.log('Usage: node prepare_villages.js <input_dir> <output_dir>'); process.exit(1); }
  const files = fs.readdirSync(inDir).filter(f => /vb_soi_[a-z]+\.geojson$/i.test(f));
  const index = [];
  for (const f of files) index.push(await convert(path.join(inDir, f), outDir));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ q: Q, states: index }));
})();
