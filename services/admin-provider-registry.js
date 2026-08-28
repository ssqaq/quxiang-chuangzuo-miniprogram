/*
 * 前端只负责把 providerRegistry 转成管理页能编辑的形状。
 * 云端仍是唯一事实来源；这里不写本地缓存，也不保存密钥。
 */
const SLOTS = Object.freeze(["face", "analysis", "image", "imageBackup", "video"]);
const MAIN_SLOTS = Object.freeze(["face", "analysis", "image", "video"]);
const SLOT_LABELS = Object.freeze({
  face: "人脸",
  analysis: "分析",
  image: "生图主",
  imageBackup: "生图备用",
  video: "视频"
});
const CAPABILITY_LABELS = Object.freeze({
  face: "人脸识别",
  analysis: "图片分析",
  image: "生图主模型",
  imageBackup: "生图备用模型",
  video: "视频"
});
const BUILTIN_NAMES = Object.freeze({
  dashscope: "阿里云百炼",
  xingju: "星炬",
  lingyun: "凌云"
});
const DEFAULT_COMMON_URLS = Object.freeze({
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  xingju: "https://newapi.akiyo.fun/v1",
  lingyun: "https://api.lingyunapi.xyz/v1"
});
const FIELD_KEYS = Object.freeze({
  face: Object.freeze(["endpoint", "model", "timeoutMs"]),
  analysis: Object.freeze(["endpoint", "model", "timeoutMs"]),
  image: Object.freeze([
    "endpoint", "model", "mode", "size", "resolution", "compatibilityMode",
    "timeoutMs", "maxRetries", "retryEnabled", "retryPreferenceVersion"
  ]),
  imageBackup: Object.freeze([
    "endpoint", "model", "mode", "size", "resolution", "compatibilityMode",
    "timeoutMs", "maxRetries", "retryEnabled", "retryPreferenceVersion"
  ]),
  video: Object.freeze([
    "endpoint", "queryEndpoint", "model", "createPath", "queryPath",
    "resolution", "aspectRatio", "timeoutMs"
  ])
});
const DEFAULT_CAPABILITY = Object.freeze({
  face: { enabled: true, endpoint: "", model: "", timeoutMs: 30000 },
  analysis: { enabled: true, endpoint: "", model: "", timeoutMs: 30000 },
  image: {
    enabled: true, endpoint: "", model: "", mode: "edits", size: "1080x1440",
    resolution: "1K", compatibilityMode: false, timeoutMs: 150000,
    maxRetries: 1, retryEnabled: true, retryPreferenceVersion: 1
  },
  imageBackup: {
    enabled: false, endpoint: "", model: "", mode: "edits", size: "1080x1440",
    resolution: "1K", compatibilityMode: false, timeoutMs: 150000,
    maxRetries: 0, retryEnabled: false, retryPreferenceVersion: 1
  },
  video: {
    enabled: true, endpoint: "", queryEndpoint: "", model: "",
    createPath: "/v1/videos/generations", queryPath: "/v1/videos/{taskId}",
    resolution: "720p", aspectRatio: "", timeoutMs: 90000
  }
});
/* 旧版配置经常只保存 provider，不把模型/地址展开到每个能力里。
 * 对已知内置服务商，这些能力本来就有云端预设；迁移时必须保持启用，
 * 让管理页切换预设时能继续补齐默认参数。自定义服务商仍按实际字段判断。 */
const LEGACY_BUILTIN_ENABLED_SLOTS = Object.freeze({
  dashscope: Object.freeze(["face", "analysis"]),
  xingju: Object.freeze(["image", "video"]),
  lingyun: Object.freeze(["image", "imageBackup"])
});

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value, fallback = "") {
  const valueText = value === undefined || value === null ? "" : String(value);
  return valueText.trim() || fallback;
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  const output = {};
  Object.keys(value).forEach((key) => { output[key] = clone(value[key]); });
  return output;
}

function providerId(value) {
  return text(value).slice(0, 64);
}

function recordKey(value, fallback = "") {
  return text(value && (value.providerKey || value.key || value.internalKey), fallback);
}

function rawProviders(registry) {
  if (!isObject(registry)) return {};
  const source = registry.providers || registry.items || registry.records;
  if (Array.isArray(source)) {
    return source.reduce((out, item) => {
      if (!isObject(item)) return out;
      const key = recordKey(item);
      if (key) out[key] = item;
      return out;
    }, {});
  }
  if (isObject(source)) return source;
  return {};
}

