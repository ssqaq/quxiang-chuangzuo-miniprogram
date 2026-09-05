"use strict";

const crypto = require("crypto");
const https = require("https");
const storage = require("./storage");

const REDEEM_COLLECTIONS = Object.freeze({
  requests: "redeem_requests",
  active: "redeem_active",
  attempts: "redeem_attempts",
  accounts: "user_accounts",
  ledger: "point_ledger"
});
const REDEEM_CODE_PATTERN = /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{8}$/;

function strictRedeemCode(value) {
  return typeof value === "string" && REDEEM_CODE_PATTERN.test(value);
}

function uuidv4(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function requiredKey(env, name) {
  const value = String(env && env[name] || "");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length >= 32) return decoded;
  const raw = Buffer.from(value, "utf8");
  if (raw.length < 32) throw new Error(name + " must contain 32 bytes or base64");
  return raw;
}

function stableLockId(openid, code, env = process.env) {
  return crypto.createHmac("sha256", requiredKey(env, "LICENSE_REDEEM_ACTIVE_LOCK_KEY"))
    .update("aips:redeem-active:v1:" + openid + ":" + code, "utf8").digest("hex");
}

function encryptCodeEnvelope(code, requestId, env = process.env) {
  const publicKey = String(env.LICENSE_REDEEM_HUB_PUBLIC_KEY || "").replace(/\\n/g, "\n");
  const keyId = String(env.LICENSE_REDEEM_HUB_KEY_ID || "v1");
  if (!publicKey) throw new Error("LICENSE_REDEEM_HUB_PUBLIC_KEY is required");
  const cek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from("redeem:v1:" + requestId + ":" + keyId, "ascii");
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(code, "ascii")), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, cek);
  return { keyId, wrappedKey: wrappedKey.toString("base64url"), nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), aad: aad.toString("ascii") };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalJson(value[key]);
    return result;
  }, {});
  return value;
}

function signHubRequest(method, path, body, env = process.env, timestamp = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(16).toString("hex")) {
  const rawBody = body === undefined ? "" : JSON.stringify(canonicalJson(body));
  const message = ["license-hub-redeem-v1", method.toUpperCase(), path, String(timestamp), nonce, crypto.createHash("sha256").update(rawBody).digest("hex")].join("\n");
  return {
    rawBody,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      "X-License-Client": String(env.LICENSE_REDEEM_CLIENT_ID || "cloudbase-miniapp"),
      "X-License-Timestamp": String(timestamp),
      "X-License-Nonce": nonce,
      "X-License-Signature": crypto.createHmac("sha256", requiredKey(env, "LICENSE_REDEEM_HMAC_SECRET")).update(message).digest("hex")
    }
  };
}

function requestHub(method, path, body, env = process.env) {
  const base = String(env.LICENSE_REDEEM_HUB_URL || "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return Promise.reject(new Error("LICENSE_REDEEM_HUB_URL must be https"));
  const signed = signHubRequest(method, path, body, env);
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const request = https.request({ method, hostname: url.hostname, port: url.port || 443, path: url.pathname, headers: signed.headers, timeout: 6000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (_error) { parsed = { ok: false, errorCode: "hub_invalid_json" }; }
        resolve({ httpStatus: response.statusCode || 0, body: parsed });
      });
    });
    request.on("timeout", () => request.destroy(new Error("hub_timeout")));
    request.on("error", reject);
    if (method !== "GET") request.write(signed.rawBody);
    request.end();
  });
}

function readDocument(ref) {
  return ref.get().then((result) => result && result.data ? result.data : null).catch((error) => {
    if (/NOT_EXIST|NOT_FOUND|not exist|not found/i.test(String(error && (error.code || error.message)))) return null;
    throw error;
  });
}

