/* Vercel serverless function — /api/pyth
 *
 * Pyth Core was upgraded on 26 Aug 2026 and Hermes now requires an API key.
 * A browser cannot hold that key: anything shipped to the page is public, and
 * a leaked key is someone else burning your quota. So the key lives here, in
 * a server-side environment variable, and the page calls its own origin.
 *
 * Setup, once:
 *   1. Get a key at https://pythdata.app/signup
 *   2. Vercel → project → Settings → Environment Variables
 *      Name: PYTH_API_KEY   Value: <your key>   (all environments)
 *   3. Redeploy.
 *
 * Calling CORS is gone too — same origin, so no preflight.
 */

const UPSTREAM = 'https://pyth.dourolabs.app/hermes/v2/updates/price/latest';

export default async function handler(req, res) {
  const key = process.env.PYTH_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'PYTH_API_KEY is not set on this deployment.' });
    return;
  }

  // Accept both ?ids[]=0x… (what the page sends) and ?ids=0x…
  const raw = req.query['ids[]'] ?? req.query.ids ?? [];
  const ids = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  if (!ids.length) {
    res.status(400).json({ error: 'No price feed ids given.' });
    return;
  }
  // A price feed id is 32 bytes of hex, optionally 0x-prefixed. Reject anything
  // else rather than forwarding arbitrary strings upstream on our key.
  const bad = ids.find(id => !/^(0x)?[0-9a-fA-F]{64}$/.test(String(id)));
  if (bad) {
    res.status(400).json({ error: 'Not a valid price feed id.' });
    return;
  }

  const qs = new URLSearchParams();
  for (const id of ids) qs.append('ids[]', String(id));
  if (req.query.encoding === 'hex' || req.query.encoding === 'base64') {
    qs.set('encoding', req.query.encoding);
  }

  try {
    const upstream = await fetch(`${UPSTREAM}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${key}`, accept: 'application/json' }
    });
    const body = await upstream.text();

    // Display reads tolerate a few seconds of edge cache; the signed update
    // blob used for an on-chain rebalance must not be reused, so it is never
    // cached (the page asks for it with encoding=hex).
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Cache-Control',
      req.query.encoding ? 'no-store' : 's-maxage=5, stale-while-revalidate=25'
    );
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Pyth request failed.', detail: String(e && e.message || e) });
  }
}
