# Device Page Tasks

## Goal

Implement the device page capabilities for automatic device scanning, grouping, status management, and displaying model, brand, and Android version information.

## Scope

- Automatically scan connected Android devices through ADB.
- Show device status clearly: online, offline, unauthorized, and unknown/error states where needed.
- Display device identity details: device ID, model, brand, Android version, and optional screen metadata.
- Support user-managed device groups.
- Persist device custom metadata such as display name, remark, and group assignment.
- Keep the renderer UI synchronized with main-process device state.

## Current Baseline

- `src/main/services/DeviceService.ts` already contains ADB-based scanning and detail lookup.
- `src/main/ipc/DeviceIpcHandler.ts` already exposes device IPC handlers.
- `src/renderer/src/services/DeviceServiceProxy.ts` already wraps device IPC calls.
- `src/renderer/src/pages/device/DevicePage.tsx` already renders device cards and has initial group/config persistence.
- Group creation/edit/delete exists, but grouped device rendering is incomplete.
- Some user-facing Chinese text appears garbled and should be cleaned while touching the device page.

## Tasks

### 1. Automatic Device Scanning

- [x] Confirm tool path initialization runs before device scanning.
- [x] Use bundled ADB first, then system ADB fallback.
- [x] Trigger an initial scan when the device page opens.
- [x] Refresh the device list on a configurable interval.
- [x] Add manual refresh with loading and error states.
- [x] Avoid unnecessary UI re-renders when scan results have not changed.
- [x] Handle empty device list with a clear empty state.
- [x] Handle ADB unavailable with a clear error message and recovery hint.

### 2. Device Status Management

- [x] Normalize ADB states into renderer-facing statuses.
- [x] Support at least `online`, `offline`, and `unauthorized`.
- [x] Add an `unknown` or error state only if scan failures need to be represented per device.
- [x] Display status with stable labels and visual tags.
- [x] Preserve devices that temporarily disappear only if product behavior requires it; otherwise remove them from the list on the next scan.
- [x] Add status-specific guidance for unauthorized devices.
- [x] Ensure status updates do not overwrite user metadata such as name, remark, or group.

### 3. Device Information Display

- [x] Read model from `ro.product.model`.
- [x] Read brand from `ro.product.brand`.
- [x] Read Android version from `ro.build.version.release`.
- [x] Optionally read screen size from `wm size`.
- [x] Optionally read density from `ro.sf.lcd_density`.
- [x] Display model, brand, and Android version on each device card.
- [x] Use sensible fallback text when a property is unavailable.
- [x] Avoid blocking the whole scan when one device property lookup fails.

### 4. Device Grouping

- [x] Keep group create, rename, and delete flows.
- [x] Persist groups in the existing config storage.
- [x] Persist each device group assignment with device metadata.
- [x] Add a real group assignment control instead of relying on free-text prompt matching.
- [x] Render devices under their assigned groups.
- [x] Render ungrouped devices in a separate section.
- [x] When deleting a group, move assigned devices back to ungrouped.
- [x] Ensure group operations work even when no devices are currently connected.

### 5. Device Metadata Persistence

- [x] Persist custom device title.
- [x] Persist custom device remark.
- [x] Persist group assignment.
- [x] Validate stored metadata shape before using it.
- [x] Keep metadata keyed by stable device ID.
- [x] Avoid losing metadata during scan refreshes.

### 6. UI And UX Polish

- [x] Replace garbled Chinese strings in the device page with i18n keys or clean text.
- [x] Keep all device actions visible and predictable on narrow screens.
- [x] Show last refresh time.
- [x] Show scanning progress without blocking existing device cards unnecessarily.
- [x] Make error modals/messages actionable.
- [x] Keep card layout stable when details are missing or loading.

### 7. Logging And Error Handling

- [x] Replace renderer `console.error` usage in device code with `loggerService` where project patterns allow it.
- [x] Keep main-process logging through `loggerService.withContext`.
- [x] Log scan failures with enough context to debug ADB/tool-path issues.
- [x] Do not log sensitive user data or arbitrary command payloads more than necessary.

### 8. Tests

- [x] Add unit tests for parsing ADB device output.
- [x] Add unit tests for status normalization.
- [x] Add unit tests for metadata validation and group deletion behavior.
- [x] Add renderer tests for empty, loading, error, grouped, and ungrouped states where practical.
- [x] Mock IPC/device services in renderer tests.

### 9. Verification

- [x] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [x] Run `pnpm format`.
- [ ] Run `pnpm build:check` before committing.
- [ ] Manually verify with no device connected.
- [ ] Manually verify with one authorized Android device connected.
- [ ] Manually verify with one unauthorized Android device connected if available.
- [ ] Manually verify group create, rename, delete, and assignment persistence after app restart.