function viewRequest(value) {
  const source = value || {};
  return { requestId: String(source.requestId || ""), clientAttemptId: String(source.clientAttemptId || ""), status: String(source.requestStatus || "processing"), hubStatus: String(source.hubStatus || "pending"), creditStatus: String(source.creditStatus || "pending"), redemptionId: String(source.redemptionId || ""), skuCode: String(source.skuCode || ""), points: Number(source.points) || 0, balance: Number.isFinite(Number(source.balance)) ? Number(source.balance) : null, message: String(source.publicMessage || "") };
}

async function createRequest(db, openid, code, requestId, codeEnvelope, clientAttemptId, env = process.env) {
  const lockId = stableLockId(openid, code, env);
  return db.runTransaction(async (transaction) => {
    const requestRef = transaction.collection(REDEEM_COLLECTIONS.requests).doc(requestId);
    const activeRef = transaction.collection(REDEEM_COLLECTIONS.active).doc(lockId);
    const existing = await readDocument(requestRef);
    if (existing) {
      if (existing.openid !== openid || existing.lockId !== lockId) throw new Error("REDEEM_REQUEST_CONFLICT");
      return existing;
    }
    const active = await readDocument(activeRef);
    if (active && active.requestId) {
      const activeRequest = await readDocument(transaction.collection(REDEEM_COLLECTIONS.requests).doc(active.requestId));
      if (activeRequest) return activeRequest;
    }
    const now = new Date();
    const value = { _id: requestId, requestId, openid, lockId, clientAttemptId, codeEnvelope, requestStatus: "processing", hubStatus: "pending", creditStatus: "pending", redemptionId: "", skuCode: "", points: 0, statusVersion: 1, hubAttemptCount: 0, hubLeaseOwner: "", hubLeaseToken: "", hubLeaseEpoch: 0, hubLeaseUntil: null, retryCount: 0, createdAt: now, updatedAt: now };
    await requestRef.set({ data: storage.stripDocumentId(value) });
    await activeRef.set({ data: { requestId, status: "processing", createdAt: now, expiresAt: new Date(now.getTime() + 86400000) } });
    return value;
  });
}

async function prepareRequest(db, openid, code, clientAttemptId, env = process.env) {
  if (!uuidv4(clientAttemptId)) throw new Error("REDEEM_ATTEMPT_ID_INVALID");
  const attemptId = stableLockId(openid, "attempt:" + clientAttemptId, env);
  return db.runTransaction(async (transaction) => {
    const attemptRef = transaction.collection(REDEEM_COLLECTIONS.attempts).doc(attemptId);
    const existingAttempt = await readDocument(attemptRef);
    if (existingAttempt) {
      if (existingAttempt.openid !== openid) throw new Error("REDEEM_ATTEMPT_CONFLICT");
      const request = await readDocument(transaction.collection(REDEEM_COLLECTIONS.requests).doc(existingAttempt.requestId));
      if (request) return request;
    }
    const lockId = stableLockId(openid, code, env);
    const active = await readDocument(transaction.collection(REDEEM_COLLECTIONS.active).doc(lockId));
    if (active && active.requestId) {
      const request = await readDocument(transaction.collection(REDEEM_COLLECTIONS.requests).doc(active.requestId));
      if (request) {
        await attemptRef.set({ data: { openid, requestId: request.requestId, createdAt: new Date() } });
        return request;
      }
    }
    const requestId = crypto.randomUUID();
    const now = new Date();
  const request = { _id: requestId, requestId, openid, lockId, clientAttemptId, codeEnvelope: encryptCodeEnvelope(code, requestId, env), requestStatus: "processing", hubStatus: "pending", creditStatus: "pending", redemptionId: "", skuCode: "", points: 0, statusVersion: 1, hubAttemptCount: 0, hubLeaseOwner: "", hubLeaseToken: "", hubLeaseEpoch: 0, hubLeaseUntil: null, retryCount: 0, createdAt: now, updatedAt: now };
    await transaction.collection(REDEEM_COLLECTIONS.requests).doc(requestId).set({ data: storage.stripDocumentId(request) });
    await transaction.collection(REDEEM_COLLECTIONS.active).doc(lockId).set({ data: { requestId, status: "processing", createdAt: now, expiresAt: new Date(now.getTime() + 86400000) } });
    await attemptRef.set({ data: { openid, requestId, createdAt: new Date() } });
    return request;
  });
}

