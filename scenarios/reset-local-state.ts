/**
 * Wipe this application's local memory.
 *
 *   npm run reset
 *
 * Deletes the ledger, the event log, the order state and the subscription
 * state in .data/. Nothing at PayPal is touched — orders, captures and
 * subscriptions in the sandbox are unaffected.
 *
 * Useful between takes: it puts the "processed exactly once" counters back to
 * zero so the next run tells the story from the beginning.
 */

import { clearLedger } from "../src/store/ledger.js";
import { clearEvents } from "../src/store/events.js";
import { clearOrders } from "../src/domain/order-state.js";
import { clearSubscriptions } from "../src/domain/subscription-state.js";
import { blank, note, ok, title } from "../src/log.js";

title("Reset local state", "PayPal's records are untouched");

clearLedger();
ok("idempotency ledger cleared");

clearEvents();
ok("webhook event log cleared");

clearOrders();
ok("local order state cleared");

clearSubscriptions();
ok("local subscription state cleared");

blank();
note("cached signing certificates in .data/certs are kept — they are public and slow to re-download");
blank();
