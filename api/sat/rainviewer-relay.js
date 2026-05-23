// Vercel Function: /api/sat/rainviewer-relay
// GET — relay RainViewer radar tiles (CORS + edge cache, 429 mitigation)

const UPSTREAM = "https://tilecache.rainviewer.com/";
const VALID_PATH = /^v2\/(radar|satellite)\/[a-z0-9]+\/256\/\d+\/\d+\/\d+\/4\/1_1\.png$/i;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function badRequest(res, message) {
  setCors(res);
  return res.status(400).json({ error: message });
}

function getTilePath(req) {
  const q = req.query || {};
  if (q.path) {
    return Array.isArray(q.path) ? q.path.join("/") : String(q.path);
  }
  const raw = String(req.url || "");
  const m = raw.match(/[?&]path=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
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

  const path = getTilePath(req);
  if (!path || !VALID_PATH.test(path)) {
    return badRequest(res, "invalid path");
  }

  const upstream = UPSTREAM + path;

  try {
    const r = await fetch(upstream, { redirect: "follow" });
    if (!r.ok) {
      return res.status(r.status).end();
    }
    const ct = r.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, s-maxage=120, max-age=120");
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(502).end();
  }
}