function rawOverride(record, slot) {
  const source = isObject(record) ? record : {};
  const overrides = isObject(source.overrides) ? source.overrides : {};
  const capability = isObject(source.capabilities) ? source.capabilities[slot] : null;
  const nested = isObject(capability) && isObject(capability.overrides)
    ? capability.overrides
    : {};
  return Object.assign({}, isObject(overrides[slot]) ? overrides[slot] : {}, nested);
}

function rawCapability(record, slot) {
  const source = isObject(record) ? record : {};
  const capabilities = isObject(source.capabilities) ? source.capabilities : {};
  const capability = isObject(capabilities[slot]) ? capabilities[slot] : {};
  const override = rawOverride(source, slot);
  const flattened = {};
  FIELD_KEYS[slot].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(capability, key)) flattened[key] = capability[key];
    if (Object.prototype.hasOwnProperty.call(override, key)) flattened[key] = override[key];
  });
  if (Object.prototype.hasOwnProperty.call(capability, "enabled")) {
    flattened.enabled = Boolean(capability.enabled);
  } else if (Object.prototype.hasOwnProperty.call(override, "enabled")) {
    flattened.enabled = Boolean(override.enabled);
  }
  return { capability, override, flattened };
}

function legacySection(record, slot) {
  const source = isObject(record) ? record : {};
  const section = isObject(source[slot]) ? source[slot] : {};
  return section;
}

function normalizeRecord(raw, keyHint = "") {
  const source = isObject(raw) ? raw : {};
  const key = recordKey(source, keyHint);
  const id = providerId(source.id || source.provider || source.externalId || key);
  if (!key || !id) return null;
  const common = isObject(source.common) ? source.common : {};
  const baseUrl = text(
    common.baseUrl !== undefined ? common.baseUrl : source.baseUrl,
    DEFAULT_COMMON_URLS[id] || ""
  );
  const apiKeyConfigured = Boolean(
    common.apiKeyConfigured
    || source.apiKeyConfigured
    || text(common.apiKey || source.apiKey)
  );
  const overrides = {};
  const capabilities = {};
  SLOTS.forEach((slot) => {
    const details = rawCapability(source, slot);
    const legacy = legacySection(source, slot);
    const cap = Object.assign({}, DEFAULT_CAPABILITY[slot]);
    const flattened = details.flattened;
    FIELD_KEYS[slot].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(flattened, field)) cap[field] = flattened[field];
      else if (Object.prototype.hasOwnProperty.call(legacy, field)) cap[field] = legacy[field];
    });
    if (Object.prototype.hasOwnProperty.call(flattened, "enabled")) cap.enabled = Boolean(flattened.enabled);
    else if (Object.prototype.hasOwnProperty.call(legacy, "enabled")) cap.enabled = Boolean(legacy.enabled);
    const override = Object.assign({}, details.override);
    const hasOverride = Boolean(
      source.capabilities && source.capabilities[slot]
      && source.capabilities[slot].overrideEnabled
      || override.baseUrl !== undefined
      || override.apiKey !== undefined
      || override.apiKeyConfigured
    );
    cap.overrideEnabled = hasOverride;
    cap.apiKeyConfigured = Boolean(
      cap.apiKeyConfigured
      || legacy.apiKeyConfigured
      || override.apiKeyConfigured
      || text(override.apiKey)
      || (slot === "video" && apiKeyConfigured)
    );
    cap.baseUrl = text(
      override.baseUrl !== undefined ? override.baseUrl : baseUrl,
      baseUrl
    );
    cap.apiKey = text(override.apiKey);
    if (!Object.prototype.hasOwnProperty.call(cap, "endpoint")) cap.endpoint = text(legacy.endpoint);
    overrides[slot] = override;
    capabilities[slot] = cap;
  });
  return {
    providerKey: key,
    id,
    name: text(source.name || source.label || source.displayName, BUILTIN_NAMES[id] || id),
    builtIn: Boolean(source.builtIn || source.builtin || source.isBuiltin || BUILTIN_NAMES[id]),
    protected: Boolean(source.protected || source.deleteProtected || source.builtIn || source.builtin || BUILTIN_NAMES[id]),
    aliases: Array.isArray(source.aliases) ? source.aliases.map((item) => text(item)).filter(Boolean) : [],
    common: {
      baseUrl,
      apiKey: text(common.apiKey || source.apiKey),
      apiKeyConfigured
    },
    baseUrl,
    apiKeyConfigured,
    overrides,
    capabilities
  };
}

