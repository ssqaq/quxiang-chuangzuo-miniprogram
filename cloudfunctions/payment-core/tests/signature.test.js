"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const payment = require("..");
const fixtures = require("./fixtures");

const merchantPublicKey = crypto.createPublicKey(
  payment.privateKeyPem(fixtures.MERCHANT_PRIVATE_KEY)
).export({ type: "spki", format: "pem" });

test("SDK 2.0 签名串规则与固定非生产向量一致", () => {
  assert.equal(payment.getSignContent(Object.assign({
    sign: "ignored",
    sign_type: "RSA",
    empty: "  ",
    list: ["ignored"],
    phpTrue: true,
    phpFalse: false
  }, fixtures.SIGN_PARAMS)), fixtures.SIGN_CONTENT.replace("&pid=", "&phpTrue=1&pid="));
  assert.equal(payment.scalarText(true), "1");
  assert.equal(payment.scalarText(false), "");
});

test("RSA-SHA256 签名结果与固定 SDK 向量一致", () => {
  const sign = payment.signParams(fixtures.SIGN_PARAMS, fixtures.MERCHANT_PRIVATE_KEY);
  assert.equal(sign, fixtures.EXPECTED_SIGNATURE);
  assert.equal(payment.verifyParamsSignature(
    Object.assign({}, fixtures.SIGN_PARAMS, { sign }),
    merchantPublicKey
  ), true);
});

test("验签严格检查 300 秒窗口和内容篡改", () => {
  const payload = Object.assign({}, fixtures.SIGN_PARAMS, {
    sign: fixtures.EXPECTED_SIGNATURE,
    sign_type: "RSA"
  });
  assert.equal(payment.verifySignedPayload(payload, merchantPublicKey, {
    nowMs: 1700000000 * 1000
  }).ok, true);
  assert.equal(payment.verifySignedPayload(payload, merchantPublicKey, {
    nowMs: (1700000000 + 301) * 1000
  }).errorCode, "PAYMENT_TIMESTAMP_EXPIRED");
  assert.equal(payment.verifySignedPayload(
    Object.assign({}, payload, { money: "19.90" }),
    merchantPublicKey,
    { nowMs: 1700000000 * 1000 }
  ).errorCode, "PAYMENT_SIGNATURE_INVALID");
});

test("V1 MD5 小写签名使用 ASCII key 排序并直接追加 key", () => {
  const params = {
    b: "2", a: "1", n: 0, t: true, f: false,
    empty: "  ", sign: "ignored", sign_type: "MD5"
  };
  assert.equal(payment.getMd5SignContent(params, fixtures.MD5_KEY),
    `a=1&b=2&n=0&t=1${fixtures.MD5_KEY}`);
  assert.equal(payment.md5SignParams(params, fixtures.MD5_KEY),
    "daa2e47032deed7d982f4ad4b8b2d9c6");
  const signed = Object.assign({}, params, {
    sign: payment.md5SignParams(params, fixtures.MD5_KEY)
  });
  assert.equal(payment.verifyParamsSignature(signed, "", {
    signatureMode: "md5", md5Key: fixtures.MD5_KEY
  }), true);
  assert.equal(payment.verifyParamsSignature(
    Object.assign({}, signed, { sign: signed.sign.toUpperCase().replace(/^D/, "e") }),
    "",
    { signatureMode: "md5", md5Key: fixtures.MD5_KEY }
  ), false);
});

test("MD5 模式必须显式测试环境且命中白名单", () => {
  const base = {
    XINGJU_API_BASE_URL: fixtures.providerConfig().apiBaseUrl,
    XINGJU_PID: fixtures.providerConfig().pid,
    XINGJU_NOTIFY_URL: fixtures.providerConfig().notifyUrl,
    XINGJU_SIGNATURE_MODE: "md5",
    XINGJU_MD5_KEY: fixtures.MD5_KEY,
    XINGJU_TEST_MERCHANT_ID: "1000",
    WECHAT_MINIAPP_TEST: "1"
  };
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    NODE_ENV: "production", XINGJU_MD5_ALLOWLIST: "1000"
  })).value.signatureMode, "rsa");
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    NODE_ENV: "test", XINGJU_MD5_ALLOWLIST: "1000"
  })).value.signatureMode, "md5");
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    NODE_ENV: "test", XINGJU_MD5_ALLOWLIST: "other"
  })).value.signatureMode, "rsa");
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    NODE_ENV: "production",
    XINGJU_TEST_MODE: "true",
    XINGJU_MD5_ALLOWLIST: "1000"
  })).value.signatureMode, "rsa");
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    NODE_ENV: "test",
    XINGJU_TEST_MERCHANT_ID: "other",
    XINGJU_MD5_ALLOWLIST: "1000"
  })).value.signatureMode, "rsa");
});

test("V1 MD5 回调没有 timestamp 也能验签，有 timestamp 仍检查窗口", () => {
  const params = {
    pid: "1000",
    trade_no: "T100",
    out_trade_no: "PAY00000000000000000000000000001",
    type: "wxpay",
    name: "AIPS 100 积分",
    money: "9.90",
    trade_status: "TRADE_SUCCESS",
    param: "user-opaque",
    sign_type: "MD5"
  };
  const signed = Object.assign({}, params, {
    sign: payment.md5SignParams(params, fixtures.MD5_KEY)
  });
  assert.equal(payment.verifySignedPayload(signed, payment.PLATFORM_PUBLIC_KEY || "", {
    signatureMode: "md5",
    md5Key: fixtures.MD5_KEY,
    allowMissingTimestamp: true,
    nowMs: 1700000000 * 1000
  }).ok, true);
  assert.equal(payment.verifySignedPayload(signed, "", {
    signatureMode: "md5",
    md5Key: fixtures.MD5_KEY,
    nowMs: 1700000000 * 1000
  }).errorCode, "PAYMENT_TIMESTAMP_INVALID");
  const withTimestamp = Object.assign({}, signed, { timestamp: "1700000000" });
  // timestamp 是签名字段，补上后必须重新签名。
  withTimestamp.sign = payment.md5SignParams(withTimestamp, fixtures.MD5_KEY);
  assert.equal(payment.verifySignedPayload(withTimestamp, "", {
    signatureMode: "md5",
    md5Key: fixtures.MD5_KEY,
    nowMs: (1700000000 + 301) * 1000
  }).errorCode, "PAYMENT_TIMESTAMP_EXPIRED");
});
