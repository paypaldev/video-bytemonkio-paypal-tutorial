# Primer: what this demo actually does

Written for someone who has never integrated a payment provider. No prior
PayPal knowledge assumed. Read this before the code and the rest will make
sense.

---

## 1. Who is involved

A payment looks like one action but involves at least five parties.

| Party | In this demo | What they do |
| --- | --- | --- |
| **Buyer** | your sandbox *personal* account | The customer. Has a PayPal account with a balance, a bank account and a card behind it. |
| **Merchant** (seller) | your sandbox *business* account | You, the shop. The money ends up here. |
| **Your application** | this repo | Your server and website. Decides prices, decides what the buyer gets. |
| **PayPal** | the sandbox | Sits between buyer and merchant. Moves the money, tells you what happened. |
| **The buyer's bank or card network** | invisible | Actually holds the money. PayPal talks to them; you never do. |

Your two sandbox accounts are created for you automatically. Find them, and the
buyer's password, at <https://developer.paypal.com/dashboard/accounts>. They look
like `sb-xxxxx@personal.example.com` and `sb-xxxxx@business.example.com`. Use
your own throughout; nothing in this repo is tied to a particular account.

These sandbox accounts exist only inside the sandbox. You sign in to the
developer dashboard with your own real PayPal account, and you sign in to the
sandbox *checkout* with the fake buyer. Two different logins, two different
worlds.

