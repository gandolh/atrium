import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 65: CORS reflected every origin (`origin: true`), a leftover from the
// cross-origin development D54 replaced. Nothing calls the API cross-origin any
// more, so no origin is granted.
describe("CORS grants no origin", () => {
  let t: TestApp;
  let cookie: string;

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("reader", "subject-reader");
  });
  after(async () => {
    await t.close();
  });

  it("a signed-in request from another site carries no Access-Control-Allow-* header", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/library",
      headers: { cookie, origin: "https://evil.example" },
    });
    assert.equal(res.statusCode, 200);
    for (const name of Object.keys(res.headers)) {
      assert.ok(!name.startsWith("access-control-"), `unexpected ${name}: ${res.headers[name]}`);
    }
  });

  it("a preflight from another site is not granted", async () => {
    const res = await t.app.inject({
      method: "OPTIONS",
      url: "/library/x/progress",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-methods"], undefined);
  });
});
