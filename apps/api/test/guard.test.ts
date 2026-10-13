import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

// D58: the guard is Ward's vendored library, and atrium's own password sign-in
// is its first way in. A wrong password and a missing session are both 401,
// and the session is a cookie scoped to the API prefix as the browser sees it.
describe("local accounts and the guard", () => {
  let t: TestApp;
  const ORIGIN = "http://localhost:5173";

  before(async () => {
    t = await buildTestApp();
    await t.accounts.createUser({ username: "reader", password: "correct horse battery", role: "member" });
  });
  after(async () => {
    await t.close();
  });

  const login = (password: string, origin = ORIGIN) =>
    t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: { username: "reader", password },
    });

  it("no session is 401, on every guarded route", async () => {
    for (const url of ["/library", "/profiles", "/notes", "/library/x/cover", "/jukebox/players"]) {
      const res = await t.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 401, url);
      assert.equal(res.json().error, "unauthorized");
    }
  });

  it("a wrong password is 401 invalid_credentials and sets no cookie", async () => {
    const res = await login("wrong password!");
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, "invalid_credentials");
    assert.equal(res.headers["set-cookie"], undefined);
  });

  it("signing in sets atrium_session on the API prefix, and it opens the library", async () => {
    const res = await login("correct horse battery");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.username, "reader");
    assert.equal(res.json().session.origin, "local");

    const setCookie = String(res.headers["set-cookie"]);
    assert.match(setCookie, /^atrium_session=[^;]+;/);
    assert.match(setCookie, /Path=\/atrium-api(;|$)/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const cookie = setCookie.split(";")[0]!;
    const library = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(library.statusCode, 200);
    const session = await t.app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    assert.equal(session.json().user.username, "reader");
    assert.deepEqual(session.json().ward, { enabled: false, linked: false });

    const out = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: ORIGIN } });
    assert.equal(out.statusCode, 204);
    const after = await t.app.inject({ method: "GET", url: "/library", headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });

  it("a sign-in from another origin is refused", async () => {
    const res = await login("correct horse battery", "https://evil.example.com");
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "cross_site");
  });

  it("the first request of a new account provisions its Default profile", async () => {
    const cookie = await t.signIn("brand-new");
    const res = await t.app.inject({ method: "GET", url: "/profiles", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().map((p: { name: string }) => p.name),
      ["Default"],
    );
  });

  it("/health needs no session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });
});
