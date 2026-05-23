// Vercel Function: /api/sat/realearth-relay
// GET — relay SSEC RealEarth image tiles (CORS + edge cache)

const UPSTREAM = "https://realearth.ssec.wisc.edu/api/image";
const VALID_PRODUCT = /^[A-Z0-9-]+(_\d{8}_\d{6})?(\.\d+)?$/;

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
  const products = String(q.products || q.Products || "");
  const x = String(q.x ?? q.X ?? "");
  const y = String(q.y ?? q.Y ?? "");
  const z = String(q.z ?? q.Z ?? "");

  if (!products || !VALID_PRODUCT.test(products)) {
    return badRequest(res, "invalid products");
  }
  if (!/^\d+$/.test(x) || !/^\d+$/.test(y) || !/^\d+$/.test(z)) {
    return badRequest(res, "invalid tile coords");
  }

  const params = new URLSearchParams();
  params.set("products", products);
  params.set("x", x);
  params.set("y", y);
  params.set("z", z);
  if (q.time || q.Time) {
    params.set("time", String(q.time || q.Time));
  }
  if (q.format || q.Format) {
    params.set("format", String(q.format || q.Format));
  }

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
    return res.status(502).end();
  }
}