### 10. Device Operation Behaviors

#### 10.1 P0 基础操作行为

- [x] 单点点击：按设备坐标执行 `tap`。
- [x] 滑动：按起止坐标执行 `swipe`。
- [x] 系统按键：返回、主页、菜单、电源。
- [x] 截图：优先 scrcpy 窗口截图，失败后回退 ADB 截图。
- [x] 长按：支持指定坐标和持续时间。
- [x] 双击：支持指定坐标和点击间隔。
- [x] 拖拽：支持从 A 点按住拖到 B 点。
- [x] 坐标百分比模式：支持 `50% 80%`，适配不同分辨率设备。
- [x] 多设备隔离：聊天指令在多设备在线时要求明确设备 ID。
- [x] scrcpy 窗口关闭后同步连接状态。
- [ ] 多设备实机验收：两台以上设备同时连接，确认不会串操作。

#### 10.2 P0 文本输入行为

- [x] ASCII 文本输入继续使用 ADB `input text`。
- [x] 非 ASCII 文本输入改为显式策略：检测 ADB Keyboard 输入桥。
- [x] 未安装 Unicode 输入桥时给出明确错误，不再静默乱码。
- [ ] 内置或引导安装 ADB Keyboard，以完成稳定中文输入闭环。
- [ ] 实机验收：在微信、浏览器搜索框、普通输入框验证中文输入。

#### 10.3 P1 操作行为

- [x] 启动应用：按包名启动。
- [x] 停止应用：按包名强制停止。
- [x] 重启应用：停止后重新启动。
- [x] 获取当前前台应用包名和 Activity。
- [x] 处理应用权限弹窗：允许、拒绝、仅本次允许。
- [x] 聊天指令结果进入消息流，而不仅是 toast。
- [ ] VLM 多步循环：观察、规划、执行、验证。

#### 10.4 P2 待开发操作行为

- [ ] 多点触控：双指缩放、双指滑动。
- [x] 批量任务队列：每台设备独立任务进度。
- [x] 批量任务暂停、继续、取消。
- [ ] 执行报告：截图、动作、结果、耗时。
- [x] 安全审计：记录设备动作、参数、结果和耗时。

### 11. DeerFlow + VLM + Batch Task Orchestration

#### 11.1 Feasibility Decision

- [x] 结论：可行，但采用“DeerFlow 编排层 + 本项目设备执行层”的集成方式。
- [x] DeerFlow 适合作为长任务规划、多 Agent 协作、技能系统、记忆、沙箱和执行追踪框架。
- [x] 本项目继续保留 Android 设备执行权：ADB、scrcpy 窗口截图、坐标映射、tap/swipe/drag/text/app 操作由 `DeviceService` 统一执行。
- [x] 不直接把 DeerFlow 沙箱进程接入真实手机控制权限，避免沙箱越权、设备串控和不可审计操作。
- [x] 先通过 DeerFlow HTTP/LangGraph API 或独立 Orchestrator Adapter 对接，不把 DeerFlow 后端硬嵌进 Electron 主进程。

#### 11.2 Architecture Tasks

- [x] 新增 `DeviceTaskOrchestrator`：统一管理任务定义、设备分配、队列状态、取消信号、执行日志。
- [x] 新增 `DeviceActionRuntime`：将高级动作转换为现有设备能力，如截图、VLM 识别、点击、滑动、输入、应用启动、权限弹窗处理。
- [x] 新增 `DeerFlowAdapter`：封装 DeerFlow 可选请求入口；服务不可用时不阻断本地执行。
- [ ] 定义 `DeviceSkill` 协议：向 DeerFlow 暴露受控技能，如 `observe_screen`、`tap`、`swipe`、`input_text`、`open_app`、`verify_state`。
- [x] 建立设备隔离上下文：每个队列任务必须绑定唯一 `deviceId`，所有截图、动作、日志和取消信号都按 `deviceId + taskId` 隔离。
- [ ] 建立执行权限边界：DeerFlow 只能返回结构化计划和动作请求，真实动作必须经过本项目 action validator。

#### 11.3 VLM Multi-Step Loop

- [x] 实现 Observe：按 `deviceId` 截取 scrcpy 单窗口画面，失败时回退 ADB 截图。
- [ ] 实现 Think/Plan：将目标、历史动作、当前截图、设备上下文提交给 VLM/DeerFlow，要求返回结构化 JSON。
- [x] 实现 Act：校验动作类型、设备绑定和基础参数后调用 `DeviceService`。
- [x] 实现 Verify：动作后重新截图并记录审计日志；语义化达成判断仍待增强。
- [ ] 支持最大步数、最大耗时、最大连续失败次数和模型 token/cost 预算。
- [x] 支持串行优先执行；并行执行仅允许不同 `deviceId` 的任务，且每台设备同一时间只运行一个 active action。

