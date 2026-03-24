# AI自动化任务流插件 - 安卓微信消息监听

这是一个CherryStudio插件，提供可视化工作流编排和安卓微信自动化功能。

## 功能特性

- **可视化工作流编辑器**：基于ReactFlow的拖拽式流程设计
- **微信消息监听**：监听微信消息并触发自动化流程
- **LLM智能脚本生成**：使用大语言模型生成安全可靠的自动化脚本
- **LangGraph工作流引擎**：基于状态图的工作流执行引擎
- **多应用支持**：支持微信、QQ等应用的自动化

## 安装和部署

### 前置条件

1. 安装Node.js 18+ 和 pnpm
2. 安装Android SDK和ADB工具
3. 准备一台已root的安卓设备（推荐）或非root设备（功能受限）

### 安装步骤

1. 克隆CherryStudio项目
```bash
git clone https://github.com/CherryHQ/cherry-studio.git
cd cherry-studio
```

2. 安装依赖
```bash
pnpm install
```

3. 构建项目
```bash
npm run build
```

4. 启动应用
```bash
npm run dev
```

### 安卓环境配置

1. 在安卓设备上启用开发者选项和USB调试
2. 连接设备到电脑
3. 验证ADB连接：
```bash
adb devices
```

4. 对于非root设备，需要安装uiautomator2：
```bash
python -m pip install uiautomator2
python -m uiautomator2 init
```

## 使用指南

### 创建工作流

1. 打开CherryStudio
2. 点击左侧菜单的"任务流"选项
3. 点击"新建任务"按钮
4. 拖拽节点到画布上构建工作流：
   - **开始节点**：流程入口
   - **监听消息节点**：监听微信消息
   - **LLM节点**：调用大语言模型
   - **执行节点**：执行自动化操作
   - **条件节点**：流程分支判断
   - **发送消息节点**：发送微信消息
   - **结束节点**：流程出口

### 配置微信监听

1. 添加"监听消息节点"
2. 配置监听参数：
   - 联系人名称（可选）
   - 群组名称（可选）
   - 关键词过滤（可选）
   - 超时时间

### 消息处理流程示例

1. **自动回复**：监听特定关键词，自动回复预设内容
2. **智能回复**：监听消息，使用LLM生成回复内容
3. **消息转发**：监听消息并转发到其他联系人或群组
4. **消息提醒**：监听重要消息并发送提醒通知

## 扩展开发

### 添加新节点类型

1. 在`src/renderer/src/plugins/taskflow/components/nodes/`目录下创建新节点组件
2. 在`src/renderer/src/plugins/taskflow/types/flow.ts`中定义节点类型
3. 在`src/renderer/src/plugins/taskflow/components/TaskFlowEditor.tsx`中注册节点类型

### 添加新应用支持

1. 在`src/renderer/src/plugins/taskflow/services/scriptGenerator.ts`中添加新应用的脚本模板
2. 在`src/renderer/src/plugins/taskflow/types/flow.ts`中添加新应用的节点类型
3. 创建对应的应用节点组件

## 安全注意事项

1. **账号安全**：避免频繁操作，设置合理的操作间隔
2. **隐私保护**：不要在脚本中硬编码敏感信息
3. **合规使用**：遵守微信等平台的使用条款
4. **异常处理**：添加完善的错误处理和重试机制

## 故障排除

### 常见问题

1. **ADB连接失败**
   - 检查USB调试是否启用
   - 尝试更换USB线或端口
   - 检查驱动程序是否安装正确

2. **uiautomator2连接失败**
   - 确保设备已安装uiautomator2
   - 尝试重启设备
   - 检查网络连接

3. **微信自动化失败**
   - 检查微信版本兼容性
   - 确保微信在前台运行
   - 调整操作间隔时间

### 调试工具

1. 使用`adb shell uiautomator dump`查看当前界面结构
2. 使用`adb logcat`查看系统日志
3. 在节点配置中添加调试输出

## 最佳实践

1. **渐进式部署**：先在小范围内测试，再逐步扩大使用范围
2. **监控告警**：设置异常告警机制
3. **定期维护**：定期检查和更新自动化脚本
4. **备份策略**：定期备份工作流配置和数据

## 技术支持

如有问题，请在GitHub提交Issue或联系技术支持。
