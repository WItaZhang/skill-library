import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicProvider, ProviderError } from "../provider.ts";
const args = {
  prompt: "do work",
  skills: [],
  signal: new AbortController().signal,
  maxOutputTokens: 128,
};
const message = (value: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: "msg_fixture",
      content: [{ type: "text", text: "fixture response" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 3 },
      ...value,
    }),
    { headers: { "request-id": "req_fixture" } },
  );
test("real adapter wire protocol is tested with explicit fake fetch, no remote execution claim", async () => {
  let calls = 0;
  const provider = createAnthropicProvider({
    apiKey: "fixture-secret",
    model: "fixture-model",
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(init?.redirect, "error");
      assert.equal(
        (init?.headers as Record<string, string>)["Authorization"],
        "Bearer fixture-secret",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 128);
      assert.equal(body.model, "fixture-model");
      assert.equal(body.tools, undefined);
      assert.equal(JSON.stringify(body).includes("fixture-secret"), false);
      return message();
    },
  });
  assert.deepEqual(await provider.execute(args), {
    text: "fixture response",
    providerRequestId: "req_fixture",
    metadata: {
      messageId: "msg_fixture",
      stopReason: "end_turn",
      inputTokens: 12,
      outputTokens: 3,
    },
  });
  assert.equal(calls, 1);
  assert.throws(
    () => createAnthropicProvider({ apiKey: "", model: "x" }),
    /required/,
  );
});
test("provider rejection, rate limit, 5xx and network are bounded and redact raw responses", async () => {
  for (const [status, code, uncertain] of [
    [401, "PROVIDER_AUTH", false],
    [429, "PROVIDER_RATE_LIMIT", false],
    [503, "PROVIDER_UNAVAILABLE", true],
  ] as const) {
    let calls = 0;
    const provider = createAnthropicProvider({
      apiKey: "test",
      model: "test",
      fetch: async () => {
        calls++;
        return new Response("private secret response", {
          status,
          headers: { "request-id": "req_error" },
        });
      },
    });
    await assert.rejects(
      provider.execute(args),
      (e: unknown) =>
        e instanceof ProviderError &&
        e.code === code &&
        e.uncertain === uncertain &&
        e.providerRequestId === "req_error" &&
        !e.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
  const provider = createAnthropicProvider({
    apiKey: "test",
    model: "test",
    fetch: async () => {
      throw new Error("secret key leak");
    },
  });
  await assert.rejects(provider.execute(args), {
    code: "NETWORK_UNCERTAIN",
    uncertain: true,
  });
});
test("invalid, truncated and oversized provider responses never become success", async () => {
  for (const [response, code] of [
    [message({ stop_reason: "max_tokens" }), "OUTPUT_LIMIT"],
    [message({ content: [] }), "RESULT_TOO_LARGE"],
    [new Response("invalid"), "PROVIDER_INVALID_RESPONSE"],
    [new Response("x".repeat(524289)), "RESULT_TOO_LARGE"],
  ] as const) {
    const provider = createAnthropicProvider({
      apiKey: "test",
      model: "test",
      fetch: async () => response,
    });
    await assert.rejects(provider.execute(args), { code });
  }
});