function legacyRegistry(result = {}) {
  const effective = isObject(result.effective) ? result.effective : result;
  const labels = isObject(result.providerLabels) ? result.providerLabels : {};
  const profiles = isObject(result.providerProfiles) ? result.providerProfiles : {};
  const ids = [];
  SLOTS.forEach((slot) => {
    const section = isObject(effective[slot]) ? effective[slot] : {};
    const id = providerId(section.provider);
    if (id && !ids.includes(id)) ids.push(id);
    const profileSection = isObject(profiles[slot]) ? profiles[slot] : {};
    Object.keys(profileSection).forEach((key) => { if (!ids.includes(key)) ids.push(key); });
  });
  Object.keys(labels).forEach((key) => { if (!ids.includes(key)) ids.push(key); });
  const providers = {};
  const legacyCapabilityEnabled = (providerId, slot, section) => {
    if (isObject(section) && Object.prototype.hasOwnProperty.call(section, "enabled")) {
      return Boolean(section.enabled);
    }
    const normalizedId = String(providerId || "").trim().toLowerCase();
    if (
      LEGACY_BUILTIN_ENABLED_SLOTS[normalizedId]
      && LEGACY_BUILTIN_ENABLED_SLOTS[normalizedId].includes(slot)
    ) {
      return true;
    }
    return Boolean(section && (section.model || section.baseUrl));
  };
  ids.forEach((id, index) => {
    const key = `legacy-${id}`;
    const overrides = {};
    const capabilities = {};
    SLOTS.forEach((slot) => {
      const section = isObject(effective[slot]) && providerId(effective[slot].provider) === id
        ? effective[slot]
        : isObject(profiles[slot]) && isObject(profiles[slot][id]) ? profiles[slot][id] : {};
      overrides[slot] = clone(section);
      capabilities[slot] = Object.assign({}, section, {
        enabled: legacyCapabilityEnabled(id, slot, section)
      });
    });
    providers[key] = normalizeRecord({
      providerKey: key,
      id,
      name: labels[id] || BUILTIN_NAMES[id] || id,
      builtIn: Boolean(BUILTIN_NAMES[id]),
      aliases: [],
      baseUrl: "",
      overrides,
      capabilities
    }, key);
  });
  return { version: 1, providers };
}

function normalizeRegistry(value, fallbackResult = {}) {
  const input = isObject(value) ? value : {};
  const source = isObject(input.providerRegistry) ? input.providerRegistry : input;
  const raw = rawProviders(source);
  const providers = {};
  Object.keys(raw).forEach((key) => {
    const normalized = normalizeRecord(raw[key], key);
    if (normalized) providers[normalized.providerKey] = normalized;
  });
  if (!Object.keys(providers).length && isObject(fallbackResult) && Object.keys(fallbackResult).length) {
    return normalizeRegistry(legacyRegistry(fallbackResult));
  }
  const order = Array.isArray(source.order)
    ? source.order.filter((key) => providers[key])
    : Object.keys(providers);
  Object.keys(providers).forEach((key) => { if (!order.includes(key)) order.push(key); });
  return { version: Number(source.version) || 1, providers, order };
}

function normalizeActiveProviders(value, registry, effective = {}) {
  const source = isObject(value) ? value : {};
  const output = {};
  SLOTS.forEach((slot) => {
    let key = text(source[slot]);
    if (key && registry.providers[key]) {
      output[slot] = key;
      return;
    }
    const externalId = key || text(effective[slot] && effective[slot].provider);
    const found = Object.keys(registry.providers).find((candidate) => {
      const record = registry.providers[candidate];
      return record.id.toLowerCase() === externalId.toLowerCase()
        || record.name === externalId;
    });
    output[slot] = found || "";
  });
  return output;
}

function capabilityComplete(record, slot) {
  const source = record && record.capabilities && record.capabilities[slot];
  if (!source || source.enabled === false) return false;
  const hasUrl = Boolean(text(source.baseUrl || record.common && record.common.baseUrl));
  const hasModel = Boolean(text(source.model));
  const hasKey = Boolean(
    source.apiKeyConfigured
    || text(source.apiKey)
    || record.common && record.common.apiKeyConfigured
    || text(record.common && record.common.apiKey)
  );
  // 视频可从环境变量取 Key，云端会在 resolver 中最终判断；有地址和模型即可展示为可用。
  return Boolean(hasUrl && hasModel && (hasKey || slot === "video"));
}

