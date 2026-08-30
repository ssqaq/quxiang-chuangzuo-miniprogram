"use strict";

const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashObject(value) {
  return sha256(stableJson(value));
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString("hex");
}

function moneyToFen(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, decimal = ""] = text.split(".");
  const fen = Number(BigInt(whole) * 100n + BigInt((decimal + "00").slice(0, 2)));
  return Number.isSafeInteger(fen) ? fen : null;
}

function fenToMoney(amountFen) {
  const value = Number(amountFen);
  if (!Number.isSafeInteger(value) || value < 0) return "";
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

module.exports = {
  sha256,
  stableJson,
  hashObject,
  randomToken,
  moneyToFen,
  fenToMoney
};