### How the pieces fit together

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  YOUR LAPTOP                                                            │
  │                                                                         │
  │    Browser  ───────────▶  Your server  ───────────▶  .data/*.json       │
  │    :8888                  :8888                      what YOUR app      │
  │    JS SDK v6              holds the client secret    believes           │
  │    <paypal-button>        decides the price          events, orders,    │
  │    <venmo-button>         /api/orders                ledger, subs       │
  │                           /webhooks/paypal                              │
  └────────┬────────────────────────┬───────────────────────────▲───────────┘
           │                        │                           │
           │ buyer approves         │ REST calls out:           │ verified
           │ (popup or redirect)    │ create order, capture,    │ events in
           │                        │ plans, subscriptions      │
           ▼                        ▼                           │
  ┌──────────────────────────────────────────────┐              │
  │  PAYPAL SANDBOX                              │              │
  │                                              │              │
  │    www.sandbox.paypal.com    buyer logs in   │              │
  │    api-m.sandbox.paypal.com  your server     │              │
  │                              calls this      │              │
  │                                              │              │
  │    buyer account  ──── money ────▶  merchant │              │
  │    sb-…@personal                    account  │              │
  │                                     sb-…@business           │
  └────────────────────┬─────────────────────────┘              │
                       │                                        │
                       │ webhook POST, signed                   │
                       │ (PayPal calling you)                   │
                       ▼                                        │
  ┌──────────────────────────────────────────────┐              │
  │  TUNNEL   https://…trycloudflare.com          │─────────────┘
  │  a temporary public front door → :8888        │
  └──────────────────────────────────────────────┘
```

Three things are worth reading off that picture.

**The browser never talks to PayPal's REST API.** It talks to your server, and
your server talks to PayPal. That is why the client secret and the price can
both stay somewhere the buyer cannot reach.

**Arrows go both ways, and the return arrow is not a response.** Your server
calls PayPal. Separately, later, PayPal calls your server. Those are two
different conversations, and the second one is the webhook.

**The tunnel exists only because of that return arrow.** In production your
server has a real public address. On your laptop it does not, so a tunnel
stands in. Nothing else in the diagram needs it.

The important thing: **your application and PayPal are separate systems that do
not share a database.** Everything hard in this repo comes from that one fact.
They can disagree, they can fall out of sync, and messages between them can be
lost, delayed, or delivered twice.

---

## 2. What the sandbox is

The **sandbox** is a complete copy of PayPal that uses fake money. Same API,
same URLs except the hostname, same webhooks, same error codes.

- Production: `https://api-m.paypal.com`
- Sandbox: `https://api-m.sandbox.paypal.com`

PayPal gives you fake buyer and merchant accounts with fake balances (ours has
$5,000). You can charge them, refund them, and deliberately break things without
touching real money.

It also has **negative testing**, a switch that lets you force specific failures
on demand: card declined, server error, and so on. That is how the errors demo
produces a real decline without needing a real broken card.

This repo refuses to run if you point it at production. That is a deliberate
guard, not a limitation.

---

## 3. The three stages of a payment

This is the core idea of the whole video. One button press is really three
separate events, on three different timelines.

```
  1. AUTHORIZATION          2. CAPTURE              3. SETTLEMENT
  ----------------          ----------              -------------
  The bank checks the       PayPal tells the        The money actually
  buyer has the money       bank to complete it     arrives in the
  and reserves it.                                  merchant account.

  Nobody has been paid.     Money moves.            Hours or days later.
  You control this.         You control this.       You do not control this.
```

**Authorization is a promise.** The bank says "this money is set aside for you."
Nothing has been paid. That promise has an expiry date. When you run
`npm run checkout -- --authorize`, the output shows it:

```
authorization id.......... 55C28610L3022525W
amount held............... 24.00 USD
expires................... 2026-09-16T15:48:22Z
```

29 days. That expiry is the proof that an authorization is not a payment. You
cannot put an expiry date on money that has already moved.

Why would you ever split them? Because sometimes you want to reserve funds
before you know the final amount, or before you ship. A hotel authorizes when
you book and captures when you check out. An online shop might authorize at
checkout and capture when the item leaves the warehouse.

**Capture is the payment.** Money moves. The response shows the split:

```
gross..................... 24.00
PayPal fee................ 1.33
net to merchant........... 22.67
```

Three numbers, because more than one party is involved. That fee line is the
first visible hint that this is not a single system.

**Settlement is later, and is not yours to schedule.** The money reaching the
merchant's actual bank account happens on PayPal's timetable. No API call in
this repo makes it happen faster. Most tutorials never mention it, which is why
people are surprised in production.

If you only take one thing from the repo: `intent: "CAPTURE"` does stages 1 and
2 together, `intent: "AUTHORIZE"` does them separately. Stage 3 is never yours.

---

## 4. The endpoints, in order

A checkout in this repo is three calls, and the order matters.

### Step 0: get a token

```
POST /v1/oauth2/token
```

You have a **client ID** and a **client secret**. You do not send those with
every request. You trade them once for a short lived **access token** (ours
lasts about 9 hours), and send that instead.

Why: the secret is long lived and catastrophic if leaked. The token expires on
its own. Keeping the secret on your server and letting only the token travel is
the same reason you do not email your password.

### Step 1: create the order

```
POST /v2/checkout/orders
```

You tell PayPal what you want to be paid: amount, currency, description. PayPal
gives you back an **order ID** and a URL to send the buyer to.

Nothing has happened yet. No bank has been asked anything. This is a record of
intent, like a pro forma invoice.

```
order id.................. 9NL82399F9025352A
status.................... PAYER_ACTION_REQUIRED
```

`PAYER_ACTION_REQUIRED` literally means "waiting for a human."

### Step 2: the buyer approves

**This step is not an API call.** The buyer goes to PayPal's website, logs in
with credentials your server never sees, and clicks Pay. You cannot make this
happen. You can only wait for it.

This is the moment your application loses control of the flow, and it is why
everything downstream is asynchronous.

```
status → APPROVED
```

Approved still does not mean paid. It means the buyer said yes.

### Step 3: capture

```
POST /v2/checkout/orders/{id}/capture
```

Now the money moves. You get a **capture ID**, which is the receipt. Keep it,
because refunds reference it.

```
capture id................ 1024030939469810V
capture status............ COMPLETED
```

---

## 5. Why webhooks exist

Here is the problem the three steps above do not solve.

You call capture. The connection dies before the response comes back. **Did the
payment happen?** You genuinely do not know. The request may have arrived and
succeeded, with only the reply lost. Or it may never have arrived at all.

More generally: things happen to a payment after your request finishes. A
refund is issued from the PayPal dashboard by someone in support. A subscription
renewal fails three months later. A payment under review clears overnight. None
of those are responses to a call you made, so there is no response for you to
read.

**A webhook is PayPal calling you.** You register a public URL, PayPal sends an
HTTP POST to it whenever something happens, and your server updates its own
records. It is how your application eventually learns the truth about things it
did not personally witness.

### Why the tunnel

PayPal's servers must be able to reach your server. `http://localhost:8888` is
only reachable from your laptop, so in development you run a **tunnel**
(cloudflared, ngrok) that gives you a public HTTPS address forwarding to your
machine:

```
https://random-words-here.trycloudflare.com
        -> http://localhost:8888
```

You register that public URL in the PayPal dashboard. That is all a tunnel is:
a temporary public front door. It changes every restart, which is why so much of
the troubleshooting is about keeping the dashboard in sync with it.

### Why you must verify every webhook

Your webhook URL is public. Anyone on the internet can POST to it. If your code
trusts whatever arrives, then "PAYMENT.CAPTURE.COMPLETED, order 123, $500" is
something a stranger can claim, and you would ship the goods.

So every event carries a cryptographic signature in its headers, and you check
it before you believe anything. PayPal signs a string built from four things:

```
transmission id | timestamp | your webhook ID | checksum of the exact bytes sent
```

You rebuild that string, verify the signature against PayPal's public
certificate, and only then parse the JSON.

Two consequences that trip everyone up:

1. **You need the raw bytes.** If a JSON parser touches the request first, the
   original bytes are gone. Re-serialising the parsed object produces different
   bytes (different spacing, different key order) and a different checksum, so
   verification fails on a perfectly genuine event. This is why the webhook route
   is registered before `express.json()` in `src/server.ts`.

2. **You need `PAYPAL_WEBHOOK_ID`.** It is part of the signed string. Without
   it, no signature can ever verify. This is the single most common reason a
   listener rejects everything.

Try it yourself with the server running:

```bash
curl -X POST http://localhost:8888/webhooks/paypal \
  -H "Content-Type: application/json" \
  -d '{"id":"WH-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED"}'
```

You get a 400, and the server logs `REJECTED`. No order is created.

---

## 6. The events, and when they fire

An **event** is one thing that happened. PayPal sends it to every webhook URL
subscribed to that event type.

| Event | Fires when | What this app does |
| --- | --- | --- |
| `CHECKOUT.ORDER.APPROVED` | Buyer clicks Pay at PayPal | Marks the order approved. No money yet. |
| `PAYMENT.CAPTURE.COMPLETED` | A capture succeeds | Records the capture, fulfils the order. This is the important one. |
| `PAYMENT.CAPTURE.DENIED` | A capture is refused | Marks the order failed. Money never moved. |
| `PAYMENT.CAPTURE.REFUNDED` | Money is sent back | Marks the order refunded. |
| `BILLING.SUBSCRIPTION.ACTIVATED` | Buyer approves a subscription | Grants access. |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | A renewal charge fails | Starts a grace period, or suspends. |
| `BILLING.SUBSCRIPTION.SUSPENDED` | PayPal gives up retrying | Revokes access. |
| `BILLING.SUBSCRIPTION.CANCELLED` | Subscription ends | Access until the paid period ends. |
| `PAYMENT.SALE.COMPLETED` | A recurring charge succeeds | Clears any grace period. |

Note the last one. A successful subscription charge does **not** arrive as a
`BILLING.SUBSCRIPTION.*` event. It is a `PAYMENT.SALE.COMPLETED`, and the field
linking it back to the subscription is `billing_agreement_id`. Worth knowing
before you spend an afternoon looking for an event that does not exist.

### The two hard properties

**Events arrive more than once.** If your server does not answer with a 2xx,
PayPal retries, up to 25 times over 3 days. You can also resend any event by
hand from the dashboard. So a duplicate is not an attack, it is normal traffic.

If your code treats each delivery as new, you ship the order twice.

The fix is one idea: **the event ID is a primary key.** First delivery does the
work, everything after it is recognised as a replay. From a real run:

```
"eventId": "WH-92J252345S923162A-0GP86237TT167633N",
"deliveries": 2,
"outcome": "REPLAY",
"firstSeenAt": "13:54:57.224Z",
"lastSeenAt":  "13:59:57.715Z",   <- resent 5 minutes later
```

and the order it belonged to:

```
"fulfilmentAttempts": 1,
"fulfilledAt": "13:54:57.227Z"    <- unchanged
```

Delivered twice, processed once.

**Events arrive out of order.** After the buyer pays, two messengers race back
to you: PayPal's webhook, and the buyer's browser being redirected to your site.
Either can win.

If the webhook wins, your database knows the payment succeeded while the buyer
is still looking at a spinner. If the browser wins, the opposite. Both happen in
practice. In our test runs the webhook won every time:

```
learned from.............. webhook
```

So the code cannot assume an order. Both paths call the same function, that
function is safe to call twice, and whichever arrives second finds there is
nothing left to do.

---

## 7. Idempotency, in plain terms

Back to the dead connection. You called capture, got nothing back, and do not
know whether the buyer was charged.

You have two bad options. Retry, and risk charging twice. Do not retry, and risk
losing an order that never completed.

**`PayPal-Request-Id` removes the dilemma.** You attach a unique ID to the
request. If PayPal sees that same ID again, it does not perform the action a
second time. It returns the result of the first one.

From a real run, the same capture sent twice:

```
RESPONSE 1                          RESPONSE 2
capture id  1024030939469810V       capture id  1024030939469810V
create_time 2026-08-18T15:49:31Z    create_time 2026-08-18T15:49:31Z
```

The second response came back three seconds later on the wall clock, but
`create_time` did not move. That is the proof: response 2 is a recording of
response 1, not a second charge.

**One detail matters more than it looks.** The ID must be derived from the
business action, not randomly generated at call time:

```ts
requestIdFor("capture", orderId)   // "capture-88E23885CM918910X"
```

If you generate a random UUID and your process crashes, the retry generates a
*different* UUID, PayPal sees a different request, and you have charged twice.
A derived ID is the same every time for the same action, across restarts and
across servers. That is the whole point.

The repo also keeps a local **ledger** recording what it attempted and with
which ID, because PayPal's protection only helps if your own code remembers to
send the same ID again.

---

## 8. Errors: three failures that look alike

Every failure looks the same in a log: the call did not work. They are not the
same, and treating them the same is how you retry a declined card forty times.

| What happened | PayPal returns | Correct response |
| --- | --- | --- |
| Card declined | `422` with issue `INSTRUMENT_DECLINED` | Tell the customer. Do not retry. |
| Your request is malformed | `400 INVALID_REQUEST` | Fix your code. A retry sends the same bug. |
| PayPal had a problem | `500 INTERNAL_SERVER_ERROR` | Retry with backoff and the same request ID. |

The decline is the interesting one. It arrives as a **422**, which is in the 4xx
family, which normally means "you sent something wrong." If you branch on the
status code alone you conclude it is your bug. It is not. The buyer's bank said
no. What disambiguates is the `details[].issue` field inside the response body.

This is what people mean by "structured errors": the response tells a machine
which of the three situations it is in, so recovery can be automatic instead of
someone reading logs at 3am.

`npm run errors` triggers all three for real, then retries the 5xx once the
mock error is removed and watches it succeed.

---

## 9. Subscriptions: two state machines

A one time payment is over in seconds. A subscription can run for years, and
during that time cards expire, people upgrade, payments fail, people cancel.

PayPal models it in three objects, created in this order:

1. **Product**: what you sell. "ByteMonk Pro."
2. **Plan**: how it is priced and billed. $12/month, one month free trial, and
   crucially `payment_failure_threshold: 3`, meaning PayPal will retry a failed
   charge three times before giving up.
3. **Subscription**: one customer on one plan. The buyer approves it, and PayPal
   starts billing on schedule. You never write a cron job.

Now the part that matters, and the thesis of the video:

> **PayPal moves the money. Your application decides access.**

There are two state machines running, and they are not the same.

```
PayPal's (billing)                    Yours (access)
------------------                    --------------
APPROVAL_PENDING                      NONE
ACTIVE                                FULL
SUSPENDED                             GRACE
CANCELLED                             SUSPENDED
EXPIRED                               ENDED
```

PayPal owns the left column. It knows whether a charge succeeded. What it cannot
know is what a failed charge should *mean* to your customer. Does a missed
payment lock them out tonight, or do they get three days to update their card?
Does a cancelled subscription end immediately, or at the end of the period they
already paid for? Those are business decisions, and they belong in your code.

The webhooks are the only wire between the two columns.

There is a trap here worth naming. This app allows **2** failed renewals before
locking the account, while the plan lets PayPal retry **3** times. That ordering
is deliberate. If your grace period outlasts PayPal's retries, PayPal suspends
the subscription while your app still believes the customer is fine, and the
customer is locked out by a system that thinks it granted them access.

`npm run subscriptions -- --simulate` walks the whole lifecycle in about twenty
seconds, printing what PayPal did and what the app decided at each step.

---

## 10. The environment variables

Everything in `.env`, and why each exists.

| Variable | What it is | Notes |
| --- | --- | --- |
| `PAYPAL_ENV` | `sandbox` or `live` | The scenarios refuse to run on `live`. |
| `PAYPAL_CLIENT_ID` | Public identifier for your app | Browser safe. It genuinely ships to the frontend, which is how the JS SDK knows whose checkout it is. |
| `PAYPAL_CLIENT_SECRET` | The password for your app | Server only. Never in the browser, never in git. Leaking it means someone can charge through your account. |
| `PAYPAL_WEBHOOK_ID` | Identifies your webhook subscription | Required for verification, because it is part of the signed string. Not a secret, but without it nothing verifies. |
| `PUBLIC_BASE_URL` | Your tunnel address | Only used to print correct instructions. PayPal is configured in the dashboard. |
| `PORT` | Local server port | Default 8888. |
| `CURRENCY` | Default currency | `USD`. Venmo requires USD. |
| `BUYER_COUNTRY` | Sandbox only override | Forces Venmo eligibility for testing. Sending it in production is a bug. |

Why `.env` and not code: so credentials never enter git. `.gitignore` is the
first commit in this repo specifically so that is structurally true rather than
just intended.

---

## 11. What each demo proves

| Command | The claim it proves |
| --- | --- |
| `npm run doctor` | Setup is correct, and names the fix if not. |
| `npm run checkout -- --authorize` | Authorization and capture are different events. The proof is `expires`. |
| `npm run idempotency` | The same capture sent twice charges once. The proof is an unchanged `create_time`. |
| `npm run webhook-replay` | Events are verified before they are trusted, and a duplicate is processed once. |
| `npm run errors` | Three similar looking failures need three different responses. |
| `npm run subscriptions` | PayPal owns billing state, the app owns access. |
| `npm run venmo` | Venmo is a funding source in the same checkout, not a second integration. In sandbox it completes through PayPal's Venmo simulator. |
| `npm run agent` | An agent changes who starts a payment, not the system underneath it. |

---

## 12. Glossary

**Order**: a record of intent to be paid. Created by you, approved by the buyer.

**Capture**: the act of moving the money, and the receipt object it produces.

**Authorization**: a reservation of funds with an expiry. Not a payment.

**Settlement**: money arriving in the merchant account. Later, and not yours to
control.

**Webhook**: an HTTP POST from PayPal to your server when something happens.

**Event**: one thing that happened, with an ID. Delivered by webhook, possibly
more than once.

**Idempotency**: sending the same request twice has the same effect as sending
it once.

**`PayPal-Request-Id`**: the header that makes a retry safe.

**Access token**: short lived credential, obtained by trading the client ID and
secret.

**Sandbox**: PayPal's test environment with fake money.

**Negative testing**: a sandbox switch that lets you force specific errors.

**Fulfilment**: your side of the deal. Shipping the box, granting the access.
The thing that must happen exactly once.
