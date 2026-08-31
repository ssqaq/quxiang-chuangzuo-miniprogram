/*
 * 管理端配置 V2 的纯数据层。
 *
 * 这个文件故意不依赖小程序 API、云开发 SDK 或页面状态。它同时被管理
 * 页面和云函数使用，所有函数都返回新对象，方便在迁移、CAS 和回滚时
 * 保留原始配置。密钥永远不进入规范化后的公开对象。
 */

const SCHEMA_VERSION = 2;

const SLOTS = Object.freeze([
  "standard.face",
  "standard.imageAnalysis",
  "standard.styleAnalysis",
  "standard.imageGeneration",
  "tencent.face",
  "tencent.imageAnalysis",
  "tencent.styleAnalysis",
  "tencent.imageGeneration",
  "shared.video"
]);

const SLOT_LABELS = Object.freeze({
  "standard.face": "人脸识别",
  "standard.imageAnalysis": "图片分析",
  "standard.styleAnalysis": "网感分析",
  "standard.imageGeneration": "生图模型",
  "tencent.face": "人脸识别",
  "tencent.imageAnalysis": "图片分析",
  "tencent.styleAnalysis": "网感分析",
  "tencent.imageGeneration": "生图模型",
  "shared.video": "共享视频模型"
});

const SLOT_GROUPS = Object.freeze({
  standard: Object.freeze(SLOTS.slice(0, 4)),
  tencent: Object.freeze(SLOTS.slice(4, 8)),
  shared: Object.freeze(["shared.video"])
});

const SLOT_ALIASES = Object.freeze({
  face: "standard.face",
  analysis: "standard.imageAnalysis",
  image: "standard.imageGeneration",
  video: "shared.video",
  sharedVideo: "shared.video",
  "standard.image": "standard.imageGeneration",
  "standard.analysis": "standard.imageAnalysis",
  "tencent.image": "tencent.imageGeneration",
  "tencent.analysis": "tencent.imageAnalysis"
});

const VALID_ROLES = Object.freeze(["primary", "backup"]);
const VALID_STATUSES = Object.freeze(["ready", "needsReview", "not-ready"]);
const VALID_PHASES = Object.freeze(["pre-migration", "dual-read", "v2-only", "rollback"]);

const SECRET_KEYS = Object.freeze([
  "apikey", "api_key", "secret", "secretkey", "secret_key", "secretid",
  "secret_id", "token", "accesstoken", "access_token", "authorization",
  "password", "privatekey", "private_key", "clientsecret", "client_secret",
  "credential", "credentials", "plainkey", "plaintextkey"
]);

const TC3_DEFAULT = Object.freeze({
  protocol: "tencent-tc3",
  displayName: "人脸融合依赖",
  status: "not-ready",
  credentialRef: "",
  extra: {
    secretIdRef: "",
    secretKeyRef: "",
    region: "",
    action: "",
    version: "",
    endpoint: ""
  }
});

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value, fallback) {
  const result = value === undefined || value === null ? "" : String(value).trim();
  return result || (fallback === undefined ? "" : String(fallback));
}

function number(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (minimum !== undefined && parsed < minimum) return fallback;
  return parsed;
}

function bool(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  return Boolean(value);
}

function clone(value, seen) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  const refs = seen || new Map();
  if (refs.has(value)) return refs.get(value);
  if (Array.isArray(value)) {
    const array = [];
    refs.set(value, array);
    value.forEach((item) => array.push(clone(item, refs)));
    return array;
  }
  const output = {};
  refs.set(value, output);
  Object.keys(value).forEach((key) => { output[key] = clone(value[key], refs); });
  return output;
}

function secretKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[-\s]/g, "");
  return SECRET_KEYS.includes(normalized);
}

