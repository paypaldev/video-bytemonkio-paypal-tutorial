# Decisions

Choices made while building this, and what they cost. Written for the PayPal
engineers reviewing the repo, and for anyone who clones it and wonders why it
is shaped this way.

---

## Raw REST over `fetch`, not a server SDK

**Decision.** Every PayPal call goes through one thin wrapper around `fetch` in
`src/paypal/client.ts`.

**Why.** The video's argument is that the API exposes the reality of moving
money rather than hiding it — so the headers have to be visible. On screen you
can see `PayPal-Request-Id` being set, see `PayPal-Mock-Response` triggering a
specific failure, and see the raw structured error body. An SDK would abstract
away exactly the things being argued about.

**Cost.** It does not exercise the official server SDKs, which are a real part
of PayPal's developer experience. A reviewer wanting to assess SDK quality will
not find it here. The wrapper is ~150 lines and would translate directly.

---

## Derived request ids, not random ones

**Decision.** `requestIdFor("capture", orderId)` returns `capture-<orderId>` —
deterministic, derived from the business action.

**Why.** The failure that idempotency exists for is: request sent, no response,
process dies. A UUID generated at call time is lost with the process, so the
retry mints a new one and PayPal sees a different call. A derived id survives
crashes, restarts, double clicks, and retries in a different process.

**Cost.** Ids are guessable, and they encode a business identifier. For a
capture keyed on an order id that is fine — the order id is not a secret and
the id is only meaningful to the merchant account that owns it. A system where
that is not true should use a stored random id, generated once and persisted
*before* the call, which is what the ledger already does.

---

## A local idempotency ledger as well as the header

**Decision.** `src/store/ledger.ts` records the attempt before the call and the
outcome after it.

**Why.** `PayPal-Request-Id` makes the remote side safe. It does not tell your
own process, after a restart, that a capture was already attempted and with
which id. The ledger is the local half of the same property.

**Cost.** Two things to keep consistent. The ledger can say `STARTED` forever
if the process dies between the write and the call — deliberately, since
`STARTED` with a known request id is exactly enough to retry safely.

---

## Both webhook verification methods

**Decision.** `verifySelf` (local RSA check) and `verifyPostback` (ask PayPal)
are both implemented. Self-verification is the default;
`WEBHOOK_VERIFY_METHOD=postback` switches.

**Why.** They fail differently and the trade-off is worth showing. Self is
faster, has no extra dependency on PayPal being reachable at the moment an
event lands, and is what PayPal recommends. Postback is easier to reason about
and needs no crypto code, at the cost of a network round trip on every event —
including during an incident, which is when events arrive in bulk.

**Cost.** Two code paths. The self path also needs the certificate cache and
the cert-URL host check, which is real security surface — see below.

---

## The `paypal-cert-url` host check

**Decision.** `assertTrustedCertUrl` refuses any certificate URL that is not
HTTPS on a `paypal.com` host.

**Why.** `paypal-cert-url` is a header on an unauthenticated inbound request:
attacker-controlled input. Without the check, an attacker points it at a
certificate they hold the private key for, signs a forged "payment completed"
event, and verification passes. If you are implementing self-verification from
any example, check that the example validates this.

**Cost.** If PayPal ever serves certificates from a new domain, verification
breaks until the allowlist is updated. That is the correct direction to fail.

---

## `payment_source` is opt-in, not the default

**Decision.** `createOrder` only sends
`payment_source.paypal.experience_context` when the caller asks for it with
`payPalWalletOnly: true`. The CLI scenarios ask; the checkout page does not.

**Why.** Naming a payment source at creation makes it the order's *preferred*
source, and approving with a different one fails with
`PREFERRED_PAYMENT_SOURCE_MISMATCH`. An order created with `payment_source.paypal`
therefore cannot be paid with the Venmo button — which would quietly break the
Venmo section while every other test still passed.

**Cost.** Orders created by the checkout page do not get `brand_name` or
`user_action: PAY_NOW`. That is the correct trade: the buyer chooses how to pay,
and the server does not pre-empt them.

---

## Claims are written `PENDING` before the handler runs

**Decision.** `claimEvent` inserts with `outcome: "PENDING"` and only a
*finished* row makes a later delivery a replay.

**Why.** The naive version — insert as processed, then do the work — turns a
crash mid-handler into permanent silence: PayPal redelivers, the row already
exists, the redelivery is dropped as a duplicate, and a paid order is never
fulfilled. PayPal's redelivery is the recovery mechanism, so the dedupe must
not eat it.

**Cost.** A row can sit `PENDING` forever if the process dies and PayPal
eventually stops retrying (25 attempts over 3 days). That is visible in
`.data/events.json` and in `/api/events`, which is the point — an unfinished
claim should be findable, not invisible.

---

## Rejected deliveries live in their own table

**Decision.** `recordRejection` writes to `rejections`, keyed on time, never to
`events`, keyed on event id.

**Why.** The `id` field in a body that failed verification is attacker-supplied.
If rejections shared the events table, anyone who could reach the endpoint could
overwrite the audit record of a genuine event, or pre-claim an id so the real
delivery arrived later and was discarded as a duplicate — silent non-fulfilment
of a paid order from an unauthenticated request.

**Cost.** Two tables to look at instead of one. `/api/rejections` exists for
exactly that.

