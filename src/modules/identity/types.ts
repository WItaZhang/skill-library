import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import type { Actor, Role } from "../../contracts/index.ts";
export type { Actor, Role };
export interface IdentityUser {
  id: string;
  displayName: string;
  email: string | null;
}
export interface IdentitySession {
  user: IdentityUser;
  csrfToken: string;
  expiresAt: string;
}
export interface IdentityTeam {
  id: string;
  name: string;
  role: Role;
}
export interface IdentityMember extends IdentityUser {
  role: Role;
  joinedAt: string;
}
export interface IdentityInvitation {
  id: string;
  teamId: string;
  email: string;
  role: Role;
  expiresAt: string;
  token: string;
}
/** Only a server configured OAuth provider may produce this result. Never accept it from HTTP JSON. */
export interface ProviderIdentity {
  subject: string;
  displayName: string;
  verifiedEmail: string | null;
}
export interface OAuthProvider {
  name: string;
  authorizationUrl(input: {
    state: string;
    challenge: string;
    redirectUri: string;
  }): string;
  exchange(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<ProviderIdentity>;
}
export interface IdentityOptions {
  pool: Pool;
  publicOrigin: string;
  mode?: "production" | "test" | "local";
  /** Only the loopback-only personal entry point may configure local access. */
  localAccess?: { userId: string; keyHash: string };
  github?: { clientId: string; clientSecret: string };
  testProvider?: OAuthProvider;
  sessionTtlMs?: number;
  invitationTtlMs?: number;
}
export interface IdentityService {
  authentication?: "github" | "local";
  localLogin?(
    request: IncomingMessage,
    key: string,
  ): Promise<{ cookies: string[] }>;
  login(
    request: IncomingMessage,
  ): Promise<{ location: string; cookies: string[] }>;
  callback(
    request: IncomingMessage,
  ): Promise<{ location: string; cookies: string[] }>;
  session(request: IncomingMessage): Promise<IdentitySession | null>;
  logout(request: IncomingMessage): Promise<{ cookies: string[] }>;
  resolveActor(request: IncomingMessage): Promise<Actor>;
  assertCsrf(request: IncomingMessage): Promise<void>;
  createTeam(
    request: IncomingMessage,
    input: { name: string },
  ): Promise<IdentityTeam>;
  listTeams(request: IncomingMessage): Promise<IdentityTeam[]>;
  invite(
    request: IncomingMessage,
    input: { teamId: string; email: string; role: Role },
  ): Promise<IdentityInvitation>;
  accept(
    request: IncomingMessage,
    input: { token: string },
  ): Promise<IdentityTeam>;
  listMembers(
    request: IncomingMessage,
    input: { teamId: string },
  ): Promise<IdentityMember[]>;
  changeRole(
    request: IncomingMessage,
    input: { teamId: string; userId: string; role: Role },
  ): Promise<void>;
  removeMember(
    request: IncomingMessage,
    input: { teamId: string; userId: string },
  ): Promise<void>;
}
export interface IdentityClient {
  authentication?(): Promise<"github" | "local">;
  localLogin?(key: string): Promise<void>;
  loginUrl: string;
  session(): Promise<IdentitySession | null>;
  logout(): Promise<void>;
  createTeam(input: { name: string }): Promise<IdentityTeam>;
  listTeams(): Promise<IdentityTeam[]>;
  invite(input: {
    teamId: string;
    email: string;
    role: Role;
  }): Promise<IdentityInvitation>;
  accept(input: { token: string }): Promise<IdentityTeam>;
  listMembers(input: { teamId: string }): Promise<IdentityMember[]>;
  changeRole(input: {
    teamId: string;
    userId: string;
    role: Role;
  }): Promise<void>;
  removeMember(input: { teamId: string; userId: string }): Promise<void>;
}
