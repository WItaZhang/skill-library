import { DomainError } from "../../contracts/index.ts";
import type { IdentityClient, IdentitySession } from "./types.ts";
export function createIdentityClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): IdentityClient {
  const transport = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "").replace(/\/$/, "") + "/api/identity/";
  let csrf = "";
  async function call<T>(method: string, input?: unknown): Promise<T> {
    const response = await transport(base + method, {
      method: input === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        input === undefined
          ? {}
          : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: input === undefined ? undefined : JSON.stringify(input),
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok)
      throw new DomainError(
        result.error?.code ?? "UNAVAILABLE",
        result.error?.message ?? "服务暂时不可用",
      );
    return result.data;
  }
  const client: IdentityClient = {
    authentication: () => call("authentication"),
    localLogin: (key) => call("localLogin", { key }),
    loginUrl: base + "login",
    async session() {
      const s = await call<IdentitySession | null>("session");
      csrf = s?.csrfToken ?? "";
      return s;
    },
    async logout() {
      await call("logout", {});
      csrf = "";
    },
    createTeam: (input) => call("createTeam", input),
    listTeams: () => call("listTeams", {}),
    invite: (input) => call("invite", input),
    accept: (input) => call("accept", input),
    listMembers: (input) => call("listMembers", input),
    changeRole: (input) => call("changeRole", input),
    removeMember: (input) => call("removeMember", input),
  };
  return client;
}
