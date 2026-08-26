# Pay on Arc

**Subscriptions that collect themselves.**

A $5 monthly plan cannot survive on a chain where collecting it costs more than
it earns. On Arc a charge costs a rounding error and gas is USDC, so a
subscription can pull its own money every period with nobody clicking anything —
and a billing agent living in the page can do the pulling.

That is the product. Around it: payments with an on-chain note, pay-links,
20-way splits, recallable payments, Chainlink CCIP cross-chain messaging, and a
Pyth-fed treasury agent that rebalances USDC against EURC.

Single static page — `index.html` — plus a vendored copy of ethers and a
Playwright test suite.

## The tabs

| Tab | What it does |
| --- | --- |
| **Subscriptions** | Approve USDC once; each period is pulled only when due. Cancel on-chain from either side. |
| **Billing Agent** | A burner-key worker in the page that scans the contract every 15s and charges what is due, unattended. Testnet only. |
| Pay & Link | A payment with a note written on-chain, or a shareable pay-link that prefills it. |
| Split | One transaction, equal shares to up to 20 wallets, dust returned. |
| Recallable | The recipient can claim; if they never do, the sender takes it back after the window. |
| Cross-Chain | A message through the CCIP router that lands and runs code on the far chain. |
| Treasury | Reads the Pyth EUR/USD feed and pays a keeper to settle drift back into band. |
| Receipts | Your payments, read from the contract's own events. |

## Running locally

```bash
npm install          # test tooling only; the page itself has no build step
npm run serve        # http://127.0.0.1:8080
npm test             # headless Playwright suite
```

The page can also be opened straight from a static host; nothing is compiled.

## Switching networks

Every chain constant lives in one place: the `NETWORKS` map at the top of the
inline script in `index.html`. Nothing else in the file hardcodes a chain ID,
an RPC, an explorer or a contract address.

```js
const ACTIVE_NETWORK = 'arc-testnet';   // ← the only line to change
```

To go live, fill in the `arc-mainnet` profile and flip that constant:

| Key | What it needs |
| --- | --- |
| `chainId`, `rpc`, `scan` | Arc mainnet chain ID, RPC endpoint, block explorer |
| `native` | Symbol and decimals of the native gas token |
| `contracts.pay` | Pay on Arc payments contract |
| `contracts.subs` | Subscriptions contract |
| `contracts.treasury` | Treasury agent contract |
| `contracts.usdc`, `contracts.eurc` | Stablecoin token addresses |
| `contracts.ccipRouter` | Chainlink CCIP router on Arc |
| `contracts.pyth` | Pyth contract on Arc |
| `ccip.destSelector`, `ccip.receiver`, `ccip.destRpc`, `ccip.destScan` | The far side of the CCIP lane |

`configProblems()` runs at boot and refuses to start on a profile with blanks,
listing exactly what is missing — a half-configured build cannot quietly send
real money to the zero address.

### What changes automatically on a non-testnet profile

The **billing agent** keeps a burner private key in `localStorage`. That is a
reasonable trade for a testnet demo and a bad one for real funds, so the whole
tab disables itself when `testnet: false`. Merchants collect with the
"Collect all due payments" button, or by running a keeper from a server they
control. Do not re-enable the in-browser agent for mainnet without moving the
key somewhere it belongs.

## Dependencies

`ethers` 6.13.2 is loaded from cdnjs with a Subresource Integrity hash and
`crossorigin="anonymous"`, falling back to the same-origin copy in `vendor/`
if the CDN is unreachable or the hash does not match. Deploy `vendor/`
alongside `index.html`.

To bump the version: replace `vendor/ethers-<v>.umd.min.js`, update both the
CDN URL and the `integrity` attribute, and recompute the hash with

```bash
echo -n "sha384-$(openssl dgst -sha384 -binary vendor/ethers-<v>.umd.min.js | openssl base64 -A)"
```

The test suite serves the vendored bytes in place of the CDN, so a stale
`integrity` attribute fails `tests/smoke.spec.js` rather than production.

## Contracts

`contracts/ArcPayV2.sol` is the payments contract deployed at the `pay` address
in the network profile. The subscriptions and treasury contracts are deployed
on-chain but their sources are not in this repository yet.

### Review notes on ArcPayV2

Read as part of wiring the frontend to it. Not an audit — an audit is still
required before any mainnet profile is filled in.

**Sound**

- `claim()` and `recall()` both set `status` *before* the external call, so a
  re-entering recipient hits the `status == 0` guard. No drain path.
- A recipient contract that rejects the transfer cannot strand a recallable
  payment: `claim()` reverts, but the sender can still `recall()` after the
  window.
- No owner, no pause, no upgrade path — nothing to trust.
- The recall window is bounded to 60s–30 days.

**Worth changing**

- `splitPay()` reverts the whole batch if *any* recipient rejects the transfer
  (`require(ok)` inside the loop). One recipient contract without a payable
  fallback — deliberate or accidental — blocks the entire split. A pull-payment
  pattern, or crediting failed shares for later withdrawal, removes the
  griefing vector.
- `splitPay()` ignores a failed dust refund (`ok2;`). The remainder is then
  stranded in the contract permanently, and the contract balance no longer
  equals the sum of pending recallables.
- `sentBy()` / `receivedBy()` return unbounded arrays. Fine today; for a very
  active address these view calls will eventually outgrow a node's response
  limits, and a paginated variant would age better.

**Used by the frontend**

`sentBy()` and `receivedBy()` are the authoritative list of a user's recallable
payments, so the Recallable tab reads them directly rather than scanning logs.
Notes live only in `RecallableCreated`, so they are fetched best-effort and a
missing log costs a note rather than the whole row.

## Tests

`tests/` drives the real page in headless Chromium against a stubbed Arc RPC
and a stubbed EIP-1193 wallet — no chain, no funds, no network.

| File | Covers |
| --- | --- |
| `smoke.spec.js` | Boot, SRI, CDN fallback, tabs, config-driven markup, label/input association |
| `validation.spec.js` | Amount parsing (incl. comma decimals) and every form's rejection paths |
| `paylink.spec.js` | Pay-link generation and consumption |
| `security.spec.js` | Escaping of chain- and URL-sourced strings, script pinning |
| `chain-guard.spec.js` | Wrong-network refusal, chain add, disconnect cleanup |
| `config.spec.js` | Unconfigured-network refusal |
| `navigation.spec.js` | Landing pitch, tab folding, deep links, keyboard tablist, live pricing |

If Playwright cannot download its own browser, point it at an existing one:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm test
```

### Screenshots

`tests/shot.js` renders the page against the same stubs and writes PNGs:

```bash
node tests/static-server.js &
node tests/shot.js ./shots
```
