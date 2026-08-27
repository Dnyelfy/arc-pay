/* Vercel serverless function — /api/pyth
 *
 * This file only does anything on a host that runs serverless functions. On
 * plain static hosting (GitHub Pages and friends) /api/pyth is a 404, which is
 * fine — index.html treats this proxy as the first of several Pyth sources and
 * falls through to public Hermes on its own. Do not make it the only source.
 *
 * Its reason to exist is the API key. A browser cannot hold one: anything
 * shipped to the page is public, and a leaked key is someone else burning your
 * quota. So the key lives here, in a server-side environment variable, and the
 * page calls its own origin. With no key set, this forwards to public Hermes
 * unauthenticated instead of failing.
 *
 * To use a key:
 *   1. Get one from your Pyth data provider.
 *   2. Vercel → project → Settings → Environment Variables
 *      Name: PYTH_API_KEY   Value: <your key>   (all environments)
 *   3. Redeploy.
 *
 * CORS does not apply on the proxied path — same origin, so no preflight.
 */

const KEYED   = 'https://pyth.dourolabs.app/hermes/v2/updates/price/latest';
const PUBLIC  = 'https://hermes.pyth.network/v2/updates/price/latest';

export default async function handler(req, res) {
  // A missing key is not fatal: fall through to public Hermes and let it decide.
  // Returning 500 here made an unconfigured deployment strictly worse than no
  // proxy at all, because the page could no longer reach Pyth by any route.
  const key = process.env.PYTH_API_KEY;
  const upstream_url = key ? KEYED : PUBLIC;

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
    const upstream = await fetch(`${upstream_url}?${qs.toString()}`, {
      headers: key
        ? { Authorization: `Bearer ${key}`, accept: 'application/json' }
        : { accept: 'application/json' }
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
