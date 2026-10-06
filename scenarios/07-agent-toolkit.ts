/**
 * SCENARIO 7 — An agent starting a payment (stretch).
 *
 *   npm run agent
 *
 * PayPal ships an Agent Toolkit and an MCP server that expose payment actions
 * as structured tools an LLM can call. Both are real and linked at the bottom
 * of this file. What neither of them does — what nothing can do for you — is
 * make the payment safe.
 *
 * So this script does not wrap the toolkit. It shows the four things you still
 * have to build around ANY agent tool surface, and then lets an agent-shaped
 * caller loose on it:
 *
 *   scoped access       the agent gets create-order, and nothing else. Not
 *                       capture, not refund. Enumerated, not assumed.
 *   approval boundary   amounts above a limit stop and wait for a human.
 *   idempotency         the same intent produces the same request id, so an
 *                       agent that retries — and they retry — does not create
 *                       a second order.
 *   audit trail         every attempt, allowed or refused, is recorded with
 *                       who asked, for what, and what happened.
 *
 * The claim from the script that this is testing: agents change WHO starts the
 * payment. They do not change the distributed system underneath it.
 */

import { createOrder, getOrder } from "../src/paypal/orders.js";
import { requestIdFor } from "../src/paypal/client.js";
import { PayPalApiError, isPaymentFailure } from "../src/paypal/errors.js";
import { beginAttempt, recordSuccess } from "../src/store/ledger.js";
import { createLocalOrder } from "../src/domain/order-state.js";
import { bad, blank, c, decision, fact, note, ok, paypal, step, takeaway, title, warn } from "../src/log.js";
import { preflight, runScenario, beat } from "./_common.js";

// ---------------------------------------------------------------------------
// The tool surface the agent is allowed to see.
// ---------------------------------------------------------------------------

interface AgentContext {
  /** Who is acting. Every audit line carries it. */
  actor: string;
  /** Enumerated capabilities. Anything not in here does not exist to the agent. */
  scopes: string[];
  /** Above this, a human has to say yes. */
  approvalLimit: number;
  currency: string;
}

interface AuditEntry {
  at: string;
  actor: string;
  tool: string;
  input: unknown;
  outcome: "ALLOWED" | "REFUSED_SCOPE" | "REFUSED_APPROVAL" | "FAILED" | "DEDUPED";
  detail: string;
  requestId?: string;
}

const audit: AuditEntry[] = [];

function record(entry: Omit<AuditEntry, "at">): void {
  audit.push({ at: new Date().toISOString(), ...entry });
}

/**
 * One tool. Note what it does BEFORE it calls PayPal: checks the scope, checks
 * the amount against the approval limit, and derives a request id from the
 * agent's own intent key. All three are the caller's job, not the toolkit's.
 */
async function toolCreateOrder(
  ctx: AgentContext,
  input: { intentKey: string; amount: string; description: string },
): Promise<{ ok: boolean; orderId?: string; message: string }> {
  const tool = "create_order";

  // 1. Scope.
  if (!ctx.scopes.includes(tool)) {
    record({ actor: ctx.actor, tool, input, outcome: "REFUSED_SCOPE", detail: "not in the agent's scopes" });
    return { ok: false, message: `refused: ${ctx.actor} does not have the ${tool} scope` };
  }

  // 2. Approval boundary.
  if (Number(input.amount) > ctx.approvalLimit) {
    record({
      actor: ctx.actor,
      tool,
      input,
      outcome: "REFUSED_APPROVAL",
      detail: `${input.amount} exceeds the ${ctx.approvalLimit} ${ctx.currency} limit`,
    });
    return {
      ok: false,
      message: `held for human approval: ${input.amount} ${ctx.currency} is over the ${ctx.approvalLimit} limit`,
    };
  }

  // 3. Idempotency, derived from the agent's stated intent — not from a fresh
  //    UUID, because an agent that retries would generate a different one.
  const requestId = requestIdFor("agent-create", input.intentKey);
  const { fresh, entry } = beginAttempt("agent-create", input.intentKey, requestId);

  if (!fresh && entry.state === "SUCCEEDED") {
    const existing = entry.result as { orderId?: string } | undefined;
    record({
      actor: ctx.actor,
      tool,
      input,
      outcome: "DEDUPED",
      detail: `intent ${input.intentKey} was already fulfilled as order ${existing?.orderId}`,
      requestId: entry.requestId,
    });
    return { ok: true, ...(existing?.orderId ? { orderId: existing.orderId } : {}), message: "already done — returning the original order" };
  }

  // 4. Now, and only now, call PayPal.
  try {
    const { data: order } = await createOrder({
      amount: input.amount,
      description: input.description,
      customId: `agent-${input.intentKey}`,
      requestId: entry.requestId,
    });

    createLocalOrder(order.id, input.amount, ctx.currency);
    recordSuccess("agent-create", input.intentKey, { orderId: order.id });
    record({
      actor: ctx.actor,
      tool,
      input,
      outcome: "ALLOWED",
      detail: `created order ${order.id}`,
      requestId: entry.requestId,
    });

    return { ok: true, orderId: order.id, message: `created order ${order.id}` };
  } catch (err) {
    const detail = isPaymentFailure(err) ? err.operatorMessage() : String(err);
    record({ actor: ctx.actor, tool, input, outcome: "FAILED", detail, requestId: entry.requestId });
    return { ok: false, message: `failed: ${err instanceof PayPalApiError ? err.body.name : "transport error"}` };
  }
}

