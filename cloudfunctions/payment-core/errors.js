"use strict";

class PaymentError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PaymentError";
    this.code = code || "PAYMENT_ERROR";
    this.retryable = Boolean(options.retryable);
    this.uncertain = Boolean(options.uncertain);
    this.publicMessage = options.publicMessage || message;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function paymentError(code, message, options) {
  return new PaymentError(code, message, options);
}

function toPublicFailure(error, fallbackMessage = "支付服务暂时不可用，请稍后再试。") {
  const known = error instanceof PaymentError;
  return {
    ok: false,
    errorCode: known ? error.code : "PAYMENT_INTERNAL_ERROR",
    message: known ? error.publicMessage : fallbackMessage,
    retryable: known ? error.retryable : false
  };
}

module.exports = {
  PaymentError,
  paymentError,
  toPublicFailure
};
