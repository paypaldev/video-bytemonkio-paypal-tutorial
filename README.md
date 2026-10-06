# Payment Systems in 2026 — a PayPal sandbox integration

A working PayPal integration built the way a payment actually behaves: as a
distributed system with three stages, two sources of truth, and a lot of
failure modes that only show up when something goes wrong.

The happy path is here, and it takes about ten minutes to run. The rest of the
repo is about what happens after that — the timeout you cannot interpret, the
webhook that arrives twice, the renewal that fails eighteen months in.

Everything runs against the **PayPal sandbox**. No real money moves. The
scenarios refuse to start if `PAYPAL_ENV` is set to `live`.

> Companion code for the ByteMonk video *Payment Systems in 2026 | PayPal*.
> If you are here to break things yourself, skip to
> [Break it yourself](#break-it-yourself).
>
> New to payments? Start with [docs/PRIMER.md](docs/PRIMER.md), which explains
> the whole flow from first principles: who the parties are, what the sandbox
> is, why webhooks exist, and what every event and environment variable means.

---

## What's in here

| Scenario | Command | What it demonstrates |
| --- | --- | --- |
| Setup check | `npm run doctor` | Every part of the setup, with the exact fix for each failure |
| Checkout | `npm run checkout` | Orders v2: create → approve → capture |
| Authorization vs capture | `npm run checkout -- --authorize` | The bank's promise and the payment, as two separate events |
| Idempotency | `npm run idempotency` | The same capture sent twice, both responses printed |
| Webhooks | `npm run webhook-replay` | Verification, duplicate delivery, out-of-order arrival |
| Errors | `npm run errors` | A decline, a bad request and a 5xx, handled three different ways |
| Subscriptions | `npm run subscriptions` | Product → plan → subscription, and the state machine after it |
| Venmo | `npm run venmo` | Venmo as a funding source in the same checkout |
| AI agents | `npm run agent` | An agent creating an order under scoped access and an audit log |
| Reset | `npm run reset` | Clears local state between runs. PayPal's records are untouched |

Plus a checkout page at `http://localhost:8888/` and a webhook listener at
`/webhooks/paypal`.

---

## The idea the code is built around

A payment is not one API call. It is at least three stages, and they belong to
different parties on different timelines:

```
  authorization          capture              settlement
  ─────────────          ───────              ──────────
  the bank checks        the money            the money reaches
  and reserves funds     actually moves       your account
  no money moved         you control this     hours or days later
                                              you do not control this
```

Two consequences run through the whole repo:

1. **You will sometimes not know what happened.** A request times out. The
   payment may or may not have gone through. Retrying is the only way to find
   out, and retrying is also how you charge someone twice. `PayPal-Request-Id`
   is what makes those two statements stop contradicting each other.

2. **Your application learns the truth late, and out of order.** The buyer's
   browser and PayPal's webhook are two racing messengers carrying the same
   news. Either can arrive first, and both can arrive more than once.

---

## Setup

Roughly fifteen minutes, most of it in PayPal's dashboard. Run
`npm run doctor` at any point — it checks each step and names the page that
fixes it.

### 1. Prerequisites

- Node.js 22 or newer (`node --version`)
- npm
- A PayPal developer account — free, no business account needed:
  <https://developer.paypal.com/dashboard/>. You sign in there with an ordinary
  PayPal account; the sandbox test accounts it later creates for you are for
  paying with, not for signing in.

### 2. Install

```bash
git clone <this repo>
cd <the folder it created>
npm install
cp .env.example .env
```

### 3. Sandbox app credentials

1. Open <https://developer.paypal.com/dashboard/applications/sandbox>.
2. **Create App** — give it any name. Choose the **Merchant** type.
3. Copy the **Client ID** and **Secret** into `.env`:

```dotenv
PAYPAL_CLIENT_ID=AY...
PAYPAL_CLIENT_SECRET=EL...
```

> Make sure you are on the **Sandbox** tab, not Live. Credentials from the
> wrong tab produce a 401 that looks like a typo. `npm run doctor` will tell
> you which one you have.

### 4. Sandbox test accounts

<https://developer.paypal.com/dashboard/accounts> — PayPal creates a personal
(buyer) and a business (merchant) account for you automatically. You need the
**buyer**'s email and password to approve payments. Click the account →
**View/Edit account** to see or change the password.

For the Venmo demo, the buyer account must be **US-based**.

At this point the first two scenarios work:

```bash
npm run doctor
npm run checkout
```

### 5. Webhook tunnel

PayPal delivers webhooks to a public HTTPS URL on port 443, so `localhost`
alone will not do. Any tunnel works. `cloudflared` is suggested first because it
needs no account and shows no interstitial page:

```bash
# terminal 1
npm run server

# terminal 2
cloudflared tunnel --url http://localhost:8888
#   https://random-words-here.trycloudflare.com
```

Put the public URL in `.env`:

```dotenv
PUBLIC_BASE_URL=https://random-words-here.trycloudflare.com
```

Alternatives:

```bash
# no install at all — just ssh
ssh -R 80:localhost:8888 localhost.run

# ngrok — requires a free account before it will start
ngrok config add-authtoken <your-token>   # dashboard.ngrok.com → Your Authtoken
ngrok http 8888
```

> These URLs change every restart. When one does, update both
> `PUBLIC_BASE_URL` and the webhook in the dashboard. `npm run doctor` warns
> you when the two have drifted apart — it is the most common reason webhooks
> stop arriving.

### 6. Subscribe the webhook

1. <https://developer.paypal.com/dashboard/applications/sandbox> → your app.
2. Scroll to **Webhooks** → **Add Webhook**.
3. URL: `https://your-tunnel-url/webhooks/paypal`
4. Event types: select **All events**, or at minimum:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `BILLING.SUBSCRIPTION.ACTIVATED`
   - `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
   - `BILLING.SUBSCRIPTION.SUSPENDED`
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `PAYMENT.SALE.COMPLETED`
5. Save. The webhook now appears in the table on that page, with a **Webhook ID**
   column next to the URL. It looks like `1AB23456CD789012E`. Copy it into
   `.env`:

```dotenv
PAYPAL_WEBHOOK_ID=1AB23456CD789012E
```

> Can't find it? Run `npm run doctor`. With credentials configured it lists every
> webhook registered for your app, with its id and URL, so you can copy straight
> from the terminal.

The webhook ID is not optional. It is part of the signed message, so without
it no signature can be verified — every delivery gets rejected, correctly.

### 7. Confirm

```bash
npm run doctor
```

Green across the board means every demo in this repo will run.

---

## Break it yourself

This is the part worth your time. Each of these is a real failure, reproduced
on purpose.

### Send the same capture twice

```bash
npm run idempotency
```

Approve in the browser when prompted. The script captures, then sends the
**exact same request again** with the same `PayPal-Request-Id`.

Look at the two responses: same capture id, same `create_time`. The second call
did not create anything — PayPal returned the stored result of the first.

Now watch what you lose without it:

```bash
npm run idempotency -- --unsafe
```

Same double call, no request id. PayPal still refuses to double-charge, but it
refuses with an **error** you have to interpret rather than a **result** you
can use. That difference is the whole feature.

**Try:** run `npm run idempotency` twice against the same order with
`-- --order <ORDER-ID>`. Kill the process mid-capture (Ctrl-C) and run it
again — the ledger in `.data/ledger.json` remembers the request id, so the
retry after a crash is the same call, not a new one.

### Deliver the same webhook twice

```bash
npm run webhook-replay -- --offline     # the logic, no tunnel needed
npm run webhook-replay                  # the real thing
```

The live run makes a payment, waits for the real `PAYMENT.CAPTURE.COMPLETED`
event, then asks PayPal to **redeliver that same event** — the API equivalent
of the Resend button in the dashboard.

In the server terminal you will see the second delivery marked `↻ REPLAY`. The
evidence is in `.data/events.json` and `.data/orders.json`:

```jsonc
// events.json — the event was delivered twice
"deliveries": 2,
"outcome": "REPLAY",
"firstSeenAt": "2026-08-18T13:54:57.224Z",
"lastSeenAt":  "2026-08-18T13:59:57.715Z",   // five minutes later

// orders.json — and the order did not notice
"fulfilmentAttempts": 1,
"fulfilledAt": "2026-08-18T13:54:57.227Z"    // unchanged
```

Note `fulfilmentAttempts` stays at **1**, not 2. The duplicate is stopped at
the event id, one layer *above* the business logic, so `fulfil()` is never
called a second time — it does not need to defend itself here. It defends
itself in the out-of-order case below, where the webhook and the redirect are
two genuinely different messengers rather than the same event twice.

You can also replay by hand: dashboard → your app → Webhooks → **Webhook
Events** → pick an event → **Resend**.

**Try:** stop the server and let PayPal retry on its own. A non-2xx response
(or none at all) makes PayPal redeliver up to 25 times over 3 days. Start the
server again and watch the backlog arrive — and get deduplicated.

### Forge a webhook

With the server running:

```bash
curl -X POST http://localhost:8888/webhooks/paypal \
  -H "Content-Type: application/json" \
  -d '{"id":"WH-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED",
       "resource":{"id":"CAP-FAKE","supplementary_data":
       {"related_ids":{"order_id":"ORDER-FAKE"}}}}'
