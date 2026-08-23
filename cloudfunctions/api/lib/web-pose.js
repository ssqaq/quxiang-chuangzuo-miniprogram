const POSE_CATEGORIES = ["侧身", "回头", "手部", "肩颈", "坐姿", "全身", "其他"];

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
    direction: "自然",
    intensity: "正常调整",
    platform: "社交平台照片"
  };
}

function normalizeWebPoseSuggestions(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.poses)
      ? value.poses
      : null;
  if (!source || source.length !== 8) return null;
  const suggestions = source.map(normalizeWebPoseSuggestion);
  if (
    suggestions.some((item) => !item)
    || new Set(suggestions.map((item) => item.id)).size !== 8
    || new Set(suggestions.map((item) => `${item.title}\n${item.description}`)).size !== 8
  ) {
    return null;
  }
  return suggestions.sort((left, right) => left.id - right.id);
}

module.exports = {
  normalizeWebPoseSuggestion,
  normalizeWebPoseSuggestions
};
