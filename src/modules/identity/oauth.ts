import { DomainError } from "../../contracts/index.ts";
import type { OAuthProvider } from "./types.ts";
export function createGitHubProvider(
  config: { clientId: string; clientSecret: string },
  transport = fetch,
): OAuthProvider {
  async function json(url: string, init: RequestInit) {
    const response = await transport(url, {
      ...init,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok)
      throw new DomainError("UNAVAILABLE", "GitHub 登录暂时不可用，请重试");
    return response.json();
  }
  return {
    name: "github",
    authorizationUrl({ state, challenge, redirectUri }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: "read:user user:email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.href;
    },
    async exchange({ code, verifier, redirectUri }) {
      const token = await json("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
      if (typeof token.access_token !== "string" || token.error)
        throw new DomainError("FORBIDDEN", "GitHub 登录授权失败");
      const headers = {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "skill-library",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const user = await json("https://api.github.com/user", { headers });
      const emails = await json("https://api.github.com/user/emails", {
        headers,
      });
      if (!Number.isSafeInteger(user.id) || !Array.isArray(emails))
        throw new DomainError("FORBIDDEN", "GitHub 身份响应无效");
      const email =
        emails.find((e) => e.verified === true && e.primary === true) ??
        emails.find((e) => e.verified === true);
      return {
        subject: String(user.id),
        displayName: String(user.name || user.login).slice(0, 200),
        verifiedEmail:
          typeof email?.email === "string" ? email.email.toLowerCase() : null,
      };
    },
  };
}
