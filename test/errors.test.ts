/**
 * Error classification: the branch that decides whether a human hears about a
 * failure, and which human.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PayPalApiError, PayPalTransportError, classify } from "../src/paypal/errors.js";

describe("classification", () => {
  test("a declined instrument is the customer's to hear about, even though it arrives as a 422", () => {
    // The trap: 422 is a 4xx, and 4xx normally means "you sent something
    // wrong". Here there is nothing to fix — the issue code is what tells you.
    const err = new PayPalApiError(422, {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      debug_id: "abc123",
      details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was either declined..." }],
    });

    assert.equal(err.handling, "SHOW_CUSTOMER");
    assert.match(err.customerMessage(), /declined/i);
  });

  test("an invalid request is the developer's to fix", () => {
    const err = new PayPalApiError(400, {
      name: "INVALID_REQUEST",
      message: "Request is not well-formed, syntactically incorrect, or violates schema.",
      details: [{ issue: "INVALID_PARAMETER_SYNTAX", field: "/purchase_units/0/amount/currency_code" }],
    });

    assert.equal(err.handling, "FIX_REQUEST");
  });

  test("a 5xx is retryable", () => {
    const err = new PayPalApiError(500, { name: "INTERNAL_SERVER_ERROR", message: "An internal server error occurred." });
    assert.equal(err.handling, "RETRY");
  });

  test("a 429 is retryable, not a client bug", () => {
    assert.equal(classify(429, "RATE_LIMIT_REACHED", []), "RETRY");
  });

  test("a request that got no response at all is retryable — that is the timeout case", () => {
    const err = new PayPalTransportError(new Error("socket hang up"), "capture-ORDER-1");

    assert.equal(err.handling, "RETRY");
    assert.match(err.operatorMessage(), /outcome UNKNOWN/);
    assert.match(err.operatorMessage(), /capture-ORDER-1/);
  });

  test("a 401 is a developer problem, not something to retry forever", () => {
    assert.equal(classify(401, "AUTHENTICATION_FAILURE", []), "FIX_REQUEST");
  });

  test("an unknown 4xx defaults to fix-your-request", () => {
    assert.equal(classify(418, "TEAPOT", []), "FIX_REQUEST");
  });
});

describe("what each audience is told", () => {
  test("the customer never sees a debug id or a field path", () => {
    const err = new PayPalApiError(422, {
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "d34db33f",
      details: [{ issue: "INSTRUMENT_DECLINED", field: "/payment_source/paypal" }],
    });

    const message = err.customerMessage();
    assert.ok(!message.includes("d34db33f"), "debug ids are for operators, not buyers");
    assert.ok(!message.includes("/payment_source"), "internal field paths must not leak to the buyer");
  });

  test("the operator gets the debug id, which is what PayPal support asks for", () => {
    const err = new PayPalApiError(
      500,
      { name: "INTERNAL_SERVER_ERROR", debug_id: "d34db33f" },
      "capture-ORDER-9",
    );

    const line = err.operatorMessage();
    assert.match(line, /debug_id=d34db33f/);
    assert.match(line, /PayPal-Request-Id=capture-ORDER-9/);
    assert.match(line, /status=500/);
  });

  test("a non-decline failure does not tell the customer to change payment method", () => {
    const err = new PayPalApiError(500, { name: "INTERNAL_SERVER_ERROR" });
    assert.ok(!/different payment method/i.test(err.customerMessage()));
  });
});
