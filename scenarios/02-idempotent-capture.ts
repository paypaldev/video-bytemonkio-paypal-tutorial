/**
 * SCENARIO 2 — The same capture, sent twice.
 *
 *   npm run idempotency
 *   npm run idempotency -- --order 5O190127TN364715T   (reuse an approved order)
 *   npm run idempotency -- --unsafe                    (send it twice with NO request id)
 *
 * The situation: your capture request goes out, and nothing comes back. The
 * connection died. You cannot tell whether the payment succeeded and the
 * response was lost, or the payment never happened at all.
 *
 * Retrying is the only way to find out. Retrying is also how you charge
 * someone twice. PayPal-Request-Id is what makes those two statements stop
 * being in conflict.
 *
 * Both responses are printed in full so you can compare them yourself. The
 * thing to look at is the capture id and its create_time: identical in both
 * responses means one charge, returned twice — not two charges.
 */

import { createOrder, captureOrder, firstCapture, getOrder } from "../src/paypal/orders.js";
import { requestIdFor } from "../src/paypal/client.js";
import { PayPalApiError } from "../src/paypal/errors.js";
import { beginAttempt, getAttempt, recordSuccess } from "../src/store/ledger.js";
import { createLocalOrder, fulfil, markPaid, getLocalOrder } from "../src/domain/order-state.js";
import { bad, blank, c, decision, fact, note, ok, paypal, step, takeaway, title, warn } from "../src/log.js";
import { preflight, runScenario, waitForApproval, beat, startReturnListener } from "./_common.js";

const argOrder = valueOf("--order");
const unsafe = process.argv.includes("--unsafe");

function valueOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

