"use strict";

const { PRODUCTS } = require("./products");
const { sha256 } = require("./crypto");
const { validatePrivateKey, validatePublicKey } = require("./signature");
const { paymentError } = require("./errors");

const DEFAULT_RECHARGE_CONFIG = Object.freeze({
  version: 1,
  rechargeEnabled: true,
  channelConfig: Object.freeze({
    wxpay: Object.freeze({ enabled: true }),
    alipay: Object.freeze({ enabled: false })
  }),
  productConfig: Object.freeze({
    enabledProductIds: Object.freeze(PRODUCTS.map((item) => item.productId))
  }),
  gray: Object.freeze({
    strategy: "hash",
    allowOpenidHashes: Object.freeze([]),
    rolloutPercent: 100
  })
});

function uniqueKnownProductIds(value) {
  const known = new Set(PRODUCTS.map((item) => item.productId));
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => known.has(item))));
}

function normalizeRechargeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const channelConfig = source.channelConfig && typeof source.channelConfig === "object"
    ? source.channelConfig
    : {};
  const productConfig = source.productConfig && typeof source.productConfig === "object"
    ? source.productConfig
    : {};
  const gray = source.gray && typeof source.gray === "object" ? source.gray : {};
  const hasProductList = Array.isArray(productConfig.enabledProductIds);
  const enabledProductIds = uniqueKnownProductIds(productConfig.enabledProductIds);
  const allowOpenidHashes = Array.from(new Set((Array.isArray(gray.allowOpenidHashes)
    ? gray.allowOpenidHashes
    : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => /^[a-f0-9]{64}$/.test(item))));
  const requestedStrategy = String(gray.strategy || "");
  const strategySpecified = Object.prototype.hasOwnProperty.call(gray, "strategy");
  const strategyValid = ["whitelist", "hash"].includes(requestedStrategy);
  const strategy = strategyValid ? requestedStrategy : strategySpecified ? "whitelist" : "hash";
  const rechargeEnabledSpecified = Object.prototype.hasOwnProperty.call(source, "rechargeEnabled");
  const wxpaySpecified = Object.prototype.hasOwnProperty.call(channelConfig, "wxpay");
  const rolloutSpecified = Object.prototype.hasOwnProperty.call(gray, "rolloutPercent");
  const requestedRolloutPercent = rolloutSpecified
    ? Number(gray.rolloutPercent) || 0
    : DEFAULT_RECHARGE_CONFIG.gray.rolloutPercent;
  const rolloutPercent = strategyValid || !strategySpecified
    ? Math.max(0, Math.min(100, requestedRolloutPercent))
    : 0;
  return {
    version: Math.max(1, Number(source.version) || DEFAULT_RECHARGE_CONFIG.version),
    rechargeEnabled: rechargeEnabledSpecified
      ? source.rechargeEnabled === true
      : DEFAULT_RECHARGE_CONFIG.rechargeEnabled,
    channelConfig: {
      wxpay: {
        enabled: wxpaySpecified
          ? Boolean(channelConfig.wxpay && channelConfig.wxpay.enabled === true)
          : DEFAULT_RECHARGE_CONFIG.channelConfig.wxpay.enabled
      },
      // 首版禁止支付宝 provider、入口和 launcher，即使误配也强制关闭。
      alipay: { enabled: false }
    },
    productConfig: {
      enabledProductIds: hasProductList
        ? enabledProductIds
        : PRODUCTS.map((item) => item.productId)
    },
    gray: {
      strategy,
      allowOpenidHashes,
      rolloutPercent
    }
  };
}