async function claimHubRequest(db, requestId, openid) {
  const owner = "redeem-" + crypto.randomBytes(8).toString("hex");
  const token = crypto.randomBytes(18).toString("hex");
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(REDEEM_COLLECTIONS.requests).doc(requestId);
    const current = await readDocument(ref);
    if (!current || current.openid !== openid) throw new Error("REDEEM_REQUEST_NOT_FOUND");
    if (current.creditStatus === "credited" || ["failed", "manual_review"].includes(current.requestStatus)) return current;
    if (current.hubLeaseUntil && new Date(current.hubLeaseUntil).getTime() > Date.now() && current.hubLeaseOwner) return null;
    const next = Object.assign({}, current, {
      hubLeaseOwner: owner,
      hubLeaseToken: token,
      hubLeaseEpoch: (Number(current.hubLeaseEpoch) || 0) + 1,
      hubLeaseUntil: new Date(Date.now() + 30000),
      hubAttemptCount: (Number(current.hubAttemptCount) || 0) + 1,
      statusVersion: (Number(current.statusVersion) || 0) + 1,
      updatedAt: new Date()
    });
    await ref.set({ data: storage.stripDocumentId(next) });
    return next;
  });
}

async function creditHubResult(db, requestId, openid, hubBody, fence) {
  return db.runTransaction(async (transaction) => {
    const requestRef = transaction.collection(REDEEM_COLLECTIONS.requests).doc(requestId);
    const current = await readDocument(requestRef);
    if (!current || current.openid !== openid) throw new Error("REDEEM_REQUEST_NOT_FOUND");
    if (current.creditStatus === "credited") return current;
    if (!fence || current.hubLeaseOwner !== fence.owner || current.hubLeaseToken !== fence.token || Number(current.hubLeaseEpoch) !== Number(fence.epoch) || Number(current.statusVersion) !== Number(fence.statusVersion)) return current;
    const points = Number(hubBody.points) || 0;
    if (hubBody.status !== "succeeded" || points <= 0) {
      const failed = Object.assign({}, current, { requestStatus: hubBody.status === "manual_review" ? "manual_review" : "failed", hubStatus: "failed_permanent", creditStatus: "not_applicable", failureStage: "hub", hubErrorCode: String(hubBody.errorCode || "voucher_failed"), hubLeaseOwner: "", hubLeaseToken: "", hubLeaseUntil: null, updatedAt: new Date() });
      await requestRef.set({ data: storage.stripDocumentId(failed) });
      return failed;
    }
    const accountRef = transaction.collection(REDEEM_COLLECTIONS.accounts).doc(storage.pointsAccountId(openid));
    const account = (await readDocument(accountRef)) || storage.defaultPointsAccount(openid, new Date());
    account.pointsBalance = Math.max(0, Number(account.pointsBalance) || 0) + points;
    account.totalRedeemedPoints = Math.max(0, Number(account.totalRedeemedPoints) || 0) + points;
    account.updatedAt = new Date();
    const ledgerRef = transaction.collection(REDEEM_COLLECTIONS.ledger).doc("redeem:" + requestId);
    const existingLedger = await readDocument(ledgerRef);
    if (existingLedger && Number(existingLedger.amount) !== points) throw new Error("REDEEM_LEDGER_CONFLICT");
    const nextLedger = { _id: "redeem:" + requestId, openid, requestId, redemptionId: String(hubBody.redemptionId || ""), type: "redeem", kind: "voucher", amount: points, balanceAfter: account.pointsBalance, description: "兑换获得 " + points + " 积分", skuCode: String(hubBody.skuCode || ""), points, billing: { source: "voucher", licenseId: String(hubBody.licenseId || ""), requestId }, createdAt: new Date() };
    const completed = Object.assign({}, current, { requestStatus: "success", hubStatus: "succeeded", creditStatus: "credited", redemptionId: String(hubBody.redemptionId || ""), skuCode: String(hubBody.skuCode || ""), points, balance: account.pointsBalance, hubLeaseOwner: "", hubLeaseToken: "", hubLeaseUntil: null, statusVersion: (Number(current.statusVersion) || 0) + 1, updatedAt: new Date(), completedAt: new Date() });
    await accountRef.set({ data: storage.stripDocumentId(account) });
    if (!existingLedger) await ledgerRef.set({ data: storage.stripDocumentId(nextLedger) });
    await requestRef.set({ data: storage.stripDocumentId(completed) });
    return completed;
  });
}