function buildProviderRows(registry, activeProviders) {
  const source = registry && registry.providers ? registry : { providers: {} };
  const active = activeProviders || {};
  return (source.order || Object.keys(source.providers)).map((key) => {
    const record = source.providers[key];
    if (!record) return null;
    const used = SLOTS.filter((slot) => active[slot] === key);
    const complete = SLOTS.filter((slot) => capabilityComplete(record, slot));
    let status = record.protected ? "内置" : used.length ? "使用中" : "未绑定";
    let statusClass = record.protected ? "builtin" : used.length ? "active" : "idle";
    if (!complete.length) { status = "未配置"; statusClass = "empty"; }
    return {
      providerKey: key,
      id: record.id,
      name: record.name,
      aliasesText: record.aliases.join("、"),
      capabilityCount: complete.length,
      capabilityText: complete.length ? `${complete.length}/${SLOTS.length} 项能力` : "未配置能力",
      usedText: used.length ? used.map((slot) => SLOT_LABELS[slot]).join("、") : "未绑定功能",
      status,
      statusClass,
      builtIn: Boolean(record.protected)
    };
  }).filter(Boolean);
}

function buildProviderOptions(registry, activeProviders, slot) {
  const options = [{ value: "", label: "未配置", status: "empty" }];
  const source = registry && registry.providers ? registry : { providers: {} };
  (source.order || Object.keys(source.providers)).forEach((key) => {
    const record = source.providers[key];
    if (!record) return;
    const complete = capabilityComplete(record, slot);
    options.push({
      value: key,
      providerKey: key,
      label: `${record.name} · ${record.id}${complete ? "（已配置）" : "（未配置）"}`,
      shortLabel: record.name,
      status: complete ? "ready" : "empty",
      disabled: false,
      active: activeProviders && activeProviders[slot] === key
    });
  });
  return options;
}

function providerRecord(registry, key) {
  return registry && registry.providers && registry.providers[key]
    ? registry.providers[key]
    : null;
}

function emptyProviderDraft() {
  const capabilities = {};
  SLOTS.forEach((slot) => {
    capabilities[slot] = Object.assign({}, DEFAULT_CAPABILITY[slot], {
      enabled: slot === "imageBackup" ? false : true,
      overrideEnabled: false,
      baseUrl: "",
      apiKey: "",
      apiKeyConfigured: false,
      clearApiKey: false
    });
  });
  return {
    providerKey: "",
    id: "",
    name: "",
    aliases: [],
    aliasesText: "",
    common: { baseUrl: "", apiKey: "", apiKeyConfigured: false, clearApiKey: false },
    capabilities
  };
}

function draftFromRecord(record, secrets = {}) {
  const normalized = normalizeRecord(record || {}, record && record.providerKey);
  const draft = emptyProviderDraft();
  if (!normalized) return draft;
  const response = isObject(secrets) ? secrets : {};
  let secretSource = response;
  if (isObject(response.secrets)) {
    const nested = response.secrets;
    const singleRecord = isObject(nested.common)
      || isObject(nested.capabilities)
      || isObject(nested.slots)
      || nested.apiKey !== undefined;
    if (singleRecord) {
      secretSource = nested;
    } else {
      const selected = nested[normalized.providerKey]
        || nested[normalized.id]
        || nested[record && record.providerKey];
      secretSource = isObject(selected) ? selected : nested;
    }
  }
  // 当前接口同时返回 selected common/capabilities；这些字段优先于
  // secrets 映射，避免把整个目录对象误当作单个档案。
  if (
    isObject(response.common)
    || isObject(response.capabilities)
    || isObject(response.slots)
    || response.apiKey !== undefined
  ) {
    secretSource = Object.assign({}, secretSource, response);
  }
  const commonSecrets = isObject(secretSource.common)
    ? secretSource.common
    : secretSource;
  draft.providerKey = normalized.providerKey;
  draft.id = normalized.id;
  draft.name = normalized.name;
  draft.aliases = normalized.aliases.slice();
  draft.aliasesText = normalized.aliases.join(", ");
  draft.builtIn = normalized.builtIn;
  draft.protected = normalized.protected;
  draft.common = {
    baseUrl: normalized.common.baseUrl,
    apiKey: text(commonSecrets.apiKey || normalized.common.apiKey),
    apiKeyConfigured: Boolean(commonSecrets.apiKeyConfigured || normalized.common.apiKeyConfigured),
    clearApiKey: false
  };
  const secretCaps = isObject(secretSource.capabilities)
    ? secretSource.capabilities
    : isObject(secretSource.slots)
      ? secretSource.slots
      : {};
  SLOTS.forEach((slot) => {
    const cap = Object.assign({}, normalized.capabilities[slot]);
    const override = normalized.overrides[slot] || {};
    const secret = isObject(secretCaps[slot]) ? secretCaps[slot] : {};
    cap.baseUrl = text(override.baseUrl, normalized.common.baseUrl);
    cap.apiKey = text(secret.apiKey || secret.key || override.apiKey);
    cap.apiKeyConfigured = Boolean(
      secret.apiKeyConfigured
      || secret.configured
      || cap.apiKeyConfigured
      || cap.apiKey
      || normalized.common.apiKeyConfigured
    );
    cap.overrideEnabled = Boolean(cap.overrideEnabled || override.baseUrl !== undefined || override.apiKey !== undefined);
    cap.clearApiKey = false;
    draft.capabilities[slot] = cap;
  });
  return draft;
}

