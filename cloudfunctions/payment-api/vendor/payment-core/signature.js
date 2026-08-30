"use strict";

const crypto = require("crypto");
const {
  PROVIDER_SIGN_TYPE,
  SIGNATURE_MAX_SKEW_SECONDS
} = require("./constants");
const { paymentError } = require("./errors");

function scalarText(value) {
  if (value === null || value === undefined) return "";
  // PHP 的 trim(false) 是空串，trim(true) 是 "1"，必须与 SDK 2.0 一致。
  if (value === true) return "1";
  if (value === false) return "";
  if (["string", "number", "bigint"].includes(typeof value)) {
    return String(value);
  }
  return "";
}

function getSignContent(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  return Object.keys(params)
    .sort()
    .filter((key) => key !== "sign" && key !== "sign_type")
    .filter((key) => {
      const value = params[key];
      if (Array.isArray(value) || (value && typeof value === "object")) return false;
      return scalarText(value).trim() !== "";
    })
    .map((key) => `${key}=${scalarText(params[key])}`)
    .join("&");
}

// 星聚 V1 MD5：规则与 RSA 共用排序/过滤，但签名串最后直接追加商户密钥。
function getMd5SignContent(params, md5Key) {
  return `${getSignContent(params)}${String(md5Key || "")}`;
}

function md5SignParams(params, md5Key) {
  const key = String(md5Key || "");
  if (!key) {
    throw paymentError("PAYMENT_MD5_KEY_INVALID", "支付 MD5 签名配置无效。");
  }
  return crypto.createHash("md5")
    .update(Buffer.from(getMd5SignContent(params, key), "utf8"))
    .digest("hex")
    .toLowerCase();
}

function pemBody(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function wrapPem(value, type) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (source.includes("-----BEGIN")) return source.replace(/\r\n/g, "\n");
  const body = pemBody(source).match(/.{1,64}/g);
  if (!body) return "";
  return `-----BEGIN ${type}-----\n${body.join("\n")}\n-----END ${type}-----`;
}

function privateKeyPem(value) {
  const source = String(value || "").trim();
  if (source.includes("BEGIN RSA PRIVATE KEY")) return source.replace(/\r\n/g, "\n");
  return wrapPem(source, "PRIVATE KEY");
}

function publicKeyPem(value) {
  const source = String(value || "").trim();
  if (source.includes("BEGIN RSA PUBLIC KEY")) return source.replace(/\r\n/g, "\n");
  return wrapPem(source, "PUBLIC KEY");
}

function validatePrivateKey(value) {
  try {
    crypto.createPrivateKey(privateKeyPem(value));
    return true;
  } catch (_error) {
    return false;
  }
}

function validatePublicKey(value) {
  try {
    crypto.createPublicKey(publicKeyPem(value));
    return true;
  } catch (_error) {
    return false;
  }
}

function signParams(params, merchantPrivateKey, options = {}) {
  if (String(options.signatureMode || "rsa").toLowerCase() === "md5") {
    return md5SignParams(params, options.md5Key);
  }
  const key = privateKeyPem(merchantPrivateKey);
  if (!key || !validatePrivateKey(key)) {
    throw paymentError("PAYMENT_PRIVATE_KEY_INVALID", "支付签名配置无效。");
  }
  return crypto.sign("RSA-SHA256", Buffer.from(getSignContent(params), "utf8"), {
    key,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }).toString("base64");
}

function verifyParamsSignature(params, platformPublicKey, options = {}) {
  if (platformPublicKey && typeof platformPublicKey === "object") {
    options = Object.assign({}, platformPublicKey, options);
    platformPublicKey = platformPublicKey.platformPublicKey;
  }
  const sign = String(params && params.sign || "").trim();
  const signatureMode = String(options.signatureMode || "rsa").toLowerCase();
  if (signatureMode === "md5") {
    if (!sign || !options.md5Key) return false;
    const expected = md5SignParams(params, options.md5Key);
    const actualBuffer = Buffer.from(sign.toLowerCase(), "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }
  const key = publicKeyPem(platformPublicKey);
  if (!sign || !key || !validatePublicKey(key)) return false;
  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(getSignContent(params), "utf8"),
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(sign, "base64")
    );
  } catch (_error) {
    return false;
  }
}

function verifySignedPayload(params, platformPublicKey, options = {}) {
  const providerConfig = platformPublicKey && typeof platformPublicKey === "object"
    ? platformPublicKey
    : null;
  const verificationKey = providerConfig ? providerConfig.platformPublicKey : platformPublicKey;
  const signatureMode = String(
    options.signatureMode || (providerConfig && providerConfig.signatureMode) || "rsa"
  ).toLowerCase();
  const md5Key = options.md5Key || (providerConfig && providerConfig.md5Key);
  const nowSeconds = Math.floor(Number(options.nowMs || Date.now()) / 1000);
  const maxSkewSeconds = Math.max(
    1,
    Number(options.maxSkewSeconds || SIGNATURE_MAX_SKEW_SECONDS)
  );
  const rawTimestamp = params && params.timestamp;
  const hasTimestamp = rawTimestamp !== undefined
    && rawTimestamp !== null
    && String(rawTimestamp).trim() !== "";
  const timestamp = hasTimestamp ? Number(rawTimestamp) : null;
  // RSA SDK 2.0 请求/响应必须带时间戳；V1 MD5 回调历史上可能不带，
  // 有时间戳时仍严格校验窗口，没带时不凭空拒绝合法回调。
  const missingTimestampAllowed = signatureMode === "md5"
    && options.allowMissingTimestamp === true;
  if (!hasTimestamp && !missingTimestampAllowed) {
    return { ok: false, errorCode: "PAYMENT_TIMESTAMP_INVALID" };
  }
  if (hasTimestamp && !Number.isSafeInteger(timestamp)) {
    return { ok: false, errorCode: "PAYMENT_TIMESTAMP_INVALID" };
  }
  if (hasTimestamp && Math.abs(nowSeconds - timestamp) > maxSkewSeconds) {
    return { ok: false, errorCode: "PAYMENT_TIMESTAMP_EXPIRED" };
  }
  const expectedSignType = signatureMode === "md5" ? "MD5" : PROVIDER_SIGN_TYPE;
  if (String(params && params.sign_type || expectedSignType).toUpperCase() !== expectedSignType) {
    return { ok: false, errorCode: "PAYMENT_SIGN_TYPE_INVALID" };
  }
  if (!verifyParamsSignature(params, verificationKey, { signatureMode, md5Key })) {
    return { ok: false, errorCode: "PAYMENT_SIGNATURE_INVALID" };
  }
  return {
    ok: true,
    timestamp,
    signContent: getSignContent(params)
  };
}

function buildSignedRequest(params, providerConfig, nowMs = Date.now()) {
  const value = Object.assign({}, params, {
    pid: providerConfig.pid,
    timestamp: String(Math.floor(Number(nowMs) / 1000))
  });
  const signatureMode = String(providerConfig.signatureMode || "rsa").toLowerCase();
  value.sign = signParams(value, providerConfig.merchantPrivateKey, {
    signatureMode,
    md5Key: providerConfig.md5Key
  });
  value.sign_type = signatureMode === "md5" ? "MD5" : PROVIDER_SIGN_TYPE;
  return value;
}

module.exports = {
  scalarText,
  getSignContent,
  getMd5SignContent,
  privateKeyPem,
  publicKeyPem,
  validatePrivateKey,
  validatePublicKey,
  signParams,
  md5SignParams,
  verifyParamsSignature,
  verifySignedPayload,
  buildSignedRequest
};
