const ACCESS = Object.freeze({
  USER: "user",
  ADMIN: "admin",
  TIMER_OR_ADMIN: "timer-or-admin"
});

function text(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeDefinition(definition = {}) {
  const name = text(definition.name, 80);
  if (!name) throw new Error("Action Registry 缺少 action 名称。");
  if (typeof definition.handler !== "function") {
    throw new Error(`Action Registry 的 ${name} 缺少处理函数。`);
  }
  const access = text(definition.access || ACCESS.USER, 40);
  if (!Object.values(ACCESS).includes(access)) {
    throw new Error(`Action Registry 的 ${name} 权限策略无效：${access}`);
  }
  return Object.freeze({
    name,
    triggerName: text(definition.triggerName, 100),
    access,
    handler: definition.handler,
    metadata: definition.metadata && typeof definition.metadata === "object"
      ? Object.freeze(Object.assign({}, definition.metadata))
      : Object.freeze({})
  });
}

function createActionRegistry(options = {}) {
  const actions = new Map();
  const triggers = new Map();
  const log = typeof options.log === "function" ? options.log : () => {};
  const isAdmin = typeof options.isAdmin === "function" ? options.isAdmin : () => false;
  const forbidden = typeof options.forbidden === "function"
    ? options.forbidden
    : () => ({ ok: false, errorCode: "ADMIN_FORBIDDEN", message: "没有管理员权限。" });
  const mapError = typeof options.mapError === "function"
    ? options.mapError
    : null;
  const getTriggerName = typeof options.getTriggerName === "function"
    ? options.getTriggerName
    : (event = {}) => text(event.triggerName || event.TriggerName || event.name, 100);

  function register(definition) {
    const entry = normalizeDefinition(definition);
    if (actions.has(entry.name)) {
      throw new Error(`Action Registry 重复登记：${entry.name}`);
    }
    actions.set(entry.name, entry);
    if (entry.triggerName) {
      if (triggers.has(entry.triggerName)) {
        throw new Error(`Action Registry 重复登记定时器：${entry.triggerName}`);
      }
      triggers.set(entry.triggerName, entry);
    }
    return entry;
  }

  function resolve(event = {}) {
    const action = text(event.action, 80);
    const triggerName = text(getTriggerName(event), 100);
    if (action && actions.has(action)) {
      return {
        entry: actions.get(action),
        action,
        triggerName,
        matchedBy: "action"
      };
    }
    if (triggerName && triggers.has(triggerName)) {
      const entry = triggers.get(triggerName);
      return {
        entry,
        action: entry.name,
        triggerName,
        matchedBy: "trigger"
      };
    }
    return null;
  }

  function allowed(resolution, context) {
    const entry = resolution.entry;
    if (entry.access === ACCESS.USER) return true;
    const trustedTimer = Boolean(
      entry.triggerName
      && resolution.triggerName
      && entry.triggerName === resolution.triggerName
    );
    if (entry.access === ACCESS.TIMER_OR_ADMIN && trustedTimer) return true;
    return Boolean(isAdmin(context));
  }

  async function dispatch(event = {}, context = {}, execution = {}) {
    const resolution = resolve(event);
    if (!resolution) return { handled: false };
    const requestId = text(execution.requestId || event.requestId, 120);
    const fields = {
      requestId,
      action: resolution.entry.name,
      matchedBy: resolution.matchedBy,
      triggerName: resolution.triggerName,
      access: resolution.entry.access
    };
    if (!allowed(resolution, context)) {
      log("warn", "action-registry.denied", fields);
      return {
        handled: true,
        denied: true,
        entry: resolution.entry,
        matchedBy: resolution.matchedBy,
        result: forbidden()
      };
    }

    const startedAt = Date.now();
    log("info", "action-registry.start", fields);
    try {
      const result = await resolution.entry.handler({
        event,
        context,
        requestId,
        action: resolution.entry.name,
        triggerName: resolution.triggerName,
        matchedBy: resolution.matchedBy,
        metadata: resolution.entry.metadata
      });
      log("info", "action-registry.finish", Object.assign({}, fields, {
        durationMs: Date.now() - startedAt,
        ok: !result || result.ok !== false
      }));
      return {
        handled: true,
        denied: false,
        entry: resolution.entry,
        matchedBy: resolution.matchedBy,
        result
      };
    } catch (error) {
      const errorFields = Object.assign({}, fields, {
        durationMs: Date.now() - startedAt,
        errorCode: text(error && error.code, 80),
        message: text(error && error.message, 240)
      });
      log("error", "action-registry.error", errorFields);
      if (mapError) {
        try {
          return {
            handled: true,
            denied: false,
            errorMapped: true,
            entry: resolution.entry,
            matchedBy: resolution.matchedBy,
            result: await mapError(error, errorFields)
          };
        } catch (mappingError) {
          log("error", "action-registry.error-map-failed", Object.assign(
            {},
            fields,
            {
              errorCode: text(mappingError && mappingError.code, 80),
              message: text(mappingError && mappingError.message, 240)
            }
          ));
        }
      }
      throw error;
    }
  }

  function list() {
    return [...actions.values()].map((entry) => ({
      name: entry.name,
      triggerName: entry.triggerName,
      access: entry.access,
      metadata: entry.metadata
    }));
  }

  return Object.freeze({
    register,
    resolve,
    dispatch,
    list
  });
}

module.exports = {
  ACCESS,
  createActionRegistry
};
