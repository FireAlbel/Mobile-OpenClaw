# Cherry Studio 项目脚本文件说明

本文档详细说明了Cherry Studio项目中所有脚本文件的作用和功能。

## 根目录脚本文件

### 1. after-pack.js
**作用**: Electron打包后的清理脚本
- 在Windows平台上，删除Electron打包后生成的LICENSE文件
- 删除`LICENSE.electron.txt`和`LICENSES.chromium.html`文件

### 2. artifact-build-completed.js
**作用**: 构建完成后重命名产物文件
- 检查构建产物文件名是否包含空格
- 如果包含空格，则将空格替换为连字符
- 更新构建结果中的文件路径

### 3. before-pack.js
**作用**: Electron打包前的准备工作
- 根据目标平台架构下载相应的预编译二进制包
- 修改pnpm-workspace.yaml以支持目标平台
- 排除不需要的平台特定包
- 处理ripgrep工具的架构特定版本

### 4. auto-translate-i18n.ts
**作用**: 自动翻译国际化文本
- 使用OpenAI兼容的API自动翻译i18n文件
- 支持并发翻译以提高效率
- 可配置的延迟和并发控制
- 支持多种语言翻译
- 进度跟踪和错误处理

### 5. check-custom-exts.ts
**作用**: 检查自定义扩展名与代码语言扩展名的重叠
- 验证自定义文本扩展名是否与代码语言扩展名冲突
- 确保扩展名定义的一致性
- 在CI/CD中用于检查配置错误

### 6. check-hardcoded-strings.ts
**作用**: 检测硬编码的中英文字符串
- 使用AST分析TypeScript/React代码
- 检测UI组件中的硬编码中文字符串
- 检测潜在的英文UI文本
- 忽略特定上下文（如日志、类型定义等）
- 支持严格模式用于CI检查

### 7. check-i18n.ts
**作用**: 检查国际化文件的完整性和一致性
- 验证翻译文件与基准文件的键值结构一致性
- 检查重复键
- 验证键值按字典序排序
- 确保所有翻译文件同步

### 8. cloudflare-worker.js
**作用**: Cloudflare Worker脚本，用于应用更新服务
- 定期检查GitHub最新版本
- 下载并缓存发布文件到R2存储
- 提供版本信息和文件下载服务
- 支持日志记录和错误处理
- 清理旧版本文件

### 9. feishu-notify.ts
**作用**: 飞书(Lark)通知工具
- 向飞书发送自定义通知
- 支持GitHub Issue通知
- 使用Webhook签名验证
- 支持多种通知类型和颜色主题

### 10. generate-openapi-spec.ts
**作用**: 生成OpenAPI规范文档
- 从API路由代码生成OpenAPI 3.0规范
- 支持ChatGPT兼容的API端点
- 包含认证和安全方案
- 生成详细的API文档结构

### 11. notarize.js
**作用**: macOS应用公证脚本
- 对macOS应用进行Apple公证
- 需要Apple ID和应用特定密码
- 确保应用可以在macOS上运行

### 12. patch-claude-agent-sdk.ts
**作用**: 修补Claude Agent SDK
- 修改SDK的child_process.spawn调用为fork
- 启用IPC通信通道
- 使用正则表达式进行语义化修补
- 支持多种变量命名模式

### 13. skills-check.ts
**作用**: 检查技能文件的一致性
- 验证公共技能文件的存在
- 检查.gitignore文件的更新状态
- 确保Claude技能文件与Agent技能文件同步
- 验证跟踪文件是否在白名单内

### 14. skills-common.ts
**作用**: 技能相关的通用工具函数
- 提供技能名称列表
- 生成.gitignore文件内容
- 文件读写工具函数
- 技能名称验证

### 15. skills-sync.ts
**作用**: 同步技能文件
- 将Agent技能文件同步到Claude技能目录
- 生成和更新.gitignore文件
- 确保技能文件的一致性

### 16. sort.ts
**作用**: 对象键值排序工具
- 递归排序对象的键值
- 支持嵌套对象的排序
- 保持数组和原始值不变

### 17. sync-i18n.ts
**作用**: 同步国际化文件
- 将翻译文件与基准文件同步
- 添加缺失的键值（标记为[to be translated]）
- 删除多余的键值
- 按字典序排序键值

### 18. update-app-upgrade-config.ts
**作用**: 更新应用升级配置文件
- 根据发布版本更新升级配置
- 支持多个升级通道（latest、rc、beta）
- 支持多个镜像源（GitHub、GitCode）
- 验证发布版本的可用性
- 清理旧版本文件

### 19. update-i18n.ts
**作用**: 更新国际化翻译
- 使用OpenAI兼容API翻译缺失的文本
- 支持多种目标语言
- 保持翻译格式的一致性

### 20. update-languages.ts
**作用**: 更新编程语言定义
- 从linguist-languages包提取语言数据
- 生成TypeScript语言定义文件
- 支持代码高亮和文件类型识别

### 21. version.js
**作用**: 版本管理脚本
- 自动更新package.json版本号
- 创建Git提交和标签
- 支持patch、minor、major版本升级
- 可选择推送到远程仓库

### 22. win-sign.js
**作用**: Windows应用签名脚本
- 对Windows应用进行代码签名
- 使用DigiCert时间戳服务
- 需要证书路径和密钥信息

## __tests__目录测试文件

### 1. check-hardcoded-strings.test.ts
**作用**: 硬编码字符串检测功能的单元测试
- 测试CJK字符检测
- 测试英文UI文本检测
- 测试文件过滤逻辑
- 测试AST节点跳过逻辑
- 测试代码上下文检测

### 2. patch-claude-agent-sdk.test.ts
**作用**: Claude Agent SDK修补功能的单元测试
- 测试各个修补函数
- 测试集成修补流程
- 测试重复修补处理
- 测试不同变量命名模式
- 验证修补结果的正确性

### 3. sort.test.ts
**作用**: 对象排序功能的单元测试
- 测试扁平对象排序
- 测试嵌套对象排序
- 测试特殊值处理
- 测试原始对象不变性
- 测试i18n JSON文件排序

## 使用说明

这些脚本可以通过以下方式运行：

```bash
# 运行特定脚本
pnpm run <script-name>

# 或者直接使用Node.js/TypeScript执行
node scripts/<script-name>.js
npx tsx scripts/<script-name>.ts
```

脚本通常用于：
- CI/CD流程自动化
- 开发环境准备
- 代码质量检查
- 发布流程管理
- 国际化和本地化