/* 删除明文凭证，但保留 configured/Ref 这类非秘密元数据。 */
function sanitizeSecrets(value, keyHint) {
  if (secretKey(keyHint)) return undefined;
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecrets(item)).filter((item) => item !== undefined);
  }
  const output = {};
  Object.keys(value).forEach((key) => {
    if (secretKey(key)) return;
    const item = sanitizeSecrets(value[key], key);
    if (item !== undefined) output[key] = item;
  });
  return output;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    if (!secretKey(key) && key !== "version" && key !== "updatedAt" && key !== "confirmedAt") {
      output[key] = stableValue(value[key]);
    }
  });
  return output;
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function hashSource(value) {
  const input = stableSerialize(value || "");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function nowValue(options) {
  const candidate = options && (options.now || options.timestamp);
  return candidate ? String(candidate) : new Date().toISOString();
}

function canonicalSlot(slot) {
  const value = text(slot);
  if (SLOTS.includes(value)) return value;
  return SLOT_ALIASES[value] || "";
}

function canonicalRole(role) {
  const value = text(role, "primary").toLowerCase();
  if (value === "main") return "primary";
  if (value === "fallback" || value === "secondary") return "backup";
  return VALID_ROLES.includes(value) ? value : "primary";
}

function canonicalStatus(status, fallback) {
  const value = text(status, fallback || "not-ready");
  if (value === "not_ready" || value === "notready") return "not-ready";
  if (value === "pending" || value === "review") return "needsReview";
  return VALID_STATUSES.includes(value) ? value : (fallback || "not-ready");
}

function providerKeyOf(value, fallback) {
  if (!isObject(value) && typeof value !== "string") return text(fallback);
  if (typeof value === "string") return text(value, fallback);
  return text(value.providerKey || value.key || value.internalKey || value.id, fallback);
}

function modelIdOf(value, fallback) {
  if (!isObject(value) && typeof value !== "string") return text(fallback);
  if (typeof value === "string") return text(value, fallback);
  return text(value.modelId || value.model || value.id || value.name, fallback);
}

function bindingKey(slot, role) {
  return `${canonicalSlot(slot)}:${canonicalRole(role)}`;
}

function modelKey(providerKey, modelId) {
  return `${text(providerKey)}:${text(modelId)}`;
}

function configuredCredential(source) {
  if (!isObject(source)) return false;
  const auth = isObject(source.auth) ? source.auth : {};
  const common = isObject(source.common) ? source.common : {};
  return Boolean(
    source.apiKeyConfigured || source.credentialConfigured || source.hasCredentials
    || common.apiKeyConfigured || common.credentialConfigured
    || auth.credentialRef || auth.extra && (auth.extra.secretIdRef || auth.extra.secretKeyRef)
    || source.apiKey || source.secretKey || source.secretId
  );
}

function normalizeAuth(raw, source) {
  const input = isObject(raw) ? raw : {};
  const protocol = text(input.protocol || input.type || source && (source.protocol || source.authType), "openai");
  const rawExtra = isObject(input.extra) ? input.extra : {};
  const extra = {};
  Object.keys(rawExtra).forEach((key) => {
    if (!secretKey(key)) extra[key] = text(rawExtra[key]);
  });
  const credentialRef = text(input.credentialRef || input.credentialsRef || source && source.credentialRef);
  if (protocol === "tencent-tc3") {
    ["secretIdRef", "secretKeyRef", "region", "action", "version", "endpoint"].forEach((key) => {
      if (rawExtra[key] !== undefined) extra[key] = text(rawExtra[key]);
      else if (input[key] !== undefined && !secretKey(key)) extra[key] = text(input[key]);
      else if (source && source[key] !== undefined && !secretKey(key)) extra[key] = text(source[key]);
      if (extra[key] === undefined) extra[key] = "";
    });
  }
  return {
    protocol,
    credentialRef,
    extra,
    configured: Boolean(input.configured || input.credentialConfigured || credentialRef || configuredCredential(source))
  };
}

function normalizeSupplier(raw, keyHint, options) {
  const source = isObject(raw) ? raw : {};
  const providerKey = providerKeyOf(source, keyHint);
  if (!providerKey) return null;
  const common = isObject(source.common) ? source.common : {};
  const endpoint = text(
    source.endpoint || source.baseUrl || common.endpoint || common.baseUrl,
    ""
  );
  const auth = normalizeAuth(source.auth, source);
  const aliases = Array.isArray(source.aliases)
    ? source.aliases.map((item) => text(item)).filter(Boolean)
    : [];
  return {
    providerKey,
    id: text(source.id || source.provider || source.externalId, providerKey),
    name: text(source.name || source.label || source.displayName, providerKey),
    endpoint,
    baseUrl: endpoint,
    auth,
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    sortOrder: number(source.sortOrder !== undefined ? source.sortOrder : source.order, 0, 0),
    version: number(source.version, 1, 1),
    builtIn: Boolean(source.builtIn || source.builtin || source.isBuiltin),
    protected: Boolean(source.protected || source.deleteProtected || source.builtIn || source.builtin),
    aliases,
    credentialConfigured: Boolean(auth.configured || configuredCredential(source)),
    metadata: sanitizeSecrets(isObject(source.metadata) ? source.metadata : {})
  };
}

function capabilityNameForSlot(slot) {
  const value = canonicalSlot(slot);
  if (!value) return "";
  return value.split(".")[1];
}

function normalizeCapabilities(value) {
  const input = Array.isArray(value) ? value : (value ? [value] : []);
  const aliases = {
    face: "face",
    image: "imageGeneration",
    imageGeneration: "imageGeneration",
    analysis: "imageAnalysis",
    imageAnalysis: "imageAnalysis",
    style: "styleAnalysis",
    webPoses: "styleAnalysis",
    styleAnalysis: "styleAnalysis",
    video: "video",
    "shared.video": "video"
  };
  return Array.from(new Set(input.map((item) => aliases[text(item)] || text(item)).filter(Boolean)));
}

function normalizeSupplierModel(raw, keyHint, options) {
  const source = isObject(raw) ? raw : {};
  const providerKey = providerKeyOf(source, keyHint && String(keyHint).split(":")[0]);
  const modelId = modelIdOf(source, keyHint && String(keyHint).split(":").slice(1).join(":"));
  if (!providerKey || !modelId) return null;
  const capabilities = normalizeCapabilities(source.capabilities || source.features || source.slots);
  const confirmed = Boolean(source.confirmed || source.confirmedAt || source.status === "confirmed");
  return {
    providerKey,
    modelId,
    capabilities,
    endpointRef: text(source.endpointRef || source.endpoint || source.baseUrl),
    protocol: text(source.protocol || source.authProtocol, "openai"),
    confirmed,
    confirmedAt: source.confirmedAt ? String(source.confirmedAt) : null,
    confirmedBy: text(source.confirmedBy || source.confirmedByOpenid),
    sourceHash: text(source.sourceHash, hashSource({
      providerKey,
      modelId,
      capabilities,
      endpointRef: source.endpointRef || source.endpoint,
      protocol: source.protocol || source.authProtocol
    })),
    version: number(source.version, 1, 1),
    fetchedAt: source.fetchedAt ? String(source.fetchedAt) : null,
    metadata: sanitizeSecrets(isObject(source.metadata) ? source.metadata : {})
  };
}

function normalizeBinding(raw, context, options) {
  const source = isObject(raw) ? raw : {};
  const slot = canonicalSlot(source.slot || source.capability || source.feature);
  if (!slot) return null;
  const role = canonicalRole(source.role || source.kind);
  const providerKey = providerKeyOf(source, "");
  const modelId = modelIdOf(source, "");
  const models = context && context.modelsByKey ? context.modelsByKey : {};
  const suppliers = context && context.suppliersByKey ? context.suppliersByKey : {};
  const model = providerKey && modelId ? models[modelKey(providerKey, modelId)] : null;
  const supplier = providerKey ? suppliers[providerKey] : null;
  let status = canonicalStatus(source.status, providerKey && modelId ? "needsReview" : "not-ready");
  if (!providerKey || !modelId || !supplier || !model) {
    status = "not-ready";
  } else if (status === "ready" && (!model.confirmed || supplier.enabled === false)) {
    status = "needsReview";
  }
  return {
    slot,
    role,
    providerKey,
    modelId,
    status,
    sourceHash: text(source.sourceHash, model && model.sourceHash || ""),
    confirmedAt: source.confirmedAt ? String(source.confirmedAt) : null,
    confirmedBy: text(source.confirmedBy || source.confirmedByOpenid),
    version: number(source.version, 1, 1),
    fallbackUsed: Boolean(source.fallbackUsed),
    lastFailureAt: source.lastFailureAt ? String(source.lastFailureAt) : null,
    metadata: sanitizeSecrets(isObject(source.metadata) ? source.metadata : {})
  };
}

function normalizeCostAdapter(raw, keyHint) {
  const source = isObject(raw) ? raw : {};
  const providerKey = providerKeyOf(source, keyHint && String(keyHint).split(":")[0]);
  const modelId = modelIdOf(source, keyHint && String(keyHint).split(":").slice(1).join(":"));
  if (!providerKey || !modelId) return null;
  const profile = isObject(source.adapterProfile)
    ? source.adapterProfile
    : isObject(source.adapterProfiles) ? source.adapterProfiles : {};
  return {
    providerKey,
    modelId,
    costIndex: number(source.costIndex, 0, 0),
    adapterProfile: sanitizeSecrets(profile),
    version: number(source.version, 1, 1),
    updatedAt: source.updatedAt ? String(source.updatedAt) : null
  };
}

function normalizeSafetyProbe(raw) {
  const source = isObject(raw) ? raw : {};
  const providerKey = providerKeyOf(source, "");
  const modelId = modelIdOf(source, "");
  if (!providerKey || !modelId) return null;
  const result = ["pass", "fail", "unknown"].includes(text(source.result))
    ? text(source.result)
    : "unknown";
  const output = {
    providerKey,
    modelId,
    path: text(source.path, ""),
    result,
    evidence: text(source.evidence, ""),
    probedAt: source.probedAt ? String(source.probedAt) : null,
    /* 探针必须由服务端明确标记；客户端只传 result 不能直接放行。 */
    serverVerified: source.serverVerified === true,
    version: number(source.version, 1, 1)
  };
  /* allowed 是客户端不可写的旧字段，永远不复制到规范数据。 */
  return output;
}

function normalizeMigrationState(raw) {
  const source = isObject(raw) ? raw : {};
  const phase = VALID_PHASES.includes(text(source.phase)) ? text(source.phase) : "pre-migration";
  return {
    phase,
    backupRef: text(source.backupRef),
    rollbackRef: text(source.rollbackRef),
    v2WriterEnabled: Boolean(source.v2WriterEnabled),
    version: number(source.version, 1, 1),
    updatedAt: source.updatedAt ? String(source.updatedAt) : null
  };
}

function normalizeDependency(raw) {
  const source = isObject(raw) ? raw : {};
  const base = Object.assign({}, TC3_DEFAULT, {
    credentialRef: text(source.credentialRef),
    status: canonicalStatus(source.status, "not-ready")
  });
  const inputExtra = isObject(source.extra) ? source.extra : source;
  base.extra = Object.assign({}, TC3_DEFAULT.extra);
  ["secretIdRef", "secretKeyRef", "region", "action", "version", "endpoint"].forEach((key) => {
    base.extra[key] = text(inputExtra[key]);
  });
  if (!base.extra.secretIdRef || !base.extra.secretKeyRef || !base.extra.region) {
    if (base.status === "ready") base.status = "needsReview";
  }
  return base;
}

function emptyV2Config(extra) {
  const output = {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    suppliers: [],
    supplierModels: [],
    bindings: [],
    costAdapters: [],
    safetyProbes: [],
    migrationState: normalizeMigrationState({}),
    dependencies: {
      tencentFaceFusion: normalizeDependency({})
    }
  };
  if (isObject(extra)) {
    Object.assign(output, sanitizeSecrets(extra));
    output.schemaVersion = SCHEMA_VERSION;
    if (!Array.isArray(output.suppliers)) output.suppliers = [];
    if (!Array.isArray(output.supplierModels)) output.supplierModels = [];
    if (!Array.isArray(output.bindings)) output.bindings = [];
    if (!Array.isArray(output.costAdapters)) output.costAdapters = [];
    if (!Array.isArray(output.safetyProbes)) output.safetyProbes = [];
  }
  return output;
}

function arraySource(source, names) {
  for (const name of names) {
    if (Array.isArray(source && source[name])) return source[name];
  }
  return [];
}

function objectSource(source, names) {
  for (const name of names) {
    if (isObject(source && source[name])) return source[name];
  }
  return {};
}

function dedupeBy(items, keyFn, mergeFn) {
  const map = new Map();
  (items || []).forEach((item) => {
    if (!item) return;
    const key = keyFn(item);
    if (!key) return;
    if (!map.has(key)) map.set(key, item);
    else map.set(key, mergeFn ? mergeFn(map.get(key), item) : item);
  });
  return Array.from(map.values());
}

function mergeSupplier(previous, next) {
  if (!previous) return next;
  const output = Object.assign({}, previous, next);
  output.auth = Object.assign({}, previous.auth || {}, next.auth || {}, {
    extra: Object.assign({}, previous.auth && previous.auth.extra, next.auth && next.auth.extra)
  });
  output.aliases = Array.from(new Set([].concat(previous.aliases || [], next.aliases || [])));
  output.credentialConfigured = Boolean(previous.credentialConfigured || next.credentialConfigured);
  return output;
}

function mergeModel(previous, next) {
  if (!previous) return next;
  const output = Object.assign({}, previous, next);
  output.capabilities = Array.from(new Set([].concat(previous.capabilities || [], next.capabilities || [])));
  output.confirmed = Boolean(previous.confirmed || next.confirmed);
  output.confirmedAt = next.confirmedAt || previous.confirmedAt || null;
  return output;
}

function mergeBinding(previous, next) {
  if (!previous) return next;
  const rank = { "not-ready": 0, needsReview: 1, ready: 2 };
  const output = Object.assign({}, previous, next);
  if ((rank[previous.status] || 0) > (rank[next.status] || 0)) output.status = previous.status;
  output.version = Math.max(number(previous.version, 1, 1), number(next.version, 1, 1));
  return output;
}

function normalizeV2Config(value, options) {
  const input = isObject(value) ? value : {};
  const source = isObject(input.providerConfigV2) ? input.providerConfigV2 : input;
  const output = emptyV2Config();

  /* 未知顶层字段保留，但先去掉明文凭证。 */
  Object.keys(input).forEach((key) => {
    if (!["schemaVersion", "version", "suppliers", "providers", "supplierModels", "models", "bindings", "costAdapters", "safetyProbes", "migrationState", "dependencies", "providerConfigV2"].includes(key)) {
      const item = sanitizeSecrets(input[key], key);
      if (item !== undefined) output[key] = item;
    }
  });
  Object.keys(source).forEach((key) => {
    if (!["schemaVersion", "version", "suppliers", "providers", "supplierModels", "models", "bindings", "costAdapters", "safetyProbes", "migrationState", "dependencies"].includes(key)) {
      const item = sanitizeSecrets(source[key], key);
      if (item !== undefined && output[key] === undefined) output[key] = item;
    }
  });

  const rawSuppliers = arraySource(source, ["suppliers"]).slice();
  const providerObject = objectSource(source, ["providers"]);
  Object.keys(providerObject).forEach((key) => rawSuppliers.push(Object.assign({}, providerObject[key], { providerKey: providerObject[key].providerKey || key })));
  output.suppliers = dedupeBy(
    rawSuppliers.map((item) => normalizeSupplier(item, item && item.providerKey, options)).filter(Boolean),
    (item) => item.providerKey,
    mergeSupplier
  );
  const suppliersByKey = {};
  output.suppliers.forEach((item) => { suppliersByKey[item.providerKey] = item; });

  const rawModels = arraySource(source, ["supplierModels", "models"]).slice();
  const modelsObject = objectSource(source, ["supplierModelsByKey"]);
  Object.keys(modelsObject).forEach((key) => rawModels.push(Object.assign({}, modelsObject[key], { key })));
  output.supplierModels = dedupeBy(
    rawModels.map((item) => normalizeSupplierModel(item, item && item.key, options)).filter(Boolean),
    (item) => modelKey(item.providerKey, item.modelId),
    mergeModel
  );
  const modelsByKey = {};
  output.supplierModels.forEach((item) => { modelsByKey[modelKey(item.providerKey, item.modelId)] = item; });

  const context = { suppliersByKey, modelsByKey };
  output.bindings = dedupeBy(
    arraySource(source, ["bindings"]).map((item) => normalizeBinding(item, context, options)).filter(Boolean),
    (item) => bindingKey(item.slot, item.role),
    mergeBinding
  );
  output.costAdapters = dedupeBy(
    arraySource(source, ["costAdapters"]).map((item) => normalizeCostAdapter(item, item && item.key)).filter(Boolean),
    (item) => modelKey(item.providerKey, item.modelId)
  );
  output.safetyProbes = dedupeBy(
    arraySource(source, ["safetyProbes"]).map((item) => normalizeSafetyProbe(item)).filter(Boolean),
    (item) => `${modelKey(item.providerKey, item.modelId)}:${item.path}`
  );
  output.schemaVersion = SCHEMA_VERSION;
  output.version = number(source.version !== undefined ? source.version : input.version, 1, 1);
  output.migrationState = normalizeMigrationState(source.migrationState);
  const dependencies = isObject(source.dependencies) ? source.dependencies : {};
  output.dependencies = Object.assign({}, sanitizeSecrets(dependencies));
  output.dependencies.tencentFaceFusion = normalizeDependency(
    dependencies.tencentFaceFusion || dependencies.tc3 || source.tencentFaceFusion || {}
  );
  return output;
}

function oldRegistryProviders(registry) {
  if (!isObject(registry)) return [];
  const source = registry.providers || registry.items || registry.records;
  if (Array.isArray(source)) return source;
  if (isObject(source)) return Object.keys(source).map((key) => Object.assign({}, source[key], { providerKey: source[key].providerKey || key }));
  return [];
}

function oldSection(source, name) {
  if (isObject(source && source[name])) return source[name];
  if (isObject(source && source.configs && source.configs[name])) return source.configs[name];
  return null;
}

function explicitStyleSection(source) {
  return oldSection(source, "styleAnalysis")
    || oldSection(source, "webPoses")
    || oldSection(source, "style")
    || (isObject(source && source.configs && source.configs.styleAnalysis) ? source.configs.styleAnalysis : null);
}

function explicitTencentSection(source, name) {
  const tencent = objectSource(source, ["tencent", "tencentConfigs", "configsTencent"]);
  return (isObject(tencent[name]) ? tencent[name] : null)
    || oldSection(source, `tencent${name.charAt(0).toUpperCase()}${name.slice(1)}`);
}

function legacyProviderSource(section, registry) {
  if (!isObject(section)) return null;
  const key = text(section.providerKey || section.provider || section.providerId);
  const providers = oldRegistryProviders(registry);
  const found = providers.find((item) => {
    const id = text(item.id || item.provider || item.externalId);
    const itemKey = providerKeyOf(item);
    return itemKey === key || id === key || text(item.name) === key;
  });
  if (found) return Object.assign({}, found, { providerKey: found.providerKey || providerKeyOf(found, key) });
  return {
    providerKey: key,
    id: text(section.provider || section.providerId, key),
    name: text(section.providerName || section.name, key),
    endpoint: text(section.endpoint || section.baseUrl),
    apiKeyConfigured: configuredCredential(section)
  };
}

function sourceForSlot(source, slot, role) {
  const roleName = canonicalRole(role);
  /* shared.video 只有一个规范来源；新字段优先于旧 video 别名。 */
  if (slot === "shared.video" && roleName === "primary") {
    const advanced = isObject(source.advanced) ? source.advanced : {};
    if (isObject(advanced.sharedVideo)) return advanced.sharedVideo;
    if (isObject(source.sharedVideo)) return source.sharedVideo;
    const advancedVideo = isObject(advanced.video) ? advanced.video : null;
    if (advancedVideo) return advancedVideo;
    if (isObject(source.video)) return source.video;
    const sharedConfig = oldSection(source, "sharedVideo");
    if (sharedConfig) return sharedConfig;
    const videoConfig = oldSection(source, "video");
    if (videoConfig) return videoConfig;
    return null;
  }
  const map = {
    "standard.face": roleName === "backup" ? ["faceBackup"] : ["face"],
    "standard.imageAnalysis": roleName === "backup" ? ["analysisBackup"] : ["analysis"],
    "standard.styleAnalysis": roleName === "backup" ? ["styleAnalysisBackup", "webPosesBackup"] : ["styleAnalysis", "webPoses", "style"],
    "standard.imageGeneration": roleName === "backup" ? ["imageBackup"] : ["image"],
    "tencent.face": roleName === "backup" ? ["tencentFaceBackup"] : ["tencentFace"],
    "tencent.imageAnalysis": roleName === "backup" ? ["tencentAnalysisBackup"] : ["tencentAnalysis"],
    "tencent.styleAnalysis": roleName === "backup" ? ["tencentStyleAnalysisBackup"] : ["tencentStyleAnalysis"],
    "tencent.imageGeneration": roleName === "backup" ? ["tencentImageBackup"] : ["tencentImage"],
    "shared.video": roleName === "backup" ? ["sharedVideoBackup"] : []
  };
  const names = map[slot] || [];
  for (const name of names) {
    const item = oldSection(source, name);
    if (item) return item;
  }
  if (slot.indexOf("tencent.") === 0) {
    const suffix = slot.split(".")[1];
    const item = explicitTencentSection(source, suffix);
    if (item && roleName === "primary") return item;
  }
  if (slot === "standard.styleAnalysis" && roleName === "primary") return explicitStyleSection(source);
  return null;
}

function sourceComplete(section) {
  return Boolean(isObject(section) && text(section.provider || section.providerKey || section.providerId) && text(section.model || section.modelId));
}

function migrateLegacyToV2(value, options) {
  const input = isObject(value) ? value : {};
  const existing = isObject(input.providerConfigV2) ? input.providerConfigV2 : input;
  if (Number(existing.schemaVersion) === SCHEMA_VERSION && Array.isArray(existing.bindings)) {
    return normalizeV2Config(existing, options);
  }
  const output = emptyV2Config();
  const registry = input.providerRegistry || input.registry || {};
  const providerCandidates = oldRegistryProviders(registry);
  const sources = [];
  SLOTS.forEach((slot) => {
    ["primary", "backup"].forEach((role) => {
      const section = sourceForSlot(input, slot, role);
      if (section) sources.push({ slot, role, section });
    });
  });
  const supplierMap = new Map();
  providerCandidates.forEach((item) => {
    const normalized = normalizeSupplier(item, item.providerKey, options);
    if (normalized) supplierMap.set(normalized.providerKey, normalized);
  });
  sources.forEach(({ section }) => {
    const provider = legacyProviderSource(section, registry);
    const normalized = normalizeSupplier(provider, provider && provider.providerKey, options);
    if (normalized) supplierMap.set(normalized.providerKey, mergeSupplier(supplierMap.get(normalized.providerKey), normalized));
  });
  output.suppliers = Array.from(supplierMap.values());
  const suppliersByKey = {};
  output.suppliers.forEach((item) => { suppliersByKey[item.providerKey] = item; });
  const modelMap = new Map();
  const bindingList = [];
  sources.forEach(({ slot, role, section }) => {
    if (!sourceComplete(section)) return;
    const providerRecord = legacyProviderSource(section, registry);
    const providerKey = text(providerRecord && providerRecord.providerKey, section.providerKey || section.provider || section.providerId);
    const modelId = text(section.modelId || section.model);
    if (!providerKey || !modelId) return;
    const supplier = suppliersByKey[providerKey] || normalizeSupplier(providerRecord || legacyProviderSource(section, registry), providerKey, options);
    if (supplier && !suppliersByKey[providerKey]) {
      suppliersByKey[providerKey] = supplier;
      output.suppliers.push(supplier);
    }
    const protocol = text(section.protocol || supplier && supplier.auth && supplier.auth.protocol, "openai");
    const model = normalizeSupplierModel({
      providerKey,
      modelId,
      protocol,
      endpointRef: section.endpoint || section.baseUrl || supplier && supplier.endpoint,
      capabilities: [capabilityNameForSlot(slot)],
      confirmed: true,
      confirmedAt: section.confirmedAt || null,
      sourceHash: hashSource({ providerKey, modelId, endpoint: section.endpoint || section.baseUrl, protocol })
    }, `${providerKey}:${modelId}`, options);
    modelMap.set(modelKey(providerKey, modelId), mergeModel(modelMap.get(modelKey(providerKey, modelId)), model));
    const status = section.status && canonicalStatus(section.status)
      || (supplier && supplier.enabled !== false ? "ready" : "needsReview");
    bindingList.push({
      slot,
      role,
      providerKey,
      modelId,
      status,
      sourceHash: hashSource({ slot, role, providerKey, modelId, endpoint: section.endpoint || section.baseUrl, protocol }),
      confirmedAt: section.confirmedAt || null,
      confirmedBy: section.confirmedBy || "migration",
      version: 1,
      metadata: { migratedFrom: role === "backup" ? `${slot}:backup` : slot }
    });
  });
  output.supplierModels = Array.from(modelMap.values());
  const modelsByKey = {};
  output.supplierModels.forEach((item) => { modelsByKey[modelKey(item.providerKey, item.modelId)] = item; });
  const context = { suppliersByKey, modelsByKey };
  output.bindings = bindingList.map((item) => normalizeBinding(item, context, options)).filter(Boolean);
  /* 所有九个主槽位都有明确状态；腾讯无来源只能是空槽，不得伪造 ready。 */
  SLOTS.forEach((slot) => {
    if (!output.bindings.some((item) => item.slot === slot && item.role === "primary")) {
      output.bindings.push(normalizeBinding({ slot, role: "primary", status: "not-ready" }, context, options));
    }
  });
  const rawAdapters = arraySource(input, ["costAdapters"]).slice();
  output.costAdapters = rawAdapters.map((item) => normalizeCostAdapter(item, item && item.key)).filter(Boolean);
  const rawProbes = arraySource(input, ["safetyProbes"]).slice();
  output.safetyProbes = rawProbes.map((item) => normalizeSafetyProbe(item)).filter(Boolean);
  const oldDeps = input.dependencies || input.systemIntegrations || input.pipelineDependencies || {};
  output.dependencies.tencentFaceFusion = normalizeDependency(
    oldDeps.tencentFaceFusion || oldDeps.tc3 || input.tencentFaceFusion || {}
  );
  const migrationTimestamp = nowValue(options);
  output.migrationState = normalizeMigrationState({
    phase: "dual-read",
    backupRef: text(options && options.backupRef, `legacy-${hashSource(input)}`),
    rollbackRef: text(options && options.rollbackRef),
    v2WriterEnabled: false,
    version: 1,
    updatedAt: migrationTimestamp
  });
  /* 保留旧形状供只读回滚/审计；sanitizeSecrets 确保不把 Key 带入 V2。 */
  output.legacy = sanitizeSecrets(input);
  output.legacyAliases = {};
  if (isObject(input.advanced) && isObject(input.advanced.video)) {
    output.legacyAliases.video = sanitizeSecrets(input.advanced.video);
  }
  if (isObject(input.video)) output.legacyAliases.video = sanitizeSecrets(input.video);
  if (isObject(input.advanced) && isObject(input.advanced.sharedVideo)) {
    output.legacyAliases.sharedVideo = sanitizeSecrets(input.advanced.sharedVideo);
  }
  return normalizeV2Config(output, options);
}

function validationErrors(config) {
  const errors = [];
  if (!isObject(config) || Number(config.schemaVersion) !== SCHEMA_VERSION) errors.push("SCHEMA_VERSION");
  if (!Array.isArray(config && config.suppliers)) errors.push("SUPPLIERS_NOT_ARRAY");
  if (!Array.isArray(config && config.supplierModels)) errors.push("MODELS_NOT_ARRAY");
  if (!Array.isArray(config && config.bindings)) errors.push("BINDINGS_NOT_ARRAY");
  if (!Array.isArray(config && config.costAdapters)) errors.push("COST_ADAPTERS_NOT_ARRAY");
  if (!Array.isArray(config && config.safetyProbes)) errors.push("SAFETY_PROBES_NOT_ARRAY");
  if (!isObject(config && config.migrationState)) errors.push("MIGRATION_STATE_MISSING");
  const suppliers = new Set();
  (config && config.suppliers || []).forEach((item) => {
    if (!item || !text(item.providerKey)) errors.push("SUPPLIER_KEY_MISSING");
    else if (suppliers.has(item.providerKey)) errors.push(`SUPPLIER_DUPLICATE:${item.providerKey}`);
    suppliers.add(item && item.providerKey);
    if (item && item.auth && item.auth.protocol === "tencent-tc3") {
      const extra = item.auth.extra || {};
      if (!text(extra.region)) errors.push(`TC3_REGION_MISSING:${item.providerKey}`);
      if (Object.prototype.hasOwnProperty.call(item.auth, "apiKey")) errors.push(`TC3_APIKEY_FIELD:${item.providerKey}`);
    }
  });
  const models = new Set();
  (config && config.supplierModels || []).forEach((item) => {
    const key = item && modelKey(item.providerKey, item.modelId);
    if (!item || !item.providerKey || !item.modelId) errors.push("MODEL_KEY_MISSING");
    else if (models.has(key)) errors.push(`MODEL_DUPLICATE:${key}`);
    models.add(key);
  });
  const bindings = new Set();
  (config && config.bindings || []).forEach((item) => {
    const key = item && bindingKey(item.slot, item.role);
    if (!item || !SLOTS.includes(item.slot)) errors.push(`BINDING_SLOT_INVALID:${item && item.slot}`);
    if (item && !VALID_ROLES.includes(item.role)) errors.push(`BINDING_ROLE_INVALID:${item.role}`);
    if (item && !VALID_STATUSES.includes(item.status)) errors.push(`BINDING_STATUS_INVALID:${item.status}`);
    if (bindings.has(key)) errors.push(`BINDING_DUPLICATE:${key}`);
    bindings.add(key);
    if (item && item.status === "ready") {
      if (!suppliers.has(item.providerKey)) errors.push(`READY_SUPPLIER_MISSING:${key}`);
      if (!models.has(modelKey(item.providerKey, item.modelId))) errors.push(`READY_MODEL_MISSING:${key}`);
    }
  });
  const adapters = new Set();
  (config && config.costAdapters || []).forEach((item) => {
    const key = item && modelKey(item.providerKey, item.modelId);
    if (adapters.has(key)) errors.push(`ADAPTER_DUPLICATE:${key}`);
    adapters.add(key);
  });
  const deps = config && config.dependencies && config.dependencies.tencentFaceFusion;
  if (!deps || deps.protocol !== "tencent-tc3") errors.push("TC3_DEPENDENCY_MISSING");
  const serialized = JSON.stringify(config || {});
  if (/("apiKey"|"secretKey"|"secretId"|"accessToken"|"password")\s*:/.test(serialized)) errors.push("PLAINTEXT_SECRET_PRESENT");
  return errors;
}

function validateV2Config(value) {
  const config = normalizeV2Config(value);
  const errors = validationErrors(config);
  return { valid: errors.length === 0, ok: errors.length === 0, errors, config };
}

function isValidV2Config(value) {
  return validateV2Config(value).valid;
}

function assertCas(config, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  if (Number(config.version) !== Number(expectedVersion)) {
    const error = new Error(`配置版本冲突：expected ${expectedVersion}, actual ${config.version}`);
    error.code = "VERSION_CONFLICT";
    error.expectedVersion = expectedVersion;
    error.actualVersion = config.version;
    throw error;
  }
}

function nextRootVersion(config) {
  return number(config.version, 1, 1) + 1;
}

function confirmModels(value, candidates, options) {
  const opts = isObject(options) ? options : {};
  const config = normalizeV2Config(value);
  assertCas(config, opts.expectedVersion);
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const models = config.supplierModels.slice();
  list.forEach((candidate) => {
    const item = isObject(candidate) ? candidate : { modelId: candidate, providerKey: opts.providerKey };
    const providerKey = providerKeyOf(item, opts.providerKey);
    const modelId = modelIdOf(item, opts.modelId);
    if (!providerKey || !modelId) return;
    const key = modelKey(providerKey, modelId);
    const index = models.findIndex((model) => modelKey(model.providerKey, model.modelId) === key);
    const current = index >= 0 ? models[index] : normalizeSupplierModel({ providerKey, modelId }, key, opts);
    if (!current) return;
    const updated = Object.assign({}, current, {
      confirmed: true,
      confirmedAt: current.confirmedAt || nowValue(opts),
      confirmedBy: text(item.confirmedBy || opts.confirmedBy, "admin"),
      version: number(current.version, 1, 1) + 1,
      capabilities: normalizeCapabilities(item.capabilities || current.capabilities),
      sourceHash: text(item.sourceHash, current.sourceHash || hashSource(item))
    });
    if (index >= 0) models[index] = updated;
    else models.push(updated);
  });
  config.supplierModels = dedupeBy(models, (item) => modelKey(item.providerKey, item.modelId), mergeModel);
  config.version = nextRootVersion(config);
  return normalizeV2Config(config);
}

function transitionBinding(value, change, options) {
  const opts = isObject(options) ? options : {};
  const config = normalizeV2Config(value);
  assertCas(config, opts.expectedVersion);
  const request = isObject(change) ? change : { slot: change };
  const slot = canonicalSlot(request.slot);
  const role = canonicalRole(request.role);
  if (!slot) {
    const error = new Error("无效功能槽位");
    error.code = "INVALID_SLOT";
    throw error;
  }
  const index = config.bindings.findIndex((item) => item.slot === slot && item.role === role);
  const previous = index >= 0 ? config.bindings[index] : normalizeBinding({ slot, role }, {
    suppliersByKey: Object.fromEntries(config.suppliers.map((item) => [item.providerKey, item])),
    modelsByKey: Object.fromEntries(config.supplierModels.map((item) => [modelKey(item.providerKey, item.modelId), item]))
  });
  const nextProvider = Object.prototype.hasOwnProperty.call(request, "providerKey")
    ? text(request.providerKey)
    : providerKeyOf(request, previous && previous.providerKey);
  const nextModel = Object.prototype.hasOwnProperty.call(request, "modelId")
    ? text(request.modelId)
    : modelIdOf(request, previous && previous.modelId);
  const desired = canonicalStatus(request.status, previous && previous.status || "not-ready");
  const suppliers = Object.fromEntries(config.suppliers.map((item) => [item.providerKey, item]));
  const models = Object.fromEntries(config.supplierModels.map((item) => [modelKey(item.providerKey, item.modelId), item]));
  const model = models[modelKey(nextProvider, nextModel)];
  const supplier = suppliers[nextProvider];
  if (desired === "ready" && (!supplier || supplier.enabled === false || !model || !model.confirmed)) {
    const error = new Error("绑定必须引用已确认且可用的供应商模型");
    error.code = "BINDING_NOT_READY";
    throw error;
  }
  if (desired === "ready" && previous && previous.status === "not-ready" && !request.confirmed) {
    const error = new Error("未确认的空槽不能直接启用");
    error.code = "BINDING_CONFIRM_REQUIRED";
    throw error;
  }
  const updated = normalizeBinding(Object.assign({}, previous || {}, request, {
    slot,
    role,
    providerKey: nextProvider,
    modelId: nextModel,
    status: desired,
    confirmedAt: desired === "ready" ? (request.confirmedAt || nowValue(opts)) : request.confirmedAt,
    confirmedBy: desired === "ready" ? text(request.confirmedBy || opts.confirmedBy, "admin") : request.confirmedBy,
    version: number(previous && previous.version, 1, 1) + 1
  }), { suppliersByKey: suppliers, modelsByKey: models }, opts);
  if (index >= 0) config.bindings[index] = updated;
  else config.bindings.push(updated);
  config.version = nextRootVersion(config);
  return normalizeV2Config(config);
}

function runtimeReadyBinding(config, binding) {
  if (!binding || binding.status !== "ready") return null;
  const supplier = config.suppliers.find((item) => item.providerKey === binding.providerKey);
  const model = config.supplierModels.find((item) => modelKey(item.providerKey, item.modelId) === modelKey(binding.providerKey, binding.modelId));
  if (!supplier || supplier.enabled === false || !model || !model.confirmed) return null;
  return Object.assign({}, binding, {
    supplier: Object.assign({}, supplier, { auth: Object.assign({}, supplier.auth, { credentialRef: supplier.auth && supplier.auth.credentialRef || "" }) }),
    model: Object.assign({}, model)
  });
}

function resolveBinding(value, slot, role, options) {
  const config = normalizeV2Config(value);
  const canonical = canonicalSlot(slot);
  const requestedRole = canonicalRole(role);
  const binding = config.bindings.find((item) => item.slot === canonical && item.role === requestedRole) || null;
  const ready = runtimeReadyBinding(config, binding);
  return {
    slot: canonical,
    role: requestedRole,
    status: ready ? "ready" : binding ? binding.status : "not-ready",
    binding: ready,
    providerKey: ready ? ready.providerKey : binding && binding.providerKey || "",
    modelId: ready ? ready.modelId : binding && binding.modelId || "",
    usable: Boolean(ready)
  };
}

function resolveFailover(value, slot, context) {
  const config = normalizeV2Config(value);
  const canonical = canonicalSlot(slot);
  const state = isObject(context) ? context : {};
  const primary = resolveBinding(config, canonical, "primary");
  const backup = resolveBinding(config, canonical, "backup");
  const primaryFailed = Boolean(state.primaryFailed || state.failed || state.error);
  const alreadySwitched = Boolean(state.fallbackUsed || state.switched || state.attemptedBackup || state.attempts >= 2);
  if (!primaryFailed && primary.usable) {
    return { slot: canonical, selected: primary.binding, binding: primary.binding, role: "primary", switched: false, fallbackUsed: false, exhausted: false };
  }
  if (primaryFailed && !alreadySwitched && backup.usable) {
    return { slot: canonical, selected: backup.binding, binding: backup.binding, role: "backup", switched: true, fallbackUsed: true, exhausted: false };
  }
  return {
    slot: canonical,
    selected: primaryFailed ? null : primary.binding,
    binding: primaryFailed ? null : primary.binding,
    role: primaryFailed ? "none" : "primary",
    switched: false,
    fallbackUsed: alreadySwitched,
    exhausted: primaryFailed,
    reason: primaryFailed ? (alreadySwitched ? "same-slot-fallback-already-used" : "no-ready-same-slot-backup") : "primary-not-ready"
  };
}

function supplierReferences(value, providerKey) {
  const config = normalizeV2Config(value);
  const bindings = config.bindings.filter((item) => item.providerKey === providerKey);
  const models = config.supplierModels.filter((item) => item.providerKey === providerKey);
  const adapters = config.costAdapters.filter((item) => item.providerKey === providerKey);
  return { bindings, models, adapters };
}

function canDeleteSupplier(value, providerKey) {
  const key = text(providerKey);
  const refs = supplierReferences(value, key);
  /* 只要绑定记录指向该供应商就阻断，哪怕模型暂时为空/待确认。 */
  const blockingBindings = refs.bindings.filter((item) => item.providerKey === key);
  return {
    allowed: blockingBindings.length === 0,
    providerKey: key,
    references: refs,
    blocking: blockingBindings,
    reason: blockingBindings.length ? "PROVIDER_REFERENCED" : "OK"
  };
}

function isSupplierDeletable(value, providerKey) {
  return canDeleteSupplier(value, providerKey).allowed;
}

function applySupplierMutation(value, mutation, options) {
  const opts = isObject(options) ? options : {};
  const config = normalizeV2Config(value);
  const request = isObject(mutation) ? mutation : {};
  assertCas(config, request.expectedVersion !== undefined ? request.expectedVersion : opts.expectedVersion);
  const action = text(request.action || request.type, "update").toLowerCase();
  const supplierInput = isObject(request.supplier) ? request.supplier : request;
  const key = providerKeyOf(supplierInput, request.providerKey);
  const index = config.suppliers.findIndex((item) => item.providerKey === key);
  if (action === "delete" || action === "remove") {
    if (index >= 0 && config.suppliers[index].protected) {
      const error = new Error(`内置供应商不可删除：${key}`);
      error.code = "PROVIDER_PROTECTED";
      throw error;
    }
    const guard = canDeleteSupplier(config, key);
    if (!guard.allowed) {
      const error = new Error(`供应商仍被功能绑定：${key}`);
      error.code = "PROVIDER_REFERENCED";
      error.references = guard.references;
      throw error;
    }
    if (index >= 0) config.suppliers.splice(index, 1);
    config.supplierModels = config.supplierModels.filter((item) => item.providerKey !== key);
    config.costAdapters = config.costAdapters.filter((item) => item.providerKey !== key);
  } else if (action === "create" || action === "add") {
    if (!key) {
      const error = new Error("新增供应商必须提供不可变 providerKey");
      error.code = "PROVIDER_KEY_REQUIRED";
      throw error;
    }
    if (index >= 0) {
      const error = new Error(`供应商已存在：${key}`);
      error.code = "PROVIDER_EXISTS";
      throw error;
    }
    const created = normalizeSupplier(supplierInput, key, opts);
    if (!created) throw new Error("供应商数据无效");
    config.suppliers.push(created);
  } else if (action === "reorder" || request.order) {
    const order = Array.isArray(request.order) ? request.order.map((item) => text(item)).filter(Boolean) : [];
    const byKey = Object.fromEntries(config.suppliers.map((item) => [item.providerKey, item]));
    const reordered = [];
    order.forEach((item) => { if (byKey[item]) { reordered.push(byKey[item]); delete byKey[item]; } });
    Object.keys(byKey).forEach((item) => reordered.push(byKey[item]));
    config.suppliers = reordered.map((item, position) => Object.assign({}, item, { sortOrder: position }));
  } else {
    if (action === "update" && request.supplier && request.providerKey
      && request.supplier.providerKey && request.supplier.providerKey !== request.providerKey) {
      const error = new Error("providerKey 创建后不可修改");
      error.code = "PROVIDER_KEY_IMMUTABLE";
      throw error;
    }
    if (index < 0) {
      const error = new Error(`供应商不存在：${key}`);
      error.code = "PROVIDER_NOT_FOUND";
      throw error;
    }
    const current = config.suppliers[index];
    const requestedKey = text(supplierInput.providerKey || request.providerKey, current.providerKey);
    if (requestedKey !== current.providerKey) {
      const error = new Error("providerKey 创建后不可修改");
      error.code = "PROVIDER_KEY_IMMUTABLE";
      throw error;
    }
    const updated = normalizeSupplier(Object.assign({}, current, supplierInput, { providerKey: current.providerKey }), current.providerKey, opts);
    config.suppliers[index] = Object.assign({}, updated, { version: number(current.version, 1, 1) + 1 });
  }
  config.version = nextRootVersion(config);
  return normalizeV2Config(config);
}

function computePixelPolicy(input, probes) {
  const source = isObject(input) ? input : {};
  const providerKey = text(source.providerKey);
  const modelId = text(source.modelId || source.model);
  const path = text(source.path, "");
  /*
   * 第二个参数是服务端已保存的探针数组，或带 probes/serverPolicy 的服务端
   * 上下文。input.allowed、input.adapterProfile 以及 input.serverAllowedPaths
   * 都是不可信的客户端字段，绝不参与决策。
   */
  const serverContext = isObject(probes) && !Array.isArray(probes) ? probes : {};
  const probeList = Array.isArray(probes)
    ? probes
    : Array.isArray(serverContext.probes)
      ? serverContext.probes
      : Array.isArray(serverContext.safetyProbes) ? serverContext.safetyProbes : [];
  const serverPolicy = isObject(serverContext.serverPolicy) ? serverContext.serverPolicy : {};
  const allowedPaths = Array.isArray(serverPolicy.allowedPaths) ? serverPolicy.allowedPaths : null;
  const matching = probeList.filter((item) => item && item.providerKey === providerKey && item.modelId === modelId && item.path === path);
  const probe = matching.find((item) => item.result === "pass" && item.serverVerified === true) || null;
  const pathAllowed = allowedPaths ? allowedPaths.includes(path) : true;
  const allowed = Boolean(path && probe && pathAllowed);
  return {
    allowed,
    trusted: true,
    providerKey,
    modelId,
    path,
    reason: allowed ? "server-probe-pass" : (probe ? "path-not-allowed" : "server-probe-required"),
    probeResult: probe ? probe.result : "unknown",
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = {
  SCHEMA_VERSION,
  SLOTS,
  SLOT_LABELS,
  SLOT_GROUPS,
  SLOT_ALIASES,
  VALID_ROLES,
  VALID_STATUSES,
  VALID_PHASES,
  TC3_DEFAULT,
  emptyV2Config,
  normalizeSupplier,
  normalizeSupplierModel,
  normalizeBinding,
  normalizeCostAdapter,
  normalizeSafetyProbe,
  normalizeMigrationState,
  normalizeDependency,
  normalizeV2Config,
  migrateLegacyToV2,
  validateV2Config,
  isValidV2Config,
  confirmModels,
  transitionBinding,
  resolveBinding,
  resolveFailover,
  canDeleteSupplier,
  isSupplierDeletable,
  applySupplierMutation,
  computePixelPolicy,
  bindingKey,
  modelKey,
  canonicalSlot,
  canonicalRole,
  canonicalStatus,
  sanitizeSecrets,
  stableSerialize,
  hashSource,
  /* 兼容 API/页面调用方的别名。 */
  confirmAdminModels: confirmModels,
  saveBinding: transitionBinding,
  resolveEffectiveBinding: resolveBinding,
  resolveProviderFailover: resolveFailover,
  deleteSupplierGuard: canDeleteSupplier,
  mutateSupplier: applySupplierMutation,
  serverPixelPolicy: computePixelPolicy
};
