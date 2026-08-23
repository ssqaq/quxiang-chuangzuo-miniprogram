const POSE_CATEGORIES = ["侧身", "回头", "手部", "肩颈", "坐姿", "全身", "其他"];
const POSE_PLATFORMS = ["社交平台照片", "商品展示", "电商模特", "头像写真"];
const POSE_INTENSITIES = ["轻微调整", "正常调整", "明显换姿势"];
const POSE_DIRECTIONS = ["自然", "显瘦", "小红书", "电商"];

const DIRECTION_RULES = {
  自然: "以自然抓拍为主，肩膀放松，动作幅度小，眼神和身体状态像真实照片。",
  显瘦: "只通过轻微侧身、重心和镜头角度显得利落，不改变真实身材比例，不做瘦身修图。",
  小红书: "偏竖屏社交平台照片，动作轻松、有生活感，眼神和手部动作自然，不摆夸张姿势。",
  电商: "动作清楚、身体线条利落，方便看清人物或商品，不遮挡重点，不做夸张转身。"
};

const PLATFORM_RULES = {
  社交平台照片: "适合真实社交平台照片：自然、轻松、像随手拍。",
  商品展示: "适合商品展示：动作不能遮住商品，主体要清楚，姿势变化要克制。",
  电商模特: "适合电商模特：站姿和手部动作要清楚，身体线条利落，不能让重点被遮挡。",
  头像写真: "适合头像写真：优先脸部、肩颈和眼神，不凭空改变看不见的手脚。"
};

function compactText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeWebPoseSuggestion(value) {
  if (!value || typeof value !== "object") return null;
  const id = Number(value.id);
  const title = compactText(value.title, 40);
  const description = compactText(value.description, 320);
  if (!Number.isInteger(id) || id < 1 || id > 8 || title.length < 2 || description.length < 12) {
    return null;
  }
  return {
    id,
    title,
    description,
    category: POSE_CATEGORIES.includes(value.category) ? value.category : "其他",
    tags: Array.isArray(value.tags)
      ? value.tags.map((item) => compactText(item, 20)).filter(Boolean).slice(0, 5)
      : [],
    unsuitableReason: compactText(value.unsuitableReason, 180),
    intensity: POSE_INTENSITIES.includes(value.intensity) ? value.intensity : "正常调整",
    platform: POSE_PLATFORMS.includes(value.platform) ? value.platform : "社交平台照片",
    direction: POSE_DIRECTIONS.includes(value.direction) ? value.direction : "自然"
  };
}

function normalizeWebPoseSuggestions(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.poses)
      ? value.poses
      : null;
  if (!source || source.length !== 8) return [];
  const suggestions = source.map(normalizeWebPoseSuggestion);
  if (
    suggestions.some((item) => !item)
    || new Set(suggestions.map((item) => item.id)).size !== 8
    || new Set(suggestions.map((item) => `${item.title}\n${item.description}`)).size !== 8
  ) {
    return [];
  }
  return suggestions.sort((left, right) => left.id - right.id);
}

function removeWebPosePromptBlock(prompt) {
  return String(prompt || "")
    .replace(/\s*【网感姿势授权开始】[\s\S]*?【网感姿势授权结束】\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildWebPosePromptBlock(suggestion) {
  const pose = normalizeWebPoseSuggestion(suggestion);
  if (!pose) return "";
  const directionRule = DIRECTION_RULES[pose.direction] || DIRECTION_RULES.自然;
  const platformRule = PLATFORM_RULES[pose.platform] || PLATFORM_RULES.社交平台照片;
  const safety = pose.intensity === "明显换姿势"
    ? "这是明显换姿势，可能需要调整红圈外的身体朝向；如果本轮只允许改红圈内，请改用轻微或正常调整。"
    : "只在原图可见范围内做姿势调整，不凭空补出被裁掉或被遮挡的手脚。";
  return [
    "【网感姿势授权开始】",
    `目标平台：${pose.platform}；分析方向：${pose.direction}；调整幅度：${pose.intensity}。`,
    `动作标准：${directionRule}`,
    `场景标准：${platformRule}`,
    `采用“${pose.title}”：${pose.description}`,
    `边界提醒：${safety}`,
    "本条授权替代原提示词中“姿态保持不变”的要求；人物身份、服装、背景、构图边界及其他未授权内容仍保持不变。",
    "【网感姿势授权结束】"
  ].join("\n");
}

function appendWebPosePromptBlock(prompt, suggestion) {
  const base = removeWebPosePromptBlock(prompt);
  const block = buildWebPosePromptBlock(suggestion);
  return [base, block].filter(Boolean).join("\n\n");
}

module.exports = {
  POSE_CATEGORIES,
  normalizeWebPoseSuggestion,
  normalizeWebPoseSuggestions,
  removeWebPosePromptBlock,
  buildWebPosePromptBlock,
  appendWebPosePromptBlock
};
