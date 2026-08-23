# 本地人脸 WASM buffer 构造器主路线设计

日期：2026-08-23
任务：T-20260822-143938-01

## 目标

修复微信开发者工具和真机都无法启动本地 MediaPipe 人脸识别的问题。

当前已确认：

- `WXWebAssembly.instantiate(Uint8Array|ArrayBuffer)` 在当前环境被拒绝；
- `WXWebAssembly.instantiate(http://...|wxfile://...)` 在当前环境被拒绝；
- 代码包内放入 11MB WASM 会触发 `80051` 体积限制；
- CloudBase 下载到用户缓存目录后，仍需要使用内存二进制构造器；
- `WXWebAssembly.Module` 和 `WXWebAssembly.Instance` 可能是可用的兼容入口，但必须用真实 WASM 和 Emscripten imports 验证，不能只依赖 8 字节空模块探针。

## 方案

### 1. 资源流转

1. WASM 继续从 CloudBase 下载；
2. 写入并读取用户缓存，保留现有缓存和分块读取逻辑；
3. MediaPipe loader 的 `instantiateWasm(imports, successCallback)` 收到 imports 后：
   - 把缓存得到的 `Uint8Array` 转成当前 Realm 的精确 `ArrayBuffer`；
   - 使用 `new WXWebAssembly.Module(arrayBuffer)` 创建真实模块；
   - 使用 `new WXWebAssembly.Instance(module, imports)` 创建真实实例；
   - 将实例和模块通过 Emscripten 的 `successCallback(instance, module)` 返回；
   - 同时返回 Promise，兼容当前 bundle 的异步初始化流程。

### 2. 路线选择

- buffer 构造器是正式主路线；
- 路径探针仅保留为诊断和兼容记录，不再优先选择；
- `WXWebAssembly.instantiate` 保留为明确兼容回退，但不能把失败的 buffer instantiate 当作构造器失败；
- 如果真实构造器也失败，状态必须保留完整错误、imports 摘要、模块/实例阶段和运行环境信息，然后进入手动圈选/云端识别降级。

### 3. 诊断日志

增加以下信息：

- `wasm-constructor-start`
- `wasm-constructor-module-result`
- `wasm-constructor-instance-result`
- `wasm-constructor-reject`
- `wasm-instantiate-start/result/reject` 中记录 `wasmMode=constructor`、真实字节数和 imports 摘要；
- 继续保留 `wasm-cap-probe-*`，但将“构造器可用”和“真实 MediaPipe 初始化成功”分开记录。

## 测试

### 本地协议测试

- `Module(ArrayBuffer)` 能创建真实最小模块；
- `Instance(module, imports)` 能使用非空 imports 创建带导入函数的 WASM；
- 真实 WASM 走构造器时，imports 不被清空；
- ArrayBuffer 的 `byteOffset` 和 `byteLength` 被正确裁剪；
- 同步抛错、Promise reject、回调成功和 callback+Promise 双重回调只结算一次。

### 集成验证

- `node --check`
- `node scripts/validate.js`
- `node scripts/compat-smoke.js`
- 开发者工具模拟器：复制完整 `local-face` 日志，确认进入 `mediapipe-init`；
- 真机：确认进入 `runtime-ready` 或得到明确的构造器拒绝原因。

## 降级与回滚

- 构造器失败时不删除已下载缓存；
- 保留手动圈选；
- 不再尝试把大 WASM 放进代码包；
- 若真机明确不支持构造器，则保留诊断实现，切换云端人脸检测作为正式产品兜底；
- 回滚只需恢复 `local-face.js`、兼容测试和版本/打包文件。

## 验收标准

至少满足以下一项才算本地路线修复：

1. 模拟器或真机日志出现 `wasmMode=constructor`、`wasm-constructor-instance-result`、`mediapipe-init`；
2. 之后出现 `runtime-ready`，并能完成一次主图人脸识别。

只有本地单元测试通过、没有运行时证据时，不宣称已修复。
