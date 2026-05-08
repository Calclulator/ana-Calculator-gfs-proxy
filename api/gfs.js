// api/gfs.js
// GFS GRIB2 proxy for ana-Calculator
// Fetches from NOMADS grib_filter, parses GRIB2, returns JSON.
// DL-3: Long-haul bbox is split in longitude (≤60° / 60–120° / >120°), parallel fetch + merge.
//
// Query params:
//   cycle  - YYYYMMDDHH (cycle must end in 00/06/12/18)
//   fhr    - forecast hour (0..384)
//   lev    - optional legacy mode: single pressure level in mb (e.g. 300)
//            default mode fetches fixed levels: 300/275/250/225/200/175/150 mb
//   west, east, south, north - bbox in degrees (see README; lonW>lonE dateline form allowed)
//   vars   - comma-separated, default UGRD,VGRD,TMP,HGT
//
// Example: /api/gfs?cycle=2026050400&fhr=3&west=139&east=241&south=29&north=41

var GRIB2CLASS = require('grib2class');

var VAR_MAP = {
  '0,2,2': 'UGRD',
  '0,2,3': 'VGRD',
  '0,0,0': 'TMP',
  '0,3,5': 'HGT'
};

var ALLOWED_VARS = ['UGRD', 'VGRD', 'TMP', 'HGT'];
var DEFAULT_LEVELS_MB = [300, 275, 250, 225, 200, 175, 150];
var PRIMARY_LEVELS_MB = [300, 250, 200, 150];
var SECONDARY_LEVELS_MB = [275, 225, 175];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function bad(res, code, msg) {
  setCors(res);
  res.status(code).json({ error: msg });
}

function bad502(res, body) {
  setCors(res);
  res.status(502).json(body);
}

function norm360(lon) {
  var x = lon % 360;
  if (x < 0) x += 360;
  return x;
}

/** One contiguous longitude span in [0,360), width = east - west (east>west). */
function bboxToNomadsSpans(west, east, south, north) {
  var w = norm360(west);
  var e = norm360(east);
  var spans = [];
  if (w <= e) {
    spans.push({ west: w, east: e, south: south, north: north, width: e - w });
  } else {
    spans.push({ west: w, east: 360, south: south, north: north, width: 360 - w });
    spans.push({ west: 0, east: e, south: south, north: north, width: e });
  }
  return spans;
}

function splitCountForWidth(width) {
  if (width <= 60) return 1;
  if (width <= 120) return 2;
  return 3;
}

function subdivideSpan(span) {
  var n = splitCountForWidth(span.width);
  var w0 = span.west;
  var w1 = span.east;
  var width = w1 - w0;
  var parts = [];
  var i;
  for (i = 0; i < n; i++) {
    var sw = w0 + (width * i) / n;
    var se = w0 + (width * (i + 1)) / n;
    if (i > 0) sw = Math.round(sw * 10000) / 10000;
    if (i < n - 1) se = Math.round(se * 10000) / 10000;
    parts.push({
      west: sw,
      east: se,
      south: span.south,
      north: span.north,
      lonW: sw,
      lonE: se
    });
  }
  return parts;
}

