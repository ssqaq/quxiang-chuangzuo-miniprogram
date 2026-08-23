const LOCKED_ELEMENTS = [
  "不改变红圈外背景",
  "不改变红圈外头发",
  "不改变发丝边缘",
  "不改变衣服",
  "不改变身体姿势",
  "不改变手部",
  "不改变道具",
  "不改变构图",
  "不改变镜头焦距",
  "不改变图片比例",
  "不改变整体画质",
  "不改变原图光影环境",
  "不改变红圈外任何人物或物体"
];

function compact(value, fallback, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length <= limit ? text : `${text.slice(0, limit).replace(/[，。；、\s]+$/, "")}。`;
}

function getPrimaryFace(faces) {
  return (faces || []).find((item) => item.isPrimary) || (faces || [])[0] || null;
}

function buildPrompt(project) {
  const faces = project.faceRefs || [];
  const wardrobe = project.wardrobeRefs || [];
  const primary = getPrimaryFace(faces);
  const scene = compact(
    project.sceneDescription,
    "沿用主图现有场景、背景、构图、拍摄氛围和真实照片质感。",
    140
  );
  const pose = compact(
    project.poseDescription,
    "沿用主图人物的身体方向、肩颈关系、手部位置和镜头距离。",
    150
  );
  const faceState = compact(
    project.faceDirectionDescription,
    "匹配红圈内原人物的头部角度、视线、表情和嘴唇状态。",
    150
  );
  const light = compact(
    project.lightingMakeupDescription,
    "匹配原脸部的光源方向、阴影、高光、肤色反射、毛孔、噪点和清晰度。",
    220
  );
  const primaryName = primary ? compact(primary.name, "主参考图", 80) : "";

  const sections = [
    "【编辑目标】\n以主图为唯一画面底板，把红圈内的人脸替换成授权参考人物；红圈标记本身不能出现在成片中。",
    `【身份素材】\n${
      primary
        ? `人脸身份以“${primaryName}”为主基准${
            faces.length > 1 ? `，并综合其余 ${faces.length - 1} 张素材的稳定五官特征` : ""
          }；忽略参考素材里的背景、服装、光线与拍摄角度。`
        : "尚未提供人脸参考素材；执行前应补充至少一张清晰人脸图片。"
    }`,
    `【原图匹配】\n场景：${scene}\n姿态：${pose}\n面部状态：${faceState}\n光影与质感：${light}`
  ];

  if (wardrobe.length) {
    const mappings = wardrobe.map((item, index) => {
      const kind = item.kind === "accessory" ? "配饰" : "衣物";
      const focus = (item.tags || []).join("、") || "款式、颜色、材质、比例和细节";
      const note = item.note ? `；备注：${item.note}` : "";
      const name = compact(item.name, `第${index + 1}张`, 80);
      return `${index + 1}. “${name}”是${kind}素材，只替换“${
        item.target || "对应位置"
      }”，重点匹配${focus}${note}。`;
    });
    sections.push(
      `【穿搭映射】\n${mappings.join(
        "\n"
      )}\n服饰必须适应原人物姿态、透视、褶皱、重力与遮挡；未指定的服饰和道具保持原样。`
    );
  }

  const custom = (project.customLockedElements || [])
    .map((item) => String(item).trim())
    .filter(Boolean)
    .join("；");
  sections.push(
    `【合成与边界】\n可改动范围仅为红圈内人脸${
      wardrobe.length ? "以及上面逐项指定的穿搭目标" : ""
    }。新脸要服从原头部角度、透视、表情和环境光，边缘自然衔接，保留真实皮肤与原始画质。区域外的背景、头发、身体、手部、人物位置、构图、颜色、噪点和可见范围不得重绘、移动、增删或裁切。${
      custom ? `额外锁定：${custom}。` : ""
    }`
  );
  const locks = (project.lockedElements || LOCKED_ELEMENTS).filter(Boolean);
  if (locks.length) {
    sections.push(`【固定保护】\n${locks.map((item) => `- ${item}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

function buildNegativePrompt(project) {
  const constraints = [
    "禁止改动授权区域以外的像素内容",
    "禁止贴脸感、断边、五官漂移、比例异常或肤色光影不一致",
    "禁止过度磨皮、塑料皮、虚假高清、插画感和明显 AI 痕迹",
    "禁止裁切、扩边、留白、改变方向或长宽比"
  ];
  if ((project.wardrobeRefs || []).length) {
    constraints.push(
      "人脸参考和穿搭参考不得混用",
      "禁止服装悬空、穿模、平面贴图、错误褶皱或错误遮挡",
      "禁止增加未指定的服装、配饰、文字、图案或标识"
    );
  }
  return Array.from(
    new Set(
      constraints.concat(
        (project.customLockedElements || []).map((item) => String(item).trim()).filter(Boolean)
      )
    )
  ).join("；");
}

module.exports = {
  LOCKED_ELEMENTS,
  buildPrompt,
  buildNegativePrompt
};
