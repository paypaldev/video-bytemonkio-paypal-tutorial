/**
 * SCENARIO 5 — Subscriptions: PayPal moves the money, the app decides access.
 *
 *   npm run subscriptions -- --simulate   the state machine, no credentials needed
 *   npm run subscriptions                 product → plan → subscription, for real
 *   npm run subscriptions -- --suspend <I-…>   suspend a live subscription
 *   npm run subscriptions -- --activate <I-…>  bring it back
 *   npm run subscriptions -- --status <I-…>    what PayPal and this app each think
 *
 * A one-time payment is a transaction. A subscription is a workflow that can
 * run for years, and the interesting part is not the first charge — it is the
 * renewal that fails eighteen months in, at 4am, while the customer is asleep.
 *
 * Two state machines are running, and confusing them is the classic mistake:
 *
 *   PayPal's    APPROVAL_PENDING → ACTIVE → SUSPENDED → CANCELLED / EXPIRED
 *               PayPal owns this. It runs the billing cycles and retries
 *               failed charges according to payment_failure_threshold.
 *
 *   yours       NONE → FULL → GRACE → SUSPENDED → ENDED
 *               You own this. PayPal cannot know whether a missed payment
 *               should lock someone out tonight or give them three days.
 *
 * The webhooks are the only wire between them.
 */

import {
  createProduct,
  createPlan,
  createSubscription,
  getSubscription,
  subscriptionApproveLink,
  suspendSubscription,
  activateSubscription,
  cancelSubscription,
  type Subscription,
} from "../src/paypal/subscriptions.js";
import { PORT } from "../src/config.js";
import { requestIdFor, sleep } from "../src/paypal/client.js";
import {
  applySubscriptionEvent,
  getSubscription as getLocalSubscription,
  upsertSubscription,
  clearSubscriptions,
  DEFAULT_POLICY,
  type SubscriptionRecord,
} from "../src/domain/subscription-state.js";
import { bad, blank, c, decision, fact, note, ok, paypal, step, takeaway, title, warn } from "../src/log.js";
import { preflight, runScenario, beat, startReturnListener } from "./_common.js";

const simulate = process.argv.includes("--simulate");
const suspendId = valueOf("--suspend");
const activateId = valueOf("--activate");
const cancelId = valueOf("--cancel");
const statusId = valueOf("--status");

function valueOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

await runScenario(async () => {
  if (simulate) return runSimulation();
  if (suspendId) return runSuspend(suspendId);
  if (activateId) return runActivate(activateId);
  if (cancelId) return runCancel(cancelId);
  if (statusId) return runStatus(statusId);
  return runLive();
});

// ---------------------------------------------------------------------------