await runScenario(async () => {
  title(
    "2 · Idempotency: the same capture, sent twice",
    unsafe ? "WITHOUT PayPal-Request-Id — for comparison" : "with PayPal-Request-Id",
  );

  await preflight();

  // -------------------------------------------------------------------------
  step(1, "Get an approved order to capture");

  let orderId: string;

  if (argOrder) {
    const { data: existing } = await getOrder(argOrder, true);
    fact("order id", existing.id);
    fact("status", existing.status);
    if (existing.status !== "APPROVED" && existing.status !== "COMPLETED") {
      throw new Error(`Order ${argOrder} is ${existing.status}; it must be APPROVED to capture.`);
    }
    orderId = existing.id;
  } else {
    const landing = await startReturnListener();
    const { data: order } = await createOrder({
      amount: "24.00",
      description: "Coffee Subscription Box",
      customId: "bytemonk-demo-02",
      payPalWalletOnly: true,
      returnUrl: landing.returnUrl,
      cancelUrl: landing.cancelUrl,
    });
    createLocalOrder(order.id, "24.00");
    fact("order id", order.id);
    await waitForApproval(order);
    landing.close();
    orderId = order.id;
  }

  await beat();

  // -------------------------------------------------------------------------
  step(2, "Send the capture — and pretend the response is lost");

  // The id is derived from the order, so it is the same id every time this
  // capture is attempted, from any process, after any crash. That is the
  // property that matters; a random UUID generated at call time gives you
  // nothing, because the retry generates a different one.
  const requestId = requestIdFor("capture", orderId);
  const { fresh, entry } = beginAttempt("capture", orderId, requestId);

  fact("PayPal-Request-Id", entry.requestId);
  note(fresh ? "first attempt at this capture" : `attempt #${entry.attempts} — reusing the id from the first attempt`);

  const first = await captureOrder(orderId, {
    requestId: unsafe ? undefined as unknown as string : entry.requestId,
    retry: false,
  });
  const firstCap = firstCapture(first.data);
  recordSuccess("capture", orderId, { captureId: firstCap?.id });

  if (firstCap?.id) {
    markPaid(orderId, firstCap.id, "api", firstCap.amount?.value, firstCap.amount?.currency_code);
    fulfil(orderId, "api");
  }

  printCapture("RESPONSE 1", first.status, first.data.status, firstCap);
  warn("now imagine this response never arrived. The socket closed. You have no idea if this happened.");

  await beat(1200);

  // -------------------------------------------------------------------------
  step(3, "Send the exact same request again");

  // Claim the attempt again before sending. The ledger counter is what shows,
  // afterwards, that two attempts produced one charge.
  const repeat = beginAttempt("capture", orderId, entry.requestId);

  if (unsafe) {
    note("no PayPal-Request-Id this time — nothing tells PayPal these two calls are the same call");
  } else {
    note(`same path, same body, same PayPal-Request-Id: ${repeat.entry.requestId}`);
    fact("ledger attempt", `#${repeat.entry.attempts}`);
  }

  let secondCap: ReturnType<typeof firstCapture>;
  let secondStatus = 0;
  let secondOrderStatus = "";

  try {
    const second = await captureOrder(orderId, {
      requestId: unsafe ? (undefined as unknown as string) : entry.requestId,
      retry: false,
    });
    secondCap = firstCapture(second.data);
    secondStatus = second.status;
    secondOrderStatus = second.data.status;
    printCapture("RESPONSE 2", second.status, second.data.status, secondCap);
  } catch (err) {
    if (err instanceof PayPalApiError) {
      // The --unsafe path lands here. PayPal still refuses to double-charge —
      // but it refuses with an ERROR, which your code has to be ready to read.
      blank();
      console.log(`     ${c.bold("RESPONSE 2")}`);
      fact("http status", err.status);
      fact("name", err.body.name);
      fact("issue", err.issues.join(", ") || "(none)");
      fact("classified as", err.handling);
      blank();
      paypal("it refused to capture the same order twice — but as a failure you have to interpret, not a result you can use.");
      note("with the request id, the second call is a SUCCESS carrying the original result. That difference is the feature.");

      finish(orderId, entry.requestId, undefined, undefined);
      return;
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  step(4, "Compare the two responses");

  const sameCapture = Boolean(firstCap?.id && firstCap.id === secondCap?.id);
  const sameTime = firstCap?.create_time === secondCap?.create_time;

  fact("capture id #1", firstCap?.id);
  fact("capture id #2", secondCap?.id);
  fact("identical", sameCapture ? "YES" : "NO");
  fact("create_time #1", firstCap?.create_time);
  fact("create_time #2", secondCap?.create_time);
  fact("identical", sameTime ? "YES" : "NO");
  fact("http status #2", secondStatus);
  fact("order status #2", secondOrderStatus);

  blank();
  if (sameCapture) {
    ok("one capture id, returned twice. The second call created nothing.");
    ok(`create_time is unchanged — response 2 is a replay of response 1, not a new charge at ${new Date().toISOString()}`);
    paypal("stored the result of the first request and handed it back, rather than performing the action again.");
  } else {
    bad("the two responses describe DIFFERENT captures. That is a double charge.");
  }

  finish(orderId, entry.requestId, firstCap?.id, secondCap?.id);
});

function printCapture(
  label: string,
  httpStatus: number,
  orderStatus: string,
  capture: ReturnType<typeof firstCapture>,
): void {
  blank();
  console.log(`     ${c.bold(label)}`);
  fact("http status", httpStatus);
  fact("order status", orderStatus);
  fact("capture id", capture?.id);
  fact("capture status", capture?.status);
  fact("amount", capture?.amount ? `${capture.amount.value} ${capture.amount.currency_code}` : "?");
  fact("create_time", capture?.create_time);
}

function finish(orderId: string, requestId: string, id1?: string, id2?: string): void {
  step(5, "What the application recorded");

  const local = getLocalOrder(orderId);
  const attempt = getAttempt("capture", orderId);

  fact("order status", local?.status);
  fact("capture recorded", local?.captureId);
  fact("fulfilment attempts", local?.fulfilmentAttempts ?? 0);
  fact("times fulfilled", local?.fulfilledAt ? 1 : 0);
  fact("ledger attempts", attempt?.attempts ?? 0);
  fact("ledger request id", attempt?.requestId ?? requestId);

  decision("one capture, one fulfilment — no matter how many times the request was sent");

  if (id1 && id2 && id1 === id2) {
    takeaway("Making the payment was never the hard part. Proving you already made it is — and a stable request id is the proof.");
  } else {
    takeaway("Without a request id you are relying on the platform to guess your intent. With one, you are telling it.");
  }
}
