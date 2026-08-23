const ISSUE_GROUPS = [
  {
    key: "face",
    title: "人脸",
    items: [
      ["identity", "身份"],
      ["lighting", "光影"],
      ["skinTone", "肤色"],
      ["gaze", "眼神"],
      ["angle", "角度"],
      ["edge", "边缘"],
      ["features", "五官"],
      ["hair", "头发"]
    ]
  },
  {
    key: "background",
    title: "背景",
    items: [
      ["outsideChanged", "红圈外内容被改动"],
      ["background", "背景"],
      ["composition", "构图"]
    ]
  },
  {
    key: "wardrobe",
    title: "衣服",
    items: [
      ["clothing", "衣服"],
      ["garment", "衣物"],
      ["accessories", "配饰"],
      ["穿模", "穿模"]
    ]
  },
  {
    key: "quality",
    title: "画质",
    items: [
      ["makeup", "妆容"],
      ["skinTexture", "皮肤质感"],
      ["beauty", "过度美颜"]
    ]
  }
];

const DEFAULT_ISSUE_KEYS = ["outsideChanged"];

function createIssueOptions(hasWardrobe) {
  return ISSUE_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    items: group.items
      .filter((item) => hasWardrobe || !["garment", "accessories", "穿模"].includes(item[0]))
      .map(([key, label]) => ({
        key,
        label,
        checked: DEFAULT_ISSUE_KEYS.includes(key)
      }))
  })).filter((group) => group.items.length);
}

function normalizeIssueKeys(keys, hasWardrobe) {
  const allowed = createIssueOptions(hasWardrobe)
    .reduce((all, group) => all.concat(group.items.map((item) => item.key)), []);
  const result = Array.from(new Set(
    (Array.isArray(keys) ? keys : [])
      .map((key) => String(key || "").trim())
      .filter((key) => allowed.includes(key))
  ));
  if (!result.length) return DEFAULT_ISSUE_KEYS.slice();
  if (!result.includes("outsideChanged")) result.unshift("outsideChanged");
  return result;
}

function createSelectableIssueOptions(hasWardrobe, keys) {
  const selected = new Set(normalizeIssueKeys(keys, hasWardrobe));
  return createIssueOptions(hasWardrobe).map((group) => Object.assign({}, group, {
    items: group.items.map((item) => Object.assign({}, item, {
      checked: selected.has(item.key)
    }))
  }));
}

function canRepairRecord(record, cloudReady = true, maxRevisions = 10) {
  const id = String(record && (record.id || record._id) || "").trim();
  const revision = Math.max(0, Number(record && record.revisionNumber) || 0);
  return Boolean(
    cloudReady
    && id
    && !id.startsWith("local-")
    && record
    && !record.isTombstone
    && record.fileID
    && revision < Math.max(1, Number(maxRevisions) || 10)
  );
}

function issueLabel(key) {
  for (const group of ISSUE_GROUPS) {
    const match = group.items.find((item) => item[0] === key);
    if (match) return match[1];
  }
  return String(key || "");
}

function buildRepairPrompt({
  projectName,
  issues,
  hasFaceReferences,
  hasWardrobeReferences,
  maskGeometry
} = {}) {
  const issueKeys = normalizeIssueKeys(issues, hasWardrobeReferences);
  const labels = issueKeys.map(issueLabel).filter(Boolean);
  const region = maskGeometry && maskGeometry.width && maskGeometry.height
    ? `本次红圈区域约为 x=${Math.round(maskGeometry.x || 0)}、y=${Math.round(maskGeometry.y || 0)}、宽=${Math.round(maskGeometry.width)}、高=${Math.round(maskGeometry.height)}。`
    : "以本次重新确认的红圈 mask 为唯一可编辑范围。";
  const lines = [
    "【局部修正】",
    `项目：${String(projectName || "未命名项目").trim()}`,
    `本次只处理：${labels.join("、")}。`,
    region,
    "以当前结果图为底板，只修正红圈内与所选问题直接相关的内容；红圈外所有像素、人物位置、背景、构图、比例、镜头和画质必须保持不变。",
    hasFaceReferences
      ? "如涉及人脸，优先参考已选人脸素材，但必须服从当前结果图的头部角度、表情、光影、肤色和边缘。"
      : "没有新增人脸参考素材时，只在当前结果图基础上修正，不改变人物身份。",
    hasWardrobeReferences
      ? "如涉及衣物或配饰，只使用已选穿搭参考，不新增未指定的衣服、配饰、文字或图案。"
      : "没有穿搭参考时，不修改衣服、配饰和身体。",
    "红圈外内容被改动是强制保护项；禁止裁切、扩边、重绘未圈选区域、过度美颜、塑料皮和明显 AI 痕迹。"
  ];
  return lines.join("\n");
}

module.exports = {
  ISSUE_GROUPS,
  DEFAULT_ISSUE_KEYS,
  createIssueOptions,
  createSelectableIssueOptions,
  normalizeIssueKeys,
  canRepairRecord,
  issueLabel,
  buildRepairPrompt
};
