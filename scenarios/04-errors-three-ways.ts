/**
 * SCENARIO 4 — Three failures that look alike and are not alike.
 *
 *   npm run errors
 *
 * A declined card, a malformed request, and a platform hiccup all arrive as
 * "the call didn't work". Treating them the same is how you end up retrying a
 * decline four times, or paging someone at 3am for a typo in a currency code.
 *
 * PayPal returns a structured error — a `name`, a list of `details[].issue`,
 * and a `debug_id` — and that structure is what lets a machine pick the right
 * branch instead of a human reading a log.
 *
 *   INSTRUMENT_DECLINED   → show the customer
 *   INVALID_REQUEST       → fix the code
 *   INTERNAL_SERVER_ERROR → retry
 *
 * The first two use PayPal's sandbox negative testing (the PayPal-Mock-Response
 * header) or a genuinely malformed request. Nothing here is a fake error
 * object invented locally — every response comes back over the wire.
 */

import { call, callWithRetry, requestIdFor } from "../src/paypal/client.js";
import { createOrder, captureOrder } from "../src/paypal/orders.js";
import { PayPalApiError, handlingLabel, type Handling } from "../src/paypal/errors.js";
import { blank, c, decision, fact, note, ok, paypal, step, takeaway, title, warn, bad } from "../src/log.js";
import { preflight, runScenario, beat } from "./_common.js";

interface Outcome {
  label: string;
  status: number | string;
  name: string;
  issue: string;
  handling: Handling | "none";
  whatWeDid: string;
}

const outcomes: Outcome[] = [];

/**
 * A per-run suffix for request ids.
 *
 * PayPal stores a request id for days, so a hard-coded one would make the
 * second take of this scenario replay the first take's response instead of
 * doing the thing on camera. The id still has to be STABLE WITHIN a run —
 * that is the whole point of step 3 — so it is minted once, here.
 */
const RUN = Date.now().toString(36);