/** A tool the agent is deliberately NOT given. */
async function toolCaptureOrder(
  ctx: AgentContext,
  input: { orderId: string },
): Promise<{ ok: boolean; message: string }> {
  const tool = "capture_order";
  if (!ctx.scopes.includes(tool)) {
    record({ actor: ctx.actor, tool, input, outcome: "REFUSED_SCOPE", detail: "not in the agent's scopes" });
    return { ok: false, message: `refused: ${ctx.actor} does not have the ${tool} scope` };
  }
  return { ok: false, message: "unreachable in this demo" };
}

// ---------------------------------------------------------------------------

await runScenario(async () => {
  title("7 · An agent starting a payment", "scoped access, an approval boundary, idempotency, and an audit trail");

  await preflight();

  const ctx: AgentContext = {
    actor: "shopping-agent@bytemonk",
    // Create an order: yes. Move money: no. That asymmetry is the whole design.
    scopes: ["create_order"],
    approvalLimit: 50,
    currency: "USD",
  };

  step(1, "What this agent is allowed to do");
  fact("actor", ctx.actor);
  fact("scopes", ctx.scopes.join(", "));
  fact("approval limit", `${ctx.approvalLimit} ${ctx.currency}`);
  note("capture and refund are absent — not disabled, absent. The agent cannot ask for what it cannot see.");

  await beat();

  // -------------------------------------------------------------------------
  step(2, "The agent creates an order, within its limit");

  const intentKey = `coffee-box-${new Date().toISOString().slice(0, 10)}`;
  fact("agent's intent key", intentKey);

  const first = await toolCreateOrder(ctx, {
    intentKey,
    amount: "24.00",
    description: "Coffee Subscription Box",
  });

  fact("result", first.message);
  const { data: created } = await getOrder(first.orderId!, true);
  fact("order status", created.status);
  paypal("an order exists, created by software rather than by a click");
  decision("no money has moved, and this agent cannot move it");

  await beat();

  // -------------------------------------------------------------------------
  step(3, "The agent retries, because agents retry");

  note("same intent, same key — a second order here would be a real duplicate charge waiting to happen");

  const retry = await toolCreateOrder(ctx, {
    intentKey,
    amount: "24.00",
    description: "Coffee Subscription Box",
  });

  fact("result", retry.message);
  fact("same order id", retry.orderId === first.orderId ? "YES" : "NO");
  ok("the request id that protects you from a double click protects you from a retrying agent, unchanged");

  await beat();

  // -------------------------------------------------------------------------
  step(4, "The agent tries to spend more than it may");

  const expensive = await toolCreateOrder(ctx, {
    intentKey: `laptop-${Date.now()}`,
    amount: "1299.00",
    description: "A laptop the agent decided you needed",
  });

  fact("result", expensive.message);
  decision("stop and ask a human — an approval boundary is a number you set, not a judgement the model makes");

  await beat();

  // -------------------------------------------------------------------------
  step(5, "The agent tries to move money");

  const capture = await toolCaptureOrder(ctx, { orderId: first.orderId! });
  fact("result", capture.message);
  warn("refused at the tool surface, before any request was built");
  note("scopes are enumerated capabilities, not instructions in a prompt");

  // -------------------------------------------------------------------------
  step("✓", "The audit trail");

  blank();
  console.log(`     ${c.bold("outcome".padEnd(19))}${c.bold("tool".padEnd(16))}${c.bold("detail")}`);
  console.log(`     ${c.grey("─".repeat(74))}`);
  for (const a of audit) {
    const colour =
      a.outcome === "ALLOWED" ? c.green : a.outcome === "DEDUPED" ? c.yellow : a.outcome === "FAILED" ? c.red : c.magenta;
    console.log(`     ${colour(a.outcome.padEnd(19))}${a.tool.padEnd(16)}${c.grey(a.detail)}`);
  }
  blank();
  note("every line names the actor and the request id — an agent's actions have to be as reviewable as a human's");

  takeaway("Agents change who starts the payment. They do not change the distributed system underneath it.");

  blank();
  note("PayPal's own agent tooling, for the production version of this:");
  note("  https://developer.paypal.com/ai-tools/mcp-server");
  note("  https://github.com/paypal/agent-toolkit");
  note("this script deliberately does not wrap either one — the point is what you still have to build around them");
});