```

`400`, and `✘ REJECTED` in the server log — the reason will be *missing one or
more paypal-transmission-\* headers*, because that curl sent none. No order was
created, nothing was fulfilled, and the body was never parsed as an event.

The rejection is logged to `.data/rejections.json`, deliberately **not** to
`.data/events.json`. The `id` in that body is attacker-controlled: if
rejections shared a table with real events, anyone could overwrite the record
of a genuine payment, or reserve an id so the real delivery arrived later and
was mistaken for a duplicate.

**Try:** change one character of `PAYPAL_WEBHOOK_ID` in `.env`, restart the
server, and make a payment. Every genuine delivery is now rejected, because the
webhook ID is part of the signed message. It is a good way to see that
verification is really checking something, and a good way to recognise the
symptom when it happens for real.

### Make the webhook beat the browser

The out-of-order case, on demand:

```bash
npm run webhook-replay -- --offline
```

Step 1 processes the webhook while the "buyer" is still in transit; step 2 has
the redirect arrive afterwards and find there is nothing left to do.

For the live version, open `http://localhost:8888/`, pay, and watch the
**learned from** field in the right-hand panel. On a fast tunnel it often says
`webhook` — PayPal's event beat your own browser back to your server.

### Break a payment three different ways

```bash
npm run errors
```