function hashBucket(openidHash) {
  const normalized = String(openidHash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return 100;
  return Number.parseInt(normalized.slice(0, 8), 16) % 100;
}

function isEligibleOpenidHash(openidHash, configValue) {
  const config = normalizeRechargeConfig(configValue);
  if (!config.rechargeEnabled) return false;
  const normalized = String(openidHash || "").toLowerCase();
  if (config.gray.strategy === "whitelist") {
    return config.gray.allowOpenidHashes.includes(normalized);
  }
  if (config.gray.strategy === "hash") {
    return config.gray.allowOpenidHashes.includes(normalized)
      || hashBucket(normalized) < config.gray.rolloutPercent;
  }
  return false;
}

function isEligibleOpenid(openid, configValue) {
  const value = String(openid || "").trim();
  return value ? isEligibleOpenidHash(sha256(value), configValue) : false;
}

function validHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && Boolean(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function parseList(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function explicitTestEnvironment(env = process.env) {
  // 生产标记优先级高于任何测试开关，避免误把生产函数切到 MD5。
  const productionEnvironment = [
    env.NODE_ENV,
    env.APP_ENV,
    env.PAYMENT_ENV,
    env.XINGJU_ENV
  ].some((value) => ["production", "prod", "live", "release"]
    .includes(String(value || "").trim().toLowerCase()));
  if (productionEnvironment) return false;
  const namedEnvironment = [env.NODE_ENV, env.APP_ENV, env.PAYMENT_ENV, env.XINGJU_ENV]
    .some((value) => String(value || "").trim().toLowerCase() === "test");
  const explicitFlag = [
    env.XINGJU_TEST_MODE,
    env.PAYMENT_TEST_MODE,
    env.XINGJU_SIGNATURE_TEST_MODE,
    env.XINGJU_TEST_ENV
  ]
    .some((value) => String(value || "").trim().toLowerCase() === "true");
  return namedEnvironment || explicitFlag;
}

function md5ModeAllowed(env, pid) {
  if (!explicitTestEnvironment(env)) return false;
  const normalizedPid = String(pid || "").trim().toLowerCase();
  if (!normalizedPid) return false;
  const localUnitTest = String(env.WECHAT_MINIAPP_TEST || "").trim() === "1";
  const declaredTestEnvironmentId = String(env.XINGJU_TEST_ENV_ID || "").trim();
  const currentEnvironmentId = String(
    env.TCB_ENV
      || env.CLOUDBASE_ENV_ID
      || env.TENCENTCLOUD_ENV_ID
      || env.SCF_NAMESPACE
      || ""
  ).trim();
  if (!localUnitTest && (
    !declaredTestEnvironmentId
    || !currentEnvironmentId
    || declaredTestEnvironmentId !== currentEnvironmentId
  )) return false;
  const allowlist = parseList(
    env.XINGJU_MD5_ALLOWLIST
      || env.XINGJU_SIGNATURE_MD5_ALLOWLIST
      || env.XINGJU_TEST_MERCHANT_ALLOWLIST
      || env.XINGJU_MD5_TEST_MERCHANT_ALLOWLIST
  ).map((item) => item.toLowerCase());
  const declaredTestMerchant = String(
    env.XINGJU_TEST_MERCHANT_ID || env.XINGJU_TEST_MERCHANT || ""
  ).trim().toLowerCase();
  if (!declaredTestMerchant || declaredTestMerchant !== normalizedPid) return false;
  // 只接受当前 XINGJU_PID 的单一精确白名单项，不接受通配词或别的商户号。
  return allowlist.length === 1 && allowlist[0] === normalizedPid;
}

function evaluateProviderConfig(env = process.env) {
  const requestedSignatureMode = String(env.XINGJU_SIGNATURE_MODE || "rsa").trim().toLowerCase();
  const md5Mode = requestedSignatureMode === "md5" && md5ModeAllowed(env, env.XINGJU_PID);
  const value = {
    apiBaseUrl: String(env.XINGJU_API_BASE_URL || "").trim().replace(/\/+$/, ""),
    pid: String(env.XINGJU_PID || "").trim(),
    platformPublicKey: String(env.XINGJU_PLATFORM_PUBLIC_KEY || "").trim(),
    merchantPrivateKey: String(env.XINGJU_MERCHANT_PRIVATE_KEY || "").trim(),
    notifyUrl: String(env.XINGJU_NOTIFY_URL || "").trim(),
    returnUrl: String(env.XINGJU_RETURN_URL || "").trim(),
    signatureMode: md5Mode ? "md5" : "rsa",
    md5Key: String(env.XINGJU_MD5_KEY || env.XINGJU_SIGNATURE_MD5_KEY || "").trim()
  };
  const missing = [];
  if (!validHttpsUrl(value.apiBaseUrl)) missing.push("XINGJU_API_BASE_URL");
  if (!value.pid) missing.push("XINGJU_PID");
  if (value.signatureMode === "rsa") {
    if (!validatePublicKey(value.platformPublicKey)) missing.push("XINGJU_PLATFORM_PUBLIC_KEY");
    if (!validatePrivateKey(value.merchantPrivateKey)) missing.push("XINGJU_MERCHANT_PRIVATE_KEY");
  } else if (!value.md5Key) {
    missing.push("XINGJU_MD5_KEY");
  }
  if (!validHttpsUrl(value.notifyUrl)) missing.push("XINGJU_NOTIFY_URL");
  if (value.returnUrl && !validHttpsUrl(value.returnUrl)) missing.push("XINGJU_RETURN_URL");
  return {
    configured: missing.length === 0,
    missing,
    value
  };
}

function requireProviderConfig(env = process.env) {
  const result = evaluateProviderConfig(env);
  if (!result.configured) {
    throw paymentError(
      "PAYMENT_NOT_CONFIGURED",
      "支付通道准备中，请稍后再试。",
      { details: { missing: result.missing } }
    );
  }
  return result.value;
}

function explicitTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function paymentRuntimeSwitches(env = process.env) {
  return {
    orderCreationEnabled: explicitTrue(env.PAYMENT_ORDER_CREATION_ENABLED),
    callbackProcessingEnabled: explicitTrue(env.PAYMENT_CALLBACK_PROCESSING_ENABLED),
    reconciliationEnabled: explicitTrue(env.PAYMENT_RECONCILIATION_ENABLED)
  };
}

module.exports = {
  DEFAULT_RECHARGE_CONFIG,
  normalizeRechargeConfig,
  hashBucket,
  isEligibleOpenidHash,
  isEligibleOpenid,
  evaluateProviderConfig,
  requireProviderConfig,
  validHttpsUrl,
  explicitTestEnvironment,
  md5ModeAllowed,
  explicitTrue,
  paymentRuntimeSwitches
};
