# Testing guide

A step by step procedure for verifying this integration on your own machine.

Each step states **what it does**, **what it proves**, and **what a passing
result looks like**, because "the command ran" and "the thing works" are not the
same. Several steps print numbers that are easy to misread; those are explained
where they appear.

Work through the tiers in order. Each requires more setup than the last, so a
failure stops you before you spend time on the next one.

**Prerequisites:** Node.js 22 or newer, npm, and a free PayPal developer
account. Tiers 2 and 3 also require a tunnel such as `cloudflared`. Setup
instructions are in the [README](../README.md); background on how the pieces fit
together is in [docs/PRIMER.md](PRIMER.md).

---

## Contents

[What is running while you test](#what-is-running-while-you-test)

**[Tier 0: no credentials needed](#tier-0-no-credentials-needed)** — 2 minutes

- [0.1 Install, typecheck, unit tests](#01-install-typecheck-unit-tests)
- [0.2 Clear local state](#02-clear-local-state)
- [0.3 Duplicate and out-of-order webhooks, offline](#03-duplicate-and-out-of-order-webhooks-offline)
- [0.4 The subscription state machine, offline](#04-the-subscription-state-machine-offline)

**[Tier 1: credentials, no tunnel](#tier-1-credentials-no-tunnel)** — 10 minutes

- [1.1 Setup check](#11-setup-check)
- [1.2 The live-environment guard](#12-the-live-environment-guard)
- [1.3 Three failures, three responses](#13-three-failures-three-responses)
- [1.4 Agent guardrails](#14-agent-guardrails)
- [1.5 Authorization versus capture](#15-authorization-versus-capture)
- [1.6 Idempotency](#16-idempotency)
- [1.7 Create a subscription](#17-create-a-subscription)

**[Tier 2: with a tunnel](#tier-2-with-a-tunnel)** — 15 minutes

- [2.1 Start everything](#21-start-everything)
- [2.2 Reject a forged webhook](#22-reject-a-forged-webhook)
- [2.3 A real event, then a real replay](#23-a-real-event-then-a-real-replay)
- [2.4 Subscription state, driven by webhooks](#24-subscription-state-driven-by-webhooks)

**[Tier 3: the checkout page](#tier-3-the-checkout-page)** — 5 minutes

- [3.1 What the page is about to do](#31-what-the-page-is-about-to-do)
- [3.2 The checkout page](#32-the-checkout-page)

[When something fails](#when-something-fails)

---

## What is running while you test

```
   TIER 0        no network at all
   ─────────     npm test, offline scenarios

   TIER 1        + PayPal sandbox over the internet
   ─────────
                  your terminal ──REST──▶ api-m.sandbox.paypal.com
                  scenarios              (create order, capture, plans)

   TIER 2/3      + a public URL pointing back at you
   ─────────
                  terminal 1:  npm run server            :8888
                  terminal 2:  cloudflared tunnel        public URL → :8888
                  terminal 3:  scenarios
                  browser:     http://localhost:8888

                  PayPal ──webhook POST──▶ tunnel ──▶ :8888/webhooks/paypal
```

Tier 0 and 1 need nothing running in the background. Tier 2 and 3 need all
three terminals up at once. See `docs/PRIMER.md` for what each piece is.

---

## Tier 0: no credentials needed

**Setup:** none. **Time:** 2 minutes.

Nothing here touches the network. If any of it fails, stop, because everything
later depends on it.

### 0.1 Install, typecheck, unit tests

```bash
npm install
npm run typecheck
npm test
```

**What it does:** compiles every TypeScript file without emitting, then runs the
unit tests.

**What it proves:** the code is internally consistent, and the four properties
that are easier to assert than to demonstrate hold: stable request ids,
exactly-once fulfilment under duplicate and out-of-order delivery, the signed
message being built from raw bytes, and the certificate URL allowlist.

- [ ] `npm run typecheck` exits silently
- [ ] `npm test` reports **50 tests, 50 pass, 0 fail**

> If tests fail on a machine where they used to pass, the usual cause is a
> `node_modules` copied between operating systems. `rm -rf node_modules && npm install`.

### 0.2 Clear local state

```bash
npm run reset
```

**What it does:** empties `.data/`, which is where this app records what it
believes: events seen, orders fulfilled, capture attempts, subscriptions.

**What it proves:** nothing on its own. It matters because several checks below
are about *counters*, and stale counters make a passing run look like a failure
or the other way round.

- [ ] Four cleared lines printed. PayPal's own records are untouched.

### 0.3 Duplicate and out-of-order webhooks, offline

```bash
npm run webhook-replay -- --offline
```

**What it does:** feeds handcrafted events straight into the handler, with no
network and no signature checking.

**What it proves:** the two properties webhook code has to have. A duplicate
event is processed once. The buyer's redirect and PayPal's webhook can arrive
in either order and still converge on the same state.

- [ ] Step 1: the webhook arrives first, `learned from webhook`, fulfilled
- [ ] Step 2: the redirect arrives second and changes nothing
- [ ] Step 3: `outcome REPLAY`, and **`fulfilment attempts` stays at 1** with
      `fulfilled at` unchanged
- [ ] Step 4: a late `ORDER.APPROVED` is `IGNORED`, not applied backwards

> **The number people misread:** in step 3 `fulfilment attempts` stays at **1**,
> not 2. The duplicate is stopped at the event id, above the business logic, so
> fulfilment is never attempted again. It reaches 2 only in step 2, where the
> redirect and the webhook are genuinely two different messengers.

### 0.4 The subscription state machine, offline

```bash
npm run subscriptions -- --simulate
```

**What it does:** walks a subscription through a year of life in about twenty
seconds: activation, a charge, three failed renewals, suspension, recovery,
cancellation.

**What it proves:** PayPal's billing status and this application's access
decision are separate things, and the app's policy is what turns one into the
other. Also that a redelivered failure does not cost the customer a grace
attempt.

- [ ] Step 4 redelivers the first failure: `failures before 1`, `failures after 1`
- [ ] The final table shows `billing` and `access` disagreeing on the failure
      rows, then agreeing again after recovery

> If step 4 shows `0` and `0`, the check is running at the wrong point and is
> proving nothing. It must run while the counter is non-zero.

---

## Tier 1: credentials, no tunnel

**Setup:** `.env` with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from the
**Sandbox** tab at <https://developer.paypal.com/dashboard/applications/sandbox>.
**Time:** 10 minutes, including browser approvals.

### 1.1 Setup check

```bash
npm run doctor
```

**What it does:** checks each part of the setup in the order you set it up, and
names the page that fixes anything broken.

**What it proves:** your credentials work, the Orders API is reachable, and
sandbox negative testing is switched on. Later tiers add webhook and tunnel
checks to the same command.

- [ ] Node version, `.env`, environment: pass
- [ ] OAuth credentials pass, with a token preview and scope count
- [ ] Orders API passes
- [ ] Negative testing passes
- [ ] Steps 5 and 6 (webhook, server, tunnel) may be skipped or fail at this
      point. That is expected; they belong to Tier 2

> **You do not need a tunnel yet.** The doctor is a diagnostic, not a sequence,
> so it reports on parts you have not set up. At this tier it should report the
> server as skipped and the tunnel as skipped or failed.
>
> If `PUBLIC_BASE_URL` is left over from an earlier session it will point at a
> tunnel that no longer exists, and the tunnel check will fail. Either clear it
> until you reach Tier 2, or read the failure as "not set up yet" rather than as
> something broken.

> Negative testing is a per-account switch at
> <https://developer.paypal.com/tools/sandbox/negative-testing/>. Without it,
> step 1.2 cannot force failures and will not demonstrate anything.

### 1.2 The live-environment guard

```bash
PAYPAL_ENV=live npm run doctor
```

**What it does:** runs the doctor once with the environment overridden to
`live`, for that single command. An inline variable takes precedence over
`.env`, so nothing on disk changes and there is nothing to undo afterwards.

**What it proves:** the repo refuses to run against production. This matters
because the check immediately after it creates an order. Against live
credentials that would be a real order on a real merchant account, so the guard
has to stop execution rather than warn and carry on.

Nothing is sent to production here. The guard exits before any network call.

- [ ] Doctor prints `environment - PAYPAL_ENV=live` and **exits immediately**
- [ ] No order id is printed
- [ ] Plain `npm run doctor` afterwards behaves normally

> Do not put `PAYPAL_ENV=live` in `.env` to run this. Overriding it for one
> command is the point: it exercises the guard without leaving a production
> setting on disk where it could be forgotten.

### 1.3 Three failures, three responses

```bash
npm run errors
```

**What it does:** causes a declined card, a malformed request and a server
error, all over the real network, using PayPal's negative testing header for
two of them and a genuinely invalid body for the third.

**What it proves:** failures that look identical in a log need different
handling, and PayPal's structured errors carry enough information to choose
automatically. Also that a retry with a stable request id recovers from a 5xx
without human involvement.

- [ ] Three branches: `SHOW THE CUSTOMER`, `FIX THE CODE`, `RETRY`
- [ ] The decline is a **422** whose `issue` is `INSTRUMENT_DECLINED`
- [ ] Step 3 shows real backoff waits, one line per retry
- [ ] Step 4 succeeds and creates exactly one order
- [ ] The summary table has three rows

> The 422 is the point of the section. A 4xx normally means "you sent something
> wrong", so branching on status alone sends a decline down the wrong path. The
> `issue` field is what distinguishes them.

### 1.4 Agent guardrails

```bash
npm run agent
```

**What it does:** runs an agent-shaped caller against a deliberately narrow tool
surface.

**What it proves:** the four things you still have to build around any agent
toolkit: scoped access, an approval boundary, idempotency derived from intent,
and an audit trail that records refusals as well as successes.

- [ ] Four audit rows: `ALLOWED`, `DEDUPED`, `REFUSED_APPROVAL`, `REFUSED_SCOPE`
- [ ] Step 3 reports `same order id: YES`

### 1.5 Authorization versus capture

```bash
npm run checkout -- --authorize
```

Approve in the browser with your sandbox buyer. Choose the **card**, not the
bank account; the bank is much slower.

**What it does:** creates an order with `intent=AUTHORIZE`, waits for approval,
authorizes, then captures the authorization as a separate call.

**What it proves:** authorization and capture are different events, not two
names for one thing. Settlement is a third thing that no API call here can
hurry.

- [ ] After approving, the browser lands on a page reading **"Approved"** and
      "no money has moved yet". It must not sit on a spinning button
- [ ] Step 3 shows an `authorization id` and an **`expires`** date about a month
      out
- [ ] Step 4 shows `gross`, `PayPal fee`, `net to merchant`
- [ ] Step 5: PayPal says `COMPLETED`, the app says `FULFILLED`

> The landing page is served by the scenario itself, on a spare port, and shut
> down when the run finishes. A real integration would send the buyer to its own
> order confirmation page instead. Its only job is to prove the buyer's journey
> ends somewhere, which is the part `return_url` is responsible for.

> `expires` is the evidence. You cannot put an expiry date on money that has
> already moved, so an authorization cannot be a payment.

### 1.6 Idempotency

```bash
npm run idempotency
```

**What it does:** captures an approved order, then sends the byte-identical
request a second time with the same `PayPal-Request-Id`.

**What it proves:** a retry is not a second charge. This is the answer to the
timeout problem, where you cannot tell whether a request succeeded.

- [ ] Both responses have the **same capture id**
- [ ] Both have the **same `create_time`**, though the wall clock moved
- [ ] Step 5: `fulfilment attempts 1`, `ledger attempts 2`

> `create_time` is the proof, not the capture id. An identical timestamp means
> response 2 is a recording of response 1, rather than a second charge that
> happened moments later.

### 1.7 Create a subscription

```bash
npm run subscriptions
```

Approve in the browser as your sandbox buyer.

**What it does:** creates a catalog product, then a plan carrying the price, the
free trial and the failure rules, then a subscription for one customer on that
plan.

**What it proves:** recurring billing is three objects in a fixed order, and
once the buyer approves, PayPal owns the schedule. No cron job of yours ever
runs a charge.

- [ ] Step 2 shows `trial 1 x 1 MONTH, free`, `then 12.00 USD / month`, and
      `failure threshold 3`
- [ ] After approving, the browser lands on the **Approved** page
- [ ] Step 4 reaches `ACTIVE` and prints the next billing date
- [ ] Step 4 then reports that nothing is listening, and does **not** wait

Write down the subscription id (`I-…`). Tier 2 uses it.

> **The last checkbox is the interesting one.** PayPal says `ACTIVE` while this
> application has granted nothing, because access follows a verified webhook and
> there is no listener yet. That disagreement is the design, not a fault, and
> Tier 2 is where the two views are made to agree.
>
> Each run creates a new product, plan and subscription in your sandbox. They
> persist. Running this repeatedly leaves clutter, which is harmless but worth
> knowing.

---

## Tier 2: with a tunnel

**Setup:** three terminals plus a webhook registered in the dashboard.
**Time:** 15 minutes.

### 2.1 Start everything

```bash
# terminal 1
npm run server

# terminal 2
cloudflared tunnel --url http://localhost:8888
```

Then, in this order:

1. Copy the `https://…trycloudflare.com` URL that cloudflared just printed into
   `.env` as `PUBLIC_BASE_URL`. It is a **new URL every time** cloudflared
   starts; a value left over from an earlier session will not resolve.
2. Open <https://developer.paypal.com/dashboard/applications/sandbox> (the
   PayPal Developer Dashboard, where you created your credentials). Click your
   sandbox app, scroll to **Webhooks**, then **Add Webhook**. URL is
   `<that URL>/webhooks/paypal`, events **All events**.

   > Sign in with your **real PayPal account**, the one the developer account
   > belongs to. Not a sandbox test account like `sb-…@personal.example.com`:
   > those exist only to pay with inside the sandbox and cannot open the
   > dashboard.
3. Save. The webhook now appears in that table with a **Webhook ID** column
   beside its URL, like `1AB23456CD789012E`. Copy it into `.env` as
   `PAYPAL_WEBHOOK_ID`. If you cannot find it, `npm run doctor` lists every
   webhook registered for your credentials with its id and URL.
4. Restart the server. It reads `.env` once, at boot.

> **When the tunnel URL changes**, edit the existing webhook rather than
> deleting and recreating it. Editing keeps the same Webhook ID, so only
> `PUBLIC_BASE_URL` changes. Recreating issues a new id.

**Why the webhook ID matters:** it is part of the string PayPal signs. Without
it no signature can be verified, so every delivery is rejected, correctly.

- [ ] Server startup prints `PAYPAL_WEBHOOK_ID is set` and the public URL

```bash
# terminal 3
npm run doctor
```

**What it now also proves:** the webhook ID belongs to a webhook registered for
*this* app, the subscribed events cover what the demos need, and the tunnel
actually reaches your machine.

- [ ] All ten checks pass, nothing skipped

> Tunnel URLs change every restart. When one does, update `PUBLIC_BASE_URL`
> **and** the dashboard, then restart the server. The doctor warns when the two
> have drifted apart, which is the most common reason webhooks stop arriving.

### 2.2 Reject a forged webhook

```bash
curl -X POST http://localhost:8888/webhooks/paypal \
  -H "Content-Type: application/json" \
  -d '{"id":"WH-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED"}'
```

**What it does:** sends your endpoint an unsigned payment event, exactly as
anyone on the internet could.

**What it proves:** the listener verifies before it believes. An unverified POST
is a claim, not an event, and it never reaches the business logic.

- [ ] Returns `400`
- [ ] Server logs `REJECTED`
- [ ] `curl -s localhost:8888/api/events` does **not** contain `WH-FORGED`
- [ ] `curl -s localhost:8888/api/rejections` **does**

> Rejections are stored separately on purpose. The `id` in an unverified body is
> attacker-controlled, so letting it into the events table would allow someone
> to overwrite the record of a real payment, or to reserve an id so the genuine
> delivery is later mistaken for a duplicate.

### 2.3 A real event, then a real replay

```bash
npm run webhook-replay
```

**What it does:** makes a real payment, waits for PayPal's
`PAYMENT.CAPTURE.COMPLETED` to arrive over the tunnel, then asks for that same
event to be delivered again.

**What it proves:** events are verified on arrival, and a genuine redelivery is
recognised and dropped.

- [ ] Step 1 prints `PayPal delivers to` and it matches your current tunnel. If
      it does not, the scenario stops before taking a payment
- [ ] Step 3: event arrives, `verified yes`, `learned from webhook`
- [ ] Step 4: the resend API declines with 404 (expected; see
      `docs/DECISIONS.md`) and the script keeps waiting
- [ ] Click **Resend** at
      <https://developer.paypal.com/dashboard/webhooksEvents>: set the
      **Application** filter to your app, find the event by its id, then Resend
- [ ] Server logs `REPLAY` for the same event id
- [ ] `curl -s localhost:8888/api/events | grep -o '"deliveries":[0-9]*'` shows a `2`
- [ ] That order still shows `"fulfilmentAttempts": 1`

> `deliveries: 2` with `fulfilmentAttempts: 1` is the whole claim in two
> numbers: delivered twice, processed once.

### 2.4 Subscription state, driven by webhooks

Use the subscription id from step 1.7.

```bash
npm run subscriptions -- --status I-XXXXXXXXXXXX
```

**What it does:** prints PayPal's view of the subscription next to this
application's view.

**What it proves:** the two are separate. PayPal owns `billingStatus`. This app
owns `accessLevel`, and decides it from the events it has verified.

- [ ] PayPal reports `ACTIVE`
- [ ] This app reports `NONE`, because it never received the activation event

That gap is left over from Tier 1, when no listener existed. Now close it:

```bash
npm run subscriptions -- --suspend  I-XXXXXXXXXXXX
npm run subscriptions -- --status   I-XXXXXXXXXXXX
npm run subscriptions -- --activate I-XXXXXXXXXXXX
npm run subscriptions -- --status   I-XXXXXXXXXXXX
```

**What it does:** makes real state changes at PayPal, each of which emits a real
webhook to your listener.

**What it proves:** the wire between the two state machines. PayPal changes the
billing state, the event arrives and is verified, and only then does this
application change what the customer can do.

- [ ] Suspend: PayPal reports `SUSPENDED`, then the command **waits** for the
      webhook and ends with `the event arrived … the two views now agree`
- [ ] The server logs `BILLING.SUBSCRIPTION.SUSPENDED`
- [ ] After it: `billing SUSPENDED`, `access SUSPENDED`
- [ ] Activate: same pattern, ending at `billing ACTIVE`, `access FULL`

> Each command changes state at PayPal and returns at once; the event that tells
> this application about it lands seconds later. The commands wait for it rather
> than printing a local record that has not had time to change. Run them back to
> back without waiting and every one will look like it did nothing.

> If you would rather see a clean run from the start, with the listener up the
> whole time, run `npm run subscriptions` again now. Step 4 will wait for the
> activation webhook and show the two views agreeing straight away. It creates a
> second product, plan and subscription in your sandbox.
- [ ] Status: PayPal's view and the app's view print side by side

---

## Tier 3: the checkout page

**Setup:** everything from Tier 2 still running. **Time:** 5 minutes.

### 3.1 What the page is about to do

```bash
npm run venmo
```

**What it does:** prints the v6 SDK setup the checkout page uses, the rules that
govern whether Venmo appears at all, and the list of things that are identical
between a PayPal payment and a Venmo one.

**What it proves:** nothing on its own; it runs no payment. It is there so the
next step is read rather than just watched, and so that "Venmo isn't showing up"
has a checklist to walk before you start debugging code.

- [ ] Prints the sandbox SDK host, not the live one
- [ ] Lists the eligibility rules, US buyer and merchant, USD

### 3.2 The checkout page

Open <http://localhost:8888/> and **hard reload** (Cmd-Shift-R). This page is
cached aggressively and a stale copy will waste your time.

**What it does:** loads PayPal's JavaScript SDK v6, asks which payment methods
this buyer is eligible for, and reveals only those buttons.

**What it proves:** the browser never holds the secret or the price, PayPal and
Venmo are one integration rather than two, and the app's view of an order is
visible as it updates.

- [ ] Badge reads `sandbox` and `JS SDK v6`
- [ ] Log: `loading JS SDK v6 from https://www.sandbox.paypal.com/web-sdk/v6/core`
- [ ] Log: `SDK loaded. Creating an instance…`
- [ ] Log: `eligible for this buyer: paypal, venmo, …`
- [ ] Both a PayPal button and a Venmo button are visible

Click **Venmo**:

- [ ] Log: `buyer chose: venmo`
- [ ] Log: `POST /api/orders` and an order id
- [ ] Venmo's own login window opens

- [ ] The popup is PayPal's **Venmo Sandbox** simulator, reading *"Venmo is
      working!"*. Sign in with your ordinary sandbox buyer to complete it; no
      separate Venmo credential is needed
- [ ] The capture appears in the log, and the server logs the same
      `PAYMENT.CAPTURE.COMPLETED` event a PayPal payment produces

Now click **PayPal** and pay:

- [ ] Log: `buyer approved order …`, then `captured: <capture id>`
- [ ] The state panel fills in
- [ ] `learned from` says **webhook** if the event beat your browser back
- [ ] `fulfilment attempts` never exceeds 2, `fulfilled at` never changes

---

## When something fails

| Symptom | Likely cause |
| --- | --- |
| Tests fail where they used to pass | `node_modules` copied between platforms. `rm -rf node_modules && npm install` |
| `401` on every call | Credentials came from the Live tab, not Sandbox |
| Every webhook rejected | `PAYPAL_WEBHOOK_ID` missing, wrong, or from a different app |
| No webhooks at all | Tunnel URL changed. Update the dashboard **and** `PUBLIC_BASE_URL`, restart the server. Updating only one of the two is the usual mistake: PayPal delivers to the dashboard URL regardless of what `.env` says |
| Webhook Events page is empty | The dashboard's **Application** filter defaults to the wrong app |
| `npm run errors` shows no failures | Negative testing is off for the sandbox business account |
| Checkout page stops after "loading JS SDK v6" | SDK did not load. Check the browser console and that the host matches your environment |
| No Venmo button | Buyer or merchant account is not US, or currency is not USD |
| Pay button spins for several seconds | Normal in sandbox, especially when it falls back to the bank account. Pick the card |
| Pay button spins forever and never returns | The order was created without a `return_url`, so PayPal has nowhere to send the browser. Approval still succeeds, but the buyer is stranded |
| Counters look wrong | `npm run reset` |
| Anything else | `npm run doctor` |

