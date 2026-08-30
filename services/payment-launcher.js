function launchError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePaymentParams(payload = {}) {
  const source = payload && payload.payment && typeof payload.payment === "object"
    ? payload.payment
    : payload;
  const params = {
    timeStamp: String(source.timeStamp || ""),
    nonceStr: String(source.nonceStr || ""),
    package: String(source.package || ""),
    signType: String(source.signType || ""),
    paySign: String(source.paySign || "")
  };
  const missing = ["timeStamp", "nonceStr", "package", "signType", "paySign"]
    .filter((key) => !params[key]);
  if (missing.length) {
    throw launchError("支付参数不完整，请重新发起。", "INVALID_PAYMENT_PARAMS");
  }
  if (
    !/^\d{10,13}$/.test(params.timeStamp)
    || params.nonceStr.length > 64
    || !/^prepay_id=[A-Za-z0-9_\-=]+$/.test(params.package)
    || !["RSA", "MD5", "HMAC-SHA256"].includes(params.signType)
    || params.paySign.length < 16
    || params.paySign.length > 1024
  ) {
    throw launchError("支付参数校验失败，请重新发起。", "INVALID_PAYMENT_PARAMS");
  }
  return params;
}

function launchPayment(provider, payload) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider !== "wxpay") {
    return Promise.reject(launchError("不支持的支付方式。", "UNSUPPORTED_PAYMENT_PROVIDER"));
  }
  if (typeof wx === "undefined" || typeof wx.requestPayment !== "function") {
    return Promise.reject(launchError("当前微信版本无法发起支付。", "PAYMENT_API_UNAVAILABLE"));
  }

  let params;
  try {
    params = normalizePaymentParams(payload);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    wx.requestPayment(Object.assign({}, params, {
      success: resolve,
      fail(error) {
        const message = String(error && error.errMsg || "支付没有完成");
        const canceled = /cancel/i.test(message);
        const normalized = launchError(
          canceled ? "已取消支付。" : "支付没有完成，请稍后重试。",
          canceled ? "PAYMENT_CANCELED" : "PAYMENT_FAILED"
        );
        normalized.canceled = canceled;
        normalized.cause = error;
        reject(normalized);
      }
    }));
  });
}

module.exports = {
  launchPayment,
  normalizePaymentParams
};
