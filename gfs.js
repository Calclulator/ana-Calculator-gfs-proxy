// api/gfs.js
// GFS GRIB2 proxy for ana-Calculator
// Fetches from NOMADS grib_filter, parses GRIB2, returns JSON.
//
// Query params:
//   cycle  - YYYYMMDDHH (cycle must end in 00/06/12/18)
//   fhr    - forecast hour (0..384)
//   lev    - pressure level in millibars (e.g. 300)
//   west, east, south, north - bbox in degrees
//   vars   - comma-separated, default UGRD,VGRD,TMP,HGT
//
// Example: /api/gfs?cycle=2026050400&fhr=3&lev=300&west=139&east=241&south=29&north=41

var GRIB2CLASS = require('grib2class');

// Variable identification by (discipline, category, parameter) tuple.
var VAR_MAP = {
  '0,2,2': 'UGRD',  // U-Component of Wind
  '0,2,3': 'VGRD',  // V-Component of Wind
  '0,0,0': 'TMP',   // Temperature
  '0,3,5': 'HGT'    // Geopotential Height
};

var ALLOWED_VARS = ['UGRD', 'VGRD', 'TMP', 'HGT'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function bad(res, code, msg) {
  setCors(res);
  res.status(code).json({ error: msg });
}

function buildNomadsUrl(p) {
  var ymd = p.cycle.slice(0, 8);
  var hh = p.cycle.slice(8, 10);
  var fhr = String(p.fhr).padStart(3, '0');

  var file = 'gfs.t' + hh + 'z.pgrb2.0p25.f' + fhr;
  var dir = '/gfs.' + ymd + '/' + hh + '/atmos';

  var qs = ['file=' + file, 'lev_' + p.lev + '_mb=on'];
  for (var i = 0; i < p.vars.length; i++) {
    qs.push('var_' + p.vars[i] + '=on');
  }
  qs.push('subregion=');
  qs.push('leftlon=' + p.west);
  qs.push('rightlon=' + p.east);
  qs.push('toplat=' + p.north);
  qs.push('bottomlat=' + p.south);
  qs.push('dir=' + encodeURIComponent(dir));

  return 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?' + qs.join('&');
}

// Read 32-bit big-endian unsigned int from Buffer.
function readU32BE(buf, offset) {
  return (buf[offset] * 0x1000000) +
         ((buf[offset + 1] << 16) >>> 0) +
         (buf[offset + 2] << 8) +
         buf[offset + 3];
}

// Split a buffer containing concatenated GRIB2 messages.
// Each message starts with "GRIB" magic and has 8-byte total length at offset+8.
function splitGribMessages(buf) {
  var messages = [];
  var i = 0;
  var n = buf.length;
  while (i <= n - 16) {
    if (buf[i] === 0x47 && buf[i + 1] === 0x52 &&
        buf[i + 2] === 0x49 && buf[i + 3] === 0x42) {
      // 8-byte length: high 4 bytes at +8, low 4 bytes at +12.
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
      // Round to 2 decimals to shrink JSON. UGRD/VGRD/TMP/HGT all need < 2 decimals.
      arr[i] = (v === undefined || v === null || isNaN(v))
        ? null
        : Math.round(v * 100) / 100;
    }
  } else {
    arr = [];
  }

  return {
    name: name,
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
  var lev = parseInt(q.lev, 10);
  if (isNaN(lev) || lev <= 0) {
    return bad(res, 400, 'lev (mb) required');
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

  var url = buildNomadsUrl({
    cycle: q.cycle, fhr: fhr, lev: lev,
    west: west, east: east, south: south, north: north,
    vars: requested
  });

  try {
    var resp = await fetch(url, {
      headers: { 'User-Agent': 'ana-Calculator-gfs-proxy/0.1' }
    });
    if (!resp.ok) {
      return bad(res, 502, 'NOMADS responded ' + resp.status + ': ' + resp.statusText);
    }
    var ab = await resp.arrayBuffer();
    var buf = Buffer.from(ab);
    if (buf.length < 16) {
      return bad(res, 502, 'empty/short response from NOMADS (' + buf.length + ' bytes)');
    }

    var messages = splitGribMessages(buf);
    if (messages.length === 0) {
      return bad(res, 502, 'no GRIB messages in response (got ' + buf.length + ' bytes)');
    }

    var vars = {};
    var meta = null;
    var grid = null;
    var parseErrors = [];

    for (var m = 0; m < messages.length; m++) {
      try {
        var parsed = parseMessage(messages[m]);
        vars[parsed.name] = parsed.data;
        if (!grid) {
          grid = {
            nx: parsed.nx, ny: parsed.ny,
            la1: parsed.la1, lo1: parsed.lo1,
            la2: parsed.la2, lo2: parsed.lo2
          };
          meta = {
            cycle: q.cycle,
            fhr: fhr,
            lev: lev,
            refTime: parsed.refTime,
            forecastHours: parsed.forecastHours,
            messageCount: messages.length
          };
        }
      } catch (e) {
        parseErrors.push({ index: m, error: e.message });
      }
    }

    setCors(res);
    // GFS for a given cycle is stable forever; cache aggressively at the edge.
    res.setHeader('Cache-Control', 'public, s-maxage=21600, max-age=600');
    res.status(200).json({
      meta: meta,
      grid: grid,
      vars: vars,
      parseErrors: parseErrors.length ? parseErrors : undefined
    });

  } catch (err) {
    console.error('handler error:', err);
    return bad(res, 500, err.message || 'internal error');
  }
};
