// Vercel Function: /api/sat/wms-relay
// GET — relay EUMETSAT View WMS GetMap (CORS + edge cache)

const UPSTREAM = "https://view.eumetsat.int/geoserver/wms";
const VALID_LAYER_PREFIX = "msg_iodc:";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function badRequest(res, message) {
  setCors(res);
  return res.status(400).json({ error: message });
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

  const q = req.query || {};
  const service = String(q.service || q.SERVICE || "").toLowerCase();
  const request = String(q.request || q.REQUEST || "").toLowerCase();
  const layers = String(q.layers || q.LAYERS || "");

  if (service !== "wms") {
    return badRequest(res, "invalid service");
  }
  if (request !== "getmap") {
    return badRequest(res, "invalid request");
  }
  if (!layers.startsWith(VALID_LAYER_PREFIX)) {
    return badRequest(res, "invalid layers");
  }

  const params = new URLSearchParams();
  Object.keys(q).forEach(function(key) {
    if (key === "_") return;
    params.append(key, String(q[key]));
  });

  const upstream = UPSTREAM + "?" + params.toString();

  try {
    const r = await fetch(upstream, { redirect: "follow" });
    if (!r.ok) {
      return res.status(r.status).end();
    }
    const ct = r.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, s-maxage=600, max-age=600");
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(502).json({ error: "upstream failed" });
  }
}
