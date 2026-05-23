// Vercel Function: /api/sat/latest_times
// GET /api/sat/latest_times?sat=goes-18&sector=full_disk&product=band_13
// RAMMB latest_times JSON relay (CORS + whitelist)

const VALID_SATS = ["goes-18", "goes-19", "goes-16", "goes-17", "himawari", "meteosat-9", "meteosat-11"];
const VALID_SECTORS = ["full_disk", "conus", "mesoscale_01", "mesoscale_02"];
const VALID_PRODUCTS = ["band_13", "band_08", "band_09", "geocolor", "cira_geocolor"];

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

  const sat = String(req.query.sat || "").trim();
  const sector = String(req.query.sector || "full_disk").trim();
  const product = String(req.query.product || "band_13").trim();

  if (!sat || !VALID_SATS.includes(sat)) {
    return badRequest(res, "invalid sat");
  }
  if (!VALID_SECTORS.includes(sector)) {
    return badRequest(res, "invalid sector");
  }
  if (!VALID_PRODUCTS.includes(product)) {
    return badRequest(res, "invalid product");
  }

  const urls = [
    `https://rammb-slider.cira.colostate.edu/data/json/${sat}/${sector}/${product}/latest_times_5760.json`,
    `https://rammb-slider.cira.colostate.edu/data/json/${sat}/${sector}/${product}/latest_times.json`
  ];

  for (const upstream of urls) {
    try {
      const r = await fetch(upstream, { redirect: "follow" });
      if (r.ok) {
        const data = await r.json();
        res.setHeader("Cache-Control", "public, s-maxage=60, max-age=60");
        return res.status(200).json(data);
      }
    } catch (err) {
      // try next upstream
    }
  }

  return res.status(502).json({ error: "upstream failed" });
}
