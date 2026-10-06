/**
 * Shared helpers for the runnable scenarios.
 *
 * Every scenario in this folder is meant to be run on camera and read aloud.
 * These helpers exist so each scenario file stays about ONE idea, with no
 * plumbing in the way.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { getOrder, approveLink, type Order } from "../src/paypal/orders.js";
import { describeToken } from "../src/paypal/auth.js";
import { API_BASE, env as payPalEnv, isLive } from "../src/config.js";
import { isPaymentFailure } from "../src/paypal/errors.js";
import { bad, blank, c, fact, note, ok, step, warn } from "../src/log.js";
import { sleep } from "../src/paypal/client.js";

/**
 * Print the environment before doing anything, so a viewer can see this is a
 * real sandbox account and not a recording of a mock.
 */
export async function preflight(): Promise<void> {
  step(0, "Authenticate: trade the client id and secret for an access token");
  fact("environment", payPalEnv);
  fact("api base", API_BASE);

  if (isLive()) {
    warn("PAYPAL_ENV is set to live. These scenarios move real money. Stopping.");
    process.exit(1);
  }

  const token = await describeToken();
  fact("access token", token.tokenPreview);
  fact("expires in", `${token.expiresInMinutes} minutes`);
  fact("scopes granted", token.scopeCount);
  note("the client secret never leaves the server; only this short-lived token travels with requests");
}

/**
 * A place for the buyer's browser to land after they approve.
 *
 * PayPal needs a `return_url`. Without one, approval works but the buyer is
 * stranded on PayPal's page watching a spinner, because there is nowhere for
 * them to be sent next. Your backend is perfectly happy; the customer thinks
 * your site is broken.
 *
 * A real integration points this at its own order confirmation page. These
 * scenarios have no web app, so each run starts a tiny listener on a spare
 * port and shuts it down afterwards. The redirect is done by the browser, not
 * by PayPal's servers, so localhost is fine.
 */
export interface ReturnListener {
  returnUrl: string;
  cancelUrl: string;
  close(): void;
}

export async function startReturnListener(): Promise<ReturnListener> {
  const server = http.createServer((req, res) => {
    const cancelled = (req.url ?? "").startsWith("/cancelled");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingPage(cancelled));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    returnUrl: `http://localhost:${port}/approved`,
    cancelUrl: `http://localhost:${port}/cancelled`,
    close: () => server.close(),
  };
}

function landingPage(cancelled: boolean): string {
  const title = cancelled ? "Payment cancelled" : "Approved";
  const body = cancelled
    ? "You cancelled at PayPal. Nothing was charged."
    : "You approved the payment, and <strong>no money has moved yet</strong>. " +
      "The capture happens on the server. Head back to your terminal.";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0e14; color:#e6e9ef;
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { max-width:32rem; padding:2.5rem; border:1px solid #232a38;
          border-radius:12px; background:#141924; text-align:center; }
  h1 { margin:0 0 .75rem; font-size:1.35rem; }
  p { margin:0; color:#8b95a7; }
  .tick { font-size:2rem; color:${cancelled ? "#e8b93b" : "#35c46b"}; }
</style></head>
<body><div class="card">
  <div class="tick">${cancelled ? "×" : "✓"}</div>
  <h1>${title}</h1>
  <p>${body}</p>
</div></body></html>`;
}

/**
 * Print the approval URL and wait for the buyer to approve at PayPal.
 *
 * This pause is not an inconvenience to be engineered away — it is the part of
 * the payment your backend does not control, and the reason the whole flow is
 * asynchronous.
 */
export async function waitForApproval(
  order: Order,
  { timeoutMs = 5 * 60_000, intervalMs = 3000 } = {},
): Promise<Order> {
  const link = approveLink(order);
  if (!link) {
    throw new Error("No approval link on the order — cannot continue.");
  }

  blank();
  console.log(c.bold("     Open this URL and pay with your SANDBOX BUYER account:"));
  console.log(`     ${c.cyan(link)}`);
  blank();
  note("polling the order until PayPal tells us the buyer approved…");

  const deadline = Date.now() + timeoutMs;
  let lastStatus = order.status;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const { data: current } = await getOrder(order.id, true);

    if (current.status !== lastStatus) {
      lastStatus = current.status;
      console.log(`     ${c.grey("status →")} ${c.bold(current.status)}`);
    }

    if (current.status === "APPROVED") {
      ok("buyer approved. Note what has NOT happened yet: no money has moved.");
      return current;
    }
    if (current.status === "VOIDED") {
      throw new Error("The buyer cancelled this order.");
    }
    process.stdout.write(c.grey("."));
  }

  throw new Error("Timed out waiting for approval.");
}

/**
 * Wrap a scenario's main function so a failure is reported the way this repo
 * argues failures should be: classified, explained, and never a bare stack.
 */
export async function runScenario(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    blank();
    if (isPaymentFailure(err)) {
      bad(`${err.name}: ${err.message}`);
      note(err.operatorMessage());
      note(`this failure classifies as: ${err.handling}`);
    } else {
      bad((err as Error).message ?? String(err));
      if (process.env.VERBOSE === "1") console.error(err);
    }
    blank();
    process.exitCode = 1;
  }
}

/** A short pause so the camera can keep up with a fast API. */
export async function beat(ms = 700): Promise<void> {
  await sleep(ms);
}