async function redeem(db, event, context, env = process.env) {
  const openid = String((context && (context.OPENID || context.openid)) || "");
  if (!openid) throw new Error("PAYMENT_AUTH_REQUIRED");
  const code = String(event && event.code || "");
  if (!strictRedeemCode(code)) throw new Error("REDEEM_CODE_INVALID");
  const clientAttemptId = String(event && event.clientAttemptId || "");
  if (!uuidv4(clientAttemptId)) throw new Error("REDEEM_ATTEMPT_ID_INVALID");
  let request = await prepareRequest(db, openid, code, clientAttemptId, env);
  if (["success", "failed", "manual_review"].includes(request.requestStatus)) return viewRequest(request);
  const claimed = await claimHubRequest(db, request.requestId, openid);
  if (!claimed) return viewRequest(request);
  const fence = { owner: claimed.hubLeaseOwner, token: claimed.hubLeaseToken, epoch: claimed.hubLeaseEpoch, statusVersion: claimed.statusVersion };
  let response;
  if (Number(claimed.hubAttemptCount) > 1) {
    response = await requestHub("GET", "/internal/api/v1/store/vouchers/redeem/" + claimed.requestId, undefined, env);
    if (response.httpStatus === 404) {
      return viewRequest(await creditHubResult(db, claimed.requestId, openid, { status: "manual_review", errorCode: "request_not_found" }, fence));
    }
  } else {
    const payload = { requestId: claimed.requestId, openidHash: crypto.createHash("sha256").update(openid).digest("hex"), codeEnvelope: claimed.codeEnvelope };
    response = await requestHub("POST", "/internal/api/v1/store/vouchers/redeem", payload, env);
  }
  if (response.httpStatus >= 500 || response.httpStatus === 429) return viewRequest(claimed);
  if (String(response.body && response.body.status || "") === "processing") return viewRequest(claimed);
  request = await creditHubResult(db, claimed.requestId, openid, response.body || {}, fence);
  return viewRequest(request);
}

async function redeemStatus(db, event, context) {
  const openid = String((context && (context.OPENID || context.openid)) || "");
  let requestId = String(event && event.requestId || "");
  const clientAttemptId = String(event && event.clientAttemptId || "");
  if (!openid || (requestId && !uuidv4(requestId)) || (!requestId && !uuidv4(clientAttemptId))) throw new Error("REDEEM_REQUEST_ID_INVALID");
  if (!requestId) {
    const attemptId = stableLockId(openid, "attempt:" + clientAttemptId, process.env);
    const attempt = await readDocument(db.collection(REDEEM_COLLECTIONS.attempts).doc(attemptId));
    requestId = attempt && attempt.requestId || "";
  }
  const request = await readDocument(db.collection(REDEEM_COLLECTIONS.requests).doc(requestId));
  if (!request || request.openid !== openid) throw new Error("REDEEM_REQUEST_NOT_FOUND");
  return viewRequest(request);
}

module.exports = { REDEEM_COLLECTIONS, strictRedeemCode, uuidv4, stableLockId, encryptCodeEnvelope, signHubRequest, createRequest, claimHubRequest, creditHubResult, redeem, redeemStatus, viewRequest };
