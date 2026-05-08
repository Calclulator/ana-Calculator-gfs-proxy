// Vercel Function: /api/point
// GET /api/point?lat=...&lon=...&cycle=YYYYMMDDHH&fhr=INT
//
// Response:
// {
//   "cycle":"2026050800",
//   "fhr":0,
//   "validUtc":"2026-05-08T00:00:00Z",
//   "lat":-6.198,
//   "lon":106.5,
//   "levels":[
//     {"mb":300,"hgt_m":9728,"u_ms":14.8,"v_ms":26.2,"tmp_k":224.5},
//     ...
//   ]
// }

const LEVELS_MB = [300, 275, 250, 225, 200, 175, 150];

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
  // YYYY-MM-DD (UTC)
  return dt.toISOString().slice(0, 10);
}

function nearestTimeIndex(hourlyTimes, targetMs) {
  let bestIdx = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hourlyTimes.length; i++) {
    // Open-Meteo hourly time is usually "YYYY-MM-DDTHH:mm"
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
  // Open-Meteo pressure-level wind components are usually m/s,
  // but convert if units say km/h.
  if (value === null) return null;
  if (u && typeof u === "string" && /km\/h/i.test(u)) return value / 3.6;
  return value;
}

function toKelvinIfNeeded(u, value) {
  // Open-Meteo temperature_* is usually °C, convert to K.
  if (value === null) return null;
  if (u && typeof u === "string" && /°c|celsius/i.test(u)) return value + 273.15;
  // If already Kelvin-like unit, keep as-is.
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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const latRaw = req.query.lat;
  const lonRaw = req.query.lon;
  const cycleRaw = req.query.cycle;
  const fhrRaw = req.query.fhr;

  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  const fhr = Number(fhrRaw);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return badRequest(res, "invalid lat");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return badRequest(res, "invalid lon");
  }
  if (!Number.isInteger(fhr) || fhr < 0 || fhr > 384) {
    return badRequest(res, "invalid fhr (0..384)");
  }

  const cycleDt = parseCycleUtc(String(cycleRaw || ""));
  if (!cycleDt) {
    return badRequest(res, "invalid cycle (YYYYMMDDHH)");
  }

  const validUtc = new Date(cycleDt.getTime() + fhr * 3600 * 1000);
  const validIso = validUtc.toISOString().replace(".000", "");

  // Request a compact time window (same day + next day) to ensure target hour exists.
  const startDate = isoDateOnly(validUtc);
  const endDate = isoDateOnly(new Date(validUtc.getTime() + 24 * 3600 * 1000));

  const hourlyVars = [];
  for (const mb of LEVELS_MB) {
    hourlyVars.push(`temperature_${mb}hPa`);
    hourlyVars.push(`geopotential_height_${mb}hPa`);
    hourlyVars.push(`wind_u_component_${mb}hPa`);
    hourlyVars.push(`wind_v_component_${mb}hPa`);
  }

  const url = new URL("https://api.open-meteo.com/v1/gfs");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("models", "gfs_seamless");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("hourly", hourlyVars.join(","));
  url.searchParams.set("wind_speed_unit", "ms");

  try {
    const data = await fetchJson(url.toString(), 12000);

    if (!data || !data.hourly || !Array.isArray(data.hourly.time)) {
      return res.status(502).json({ error: "invalid response from Open-Meteo" });
    }

    const idx = nearestTimeIndex(data.hourly.time, validUtc.getTime());
    if (idx < 0) {
      return res.status(502).json({ error: "no hourly time found in Open-Meteo response" });
    }

    const units = (data.hourly_units || {});
    const levels = [];

    for (const mb of LEVELS_MB) {
      const tk = `temperature_${mb}hPa`;
      const hk = `geopotential_height_${mb}hPa`;
      const uk = `wind_u_component_${mb}hPa`;
      const vk = `wind_v_component_${mb}hPa`;

      const tRaw = getAt(data.hourly[tk], idx);
      const hRaw = getAt(data.hourly[hk], idx);
      const uRaw = getAt(data.hourly[uk], idx);
      const vRaw = getAt(data.hourly[vk], idx);

      if (tRaw === null || hRaw === null || uRaw === null || vRaw === null) {
        continue;
      }

      const tmpK = toKelvinIfNeeded(units[tk], tRaw);
      const hgtM = hRaw; // expected meters
      const uMs = toMsIfNeeded(units[uk], uRaw);
      const vMs = toMsIfNeeded(units[vk], vRaw);

      levels.push({
        mb: mb,
        hgt_m: Number(hgtM.toFixed(3)),
        u_ms: Number(uMs.toFixed(4)),
        v_ms: Number(vMs.toFixed(4)),
        tmp_k: Number(tmpK.toFixed(4))
      });
    }

    if (!levels.length) {
      return res.status(502).json({ error: "no valid pressure-level values found" });
    }

    return res.status(200).json({
      cycle: String(cycleRaw),
      fhr: fhr,
      validUtc: validIso,
      lat: lat,
      lon: lon,
      levels: levels
    });
  } catch (err) {
    return res.status(502).json({
      error: "point fetch failed",
      detail: String(err && err.message ? err.message : err)
    });
  }
}