async function runLive(): Promise<void> {
  title("5 · Subscriptions: product → plan → subscription", "the current Subscriptions API");
  await preflight();

  // -------------------------------------------------------------------------
  step(1, "Create the product — what you sell");

  const { data: product } = await createProduct({
    name: "ByteMonk Pro",
    description: "Monthly access to everything",
    type: "SERVICE",
    category: "SOFTWARE",
    requestId: requestIdFor("product", `bytemonk-pro-${today()}`),
  });

  fact("product id", product.id);
  fact("type", product.type);
  note("a catalogue entry; nothing is priced yet");

  await beat();

  // -------------------------------------------------------------------------
  step(2, "Create the plan — the price, the trial, and the failure rules");

  const { data: plan } = await createPlan({
    productId: product.id,
    name: "ByteMonk Pro Monthly",
    description: "7-day free trial, then $12/month",
    price: "12.00",
    interval: "MONTH",
    intervalCount: 1,
    trialCycles: 1,
    totalCycles: 0,
    // The number that matters most on this whole page: how many consecutive
    // failed charges PayPal will absorb before it suspends the subscription.
    paymentFailureThreshold: 3,
    requestId: requestIdFor("plan", `bytemonk-pro-monthly-${today()}`),
  });

  fact("plan id", plan.id);
  fact("status", plan.status);

  const trial = plan.billing_cycles?.find((b) => b.tenure_type === "TRIAL");
  const regular = plan.billing_cycles?.find((b) => b.tenure_type === "REGULAR");
  fact("trial", trial ? `${trial.total_cycles} × ${trial.frequency.interval_count} ${trial.frequency.interval_unit}, free` : "none");
  fact("then", regular ? `${regular.pricing_scheme?.fixed_price.value} ${regular.pricing_scheme?.fixed_price.currency_code} / ${regular.frequency.interval_unit.toLowerCase()}` : "?");
  fact("cycles", regular?.total_cycles === 0 ? "until cancelled" : String(regular?.total_cycles));
  fact("failure threshold", plan.payment_preferences?.payment_failure_threshold);
  fact("auto-bill outstanding", String(plan.payment_preferences?.auto_bill_outstanding));

  paypal("owns the billing schedule from here. No cron job of yours will ever run a charge.");
  decision(
    `our grace policy allows ${DEFAULT_POLICY.graceFailures} failures — deliberately BELOW PayPal's threshold of ${plan.payment_preferences?.payment_failure_threshold}`,
  );
  note("if your grace outlasts PayPal's retries, PayPal suspends while your app still thinks the customer is fine");

  await beat();

  // -------------------------------------------------------------------------
  step(3, "Create the subscription and send the customer to approve it");

  const landing = await startReturnListener();
  const { data: subscription } = await createSubscription({
    planId: plan.id,
    givenName: "Sandbox",
    surname: "Buyer",
    customId: `bytemonk-${today()}`,
    returnUrl: landing.returnUrl,
    cancelUrl: landing.cancelUrl,
    requestId: requestIdFor("subscription", `${plan.id}-${Date.now()}`),
  });

  fact("subscription id", subscription.id);
  fact("status", subscription.status);
  upsertSubscription(subscription.id, plan.id, subscription.status);

  const link = subscriptionApproveLink(subscription);
  if (!link) {
    warn("no approval link on the subscription — printing all links for inspection");
    for (const l of subscription.links ?? []) note(`${l.rel} ${l.method ?? "GET"} ${l.href}`);
    throw new Error("Cannot continue without an approval link.");
  }

  blank();
  console.log(c.bold("     Approve as your SANDBOX BUYER:"));
  console.log(`     ${c.cyan(link)}`);
  blank();

  // -------------------------------------------------------------------------
  step(4, "Wait for it to become ACTIVE");

  const active = await pollSubscription(subscription.id, ["ACTIVE"], 5 * 60_000);
  landing.close();
  fact("status", active.status);
  fact("next billing", active.billing_info?.next_billing_time ?? "(during trial)");
  fact("last payment", active.billing_info?.last_payment?.amount.value ?? "(none — free trial)");

  // Deliberately NOT synthesising a BILLING.SUBSCRIPTION.ACTIVATED here. The
  // webhook is the only thing allowed to move this application's view of a
  // subscription — that is the whole design.
  //
  // But PayPal reports ACTIVE the moment the buyer approves, and the webhook
  // takes a few seconds longer to arrive. Printing in that gap shows our
  // record still saying APPROVAL_PENDING / NONE, which looks like a bug rather
  // than a lesson. So wait for the event, and say what we are waiting for.
  blank();

  // Only wait for a webhook if something is actually listening for one.
  // Otherwise this is a guaranteed minute of watching dots for an event that
  // has nowhere to be delivered, which looks like a hang rather than a lesson.
  const listening = await fetch(`http://localhost:${PORT}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!listening) {
    warn("PayPal says ACTIVE. This application has granted nothing, and cannot yet.");
    note(`nothing is listening on http://localhost:${PORT}, so no webhook can arrive`);
    note("that gap is the design, not a bug: access follows a verified event, never a poll");
    blank();
    note("to see the two views agree, run the server and a tunnel, then:");
    note(`  npm run subscriptions -- --status ${subscription.id}`);
    blank();
    printLocal(subscription.id);
  } else {
    note("PayPal says ACTIVE. Our record will not move until a verified webhook says so —");
    note("waiting for BILLING.SUBSCRIPTION.ACTIVATED to arrive…");

    const agreed = await waitForLocalStatus(subscription.id, "ACTIVE", 60_000);
    blank();
    printLocal(subscription.id);

    if (agreed) {
      ok("the webhook arrived, was verified, and granted access — the two views now agree");
    } else {
      warn("no activation webhook arrived. PayPal is ACTIVE; this application has granted nothing.");
      note("the listener is up, so check the tunnel is running and its URL matches the dashboard");
      note("run `npm run doctor` to find out which");
    }
  }

  ok("PayPal will now charge this customer on schedule, without you scheduling anything");

  blank();
  note("what happens next takes a month in real time, so run the state machine directly:");
  note(`  npm run subscriptions -- --simulate`);
  note("or drive real state changes and watch the webhooks land:");
  note(`  npm run subscriptions -- --suspend ${subscription.id}`);
  note(`  npm run subscriptions -- --activate ${subscription.id}`);

  takeaway("PayPal moves the money. The application decides access.");
}

// ---------------------------------------------------------------------------