function draftToProvider(draft) {
  const source = draft && typeof draft === "object" ? draft : emptyProviderDraft();
  const common = source.common || {};
  const provider = {
    providerKey: text(source.providerKey),
    id: text(source.id),
    name: text(source.name),
    aliases: (String(source.aliasesText || "").trim()
      ? String(source.aliasesText).split(/[,，\s]+/)
      : Array.isArray(source.aliases) ? source.aliases : [])
      .map((item) => text(item)).filter(Boolean),
    common: {
      baseUrl: text(common.baseUrl),
      apiKey: text(common.apiKey),
      apiKeyConfigured: Boolean(common.apiKeyConfigured),
      clearApiKey: Boolean(common.clearApiKey)
    },
    capabilities: {},
    overrides: {}
  };
  SLOTS.forEach((slot) => {
    const cap = source.capabilities && source.capabilities[slot] || {};
    const override = {};
    FIELD_KEYS[slot].forEach((field) => {
      if (cap[field] !== undefined && cap[field] !== "") override[field] = cap[field];
    });
    if (cap.overrideEnabled) {
      override.baseUrl = text(cap.baseUrl);
      override.apiKey = text(cap.apiKey);
      override.apiKeyConfigured = Boolean(cap.apiKeyConfigured);
      override.clearApiKey = Boolean(cap.clearApiKey);
    }
    override.enabled = cap.enabled !== false;
    provider.capabilities[slot] = {
      enabled: cap.enabled !== false,
      overrideEnabled: Boolean(cap.overrideEnabled),
      overrides: override
    };
    provider.overrides[slot] = override;
  });
  return provider;
}

function effectiveSection(record, slot, current = {}) {
  const source = record && record.capabilities && record.capabilities[slot]
    ? record.capabilities[slot]
    : {};
  const output = Object.assign({}, current || {});
  output.provider = record ? record.id : "";
  output.baseUrl = text(source.baseUrl, record && record.common && record.common.baseUrl);
  output.apiKeyConfigured = Boolean(source.apiKeyConfigured || record && record.common && record.common.apiKeyConfigured);
  FIELD_KEYS[slot].forEach((field) => {
    if (source[field] !== undefined) output[field] = source[field];
  });
  if (slot === "imageBackup") output.enabled = Boolean(source.enabled);
  return output;
}

function registryFromResult(result) {
  const source = result && typeof result === "object" ? result : {};
  return normalizeRegistry(source.providerRegistry || source.registry, source);
}

module.exports = {
  SLOTS,
  MAIN_SLOTS,
  SLOT_LABELS,
  CAPABILITY_LABELS,
  FIELD_KEYS,
  BUILTIN_NAMES,
  normalizeRegistry,
  registryFromResult,
  normalizeActiveProviders,
  capabilityComplete,
  buildProviderRows,
  buildProviderOptions,
  providerRecord,
  emptyProviderDraft,
  draftFromRecord,
  draftToProvider,
  effectiveSection
};
