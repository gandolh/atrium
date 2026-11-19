import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { SESSION_COOKIE } from "../src/plugins/auth/index.js";
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

  /** A signed-in local user who has a password, and the cookie of its session. */
  async function withPassword(id: string, password = "correct horse battery") {
    await t.accounts.createUser({ id, username: id, password, role: "member" });
    const { token } = await t.accounts.startSession(id);
    return { cookie: `${SESSION_COOKIE}=${token}`, password };
  }

  const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
    t.app.inject({ method: "POST", url, headers: { cookie, origin: ORIGIN }, payload: payload ?? {} });

  it("linking and unlinking ask for the current password", async () => {
    const { cookie, password } = await withPassword("local-linker");

    const missing = await post("/auth/ward/link", cookie);
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().error, "invalid_request");

    const wrong = await post("/auth/ward/link", cookie, { currentPassword: "not the password" });
    assert.equal(wrong.statusCode, 401, wrong.body);
    assert.equal(wrong.json().error, "invalid_credentials");

    const right = await post("/auth/ward/link", cookie, { currentPassword: password });
    assert.equal(right.statusCode, 200, right.body);
    assert.ok(String(right.json().url).startsWith(`${ISSUER}/auth?`));

    // Not linked yet, so unlink is a 409 before the body is read.
    const notLinked = await post("/auth/ward/unlink", cookie, { currentPassword: password });
    assert.equal(notLinked.statusCode, 409, notLinked.body);
    assert.equal(notLinked.json().error, "not_linked");
  });

  it("a linked user unlinks with the password, and still signs in with Ward until then", async () => {
    const { cookie, password } = await withPassword("local-unlinker");
    const identities = createWardIdentities({ accounts: t.accounts });
    await identities.link("local-unlinker", "subject-unlinker");
    assert.equal((await identities.findUserBySubject("subject-unlinker"))?.id, "local-unlinker");

    const missing = await post("/auth/ward/unlink", cookie);
    assert.equal(missing.statusCode, 400, missing.body);
    const wrong = await post("/auth/ward/unlink", cookie, { currentPassword: "nope nope nope" });
    assert.equal(wrong.statusCode, 401, wrong.body);
    assert.equal(wrong.json().error, "invalid_credentials");
    assert.equal(await identities.subjectOf("local-unlinker"), "subject-unlinker");

    const right = await post("/auth/ward/unlink", cookie, { currentPassword: password });
    assert.equal(right.statusCode, 200, right.body);
    assert.equal(await identities.subjectOf("local-unlinker"), undefined);
  });

  it("a Ward-only user cannot unlink, whatever is sent", async () => {
    const cookie = await wardSession("subject-ward-only");
    const res = await post("/auth/ward/unlink", cookie, { currentPassword: "anything at all" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, "no_local_password");
  });

  it("renaming works and the account signs in under the new name", async () => {
    const { cookie, password } = await withPassword("rename-me");
    const res = await post("/auth/username", cookie, { username: "Renamed-Reader" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.username, "Renamed-Reader");
    assert.equal((await t.accounts.findUserById("rename-me"))?.username, "Renamed-Reader");
    assert.ok(await t.accounts.verifyCredentials("Renamed-Reader", password));
    assert.equal(await t.accounts.verifyCredentials("rename-me", password), undefined);
  });

  it("a taken name and a look-alike are both username_taken", async () => {
    await t.accounts.createUser({ id: "alice-id", username: "alice", password: "alice password 1", role: "member" });
    const { cookie } = await withPassword("rename-clash");
    for (const name of ["alice", "ALICE", "AIice"]) {
      const res = await post("/auth/username", cookie, { username: name });
      assert.equal(res.statusCode, 409, `${name}: ${res.body}`);
      assert.equal(res.json().error, "username_taken", name);
    }
    assert.equal((await t.accounts.findUserById("rename-clash"))?.username, "rename-clash");
  });
});
