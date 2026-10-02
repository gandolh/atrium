import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WardUnavailableError } from "../src/modules/ward/ward.types.js";
import { buildTestApp, type TestApp } from "./harness.js";

// The guard's three refusals are three different instructions to the web
// client (sign in; ask for a grant; wait), so each must keep its own status.
describe("Ward guard", () => {
  let t: TestApp;
  before(async () => {
    t = await buildTestApp();
  });
  after(async () => {
    await t.close();
  });

  it("no cookie is 401", async () => {
    const res = await t.app.inject({ method: "GET", url: "/library" });
    assert.equal(res.statusCode, 401);
  });

  it("Ward unavailable is 503 IDENTITY_UNAVAILABLE, never signed out", async () => {
    const cookie = t.ward.failWith("down", new WardUnavailableError("introspection request failed"));
    const res = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "IDENTITY_UNAVAILABLE");
  });

  it("a live session with no atrium grant is 403 NO_ATRIUM_GRANT", async () => {
    const cookie = t.ward.signIn("prm-only", "subject-prm", { prm: ["user"] });
    const res = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "NO_ATRIUM_GRANT");
  });

  it("a granted session is let through", async () => {
    const cookie = t.ward.signIn("granted", "subject-a");
    const res = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(res.statusCode, 200);
  });

  it("/health needs no session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });
});