/** Flat list of sub-bboxes (0–360 lon), west → east across spans and subs. */
function buildSubBboxes(west, east, south, north) {
  var spans = bboxToNomadsSpans(west, east, south, north);
  var subs = [];
  var si;
  for (si = 0; si < spans.length; si++) {
    var parts = subdivideSpan(spans[si]);
    var pi;
    for (pi = 0; pi < parts.length; pi++) {
      subs.push(parts[pi]);
    }
  }
  return { subs: subs, spanCount: spans.length };
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(url, maxAttempts) {
  maxAttempts = maxAttempts || 4;
  var attempt = 0;
  var lastErr;
  while (attempt < maxAttempts) {
    try {
      var resp = await fetch(url, {
        headers: { 'User-Agent': 'ana-Calculator-gfs-proxy/0.2' }
      });
      if (!resp.ok) {
        var e = new Error('HTTP ' + resp.status);
        e.status = resp.status;
        throw e;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500) break;
      attempt++;
      if (attempt >= maxAttempts) break;
      var backoff = Math.min(2000, Math.round(250 * Math.pow(2, attempt)));
      await sleep(backoff);
    }
  }
  throw lastErr || new Error('fetch failed');
}

function buildNomadsUrl(p) {
  var ymd = p.cycle.slice(0, 8);
  var hh = p.cycle.slice(8, 10);
  var fhr = String(p.fhr).padStart(3, '0');

  var file = 'gfs.t' + hh + 'z.' + p.filePart + '.0p25.f' + fhr;
  var dir = '/gfs.' + ymd + '/' + hh + '/atmos';

  var qs = ['file=' + file];
  for (var li = 0; li < p.levels.length; li++) {
    qs.push('lev_' + p.levels[li] + '_mb=on');
  }
  for (var i = 0; i < p.vars.length; i++) {
    qs.push('var_' + p.vars[i] + '=on');
  }
  qs.push('subregion=');
  qs.push('leftlon=' + p.west);
  qs.push('rightlon=' + p.east);
  qs.push('toplat=' + p.north);
  qs.push('bottomlat=' + p.south);
  qs.push('dir=' + encodeURIComponent(dir));

  var script = p.filePart === 'pgrb2b'
    ? 'filter_gfs_0p25b.pl'
    : 'filter_gfs_0p25.pl';
  return 'https://nomads.ncep.noaa.gov/cgi-bin/' + script + '?' + qs.join('&');
}

function splitLevelsByProduct(levels) {
  var byProduct = {
    pgrb2: [],
    pgrb2b: []
  };
  for (var i = 0; i < levels.length; i++) {
    var lev = levels[i];
    if (SECONDARY_LEVELS_MB.indexOf(lev) >= 0) {
      byProduct.pgrb2b.push(lev);
    } else if (PRIMARY_LEVELS_MB.indexOf(lev) >= 0) {
      byProduct.pgrb2.push(lev);
    } else {
      byProduct.pgrb2.push(lev);
    }
  }
  return byProduct;
}

function makeNullArray(len) {
  var arr = new Array(len);
  for (var i = 0; i < len; i++) arr[i] = null;
  return arr;
}

function buildSlices(levels, varsByLevel, grid, includeHgt) {
  var len = grid && grid.nx && grid.ny ? (grid.nx * grid.ny) : 0;
  var fallback = makeNullArray(len);
  var slices = [];
  for (var i = 0; i < levels.length; i++) {
    var lev = levels[i];
    var levVars = varsByLevel[String(lev)] || {};
    var slice = {
      lev: lev,
      u: levVars.UGRD || fallback,
      v: levVars.VGRD || fallback,
      t: levVars.TMP || fallback
    };
    if (includeHgt) slice.h = levVars.HGT || fallback;
    slices.push(slice);
  }
  return slices;
}

function readU32BE(buf, offset) {
  return (buf[offset] * 0x1000000) +
         ((buf[offset + 1] << 16) >>> 0) +
         (buf[offset + 2] << 8) +
         buf[offset + 3];
}

function splitGribMessages(buf) {
  var messages = [];
  var i = 0;
  var n = buf.length;
  while (i <= n - 16) {
    if (buf[i] === 0x47 && buf[i + 1] === 0x52 &&
        buf[i + 2] === 0x49 && buf[i + 3] === 0x42) {
      var hi = readU32BE(buf, i + 8);
      var lo = readU32BE(buf, i + 12);
      var msgLen = hi * 0x100000000 + lo;
      if (msgLen > 0 && i + msgLen <= n) {
        messages.push(buf.slice(i, i + msgLen));
        i += msgLen;
        continue;
      }
    }
    i++;
  }
  return messages;
}

function parseMessage(msgBuffer) {
  var grib = new GRIB2CLASS({ log: false, numMembers: 1 });
  grib.parse(msgBuffer);

  var key = grib.DisciplineOfProcessedData + ',' +
            grib.CategoryOfParametersByProductDiscipline + ',' +
            grib.ParameterNumberByProductDisciplineAndParameterCategory;
  var name = VAR_MAP[key] || ('UNK_' + key);

  var values = grib.DataValues && grib.DataValues[0];
  var arr;
  if (values && values.length) {
    arr = new Array(values.length);
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      arr[i] = (v === undefined || v === null || isNaN(v))
        ? null
        : Math.round(v * 100) / 100;
    }
  } else {
    arr = [];
  }

  var levMb = null;
  if (typeof grib.ScaledValueOfFirstFixedSurface === 'number' &&
      !isNaN(grib.ScaledValueOfFirstFixedSurface)) {
    var rawLev = grib.ScaledValueOfFirstFixedSurface;
    levMb = rawLev > 2000 ? (rawLev / 100) : rawLev;
  }

  return {
    name: name,
    levMb: levMb,
    data: arr,
    nx: grib.Nx,
    ny: grib.Ny,
    la1: grib.La1,
    lo1: grib.Lo1,
    la2: grib.La2,
    lo2: grib.Lo2,
    refTime: {
      year: grib.Year, month: grib.Month, day: grib.Day,
      hour: grib.Hour, minute: grib.Minute, second: grib.Second
    },
    forecastHours: grib.ForecastConvertedTime
  };
}

