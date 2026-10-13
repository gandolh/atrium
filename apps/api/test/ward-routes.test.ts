import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { SESSION_COOKIE } from "../src/modules/auth/auth.guard.js";
import { createWardClient, createWardIdentities } from "../vendor/ward/ward-auth.js";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * "Sign in with Ward" is wired (D58), against a Ward that is a fake `fetch`.
 * The library's own suite drives the whole flow against a real Ward; what
 * matters here is that atrium registered it with the right paths, and that a
 * Ward-originated session is checked while a local one never is.
 */

const ISSUER = "http://localhost:8792/ward-api/oidc";
const ORIGIN = "http://localhost:5173";

/** The env value Ward's key script writes: base64url of a private Ed25519 JWK. */
function clientKey(): string {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return Buffer.from(
    JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d, kid: "k1", use: "sig" }),
  ).toString("base64url");
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Ward as far as these tests reach it: discovery and the 30-second check. */
const ward = {
  up: true,
  /** What `/session-status` says about every session. */
  active: true,
  /** Every attempt to reach `/session-status`, answered or not. */
  sessionChecks: 0,
};

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/session-status")) ward.sessionChecks += 1;
  if (!ward.up) throw new TypeError("fetch failed");
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return json(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      end_session_endpoint: `${ISSUER}/session/end`,
      id_token_signing_alg_values_supported: ["EdDSA"],
    });
  }
  if (url === "http://localhost:8792/ward-api/session-status") {
    return json(200, ward.active ? { active: true, role: "admin" } : { active: false });
  }
  return json(404, { error: "not_found" });
}) as typeof fetch;

describe("Sign in with Ward", () => {
  let t: TestApp;
  let now = 1_000_000;

  before(async () => {
    const wardClient = await createWardClient({
      issuer: ISSUER,
      clientId: "atrium",
      clientKey: clientKey(),
      redirectUri: `${ORIGIN}/atrium-api/auth/ward/callback`,
      fetch: fakeFetch,
      // The 30-second cache, moved by hand below.
      now: () => now,
    });
    t = await buildTestApp({ wardClient });
  });
  after(async () => {
    await t.close();
  });

  /** A user linked to a Ward subject, and a session that began with Ward. */
  async function wardSession(subject: string): Promise<string> {
    const identities = createWardIdentities({ accounts: t.accounts });
    await identities.createLinkedUser({ subject, id: subject, username: subject, role: "member" });
    const { token } = await t.accounts.startSession(subject, { origin: "ward", wardSid: `family-${subject}` });
    return `${SESSION_COOKIE}=${token}`;
  }

  it("the session says Ward is on, so the login page shows the button", async () => {
    const res = await t.app.inject({ method: "GET", url: "/auth/session" });
    assert.equal(res.json().user, null);
    assert.equal(res.json().ward.enabled, true);
  });

  it("starting a sign-in answers a URL on Ward, and a flow cookie for the callback only", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/ward/start",
      headers: { origin: ORIGIN },
      payload: { returnTo: "/atrium/notes" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const url = new URL(res.json().url);
    assert.equal(`${url.origin}${url.pathname}`, `${ISSUER}/auth`);
    assert.equal(url.searchParams.get("client_id"), "atrium");
    assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/atrium-api/auth/ward/callback`);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(String(res.headers["set-cookie"]), /^atrium_session_ward=.*Path=\/atrium-api\/auth\/ward\/callback/);
  });

  it("a callback with no flow goes back to atrium's login page with the error", async () => {
    const res = await t.app.inject({ method: "GET", url: "/auth/ward/callback?code=x&state=y" });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `${ORIGIN}/atrium/login?ward_error=invalid_callback`);
  });

  it("a Ward session is checked; once Ward says it ended, it is 401 ward_session_ended", async () => {
    const cookie = await wardSession("subject-revoked");
    const live = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(live.statusCode, 200);

    ward.active = false;
    now += 31_000;
    const ended = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(ended.statusCode, 401);
    assert.equal(ended.json().reason, "ward_session_ended");
    ward.active = true;
  });

  it("with Ward down a Ward session is refused as ward_unavailable, and a local one keeps working", async () => {
    const wardCookie = await wardSession("subject-outage");
    const local = await t.signIn("local-reader");
    const checksBefore = ward.sessionChecks;

    ward.up = false;
    now += 31_000;
    try {
      const refused = await t.app.inject({ method: "GET", url: "/library", headers: { cookie: wardCookie } });
      assert.equal(refused.statusCode, 401);
      assert.equal(refused.json().reason, "ward_unavailable");

      const fine = await t.app.inject({ method: "GET", url: "/library", headers: { cookie: local } });
      assert.equal(fine.statusCode, 200);
    } finally {
      ward.up = true;
    }
    // One check, the Ward session's: a local session never asks Ward.
    assert.equal(ward.sessionChecks, checksBefore + 1);
  });

  it("linking and unlinking from settings need a session", async () => {
    for (const url of ["/auth/ward/link", "/auth/ward/unlink", "/auth/ward/set-password"]) {
      const res = await t.app.inject({ method: "POST", url, headers: { origin: ORIGIN }, payload: {} });
      assert.equal(res.statusCode, 401, url);
    }
  });

  it("linking answers a URL on Ward for a signed-in local user", async () => {
    const cookie = await t.signIn("local-linker");
    const res = await t.app.inject({ method: "POST", url: "/auth/ward/link", headers: { cookie, origin: ORIGIN } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(String(res.json().url).startsWith(`${ISSUER}/auth?`));
  });
});
