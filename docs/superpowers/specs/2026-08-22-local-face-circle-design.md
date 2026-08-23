# 本地自动贴脸兼容方案

## 目标

让微信小程序的“红圈自动贴脸”不再调用 `detectFaceCircle` 云函数，不读取 `AI_API_KEY`，而是在设备本地复用桌面端的 `face_landmarker.task`、MediaPipe FaceLandmarker 和“脸部轮廓 → 红圈坐标”算法。

## 已确认事实

1. 小程序当前 `autoFaceCircle()` 先上传主图，再调用 `cloud.detectFaceCircle()`；云函数因此检查 `AI_API_KEY`。
2. 桌面端已经使用 `FaceLandmarker.FACE_LANDMARKS_FACE_OVAL`，按脸部轮廓点计算外接框，再放大和限制到原图边界。
3. 桌面端的 `face_landmarker.task`、MediaPipe vision bundle 和 WASM 资源都能从源码包提取。
4. 微信小程序支持 `wx.createOffscreenCanvas({ type: "webgl" })`，可作为 MediaPipe Tasks 的 WebGL 输入画布。

## 方案

### 运行时

- 新增 `utils/local-face.js`，只负责本地资源加载、FaceLandmarker 初始化、图片输入和结果归一化。
- 运行时缓存单例，第一次点击初始化，后续点击复用同一个模型实例。
- 使用 `@mediapipe/tasks-vision` 的独立 CommonJS bundle，避免直接依赖桌面端带 DOM 的 Electron bundle。
- 使用 `wx.createOffscreenCanvas({ type: "webgl" })` 和 `canvas.createImage()` 读取小程序临时图片路径。

### 算法

- 复用桌面端 `FACE_LANDMARKS_FACE_OVAL` 索引。
- 每张脸取轮廓点的最小/最大 x、y。
- 生成桌面端同样的主圈和较紧的 snap 圈；小程序自动贴脸默认使用主圈，保证与原有手动圈选尺寸一致。
- 返回小程序已有 `selectFaceForCircle()` 能理解的 `{ x, y, width, height, confidence }` 结构。

### 页面接入

- `autoFaceCircle()` 只调用本地适配器。
- 不再执行 `prepareCloudAssets()`、`cloud.detectFaceCircle()` 和 API Key 检查。
- 本地识别失败、设备不支持 WebGL、资源加载失败或没有检测到人脸时，提示“请改用手动圈选”，不阻塞主图上传、AI 分析主图、参考网感分析和生图。
- 保留 `analysisAction === "faceCircle"` 的按钮防重复点击。

### 资源与兼容

- 复制 `face_landmarker.task`、`vision_wasm_internal.wasm`、WASM loader 和 vision bundle 到小程序工程。
- 资源加载提供明确错误信息；如果开发者工具报告包体限制，再把同一组资源移到 CloudBase 静态资源/文件下载缓存，算法和页面接口不变。
- 不把 `selfie_multiclass_256x256.tflite` 带入小程序，因为自动贴脸只需要脸部轮廓，不需要桌面端后续的面部分割。

## 验证计划

1. `node --check` 检查新增适配器和页面 JS。
2. 运行项目现有 `validate.js`、`compat-smoke.js`、`image-smoke.js`。
3. 开发者工具编译，确认资源没有被错误当作 WXML/WXSS 解析。
4. 使用一张正面人像验证：无云端 API Key 时点击自动贴脸能得到红圈。
5. 使用多人脸、侧脸和无脸图片验证：失败有明确提示，手动圈选仍可用。
6. 真机验证首次初始化、第二次复用、按钮防重复点击和页面返回。

## 风险与回退

- WebGL、WASM 或模型资源在某些老设备不可用：自动贴脸回退手动圈选，不影响其他功能。
- 首次加载模型会比桌面端慢：只在点击时初始化并缓存，不在启动页预加载。
- 资源包体可能超过主包限制：优先放入分包；若仍超限，改为 CloudBase 文件缓存下载，仍不需要 AI API Key。
