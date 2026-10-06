/**
 * SCENARIO 1 — The happy path, with the lifecycle left visible.
 *
 *   npm run checkout              create → approve → capture
 *   npm run checkout -- --authorize   create → approve → authorize → capture
 *
 * The second form is the one worth recording. It splits the payment into the
 * two events the API is modelling: the bank's PROMISE, which has an expiry
 * date and moves no money, and the CAPTURE, which does. Settlement — the money
 * actually landing in the merchant account — is a third thing that happens on
 * PayPal's schedule, hours or days later, and no API call in this script makes
 * it happen sooner.
 */

import { createOrder, captureOrder, authorizeOrder, captureAuthorization, firstAuthorization, firstCapture, getOrder, orderAmount } from "../src/paypal/orders.js";
import { requestIdFor } from "../src/paypal/client.js";
import { createLocalOrder, markApproved, markPaid, fulfil, getLocalOrder } from "../src/domain/order-state.js";
import { beginAttempt, recordSuccess } from "../src/store/ledger.js";
import { blank, fact, note, ok, paypal, step, takeaway, title, decision } from "../src/log.js";
import { preflight, runScenario, waitForApproval, beat, startReturnListener } from "./_common.js";

const useAuthorize = process.argv.includes("--authorize");
const AMOUNT = "24.00";

await runScenario(async () => {
  title(
    "1 · Checkout: create → approve → capture",
    useAuthorize ? "intent=AUTHORIZE — the promise and the payment as two events" : "intent=CAPTURE — the standard one-step checkout",
  );

  await preflight();

  // -------------------------------------------------------------------------
  step(1, "Create the order — describe what you want to be paid");

  // Somewhere for the buyer's browser to go after they approve. Without a
  // return_url they are left on PayPal watching a spinner.
  const landing = await startReturnListener();

  const { data: order } = await createOrder({
    amount: AMOUNT,
    intent: useAuthorize ? "AUTHORIZE" : "CAPTURE",
    description: "Coffee Subscription Box",
    customId: "bytemonk-demo-01",
    // This is a PayPal-wallet flow, so pinning the payment source is safe and
    // gets us the branded review page. The checkout page deliberately does NOT
    // do this — see the note on payPalWalletOnly in src/paypal/orders.ts.
    payPalWalletOnly: true,
    returnUrl: landing.returnUrl,
    cancelUrl: landing.cancelUrl,
  });

  createLocalOrder(order.id, AMOUNT);

  fact("order id", order.id);
  fact("intent", order.intent ?? (useAuthorize ? "AUTHORIZE" : "CAPTURE"));
  fact("amount", orderAmount(order));
  fact("status", order.status);
  paypal("the order exists. No bank has been asked anything. No money has moved.");
  note("this is a record of intent — the payment has not begun");

  // -------------------------------------------------------------------------
  step(2, "Approve — the part of the payment your backend does not control");

  const approved = await waitForApproval(order);
  landing.close();
  markApproved(order.id, "redirect");
  fact("status", approved.status);
  note("the buyer authenticated at PayPal, on PayPal's domain, with credentials your server never sees");

  await beat();

  if (useAuthorize) {
    // -----------------------------------------------------------------------
    step(3, "Authorize — get the promise, and look at what a promise is");

    const authRequestId = requestIdFor("authorize", order.id);
    const { data: authorized } = await authorizeOrder(order.id, authRequestId);
    const auth = firstAuthorization(authorized);

    fact("authorization id", auth?.id);
    fact("authorization status", auth?.status);
    fact("amount held", auth?.amount ? `${auth.amount.value} ${auth.amount.currency_code}` : "?");
    fact("expires", auth?.expiration_time ?? "(not returned)");

    paypal("the funds are reserved. The buyer's balance is committed, and your account is empty.");
    note("that expiry date is the whole argument: a promise is a thing with a deadline, not a payment");

    await beat();

    // -----------------------------------------------------------------------
    step(4, "Capture the authorization — now the money moves");

    if (!auth?.id) throw new Error("No authorization id returned; cannot capture.");

    const capRequestId = requestIdFor("capture-auth", auth.id);
    beginAttempt("capture-auth", auth.id, capRequestId);
    const { data: capture } = await captureAuthorization(auth.id, capRequestId);
    recordSuccess("capture-auth", auth.id, { captureId: capture.id });

    fact("capture id", capture.id);
    fact("capture status", capture.status);
    fact("gross", capture.seller_receivable_breakdown?.gross_amount?.value ?? capture.amount?.value);
    fact("PayPal fee", capture.seller_receivable_breakdown?.paypal_fee?.value ?? "(not returned)");
    fact("net to merchant", capture.seller_receivable_breakdown?.net_amount?.value ?? "(not returned)");

    markPaid(order.id, capture.id, "api", capture.amount?.value, capture.amount?.currency_code);
    const shipped = fulfil(order.id, "api");
    decision(shipped.explanation);

    paypal("the payment is COMPLETED. Settlement — the money reaching the merchant account — has NOT happened yet.");
  } else {
    // -----------------------------------------------------------------------
    step(3, "Capture — now the money moves");

    // The request id is derived from the order id, not random. Run this script
    // twice against the same order and PayPal returns the first result rather
    // than charging again. Scenario 2 does exactly that, on purpose.
    const requestId = requestIdFor("capture", order.id);
    beginAttempt("capture", order.id, requestId);

    fact("PayPal-Request-Id", requestId);

    const { data: captured } = await captureOrder(order.id, { requestId });
    const capture = firstCapture(captured);

    recordSuccess("capture", order.id, { captureId: capture?.id });

    fact("order status", captured.status);
    fact("capture id", capture?.id);
    fact("capture status", capture?.status);
    fact("gross", capture?.seller_receivable_breakdown?.gross_amount?.value ?? capture?.amount?.value);
    fact("PayPal fee", capture?.seller_receivable_breakdown?.paypal_fee?.value ?? "(not returned)");
    fact("net to merchant", capture?.seller_receivable_breakdown?.net_amount?.value ?? "(not returned)");

    if (capture?.id) {
      markPaid(order.id, capture.id, "api", capture.amount?.value, capture.amount?.currency_code);
      const shipped = fulfil(order.id, "api");
      decision(shipped.explanation);
    }

    paypal("the payment is COMPLETED. Notice the fee breakdown — that is the first hint that a payment is several parties, not one.");
  }

  // -------------------------------------------------------------------------
  step(5, "Ask PayPal what it thinks, and compare with what we recorded");

  const { data: finalOrder } = await getOrder(order.id, true);
  const local = getLocalOrder(order.id);

  fact("PayPal says", finalOrder.status);
  fact("this app says", local?.status ?? "(nothing)");
  fact("we learned it from", local?.paidLearnedFrom ?? "(n/a)");
  fact("fulfilment attempts", local?.fulfilmentAttempts ?? 0);

  blank();
  ok("the two views agree — for now. Scenario 3 is what happens when they disagree.");

  takeaway("Authorization is a promise. Capture is the payment. Settlement is later, and it is not yours to schedule.");
  note(`order id for the next scenario:  ${order.id}`);
});