function refTimeKey(rt) {
  if (!rt) return '';
  return rt.year + '-' + rt.month + '-' + rt.day + '-' + rt.hour + '-' + (rt.minute || 0);
}

function metaMismatchMsg(a, b) {
  return 'meta mismatch: ' + a + ' vs ' + b;
}

/** Merge parsed GRIB fields of same lev+name, west → east. Returns merged parsed object. */
function mergeParsedHorizontally(parsedArr) {
  if (!parsedArr || parsedArr.length === 0) {
    throw new Error('mergeParsedHorizontally: empty');
  }
  if (parsedArr.length === 1) return parsedArr[0];

  var ny0 = parsedArr[0].ny;
  var nx0 = parsedArr[0].nx;
  var la1 = parsedArr[0].la1;
  var la2 = parsedArr[0].la2;
  var lo1 = parsedArr[0].lo1;
  var lo2 = parsedArr[0].lo2;
  var name = parsedArr[0].name;
  var levMb = parsedArr[0].levMb;
  var refTime = parsedArr[0].refTime;
  var forecastHours = parsedArr[0].forecastHours;
  var z;
  for (z = 1; z < parsedArr.length; z++) {
    if (parsedArr[z].ny !== ny0) throw new Error(metaMismatchMsg('ny', parsedArr[z].ny + '!=' + ny0));
    if (Math.abs(parsedArr[z].la1 - la1) > 0.02) throw new Error(metaMismatchMsg('la1', ''));
    if (Math.abs(parsedArr[z].la2 - la2) > 0.02) throw new Error(metaMismatchMsg('la2', ''));
    if (parsedArr[z].name !== name) throw new Error(metaMismatchMsg('name', ''));
    if (String(parsedArr[z].levMb) !== String(levMb)) throw new Error(metaMismatchMsg('levMb', ''));
    if (refTimeKey(parsedArr[z].refTime) !== refTimeKey(refTime)) {
      throw new Error(metaMismatchMsg('refTime', ''));
    }
    if (parsedArr[z].forecastHours !== forecastHours) {
      throw new Error(metaMismatchMsg('forecastHours', ''));
    }
  }

  var dlon = (lo2 - lo1) / Math.max(1, nx0 - 1);
  var mergedData = parsedArr[0].data.slice();
  var curNx = nx0;
  var curLo2 = lo2;
  var k;
  for (k = 1; k < parsedArr.length; k++) {
    var p = parsedArr[k];
    var nxk = p.nx;
    var dlonK = (p.lo2 - p.lo1) / Math.max(1, nxk - 1);
    if (Math.abs(dlon - dlonK) > 0.0005) {
      throw new Error(metaMismatchMsg('dlon', dlon + ' vs ' + dlonK));
    }

    var shift = 0;
    while (shift < 4 && p.lo1 + shift * 360 < curLo2 - dlon * 0.5) shift++;
    while (shift > -4 && p.lo1 + shift * 360 > curLo2 + dlon * 1.5) shift--;
    var pLo1 = p.lo1 + shift * 360;
    var pLo2 = p.lo2 + shift * 360;

    var overlap = 1;
    var gapCells = Math.abs((pLo1 - curLo2) / dlon);
    if (gapCells < 0.25) overlap = 1;
    else if (gapCells < 1.25) overlap = 1;
    else overlap = 0;

    if (overlap > curNx || overlap > nxk) overlap = 0;

    var newNx = curNx + nxk - overlap;
    var newData = new Array(newNx * ny0);
    var iy;
    for (iy = 0; iy < ny0; iy++) {
      var ix;
      for (ix = 0; ix < curNx; ix++) {
        newData[iy * newNx + ix] = mergedData[iy * curNx + ix];
      }
      var j;
      for (j = 0; j < nxk - overlap; j++) {
        newData[iy * newNx + curNx - overlap + j] = p.data[iy * nxk + overlap + j];
      }
    }
    mergedData = newData;
    curNx = newNx;
    curLo2 = pLo2;
  }

  return {
    name: name,
    levMb: levMb,
    data: mergedData,
    nx: curNx,
    ny: ny0,
    la1: la1,
    lo1: lo1,
    la2: la2,
    lo2: curLo2,
    refTime: refTime,
    forecastHours: forecastHours
  };
}

