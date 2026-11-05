// Vercel Function: /api/points
// GET /api/points?pts=lat,lon;lat,lon&cycle=YYYYMMDDHH&fhr=INT
// Up to 8 locations in one Open-Meteo request.

const LEVELS_MB = [400, 300, 275, 250, 225, 200, 175, 150];

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function badRequest(res, message) {
  setCors(res);
  return res.status(400).json({ error: message });
}

function parseCycleUtc(cycle) {
  if (!/^\d{10}$/.test(cycle)) return null;
  const y = Number(cycle.slice(0, 4));
  const m = Number(cycle.slice(4, 6));
  const d = Number(cycle.slice(6, 8));
  const h = Number(cycle.slice(8, 10));
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    !Number.isInteger(h) ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31 ||
    h < 0 ||
    h > 23
  ) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d, h, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isoDateOnly(dt) {
  return dt.toISOString().slice(0, 10);
}

function nearestTimeIndex(hourlyTimes, targetMs) {
  let bestIdx = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hourlyTimes.length; i++) {
    const ms = Date.parse(hourlyTimes[i] + "Z");
    if (Number.isNaN(ms)) continue;
    const d = Math.abs(ms - targetMs);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function getAt(arr, idx) {
  if (!Array.isArray(arr)) return null;
  if (idx < 0 || idx >= arr.length) return null;
  const v = arr[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toMsIfNeeded(u, value) {
  if (value === null) return null;
  if (u && typeof u === "string" && /km\/h/i.test(u)) return value / 3.6;
  return value;
}

function toKelvinIfNeeded(u, value) {
  if (value === null) return null;
  if (u && typeof u === "string" && /°c|celsius/i.test(u)) return value + 273.15;
  return value;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Open-Meteo HTTP ${r.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function levelsFromLocation(loc, validMs) {
  if (!loc || !loc.hourly || !Array.isArray(loc.hourly.time)) return [];
  const idx = nearestTimeIndex(loc.hourly.time, validMs);
  if (idx < 0) return [];
  const units = loc.hourly_units || {};
  const levels = [];
  for (const mb of LEVELS_MB) {
    const tk = `temperature_${mb}hPa`;
    const hk = `geopotential_height_${mb}hPa`;
    const uk = `wind_u_component_${mb}hPa`;
    const vk = `wind_v_component_${mb}hPa`;
    const tRaw = getAt(loc.hourly[tk], idx);
    const hRaw = getAt(loc.hourly[hk], idx);
    const uRaw = getAt(loc.hourly[uk], idx);
    const vRaw = getAt(loc.hourly[vk], idx);
    if (tRaw === null || hRaw === null || uRaw === null || vRaw === null) continue;
    const tmpK = toKelvinIfNeeded(units[tk], tRaw);
    const uMs = toMsIfNeeded(units[uk], uRaw);
    const vMs = toMsIfNeeded(units[vk], vRaw);
    levels.push({
      mb: mb,
      hgt_m: Number(hRaw.toFixed(3)),
      u_ms: Number(uMs.toFixed(4)),
      v_ms: Number(vMs.toFixed(4)),
      tmp_k: Number(tmpK.toFixed(4))
    });
  }
  return levels;
}

function parsePts(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parts = text.split(";");
  if (parts.length < 1 || parts.length > 8) return null;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i].split(",");
    if (pair.length !== 2) return null;
    const lat = Number(pair[0]);
    const lon = Number(pair[1]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    out.push({ lat: lat, lon: lon });
  }
  return out;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const pts = parsePts(req.query.pts);
  if (!pts) {
    return badRequest(res, "invalid pts (1-8 of lat,lon separated by ;)");
  }

  const fhr = Number(req.query.fhr);
  if (!Number.isInteger(fhr) || fhr < 0 || fhr > 384) {
    return badRequest(res, "invalid fhr (0..384)");
  }

  const cycleDt = parseCycleUtc(String(req.query.cycle || ""));
  if (!cycleDt) {
    return badRequest(res, "invalid cycle (YYYYMMDDHH)");
  }

  const validUtc = new Date(cycleDt.getTime() + fhr * 3600 * 1000);
  const validIso = validUtc.toISOString().replace(".000", "");
  const day = isoDateOnly(validUtc);

  const hourlyVars = [];
  for (const mb of LEVELS_MB) {
    hourlyVars.push(`temperature_${mb}hPa`);
    hourlyVars.push(`geopotential_height_${mb}hPa`);
    hourlyVars.push(`wind_u_component_${mb}hPa`);
    hourlyVars.push(`wind_v_component_${mb}hPa`);
  }

  const lats = pts.map((p) => String(p.lat)).join(",");
  const lons = pts.map((p) => String(p.lon)).join(",");
  const url = new URL("https://api.open-meteo.com/v1/gfs");
  url.searchParams.set("latitude", lats);
  url.searchParams.set("longitude", lons);
  url.searchParams.set("models", "gfs_seamless");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", day);
  url.searchParams.set("end_date", day);
  url.searchParams.set("hourly", hourlyVars.join(","));
  url.searchParams.set("wind_speed_unit", "ms");

  try {
    const data = await fetchJson(url.toString(), 9000);
    const locations = Array.isArray(data) ? data : [data];
    const results = [];
    for (let i = 0; i < pts.length; i++) {
      results.push({
        lat: pts[i].lat,
        lon: pts[i].lon,
        levels: levelsFromLocation(locations[i], validUtc.getTime())
      });
    }
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=43200");
    return res.status(200).json({
      cycle: String(req.query.cycle),
      fhr: fhr,
      validUtc: validIso,
      results: results
    });
  } catch (err) {
    return res.status(502).json({
      error: "points fetch failed",
      detail: String(err && err.message ? err.message : err)
    });
  }
}