---

## Node 22, TypeScript, zero runtime dependencies except Express

**Decision.** `express` is the only production dependency. `.env` loading uses
`process.loadEnvFile`, CRC32 uses `zlib.crc32`, UUIDs use `node:crypto`, HTTP
uses global `fetch`.

**Why.** Anyone cloning this should be able to read every line that runs. Fewer
dependencies is fewer things to explain and fewer things to go stale.

**Cost.** Node 22 or newer is required — `zlib.crc32` and `process.loadEnvFile`
are recent. Stated in `engines` and checked by the doctor.

---

## JSON files instead of a database

**Decision.** `src/store/json-store.ts`, one file per table in `.data/`.

**Why.** A reviewer can `cat .data/events.json` and see exactly what the
application believed and when. Adding Postgres would make the repo harder to
run and would not make any of the payment logic more correct.

**Cost.** It is not concurrency-safe in the way a database is. `claimEvent` is a
read-then-write, not an atomic operation — under genuinely concurrent delivery
two processes could both believe they were first. In production the dedupe
boundary is a UNIQUE constraint or a conditional update inside a transaction:
`INSERT ... ON CONFLICT DO NOTHING`, and you check the row count. The shape of
the logic is identical; the atomicity guarantee is not. Writes are at least
atomic per file (write temp, rename) so a crash cannot leave a half-written
ledger.

---

## Scenario scripts instead of one application

**Decision.** `scenarios/` holds seven small scripts. The server does the
minimum needed for the checkout page and the webhook listener.

**Why.** Each script is one idea, runnable in isolation, with console output
written to be read aloud. A single application demonstrating all of this would
bury each idea in the others.

**Cost.** Some duplication between the scripts and the server's request path —
for instance both capture orders. That duplication is deliberate: the server
shows the production shape, the scripts show the argument.

---

## JS SDK v6 for the checkout page

**Decision.** `public/index.html` uses the v6 Web SDK: `createInstance`,
`findEligibleMethods`, and the `<paypal-button>` / `<venmo-button>` web
components, loaded from `https://www.sandbox.paypal.com/web-sdk/v6/core`.

**Why.** v6 is the generation PayPal steers new integrations toward, and this
repo warns against following outdated integration generations, so showing
anything else would be inconsistent.

It also demonstrates the point better than v5 did. In v5 you declared what you
wanted with `enable-funding=venmo` and hoped; the eligibility API reported
nothing usable in sandbox, so the page could not honestly say whether Venmo was
available. In v6 you *ask*: `findEligibleMethods()` returns what this specific
buyer can use, and you reveal only those buttons. "Check before you render" is a
better lesson than "declare and hope".

**What changed from v5**, for anyone comparing:

| v5 | v6 |
| --- | --- |
| Query params on the script URL | `createInstance({ clientId, components })` |
| `enable-funding=venmo` | `components: ["venmo-payments"]` plus an eligibility check |
| `buyer-country=US` | `findEligibleMethods({ countryCode })` |
| `paypal.Buttons().render()` | `<paypal-button>` web component, revealed when eligible |
| `createOrder` returns an id string | `createOrder` returns `{ orderId }` |
| `onApprove(data)` with `data.orderID` | `onApprove(data)` with `data.orderId` |
| One host, `?client-id=` | Separate sandbox and live hosts |

**Cost.** v6 is newer, so there is less third party material to fall back on
when something behaves unexpectedly. The redirect-resume path
(`hasReturned()` / `resume()`) is implemented but only exercised when the SDK
chooses redirect over popup, which it does not usually do on desktop.

---

## Simulated subscription failures

**Decision.** `npm run subscriptions -- --simulate` drives the state machine
with fixture events, clearly labelled as simulated.

**Why.** A real renewal failure is a month away. The alternative — waiting, or
faking it silently — is either impossible or dishonest.

**Cost.** The simulation exercises the app's state machine and not PayPal's
event delivery. The live path (`--suspend` / `--activate`) does exercise real
webhooks for the transitions that can be triggered on demand, and the two are
kept separate so nobody mistakes one for the other.

---

## Grace policy below PayPal's failure threshold

**Decision.** `DEFAULT_POLICY.graceFailures` is 2, while the demo plan's
`payment_failure_threshold` is 3.

**Why.** If your grace period outlasts PayPal's retries, PayPal suspends the
subscription while your application still believes the customer is fine. The
customer is locked out by a system that thinks it granted them access.

**Cost.** Slightly stricter than necessary. The point is the ordering
relationship, not the specific numbers, and the simulation makes the failure
mode visible if you invert them.

---

## What this repo deliberately does not do

- **No PCI-scope card handling.** No card fields, no vaulting. That is a
  different integration with different obligations.
- **No partial captures, no refund flows beyond the webhook.** Both are real
  and neither is in the script.
- **No auth on the demo endpoints.** `/api/events`, `/api/rejections`,
  `/api/orders`, `/api/subscriptions` and `/api/orders/:id/paypal` are all open
  because this is a local demo. The last one is the one that matters: it
  proxies any order in the merchant account and the response includes the
  buyer's name and email. In anything real, all of them are admin-only.
- **No retry queue.** Failed webhook processing relies on PayPal's own
  redelivery, which is the right default and is worth saying out loud rather
  than hiding behind a queue nobody can see.