await runScenario(async () => {
  title("4 · Three failures, three different responses", "PayPal sandbox negative testing");
  await preflight();

  // =========================================================================
  step(1, "A declined instrument — the buyer's problem, and only theirs");

  note("PayPal-Mock-Response: {\"mock_application_codes\":\"INSTRUMENT_DECLINED\"}");

  try {
    const { data: order } = await createOrder({
      amount: "24.00",
      description: "Coffee Subscription Box",
      customId: "bytemonk-demo-04-decline",
    });
    fact("order id", order.id);

    await captureOrder(order.id, {
      requestId: requestIdFor("capture", order.id),
      mockApplicationCode: "INSTRUMENT_DECLINED",
      retry: false,
    });

    warn("expected a decline and did not get one — the sandbox may not be honouring the mock header today");
    outcomes.push({
      label: "declined instrument",
      status: "200",
      name: "(none)",
      issue: "(none)",
      handling: "none",
      whatWeDid: "nothing — no error to branch on",
    });
  } catch (err) {
    const e = expectPayPalError(err);
    report(e);

    // The branch. Note what is NOT here: no retry loop, no alerting, no
    // exception bubbling into a 500. The customer gets a sentence they can act
    // on, and the request ends.
    decision(`show the customer: "${e.customerMessage()}"`);
    note("no retry — a declined instrument declined for a reason, and asking again just declines again");
    note(`the operator line, which never reaches the buyer: ${e.operatorMessage()}`);

    outcomes.push({
      label: "declined instrument",
      status: e.status,
      name: e.body.name ?? "?",
      issue: e.issues.join(",") || "-",
      handling: e.handling,
      whatWeDid: "showed the customer a message and stopped",
    });
  }

  await beat();

  // =========================================================================
  step(2, "A malformed request — our problem, and a retry cannot help");

  note("no mock header this time: we are genuinely sending an invalid body");

  try {
    // A currency code that does not exist. Deliberately our own bug.
    await call({
      method: "POST",
      path: "/v2/checkout/orders",
      body: {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USDD", value: "24.00" } }],
      },
      requestId: requestIdFor("create", `deliberately-invalid-${RUN}`),
    });
    warn("expected a validation error and did not get one");
  } catch (err) {
    const e = expectPayPalError(err);
    report(e);

    // The detail that makes this actionable: PayPal names the offending field.
    const field = e.body.details?.[0]?.field;
    const description = e.body.details?.[0]?.description;
    if (field) fact("offending field", field);
    if (description) fact("description", description);

    decision("do NOT retry. Log it, alert the team, fail the request.");
    note("retrying an invalid request just sends the same invalid request, more often");
    note(`the buyer sees a generic apology; the engineer gets: ${e.operatorMessage()}`);

    outcomes.push({
      label: "malformed request",
      status: e.status,
      name: e.body.name ?? "?",
      issue: e.issues.join(",") || "-",
      handling: e.handling,
      whatWeDid: "failed fast and alerted — nothing to retry",
    });
  }

  await beat();

  // =========================================================================
  step(3, "A platform error — nobody did anything wrong, so retry");

  note("PayPal-Mock-Response: {\"mock_application_codes\":\"INTERNAL_SERVER_ERROR\"}");

  // Same request id across every attempt. That is what makes retrying a
  // payment safe rather than reckless — see scenario 2.
  const retryRequestId = requestIdFor("create", `retry-demo-${RUN}`);
  fact("PayPal-Request-Id", retryRequestId);

  let attemptsMade = 0;

  try {
    // A real retry loop, not a narrated one: three attempts, exponential
    // backoff with jitter, the same request id on every one of them. The mock
    // header stays set, so every attempt fails and you can watch the waits
    // grow.
    await callWithRetry(
      {
        method: "POST",
        path: "/v2/checkout/orders",
        body: {
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: "USD", value: "24.00" } }],
        },
        requestId: retryRequestId,
        mockApplicationCode: "INTERNAL_SERVER_ERROR",
      },
      {
        attempts: 3,
        baseDelayMs: 500,
        // Count only. callWithRetry already narrates each backoff, and two
        // lines saying the same thing reads as a bug on screen.
        onRetry: (attempt) => {
          attemptsMade = attempt;
        },
      },
    );
    warn("expected a 5xx and did not get one");
  } catch (err) {
    attemptsMade += 1;
    const e = err instanceof PayPalApiError ? err : null;
    if (e) {
      report(e);
      fact("attempts made", attemptsMade);
      decision("retry with exponential backoff and jitter — the SAME request id every time");
      note("without jitter every server in your fleet retries in lockstep and you recreate the outage yourself");

      outcomes.push({
        label: "platform error",
        status: e.status,
        name: e.body.name ?? "?",
        issue: e.issues.join(",") || "-",
        handling: e.handling,
        whatWeDid: `retried ${attemptsMade}× with backoff, reusing the request id`,
      });
    } else {
      bad((err as Error).message);
      outcomes.push({
        label: "platform error",
        status: "no response",
        name: "TRANSPORT",
        issue: "-",
        handling: "RETRY",
        whatWeDid: "retried — an unanswered request is the case idempotency exists for",
      });
    }
  }

  await beat();

  // =========================================================================
  step(4, "The retry, once the platform is healthy again");

  note("same request id, same body, no mock header — this is the attempt that succeeds");

  const { data: recovered } = await call<{ id: string; status: string }>({
    method: "POST",
    path: "/v2/checkout/orders",
    body: {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "24.00" } }],
    },
    requestId: retryRequestId,
    prefer: "return=representation",
  });

  fact("order id", recovered.id);
  fact("status", recovered.status);
  fact("failed attempts before", attemptsMade);
  ok("recovered automatically — no human involved, and exactly one order exists");
  paypal("the failure was transient, the request id made the retry safe, and the outage cost one order nothing");

  // =========================================================================
  step("✓", "Same-looking failures, side by side");

  blank();
  console.log(
    `     ${c.bold("failure".padEnd(22))}${c.bold("http".padEnd(7))}${c.bold("name".padEnd(24))}${c.bold("branch")}`,
  );
  console.log(`     ${c.grey("─".repeat(70))}`);
  for (const o of outcomes) {
    const colour =
      o.handling === "SHOW_CUSTOMER" ? c.yellow : o.handling === "FIX_REQUEST" ? c.red : c.blue;
    console.log(
      `     ${o.label.padEnd(22)}${String(o.status).padEnd(7)}${o.name.slice(0, 22).padEnd(24)}${colour(
        o.handling === "none" ? "-" : handlingLabel(o.handling),
      )}`,
    );
  }
  blank();
  for (const o of outcomes) {
    console.log(`     ${c.grey(`${o.label}:`)} ${o.whatWeDid}`);
  }

  takeaway("One should be shown to the customer. One should be fixed by you. One should simply be retried.");
});

function expectPayPalError(err: unknown): PayPalApiError {
  if (err instanceof PayPalApiError) return err;
  throw err;
}

function report(e: PayPalApiError): void {
  blank();
  fact("http status", e.status);
  fact("name", e.body.name ?? e.body.error ?? "?");
  fact("issue", e.issues.join(", ") || "(none)");
  fact("message", e.body.message ?? e.body.error_description ?? "(none)");
  fact("debug_id", e.debugId);
  fact("classified as", handlingLabel(e.handling).toUpperCase());
}
