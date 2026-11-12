import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./harness.js";

/**
 * Every route declares its schemas through the zod type provider: the request
 * is validated before the handler runs, and the reply is encoded with the
 * route's response schema, so a field the schema doesn't name never leaves the
 * server and a reply that doesn't match it is a 500 that says nothing.
 */
describe("route schemas", () => {
  let t: TestApp;

  before(async () => {
    t = await buildTestApp();
  });
  after(async () => {
    await t.close();
  });

  const inject = (cookie: string | undefined, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as "GET",
      url,
      headers: cookie ? { cookie } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it("GET /health answers without a session", async () => {
    const res = await inject(undefined, "GET", "/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"status":"ok"}');
  });
});