/** Per sub: map "lev\tname" -> parsed. Merge each key west→east across subs. */
function mergeMessagesFromSubs(subParsedArrays) {
  var nSubs = subParsedArrays.length;
  var maps = [];
  var si;
  var mj;
  var p;
  var k;
  for (si = 0; si < nSubs; si++) {
    var m = {};
    for (mj = 0; mj < subParsedArrays[si].length; mj++) {
      p = subParsedArrays[si][mj];
      k = (p.levMb === null ? 'unknown' : String(p.levMb)) + '\t' + p.name;
      if (m[k]) {
        throw new Error(metaMismatchMsg('duplicate in sub', String(si) + ' ' + k));
      }
      m[k] = p;
    }
    maps.push(m);
  }
  var allKeys = {};
  for (si = 0; si < nSubs; si++) {
    for (k in maps[si]) {
      if (Object.prototype.hasOwnProperty.call(maps[si], k)) {
        allKeys[k] = true;
      }
    }
  }
  var mergedList = [];
  for (k in allKeys) {
    if (!Object.prototype.hasOwnProperty.call(allKeys, k)) continue;
    var chain = [];
    for (si = 0; si < nSubs; si++) {
      if (!maps[si][k]) {
        throw new Error('missing layer in sub ' + si + ': ' + k);
      }
      chain.push(maps[si][k]);
    }
    mergedList.push(mergeParsedHorizontally(chain));
  }
  return mergedList;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    return bad(res, 405, 'Method not allowed');
  }

  var q = req.query || {};

  if (!/^[0-9]{10}$/.test(q.cycle || '')) {
    return bad(res, 400, 'cycle must be YYYYMMDDHH (10 digits)');
  }
  var hh = q.cycle.slice(8, 10);
  if (['00', '06', '12', '18'].indexOf(hh) < 0) {
    return bad(res, 400, 'cycle hour must be 00/06/12/18');
  }
  var fhr = parseInt(q.fhr, 10);
  if (isNaN(fhr) || fhr < 0 || fhr > 384) {
    return bad(res, 400, 'fhr must be integer 0..384');
  }
  var legacyLev = null;
  if (q.lev !== undefined) {
    legacyLev = parseInt(q.lev, 10);
    if (isNaN(legacyLev) || legacyLev <= 0) {
      return bad(res, 400, 'lev (mb) must be positive integer');
    }
  }
  var west = parseFloat(q.west);
  var east = parseFloat(q.east);
  var south = parseFloat(q.south);
  var north = parseFloat(q.north);
  if ([west, east, south, north].some(isNaN)) {
    return bad(res, 400, 'west/east/south/north required');
  }
  if (south >= north) {
    return bad(res, 400, 'south must be < north');
  }

  var varsParam = (q.vars || 'UGRD,VGRD,TMP,HGT').split(',');
  var requested = [];
  for (var i = 0; i < varsParam.length; i++) {
    var v = varsParam[i].trim().toUpperCase();
    if (ALLOWED_VARS.indexOf(v) >= 0 && requested.indexOf(v) < 0) {
      requested.push(v);
    }
  }
  if (requested.length === 0) {
    return bad(res, 400, 'no valid vars (allowed: ' + ALLOWED_VARS.join(',') + ')');
  }

  var requestLevels = legacyLev !== null ? [legacyLev] : DEFAULT_LEVELS_MB;

  var bboxInfo = buildSubBboxes(west, east, south, north);
  var subs = bboxInfo.subs;
  var t0 = Date.now();

  try {
    var levelGroups = splitLevelsByProduct(requestLevels);
    var productSpecs = [
      { key: 'pgrb2', filePart: 'pgrb2', levels: levelGroups.pgrb2 },
      { key: 'pgrb2b', filePart: 'pgrb2b', levels: levelGroups.pgrb2b }
    ];

    var allMergedParsed = [];
    var totalRawMessages = 0;
    var pi;

    for (pi = 0; pi < productSpecs.length; pi++) {
      var spec = productSpecs[pi];
      if (!spec.levels.length) continue;

      var fetchTasks = subs.map(function (sub) {
        var url = buildNomadsUrl({
          cycle: q.cycle,
          fhr: fhr,
          levels: spec.levels,
          filePart: spec.filePart,
          west: sub.west,
          east: sub.east,
          south: south,
          north: north,
          vars: requested
        });
        return (async function () {
          try {
            var buf = await fetchWithRetry(url, 4);
            return { sub: sub, buf: buf, ok: true };
          } catch (err) {
            return { sub: sub, err: err, ok: false };
          }
        })();
      });

      var results = await Promise.all(fetchTasks);
      var ri;
      for (ri = 0; ri < results.length; ri++) {
        if (!results[ri].ok) {
          console.error('[gfs] sub fetch failed', spec.filePart, results[ri].sub, results[ri].err && results[ri].err.message);
          return bad502(res, {
            error: 'NOMADS sub fetch failed after retries',
            failedSubBbox: { lonW: results[ri].sub.lonW, lonE: results[ri].sub.lonE }
          });
        }
        var buf = results[ri].buf;
        if (buf.length < 16) {
          return bad502(res, {
            error: 'empty/short response from NOMADS ' + spec.filePart + ' (' + buf.length + ' bytes)',
            failedSubBbox: { lonW: results[ri].sub.lonW, lonE: results[ri].sub.lonE }
          });
        }
        var split = splitGribMessages(buf);
        if (split.length === 0) {
          return bad502(res, {
            error: 'no GRIB messages in NOMADS ' + spec.filePart + ' response',
            failedSubBbox: { lonW: results[ri].sub.lonW, lonE: results[ri].sub.lonE }
          });
        }
        totalRawMessages += split.length;
      }

      var subParsedArrays = [];
      for (ri = 0; ri < results.length; ri++) {
        var buf2 = results[ri].buf;
        var split2 = splitGribMessages(buf2);
        var parsedList = [];
        var sj;
        for (sj = 0; sj < split2.length; sj++) {
          try {
            parsedList.push(parseMessage(split2[sj]));
          } catch (pe) {
            parsedList.push(null);
          }
        }
        subParsedArrays.push(parsedList.filter(Boolean));
      }

      try {
        var mergedForProduct = mergeMessagesFromSubs(subParsedArrays);
        var mj;
        for (mj = 0; mj < mergedForProduct.length; mj++) {
          allMergedParsed.push(mergedForProduct[mj]);
        }
      } catch (mergeErr) {
        console.error('[gfs] merge/meta', mergeErr.message);
        return bad502(res, {
          error: mergeErr.message || 'merge failed',
          reason: 'meta_mismatch'
        });
      }
    }

    var vars = legacyLev !== null ? {} : {};
    var meta = null;
    var grid = null;
    var parseErrors = [];

    for (var m = 0; m < allMergedParsed.length; m++) {
      try {
        var parsed = allMergedParsed[m];
        if (legacyLev !== null) {
          vars[parsed.name] = parsed.data;
        } else {
          var levKey2 = parsed.levMb === null ? 'unknown' : String(parsed.levMb);
          if (!vars[levKey2]) vars[levKey2] = {};
          vars[levKey2][parsed.name] = parsed.data;
        }
        if (!grid) {
          grid = {
            nx: parsed.nx,
            ny: parsed.ny,
            la1: parsed.la1,
            lo1: parsed.lo1,
            la2: parsed.la2,
            lo2: parsed.lo2
          };
          meta = {
            cycle: q.cycle,
            fhr: fhr,
            refTime: parsed.refTime,
            forecastHours: parsed.forecastHours,
            messageCount: allMergedParsed.length
          };
          if (legacyLev !== null) {
            meta.lev = legacyLev;
          } else {
            meta.levels = DEFAULT_LEVELS_MB;
          }
        }
      } catch (e) {
        parseErrors.push({ index: m, error: e.message });
      }
    }

    var slices;
    if (legacyLev !== null) {
      var legacyLen = grid && grid.nx && grid.ny ? (grid.nx * grid.ny) : 0;
      var legacyFallback = makeNullArray(legacyLen);
      slices = [{
        lev: legacyLev,
        u: vars.UGRD || legacyFallback,
        v: vars.VGRD || legacyFallback,
        t: vars.TMP || legacyFallback,
        h: vars.HGT || legacyFallback
      }];
    } else {
      slices = buildSlices(DEFAULT_LEVELS_MB, vars, grid, true);
    }

    var elapsed = Date.now() - t0;
    console.log(JSON.stringify({
      tag: 'gfs-bbox-split',
      splitSubCount: subs.length,
      spanCount: bboxInfo.spanCount,
      subBboxes: subs.map(function (s) {
        return { lonW: s.lonW, lonE: s.lonE };
      }),
      fetchMs: elapsed,
      messageCount: meta.messageCount,
      rawMessageTotal: totalRawMessages
    }));

    setCors(res);
    res.setHeader('Cache-Control', 'public, s-maxage=21600, max-age=600');
    res.status(200).json({
      meta: meta,
      grid: grid,
      slices: slices,
      vars: vars,
      parseErrors: parseErrors.length ? parseErrors : undefined
    });
  } catch (err) {
    console.error('handler error:', err);
    return bad(res, 500, err.message || 'internal error');
  }
};