Three failures that look alike in a log and are not alike at all:

| What happened | PayPal says | What the code does |
| --- | --- | --- |
| Card declined | `422 UNPROCESSABLE_ENTITY`, issue `INSTRUMENT_DECLINED` | Show the customer. Do not retry. |
| Bad currency code | `400 INVALID_REQUEST` | Fail fast, alert an engineer. A retry sends the same bug. |
| Platform hiccup | `500 INTERNAL_SERVER_ERROR` | Retry with backoff and the same request id. |

The last step retries the 5xx once the mock header is removed, and it
succeeds — automatic recovery, no human, exactly one order.

**Try:** other codes from PayPal's negative testing catalogue, by editing the
`mockApplicationCode` values in `scenarios/04-errors-three-ways.ts`. Start with
`PAYER_ACCOUNT_RESTRICTED` and `CURRENCY_NOT_SUPPORTED`, and see which branch
each one takes.

### Fail a subscription renewal

A real renewal failure is a month away, so the state machine can be driven
directly:

```bash
npm run subscriptions -- --simulate
```

Activation, a charge, three failed renewals, suspension, recovery, and a
cancellation — with PayPal's billing status and this application's access
decision printed side by side at every step.

For real state changes with real webhooks:

```bash
npm run subscriptions                          # create it, approve in the browser
npm run subscriptions -- --suspend I-XXXX      # watch the webhook land
npm run subscriptions -- --activate I-XXXX
npm run subscriptions -- --status I-XXXX       # what PayPal thinks vs what we think
```

**Try:** change `DEFAULT_POLICY` in `src/domain/subscription-state.ts` to
`{ graceFailures: 0, graceDays: 0 }` and re-run the simulation. The customer is
locked out on the first failure while PayPal is still happily retrying. That
gap between the two state machines is where most billing bugs live.

### Start from a clean slate

```bash
npm run reset
```

Clears this application's local memory. PayPal's records are untouched.

---

