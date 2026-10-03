import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, base64url } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { initDatabase } from "../src/database/bootstrap.js";
import { closeDatabase } from "../src/database/knex.js";
import { createWardClient } from "../src/modules/ward/ward.client.js";
import { WardAuthenticationError, WardUnavailableError } from "../src/modules/ward/ward.types.js";
import { BASE, ORIGIN, json, makeKeys, signToken, wardFetch, type Keys } from "./real-ward.js";

// Brief 61: atrium's real Ward client, with real keys. Every other API test
// swaps the client for `fake-ward.ts`, which is why a key-fetch failure could
// turn a Ward outage into "signed out" without any test noticing.

const ACTIVE = { active: true, subject: "subject-1", username: "ana", grants: { atrium: ["user"] } };

const client = (fetchImpl: typeof fetch, extra = {}) =>
  createWardClient({ publicOrigin: ORIGIN, apiBasePath: BASE, appKey: "k", fetch: fetchImpl, ...extra });

const unreachable = () => {
  throw new TypeError("fetch failed");
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

describe("Ward client: a key set Ward cannot serve is Ward unavailable", () => {
  let keys: Keys;
  let token: string;

  before(async () => {
    keys = await makeKeys("ward-key-1");
    token = await signToken(keys);
  });

  const cases: [string, Parameters<typeof wardFetch>[0]["jwks"], object?][] = [
    ["the fetch throws", unreachable],
    ["it answers 500", () => new Response("boom", { status: 500 })],
    ["it answers HTML", () => new Response("<html>", { status: 200 })],
    ["it is not a key set", () => json({ nope: true })],
    [
      "it never answers",
      (_url, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
      { jwksTimeoutMs: 20 },
    ],
  ];

  for (const [name, jwks, extra] of cases) {
    it(`when ${name}`, async () => {
      const ward = client(wardFetch({ jwks, introspect: () => json(ACTIVE) }), extra);
      const error = await failure(ward.authenticate(`ward_session=${token}`));
      assert.ok(error instanceof WardUnavailableError, String(error));
    });
  }
});

describe("Ward client: a bad token is still an authentication error", () => {
  let keys: Keys;
  let ward: ReturnType<typeof client>;

  before(async () => {
    keys = await makeKeys("ward-key-1");
    ward = client(wardFetch({ jwks: () => json({ keys: [keys.jwk] }), introspect: () => json(ACTIVE) }));
  });

  const rejectsAsAuth = async (token: string) => {
    const error = await failure(ward.authenticate(`ward_session=${token}`));
    assert.ok(error instanceof WardAuthenticationError, String(error));
    assert.ok(!(error instanceof WardUnavailableError), "must not be a 503");
  };

  it("a live, valid token resolves the caller", async () => {
    const caller = await ward.authenticate(`ward_session=${await signToken(keys)}`);
    assert.equal(caller.subject, "subject-1");
    assert.equal(caller.sid, "device-1");
  });

  it("a forged signature under Ward's own kid", async () => {
    const forger = await makeKeys("ward-key-1");
    await rejectsAsAuth(await signToken(forger));
  });

  it("an unknown kid, after jose's refetch", async () => {
    const stranger = await makeKeys("not-wards");
    await rejectsAsAuth(await signToken(stranger));
  });

  it("an expired token", async () => {
    await rejectsAsAuth(await signToken(keys, { expiresAt: Math.floor(Date.now() / 1000) - 60 }));
  });

  it("HS256 keyed with the public key's own bytes", async () => {
    const forged = await new SignJWT({ sid: "device-1" })
      .setProtectedHeader({ alg: "HS256", kid: keys.jwk.kid!, typ: "JWT" })
      .setSubject("subject-1")
      .setJti("jti-1")
      .setIssuer(ORIGIN)
      .setAudience("ward-estate")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(base64url.decode(keys.jwk.x!));
    await rejectsAsAuth(forged);
  });
});

describe("the guard with the real client", () => {
  let keys: Keys;
  let jwksUp = true;
  let app: FastifyInstance;

  before(async () => {
    keys = await makeKeys("ward-key-1");
    await initDatabase();
    app = await buildApp({
      wardClient: client(
        wardFetch({
          jwks: () => (jwksUp ? json({ keys: [keys.jwk] }) : unreachable()),
          introspect: () => json(ACTIVE),
        }),
      ),
    });
    app.log.level = "silent";
    await app.ready();
  });
  after(async () => {
    await app.close();
    await closeDatabase();
  });

  const get = async (token: string) =>
    app.inject({ method: "GET", url: "/profiles", headers: { cookie: `ward_session=${token}` } });

  it("Ward's key set unreachable with a cold cache: 503 IDENTITY_UNAVAILABLE, not 401", async () => {
    jwksUp = false;
    const res = await get(await signToken(keys));
    assert.equal(res.statusCode, 503, res.body);
    assert.deepEqual(res.json(), { error: "IDENTITY_UNAVAILABLE" });
  });

  it("once Ward is back, a live granted session gets through", async () => {
    jwksUp = true;
    const res = await get(await signToken(keys));
    assert.equal(res.statusCode, 200, res.body);
  });

  it("a forged token is 401", async () => {
    const res = await get(await signToken(await makeKeys("ward-key-1")));
    assert.equal(res.statusCode, 401, res.body);
  });
});