#### 11.4 Batch Queue And Scheduling

- [x] 为每台设备维护独立 FIFO 队列，任务状态包含 `pending`、`running`、`paused`、`cancelled`、`failed`、`completed`。
- [ ] 支持批量下发同一任务模板到多个设备，并生成独立任务实例。
- [x] 支持暂停、继续、取消单设备任务；批量操作仍待补充。
- [ ] 支持任务优先级、失败重试、冷却间隔、每日执行次数限制。
- [ ] 支持设备掉线恢复：任务进入 `paused` 或 `waiting_device`，设备恢复后可继续或人工确认。
- [ ] 支持任务模板参数化：目标 App 包名、关键词、评论内容池、点赞概率、滑动次数、时间窗口。

#### 11.5 Visual Workflow UI

- [ ] 扩展 TaskFlow 节点类型：Device Selector、Screenshot/VLM Observe、App Action、Touch Action、Text Input、Condition、Retry、Report。
- [x] 在可视化编排页面展示每台设备的任务队列、当前步骤和执行日志。
- [ ] 支持从自然语言目标生成初始流程草稿，再允许用户手工编辑节点。
- [ ] 支持保存任务模板、复制模板、批量绑定设备运行。
- [ ] 支持运行中节点高亮、失败节点定位、单步重跑和从指定节点继续。
- [ ] 支持导出执行报告：任务目标、设备 ID、步骤、截图、动作参数、模型判断、耗时和错误。

#### 11.6 Safety And Audit

- [ ] 定义高风险动作清单：支付、发私信、评论、关注、删除、授权、登录、隐私数据读取。
- [ ] 高风险动作默认需要用户确认，可按任务模板配置白名单。
- [ ] 所有动作写入审计日志：`taskId`、`deviceId`、时间、截图 hash、动作、参数、执行结果。
- [ ] 对评论/发消息类动作增加内容策略检查和频率限制。
- [ ] 对随机行为增加可控参数：随机种子、概率范围、最小/最大间隔，保证可复现和可审计。
- [ ] 明确禁止 DeerFlow/LLM 直接执行未经校验的 shell、ADB 原始命令或跨设备动作。

#### 11.7 Integration Validation

- [ ] 单设备端到端验证：打开指定 App、进入目标页面、执行一次点击/滑动/验证闭环。
- [ ] 多设备隔离验证：两台以上设备并行运行不同任务，确认截图、动作、日志不串设备。
- [ ] DeerFlow 断连验证：编排服务不可用时任务进入可恢复失败状态，不影响手动设备控制。
- [ ] VLM 错误坐标验证：坐标越界、窗口尺寸变化、旋转屏幕时能阻断或重新映射。
- [ ] 队列恢复验证：应用重启后可恢复未完成任务状态和执行日志。
- [ ] 压力验证：连续运行 30 分钟以上，观察内存、截图延迟、队列堆积和 scrcpy 窗口状态。

#### 11.8 External Dependency Notes

- DeerFlow 2.0 is a LangGraph/LangChain-based super agent harness with skills, tools, sub-agents, memory and sandbox execution.
- Prefer DeerFlow API integration over vendoring its full backend into this Electron app.
- Keep mobile device tools as first-party tools in this repository, exposed to DeerFlow only through a restricted adapter.
- Use local model configuration already available in this app for quick validation, then add optional DeerFlow model mapping.
- Treat DeerFlow as optional: core device page and manual control must continue to work without DeerFlow installed or running.

## Acceptance Criteria

- Opening the device page automatically scans for Android devices.
- Connected authorized devices appear with online status.
- Unauthorized devices appear with unauthorized status and a useful hint.
- Device cards show device ID, model, brand, and Android version when available.
- Users can create groups and assign devices to groups.
- Group assignments and custom metadata persist across refreshes and app restarts.
- Deleting a group does not delete device metadata except the removed group assignment.
- The page remains usable when ADB or scrcpy is missing.
- Device page code follows project logging and i18n conventions.
- Required lint, test, and format commands pass before completion.

## Notes

- ADB and scrcpy are available in `resources/tools/scrcpy`, but the app should continue to support system-installed tools.
- Current project environment still needs `pnpm@10.27.0` before verification commands can run.
- This task list intentionally focuses on the device page target. Scrcpy streaming/control, screenshots, reboot, APK install, and TaskFlow automation can be handled as separate task tracks.
- `pnpm lint`, `pnpm format`, and device-related targeted tests pass.
- `pnpm test` / `pnpm build:check` were attempted but are currently blocked by unrelated existing failures in `BackupManager.deleteTempBackup.test.ts`, `DxtService.test.ts`, `process.test.ts`, and `uiautomator2.test.ts`.