## How it fits together

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  YOUR LAPTOP                                                            │
  │                                                                         │
  │    Browser  ───────────▶  Your server  ───────────▶  .data/*.json       │
  │    :8888                  :8888                      what YOUR app      │
  │    JS SDK v6              holds the client secret    believes           │
  │    <paypal-button>        decides the price                             │
  │    <venmo-button>         /api/orders                                   │
  │                           /webhooks/paypal                              │
  └────────┬────────────────────────┬───────────────────────────▲───────────┘
           │                        │                           │
           │ buyer approves         │ REST calls out            │ verified
           │                        │                           │ events in
           ▼                        ▼                           │
  ┌──────────────────────────────────────────────┐              │
  │  PAYPAL SANDBOX                              │              │
  │    www.sandbox.paypal.com     buyer logs in  │              │
  │    api-m.sandbox.paypal.com   your server    │              │
  │                                              │              │
  │    buyer account  ──── money ────▶  merchant │              │
  └────────────────────┬─────────────────────────┘              │
                       │ webhook POST, signed                   │
                       ▼                                        │
  ┌──────────────────────────────────────────────┐              │
  │  TUNNEL   https://…trycloudflare.com          │─────────────┘
  │  temporary public front door → :8888          │
  └──────────────────────────────────────────────┘
```

The browser never talks to PayPal's REST API. Your server does. That is why the
secret and the price stay somewhere the buyer cannot reach. The arrow coming
back is not a response to anything: it is PayPal calling you later, which is
what a webhook is, and the only reason a tunnel is needed at all.

```
src/
  config.ts               credentials from .env, and nothing else
  log.ts                  console narration
  paypal/
    auth.ts               OAuth client credentials, cached token
    client.ts             the one HTTP path to PayPal
    errors.ts             structured errors → a decision
    orders.ts             Orders v2
    subscriptions.ts      catalog products, plans, subscriptions
    webhooks.ts           signature verification, both methods
  domain/
    order-state.ts        exactly-once fulfilment
    subscription-state.ts billing status (theirs) vs access level (ours)
    handle-event.ts       one verified event → one business decision
  store/
    ledger.ts             what we attempted, and with which request id
    events.ts             every event id we have seen — the dedupe boundary
  server.ts               checkout backend + webhook listener

scenarios/                one runnable script per demo moment
public/index.html         checkout page, JS SDK v6, PayPal and Venmo
test/                     50 tests, no credentials required
```

Design decisions and their trade-offs are written up in
[`docs/DECISIONS.md`](docs/DECISIONS.md). A step by step checklist for verifying
the whole thing locally is in [`docs/TESTING.md`](docs/TESTING.md).

---

## Notes on reading the code

**The webhook route is registered before `express.json()`,** with
`express.raw()`. Verification needs the exact bytes PayPal sent; once a JSON
parser has touched the request, the original bytes are gone and the signature
can never be checked. This is the single most common webhook bug.

**Request ids are derived, not random.** `requestIdFor("capture", orderId)`
returns the same id every time for a given order, which is what makes a retry
after a crash the *same* call rather than a new one. A UUID generated at call
time would be useless for exactly the case idempotency exists for.

**Two state fields, deliberately.** `billingStatus` mirrors PayPal and is never
invented locally. `accessLevel` is this application's decision. PayPal moves
the money; the app decides access.

**Both webhook verification methods are implemented.** `WEBHOOK_VERIFY_METHOD`
in `.env` switches between `self` (verify the signature locally, PayPal's
recommendation) and `postback` (send the transmission back and let PayPal
verify). Switch it and re-run a webhook scenario to compare: the verification
time is printed for every event, and the difference is the point.

**The stores are JSON files.** In production these are rows with a UNIQUE
constraint doing the deduplication — the constraint is the point, not the
storage engine. Files keep the evidence readable: `cat .data/events.json` shows
exactly what the application believed and when.

---

## Tests

```bash
npm test        # 50 tests, no credentials needed
npm run typecheck
```

They cover the parts where being right matters and a demo cannot prove it:
stable request ids, exactly-once fulfilment under duplicate and out-of-order
delivery, the signed-message construction, the certificate-URL host check, and
the subscription policy boundary.

The half of idempotency that lives at PayPal — the same request id returning
the original result — is demonstrated live in `npm run idempotency`, because
asserting it against a mock would only prove the mock works.

---

## Security

- `.gitignore` is the first commit in this repository. `.env` cannot reach git.
- The client secret never leaves the server. `/api/config` sends only the
  client ID, which is browser-safe by design.
- Prices come from the server's catalogue. The browser sends an item id, never
  an amount.
- Signing certificates are only fetched from `*.paypal.com` over HTTPS. The
  `paypal-cert-url` header is attacker-controlled input; without that check,
  anyone could sign their own "payment completed" and have it verify.
- Unverified webhooks are rejected with `400` before the body is parsed.

---

## Documentation

Current PayPal docs only — the older generations of these APIs are still
findable and still wrong for new integrations.

- [Orders API v2](https://developer.paypal.com/docs/api/orders/v2/) — use this for new checkouts
- [API requests and headers](https://developer.paypal.com/api/rest/requests/) — including `PayPal-Request-Id`
- [Integrate webhooks](https://developer.paypal.com/api/rest/webhooks/rest/) — both verification methods
- [Webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/)
- [Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/) — not the deprecated Billing Agreements API
- [Catalog Products API](https://developer.paypal.com/docs/api/catalog-products/v1/)
- [Negative testing](https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/)
- [JavaScript SDK v6 setup](https://developer.paypal.com/sdk/js/set-up) — the SDK this repo uses
- [JavaScript SDK v6 reference](https://developer.paypal.com/sdk/js/reference) — `findEligibleMethods`, sessions, web components
- [Pay with Venmo](https://developer.paypal.com/docs/checkout/pay-with-venmo/)

---

## Licence

MIT. Demo code — read it, run it, break it. It is not a production payment
system, and the places where it would need to be more than a demo are marked in
the comments.