async function runSimulation(): Promise<void> {
  title("5 · The subscription state machine", "renewal failure → grace → suspend → recovery");

  warn("SIMULATED: these events are fixtures. A real renewal failure is a month away and does not fit in a video.");
  note("the transitions, the policy, and the code path are exactly the ones the live webhooks drive");
  blank();
  note(`policy: keep access for up to ${DEFAULT_POLICY.graceFailures} failed renewals, or ${DEFAULT_POLICY.graceDays} days, whichever comes first`);

  clearSubscriptions();
  const id = "I-SIMULATED0001";
  upsertSubscription(id, "P-SIMULATEDPLAN0000000000");

  interface Beat {
    /** Stable id, so a beat can be deliberately redelivered later. */
    eventId: string;
    eventType: string;
    story: string;
    /**
     * Redeliver this same event immediately after it lands.
     *
     * Placed on the FIRST failure on purpose. The counter is 1 at that moment,
     * so a replay that leaves it at 1 is visible proof. Doing this at the end
     * of the run instead would compare 0 with 0, after a successful charge had
     * already reset the counter, and prove nothing at all.
     */
    thenRedeliver?: boolean;
  }

  const beats: Beat[] = [
    { eventId: "sim-01", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", story: "the customer approved and the trial began" },
    { eventId: "sim-02", eventType: "PAYMENT.SALE.COMPLETED", story: "the first real charge, after the trial" },
    { eventId: "sim-03", eventType: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", story: "month four: the card expired", thenRedeliver: true },
    { eventId: "sim-04", eventType: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", story: "PayPal's first retry also failed" },
    { eventId: "sim-05", eventType: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", story: "and the second" },
    { eventId: "sim-06", eventType: "BILLING.SUBSCRIPTION.SUSPENDED", story: "PayPal gave up, per payment_failure_threshold" },
    { eventId: "sim-07", eventType: "PAYMENT.SALE.COMPLETED", story: "the customer updated their card and paid" },
    { eventId: "sim-08", eventType: "BILLING.SUBSCRIPTION.ACTIVATED", story: "PayPal reactivated the subscription" },
    { eventId: "sim-09", eventType: "BILLING.SUBSCRIPTION.CANCELLED", story: "eleven months later, they cancelled" },
  ];

  let n = 1;
  for (const { eventId, eventType, story, thenRedeliver } of beats) {
    step(n++, story);
    const res = applySubscriptionEvent(id, eventType, eventId);
    fact("event", eventType);
    paypal(res.paypalDid);
    decision(res.appDecided);
    fact("billing status", res.record.billingStatus);
    fact("access level", accessColour(res.record.accessLevel));
    fact("consecutive failures", res.record.consecutiveFailures);
    await beat(400);

    if (!thenRedeliver) continue;

    // -----------------------------------------------------------------------
    step(n++, "PayPal delivers that same failure again");

    const before = getLocalSubscription(id)!.consecutiveFailures;
    const replay = applySubscriptionEvent(id, eventType, eventId);
    const after = getLocalSubscription(id)!.consecutiveFailures;

    fact("event id", eventId);
    fact("failures before", before);
    fact("failures after", after);
    note(replay.appDecided);

    if (before === after && before > 0) {
      ok(`still ${after} failure, not ${before + 1} — the replay did not burn a grace attempt`);
      note("get this wrong and a customer loses access to a duplicate, not to a missed payment");
    } else {
      bad(`counter moved from ${before} to ${after} on a replay`);
    }
    await beat(400);
  }

  step("✓", "The history, as the application recorded it");
  printHistory(getLocalSubscription(id)!);

  takeaway("PayPal manages the billing attempts. Your application decides what a failed attempt means for the customer.");
}

// ---------------------------------------------------------------------------

async function runSuspend(id: string): Promise<void> {
  title("5 · Suspend a live subscription", id);
  await preflight();
  step(1, "POST /v1/billing/subscriptions/{id}/suspend");
  await suspendSubscription(id, "Demonstrating the suspended state on camera");
  paypal("accepted the suspension — a BILLING.SUBSCRIPTION.SUSPENDED webhook is on its way");
  const after = await pollSubscription(id, ["SUSPENDED"], 60_000);
  fact("PayPal status", after.status);
  note("PayPal has stopped billing. Whether the customer loses access is our call,");
  note("and we do not make it until a verified event tells us to.");
  await showAgreement(id, "SUSPENDED");
}

async function runActivate(id: string): Promise<void> {
  title("5 · Reactivate a subscription", id);
  await preflight();
  step(1, "POST /v1/billing/subscriptions/{id}/activate");
  await activateSubscription(id, "Restoring access after the customer fixed their payment method");
  paypal("accepted the reactivation");
  const after = await pollSubscription(id, ["ACTIVE"], 60_000);
  fact("PayPal status", after.status);
  await showAgreement(id, "ACTIVE");
}

async function runCancel(id: string): Promise<void> {
  title("5 · Cancel a subscription", id);
  await preflight();
  step(1, "POST /v1/billing/subscriptions/{id}/cancel");
  await cancelSubscription(id, "Demo cleanup");
  paypal("cancelled — no further charges will be attempted");
  const after = await pollSubscription(id, ["CANCELLED"], 60_000);
  fact("PayPal status", after.status);
  decision("access continues until the end of the period they already paid for");
  await showAgreement(id, "CANCELLED");
}

async function runStatus(id: string): Promise<void> {
  title("5 · Two views of one subscription", id);
  await preflight();

  step(1, "What PayPal thinks");
  const { data: sub } = await getSubscription(id);
  fact("status", sub.status);
  fact("plan", sub.plan_id);
  fact("next billing", sub.billing_info?.next_billing_time ?? "(none)");
  fact("failed payments", sub.billing_info?.failed_payments_count ?? 0);
  fact("outstanding", sub.billing_info?.outstanding_balance?.value ?? "0.00");

  step(2, "What this application thinks");
  printLocal(id);
  note("PayPal's column is billing. Ours is access. They are related, and they are not the same.");
}

// ---------------------------------------------------------------------------

async function pollSubscription(
  id: string,
  wanted: Subscription["status"][],
  timeoutMs: number,
): Promise<Subscription> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { data } = await getSubscription(id, true);
    if (data.status !== last) {
      last = data.status;
      console.log(`     ${c.grey("status →")} ${c.bold(data.status)}`);
    }
    if (wanted.includes(data.status)) return data;
    process.stdout.write(c.grey("."));
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for ${wanted.join(" or ")}`);
}

/**
 * Wait for the webhook to move this application's record, then print both
 * views.
 *
 * Every command here changes state at PayPal and returns immediately. The
 * event that tells this application about it arrives seconds later. Printing
 * the local record straight away therefore always shows it unchanged, which
 * reads as a broken app rather than as the asynchrony being demonstrated.
 */
async function showAgreement(id: string, wantedBillingStatus: string): Promise<void> {
  const listening = await fetch(`http://localhost:${PORT}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!listening) {
    blank();
    warn(`PayPal has changed. This application has not, and cannot.`);
    note(`nothing is listening on http://localhost:${PORT}, so no webhook can arrive`);
    note("access follows a verified event, never a poll — that is the design");
    blank();
    printLocal(id);
    return;
  }

  blank();
  note(`waiting for the webhook to reach this application…`);
  const agreed = await waitForLocalStatus(id, wantedBillingStatus, 60_000);
  blank();
  printLocal(id);

  if (agreed) {
    ok("the event arrived, was verified, and the two views now agree");
  } else {
    warn("no webhook arrived within 60s. PayPal has changed; this application has not.");
    note("check the server terminal, then `npm run doctor` for the tunnel");
  }
}

/** Wait for a verified webhook to move THIS application's record. */
async function waitForLocalStatus(
  id: string,
  wanted: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getLocalSubscription(id)?.billingStatus === wanted) return true;
    process.stdout.write(c.grey("."));
    await sleep(2000);
  }
  return false;
}

function printLocal(id: string): void {
  const record = getLocalSubscription(id);
  if (!record) {
    note("this application has no record of that subscription yet");
    return;
  }
  fact("billing status (PayPal's)", record.billingStatus);
  fact("access level (ours)", accessColour(record.accessLevel));
  fact("consecutive failures", record.consecutiveFailures);
  fact("events applied", record.appliedEventIds.length);
}

function printHistory(record: SubscriptionRecord): void {
  blank();
  console.log(
    `     ${c.bold("event".padEnd(38))}${c.bold("billing".padEnd(18))}${c.bold("access")}`,
  );
  console.log(`     ${c.grey("─".repeat(72))}`);
  for (const h of record.history) {
    console.log(`     ${h.event.padEnd(38)}${h.billing.padEnd(18)}${accessColour(h.access)}`);
    console.log(`     ${c.grey(`  └ ${h.why}`)}`);
  }
  blank();
}

function accessColour(level: string): string {
  switch (level) {
    case "FULL":
      return c.green(level);
    case "GRACE":
      return c.yellow(level);
    case "SUSPENDED":
      return c.red(level);
    default:
      return c.grey(level);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
