import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubProvider } from "./oauth.ts";

test("GitHub HTTP 适配 fixture：PKCE、固定端点、verified 邮箱和失败关闭（非真实提供方验收）", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const data = String(url).includes("access_token")
      ? { access_token: "test-only" }
      : String(url).endsWith("/emails")
        ? [
            { email: "unverified@example.com", primary: true, verified: false },
            { email: "VERIFIED@example.com", verified: true },
          ]
        : { id: 42, login: "tester", email: "unverified@example.com" };
    return Response.json(data);
  };
  const provider = createGitHubProvider(
    { clientId: "fixture-id", clientSecret: "fixture-secret" },
    transport,
  );
  const url = new URL(
    provider.authorizationUrl({
      state: "state",
      challenge: "challenge",
      redirectUri: "https://app.test/api/identity/callback",
    }),
  );
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.deepEqual(
    await provider.exchange({
      code: "code",
      verifier: "verifier",
      redirectUri: "https://app.test/api/identity/callback",
    }),
    {
      subject: "42",
      displayName: "tester",
      verifiedEmail: "verified@example.com",
    },
  );
  const body = requests[0].init?.body as URLSearchParams;
  assert.equal(body.get("code_verifier"), "verifier");
  assert.equal(
    body.get("redirect_uri"),
    "https://app.test/api/identity/callback",
  );
  assert.ok(requests.every((r) => r.init?.redirect === "error"));
  const failed = createGitHubProvider(
    { clientId: "x", clientSecret: "x" },
    async () => Response.json({ error: "bad_verification_code" }),
  );
  await assert.rejects(
    failed.exchange({
      code: "bad",
      verifier: "v",
      redirectUri: "https://app.test",
    }),
    /授权失败/,
  );
  const unavailable = createGitHubProvider(
    { clientId: "x", clientSecret: "x" },
    async () => new Response("", { status: 503 }),
  );
  await assert.rejects(
    unavailable.exchange({
      code: "bad",
      verifier: "v",
      redirectUri: "https://app.test",
    }),
    /暂时不可用/,
  );
});
