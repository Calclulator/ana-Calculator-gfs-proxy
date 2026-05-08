// Vercel Function: /api/grid
// GET /api/grid?bboxN=..&bboxS=..&bboxW=..&bboxE=..&cycle=YYYYMMDDHH&fhr=INT&dlat=0.5&dlon=0.5
//
// Returns:
// {
//   "cycle":"2026050800",
//   "fhr":0,
//   "validUtc":"2026-05-08T00:00:00Z",
//   "bbox":{"N":..,"S":..,"W":..,"E":..},
//   "dlat":0.5,"dlon":0.5,
//   "nlat":12,"nlon":24,
//   "levels":[
//     {"mb":300,"u_ms":[[...]],"v_ms":[[...]],"tmp_k":[[...]],"hgt_m":[[...]]},
//     ...
//   ]
// }

const LEVELS_MB = [300, 275, 250, 225, 200, 175, 150];

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function badRequest(res, message) {
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

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function toFixedNumber(v, digits) {
  return Number(Number(v).toFixed(digits));
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

function toMsIfNeeded(unit, value) {
  if (value === null) return null;
  if (unit && typeof unit === "string" && /km\/h/i.test(unit)) return value / 3.6;
  return value;
}

function toKelvinIfNeeded(unit, value) {
  if (value === null) return null;
  if (unit && typeof unit === "string" && /°c|celsius/i.test(unit)) return value + 273.15;
  return value;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const err = new Error(`Open-Meteo HTTP ${r.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHourlyVars() {
  const hourlyVars = [];
  for (const mb of LEVELS_MB) {
    hourlyVars.push(`temperature_${mb}hPa`);
    hourlyVars.push(`geopotential_height_${mb}hPa`);
    hourlyVars.push(`wind_u_component_${mb}hPa`);
    hourlyVars.push(`wind_v_component_${mb}hPa`);
  }
  return hourlyVars;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET,OPTIONS");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const bboxN = Number(req.query.bboxN);
  const bboxS = Number(req.query.bboxS);
  const bboxW = Number(req.query.bboxW);
  const bboxE = Number(req.query.bboxE);
  const cycleRaw = String(req.query.cycle || "");
  const fhr = Number(req.query.fhr);
  let dlat = Number(req.query.dlat);
  let dlon = Number(req.query.dlon);

  if (!Number.isFinite(bboxN) || !Number.isFinite(bboxS) || !Number.isFinite(bboxW) || !Number.isFinite(bboxE)) {
    return badRequest(res, "invalid bbox");
  }
  if (bboxS > bboxN) return badRequest(res, "bboxS must be <= bboxN");
  if (!Number.isInteger(fhr) || fhr < 0 || fhr > 384) return badRequest(res, "invalid fhr (0..384)");
  const cycleDt = parseCycleUtc(cycleRaw);
  if (!cycleDt) return badRequest(res, "invalid cycle (YYYYMMDDHH)");

  if (!Number.isFinite(dlat) || dlat <= 0) dlat = 0.5;
  if (!Number.isFinite(dlon) || dlon <= 0) dlon = 0.5;

  // sanity clamp to avoid insane response sizes
  dlat = clamp(dlat, 0.25, 2.0);
  dlon = clamp(dlon, 0.25, 2.0);

  const validUtc = new Date(cycleDt.getTime() + fhr * 3600 * 1000);
  const validIso = validUtc.toISOString().replace(".000", "");

  // Build lat/lon grid (j=lat index, i=lon index)
  // lat: from N down to S
  // lon: from W up to E (no dateline wrap support here; keep bbox small)
  const lats = [];
  for (let lat = bboxN; lat >= bboxS - 1e-9; lat -= dlat) lats.push(toFixedNumber(lat, 6));
  const lons = [];
  for (let lon = bboxW; lon <= bboxE + 1e-9; lon += dlon) lons.push(toFixedNumber(lon, 6));

  const nlat = lats.length;
  const nlon = lons.length;

  if (nlat <= 0 || nlon <= 0) return badRequest(res, "empty grid");
  // hard limit to keep Open-Meteo + response size safe
  const maxPoints = 1200;
  if (nlat * nlon > maxPoints) {
    return badRequest(res, `grid too large: ${nlat}x${nlon}=${nlat * nlon} > ${maxPoints} (increase dlat/dlon or shrink bbox)`);
  }

  // Flatten points in row-major order: j then i
  const ptsLat = [];
  const ptsLon = [];
  for (let j = 0; j < nlat; j++) {
    for (let i = 0; i < nlon; i++) {
      ptsLat.push(lats[j]);
      ptsLon.push(lons[i]);
    }
  }

  const startDate = isoDateOnly(validUtc);
  const endDate = isoDateOnly(new Date(validUtc.getTime() + 24 * 3600 * 1000));
  const hourlyVars = buildHourlyVars();

  const totalCells = nlat * nlon;
  // Prefer fewer calls to avoid minute-rate limits while staying well under provider point caps.
  const batchSize = Math.min(500, Math.max(200, totalCells));
  const latBatches = chunkArray(ptsLat, batchSize);
  const lonBatches = chunkArray(ptsLon, batchSize);
  const batchCount = latBatches.length;

  // Prepare output arrays
  const levelsOut = LEVELS_MB.map((mb) => ({
    mb,
    u_ms: Array.from({ length: nlat }, () => Array.from({ length: nlon }, () => null)),
    v_ms: Array.from({ length: nlat }, () => Array.from({ length: nlon }, () => null)),
    tmp_k: Array.from({ length: nlat }, () => Array.from({ length: nlon }, () => null)),
    hgt_m: Array.from({ length: nlat }, () => Array.from({ length: nlon }, () => null))
  }));

  // Helper to set a point (flat index p -> j,i)
  function setPoint(p, mb, u, v, tK, h) {
    const j = Math.floor(p / nlon);
    const i = p - j * nlon;
    const li = LEVELS_MB.indexOf(mb);
    if (li < 0) return;
    levelsOut[li].u_ms[j][i] = u;
    levelsOut[li].v_ms[j][i] = v;
    levelsOut[li].tmp_k[j][i] = tK;
    levelsOut[li].hgt_m[j][i] = h;
  }

  try {
    const t0 = Date.now();
    let openMeteoCalls = 0;
    console.log("[grid] start", JSON.stringify({
      cycle: cycleRaw,
      fhr: fhr,
      totalCells: totalCells,
      nlat: nlat,
      nlon: nlon,
      batchSize: batchSize,
      batchCount: batchCount
    }));

    let p0 = 0;
    for (let b = 0; b < latBatches.length; b++) {
      const latList = latBatches[b].join(",");
      const lonList = lonBatches[b].join(",");

      const url = new URL("https://api.open-meteo.com/v1/gfs");
      url.searchParams.set("latitude", latList);
      url.searchParams.set("longitude", lonList);
      url.searchParams.set("models", "gfs_seamless");
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date", endDate);
      url.searchParams.set("hourly", hourlyVars.join(","));
      url.searchParams.set("wind_speed_unit", "ms");

      let data;
      try {
        openMeteoCalls += 1;
        data = await fetchJson(url.toString(), 20000);
      } catch (err) {
        if (err && err.status === 429) {
          console.log("[grid] 429 retry", JSON.stringify({ batchIndex: b, waitMs: 1000 }));
          await sleep(1000);
          openMeteoCalls += 1;
          data = await fetchJson(url.toString(), 20000);
        } else {
          throw err;
        }
      }

      // Open-Meteo multi-point returns { latitude:[], longitude:[], hourly:[] } (hourly per point)
      // Handle both shapes: hourly as array (multi) OR object (single).
      const isMulti = Array.isArray(data.hourly);
      const hourlyArr = isMulti ? data.hourly : [data.hourly];
      const units = data.hourly_units || {};

      for (let pi = 0; pi < hourlyArr.length; pi++) {
        const hourly = hourlyArr[pi];
        if (!hourly || !Array.isArray(hourly.time)) continue;

        const idx = nearestTimeIndex(hourly.time, validUtc.getTime());
        if (idx < 0) continue;

        for (const mb of LEVELS_MB) {
          const tk = `temperature_${mb}hPa`;
          const hk = `geopotential_height_${mb}hPa`;
          const uk = `wind_u_component_${mb}hPa`;
          const vk = `wind_v_component_${mb}hPa`;

          const tRaw = getAt(hourly[tk], idx);
          const hRaw = getAt(hourly[hk], idx);
          const uRaw = getAt(hourly[uk], idx);
          const vRaw = getAt(hourly[vk], idx);

          if (tRaw === null || hRaw === null || uRaw === null || vRaw === null) continue;

          const tK = toKelvinIfNeeded(units[tk], tRaw);
          const uMs = toMsIfNeeded(units[uk], uRaw);
          const vMs = toMsIfNeeded(units[vk], vRaw);

          setPoint(p0 + pi, mb,
            toFixedNumber(uMs, 4),
            toFixedNumber(vMs, 4),
            toFixedNumber(tK, 4),
            toFixedNumber(hRaw, 3)
          );
        }
      }

      p0 += hourlyArr.length;
    }

    console.log("[grid] done", JSON.stringify({
      totalCells: totalCells,
      batchSize: batchSize,
      batchCount: batchCount,
      openMeteoCalls: openMeteoCalls,
      elapsedMs: Date.now() - t0
    }));

    return res.status(200).json({
      cycle: cycleRaw,
      fhr: fhr,
      validUtc: validIso,
      bbox: { N: bboxN, S: bboxS, W: bboxW, E: bboxE },
      dlat: dlat,
      dlon: dlon,
      nlat: nlat,
      nlon: nlon,
      levels: levelsOut
    });
  } catch (err) {
    return res.status(502).json({
      error: "grid fetch failed",
      detail: String(err && err.message ? err.message : err)
    });
  }
}
