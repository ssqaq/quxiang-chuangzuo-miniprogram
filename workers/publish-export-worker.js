const core = require("../utils/publish-export-core");

if (typeof worker !== "undefined" && worker.onMessage) {
  worker.onMessage((message = {}) => {
    try {
      const data = message.data && message.data.data
        ? message.data.data
        : message.data;
      const payload = message.data && message.data.data
        ? message.data
        : message;
      const result = core.processRgba({
        data: data instanceof Uint8ClampedArray
          ? data
          : new Uint8ClampedArray(data || []),
        width: Number(payload.width) || 1,
        height: Number(payload.height) || 1,
        options: payload.options || {},
        seed: payload.seed || "publish-export-worker"
      });
      worker.postMessage({
        id: payload.id || "",
        ok: true,
        data: result
      });
    } catch (error) {
      worker.postMessage({
        id: message && message.data && message.data.id || "",
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  });
}

