/**
 * SCENARIO 6 — Venmo as a funding source, not a second integration.
 *
 *   npm run venmo
 *
 * The point the script makes: Venmo is not a separate payment backend you
 * build and operate. It is the same SDK instance, the same order, the same
 * capture, the same webhooks, with one extra component and an eligibility
 * check.
 *
 * This script explains the v6 setup the checkout page uses, states the
 * eligibility rules plainly, and says what stays identical, because "Venmo
 * isn't showing up" is almost always one of those rules rather than a bug in
 * your code.
 */

import { BUYER_COUNTRY, CURRENCY, PORT, clientId, isLive } from "../src/config.js";
import { blank, c, fact, note, ok, step, takeaway, title, warn } from "../src/log.js";
import { runScenario } from "./_common.js";

await runScenario(async () => {
  title("6 · Venmo in the same checkout", "one component and an eligibility check, not a second integration");

  // -------------------------------------------------------------------------
  step(1, "How the checkout page loads the SDK");

  const host = isLive() ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";

  blank();
  console.log(`     ${c.cyan(`<script src="${host}/web-sdk/v6/core"></script>`)}`);
  blank();

  fact("SDK", "JavaScript SDK v6");
  fact("host", `${host} — sandbox and live are different hosts, not a query parameter`);
  note("loading the wrong host silently talks to the wrong world");

  // -------------------------------------------------------------------------
  step(2, "Creating the instance");

  blank();
  console.log(
    c.cyan(
      [
        "     const sdkInstance = await window.paypal.createInstance({",
        `       clientId: "${clientId().slice(0, 8)}…",`,
        '       components: ["paypal-payments", "venmo-payments"],',
        '       pageType: "checkout",',
        "     });",
      ].join("\n"),
    ),
  );
  blank();

  fact("clientId", "browser-safe — this one is meant to ship to the frontend");
  fact("venmo-payments", "the component that makes Venmo available at all");
  note("the client secret never appears here. For standard checkout, v6 authenticates with the id alone.");

  // -------------------------------------------------------------------------
  step(3, "Asking what this buyer can actually use");

  blank();
  console.log(
    c.cyan(
      [
        "     const paymentMethods = await sdkInstance.findEligibleMethods({",
        `       currencyCode: "${CURRENCY}",`,
        ...(isLive() ? [] : [`       countryCode: "${BUYER_COUNTRY}",   // sandbox testing only`]),
        "     });",
        "",
        '     if (paymentMethods.isEligible("venmo")) { /* reveal the button */ }',
      ].join("\n"),
    ),
  );
  blank();

  ok("this is the part v5 could not do honestly");
  note("in v5 you declared enable-funding=venmo and hoped; the eligibility API reported nothing usable");
  note("in v6 you ask first, and only reveal buttons the buyer can actually use");

  if (!isLive()) {
    warn("countryCode is a sandbox testing override. Never send it in production.");
  }

  // -------------------------------------------------------------------------
  step(4, "What has to be true for Venmo to appear");

  const rules: Array<[string, string]> = [
    ["merchant account", "must be US-based"],
    ["buyer", "must be US-based"],
    ["currency", "must be USD"],
    ["component", "venmo-payments must be requested at createInstance"],
    ["mobile buyers", "Safari on iOS, Chrome on Android, with the Venmo app installed"],
    ["desktop buyers", "QR code in production; sandbox shows a Venmo web login instead"],
  ];
  blank();
  for (const [what, requirement] of rules) {
    console.log(`     ${c.grey(what.padEnd(18))} ${requirement}`);
  }
  blank();
  note("if the Venmo button does not render, walk this list before you debug your code");

  // -------------------------------------------------------------------------
  step(5, "What stays exactly the same");

  ok("the order is created by your server, the same way, with the same body");
  ok("the capture is the same call, with the same PayPal-Request-Id protection");
  ok("the webhooks are the same events, verified the same way");
  note("PayPal and Venmo share one set of session callbacks on the page — onApprove, onCancel, onError");
  note("the only difference is which createXOneTimePaymentSession you called");

  // -------------------------------------------------------------------------
  step(6, "The moment to record");

  const health = await fetch(`http://localhost:${PORT}/api/health`)
    .then((r) => r.json())
    .catch(() => null);

  if (health) {
    ok(`server is up — open http://localhost:${PORT}/`);
  } else {
    warn(`nothing is listening on http://localhost:${PORT} — run \`npm run server\` first`);
  }

  blank();
  note("on the page you should see, in the log panel:");
  note("  • eligible for this buyer: paypal, venmo, …");
  note("  • `venmo is eligible for this buyer ✓`");
  note("  • `buyer chose: venmo` when you press the Venmo button");
  note("  • then POST /api/orders — the SAME endpoint the PayPal button uses");
  blank();
  note("you CAN complete the payment. Clicking Venmo in sandbox opens PayPal's");
  note("Venmo Sandbox simulator, which reads 'Venmo is working!' and lets you");
  note("sign in with your ordinary sandbox buyer to simulate a Venmo payment.");
  note("No separate Venmo credential is needed.");
  blank();
  note("the resulting order is captured through the same endpoint, and produces");
  note("the same PAYMENT.CAPTURE.COMPLETED webhook, as a PayPal payment does.");

  takeaway("Same checkout, same server code, same webhooks — one more funding source the buyer already trusts.");
});
