import type { WardClient } from "../src/modules/ward/ward.client.js";
import {
  WardAuthenticationError,
  type AccessTokenClaims,
  type SessionResolution,
  type WardCaller,
} from "../src/modules/ward/ward.types.js";

/**
 * A `WardClient` that answers from a script instead of Ward. Each test cookie
 * value (`ward_session=<token>`) maps to the caller it authenticates as, or to
 * the error the real client would throw. The real guard still decides what that
 * means, so the 401/403/503 mapping under test is the production one.
 */
export class FakeWard implements WardClient {
  private readonly sessions = new Map<string, WardCaller | Error>();

  /** `cookie` header value that authenticates as `subject`. */
  signIn(
    token: string,
    subject: string,
    grants: Record<string, string[]> = { atrium: ["user"] },
    sid = `sid-${token}`,
  ): string {
    this.sessions.set(token, { active: true, subject, username: subject, grants, sid });
    return `ward_session=${token}`;
  }

  /** `cookie` header value whose authentication throws `error`. */
  failWith(token: string, error: Error): string {
    this.sessions.set(token, error);
    return `ward_session=${token}`;
  }

  readAccessCookie(header: string | string[] | undefined): string | undefined {
    const flat = Array.isArray(header) ? header.join("; ") : (header ?? "");
    for (const pair of flat.split(";")) {
      const [name, ...value] = pair.trim().split("=");
      if (name === "ward_session" && value.join("=")) return value.join("=");
    }
    return undefined;
  }

  async authenticate(cookieHeader: string | string[] | undefined): Promise<WardCaller> {
    const token = this.readAccessCookie(cookieHeader);
    if (token === undefined) throw new WardAuthenticationError("no access token presented");
    const entry = this.sessions.get(token);
    if (entry === undefined) throw new WardAuthenticationError("unknown test token");
    if (entry instanceof Error) throw entry;
    return entry;
  }

  async verify(): Promise<AccessTokenClaims> {
    throw new Error("FakeWard.verify is not used by the guard");
  }

  async introspect(): Promise<SessionResolution> {
    throw new Error("FakeWard.introspect is not used by the guard");
  }
}
