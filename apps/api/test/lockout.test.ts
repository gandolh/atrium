import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 89. The library reads AUTH_TRUSTED_PROXIES when the guard registers,
// which is inside buildTestApp, so it is set first. This file is its own
// process, so no other test sees it.
process.env.AUTH_TRUSTED_PROXIES = "172.16.0.0/12";

// In the container the socket peer is Docker's bridge, never the client.
const BRIDGE = "172.18.0.1";
const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery";

describe("the sign-in lockout behind a trusted proxy", () => {
  let t: TestApp;

  before(async () => {
    t = await buildTestApp();
    await t.accounts.createUser({ username: "owner", password: PASSWORD, role: "member" });
  });
  after(async () => {
    await t.close();
  });

  const login = (password: string, remoteAddress: string, forwardedFor?: string) =>
    t.app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress,
      headers: { origin: ORIGIN, ...(forwardedFor && { "x-forwarded-for": forwardedFor }) },
      payload: { username: "owner", password },
    });

  it("two clients behind the bridge keep separate counters", async () => {
    const attacker = "203.0.113.5";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await login("wrong password!", BRIDGE, attacker);
      assert.equal(res.statusCode, 401, `attempt ${attempt}`);
    }
    const locked = await login(PASSWORD, BRIDGE, attacker);
    assert.equal(locked.statusCode, 429);
    assert.ok(Number(locked.headers["retry-after"]) > 0);

    // The owner, through the same proxy, from another address.
    const owner = await login(PASSWORD, BRIDGE, "198.51.100.7");
    assert.equal(owner.statusCode, 200, owner.body);
  });

  it("the proxy's appended entry is the key, so a client cannot prepend its way out", async () => {
    // Caddy appends the peer it saw; the locked-out client's own prefix is ignored.
    const res = await login(PASSWORD, BRIDGE, "198.51.100.7, 203.0.113.5");
    assert.equal(res.statusCode, 429);
  });

  it("a peer outside the trusted range is its own key, whatever it forwards", async () => {
    const direct = "192.0.2.44";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await login("wrong password!", direct, `198.51.100.${attempt}`);
      assert.equal(res.statusCode, 401, `attempt ${attempt}`);
    }
    const res = await login(PASSWORD, direct, "198.51.100.99");
    assert.equal(res.statusCode, 429);
  });
});
