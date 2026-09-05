"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const redeem = require("../redeem");

test("strict redeem code accepts only the approved new format", () => {
  assert.equal(redeem.strictRedeemCode("ab12cd34"), true);
  assert.equal(redeem.strictRedeemCode("AB12CD34"), false);
  assert.equal(redeem.strictRedeemCode("abcdefgh"), false);
  assert.equal(redeem.strictRedeemCode("12345678"), false);
  assert.equal(redeem.strictRedeemCode("ab12 cd34"), false);
  assert.equal(redeem.strictRedeemCode("abc12345"), true);
});

test("envelope and request signature are deterministic at the contract boundary", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    LICENSE_REDEEM_HUB_PUBLIC_KEY: pair.publicKey.export({ type: "spki", format: "pem" }),
    LICENSE_REDEEM_ACTIVE_LOCK_KEY: Buffer.alloc(32, 7).toString("base64"),
    LICENSE_REDEEM_HMAC_SECRET: Buffer.alloc(32, 8).toString("base64")
  };
  const requestId = "11111111-1111-4111-8111-111111111111";
  const envelope = redeem.encryptCodeEnvelope("ab12cd34", requestId, env);
  assert.equal(envelope.keyId, "v1");
  assert.equal(envelope.aad, "redeem:v1:" + requestId + ":v1");
  assert.match(envelope.wrappedKey, /^[A-Za-z0-9_-]+$/);
  assert.match(redeem.stableLockId("openid", "ab12cd34", env), /^[0-9a-f]{64}$/);
  const signed = redeem.signHubRequest("POST", "/internal/api/v1/store/vouchers/redeem", { requestId }, env, 1700000000, "0123456789abcdef0123456789abcdef");
  assert.equal(signed.headers["X-License-Timestamp"], "1700000000");
  assert.match(signed.headers["X-License-Signature"], /^[0-9a-f]{64}$/);
});
