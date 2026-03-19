# UiAutomator2 MCP Server

基于原生 UiAutomator2 框架的 Android 自动化 MCP 服务器，通过直接调用 Python uiautomator2 库实现设备控制，避免使用 uiautomator2-ts 库带来的依赖问题。

## 功能特性

- **智能设备连接** - 自动检测和管理 Android 设备
- **高级 UI 交互** - 支持元素查找、点击、文本输入
- **人类化操作** - 内置随机性避免机器人检测
- **中文输入优化** - 使用 UiAutomator2 原生方法解决中文输入乱码问题
- **手势操作** - 支持滑动、长按等复杂手势
- **应用管理** - 启动、停止、监控应用状态
- **设备信息** - 获取设备和应用详细信息
- **截图功能** - 屏幕截图和保存

## 核心优势

### 1. 中文输入支持
传统 ADB 输入方式在处理中文时容易出现乱码问题。本实现使用 UiAutomator2 的 `set_text()` 方法，确保中文输入准确无误。

### 2. 人类化操作模式
为避免被应用识别为机器人行为，实现了以下人性化特征：
- **点击随机性**：在元素区域内添加随机偏移量
- **滑动自然性**：滑动路径添加随机抖动
- **操作间隔**：模拟人类操作的时间间隔

### 3. 零依赖架构
不再依赖 uiautomator2-ts 库，直接使用 Python 的 uiautomator2 框架，更加稳定可靠。

## 使用前提

1. **Python 环境** - 安装 Python 3.6+
2. **Android 设备** - 启用开发者选项和 USB 调试
3. **ADB 工具** - 确保 adb 命令可用（可通过设备控制面板自动管理）
4. **uiautomator2 框架** - 可通过工具自动安装

## 快速开始

### 1. 安装 uiautomator2
```bash
# 自动安装（推荐）
{
  "name": "install_uiautomator2",
  "arguments": {
    "deviceId": "your_device_serial"
  }
}

# 或手动安装
pip install uiautomator2
python -m uiautomator2 init --serial your_device_serial
```

### 2. 连接设备
```bash
{
  "name": "connect_device",
  "arguments": {
    "deviceId": "emulator-5554",  // 可选，自动检测第一个设备
    "host": "localhost",          // 可选，默认 localhost
    "port": 9008                  // 可选，默认 9008
  }
}
```

## 可用工具

### 1. install_uiautomator2
自动安装和初始化 uiautomator2 框架

**参数：**
- `deviceId` (string, 可选): 设备序列号，不指定则使用第一个可用设备

### 2. connect_device
连接到 Android 设备并启动 uiautomator2 服务

**参数：**
- `deviceId` (string, 可选): 设备序列号，自动检测可用设备
- `host` (string, 可选): 服务主机，默认 localhost
- `port` (number, 可选): 服务端口，默认 9008

### 3. find_element
查找屏幕上的 UI 元素

**参数：**
- `selector` (object): 元素选择器
  - `text` (string, 可选): 元素文本内容
  - `resourceId` (string, 可选): 元素资源 ID (如 com.example:id/button)
  - `className` (string, 可选): 元素类名 (如 android.widget.Button)
  - `description` (string, 可选): 元素描述
  - `packageName` (string, 可选): 应用包名
- `timeout` (number, 可选): 查找超时时间（毫秒），默认 10000

### 4. click_element
点击 UI 元素（支持人类化随机点击）

**参数：**
- `selector` (object): 元素选择器（同 find_element）
- `timeout` (number, 可选): 操作超时时间（毫秒），默认 10000
- `offset` (object, 可选): 点击偏移量
  - `x` (number): X 偏移比例（0-1），默认 0.5（中心）
  - `y` (number): Y 偏移比例（0-1），默认 0.5（中心）
- `randomize` (boolean, 可选): 是否添加随机性避免检测，默认 true

### 5. input_text
输入文本到元素（优化中文输入）

**参数：**
- `selector` (object): 元素选择器（同 find_element）
- `text` (string): 要输入的文本（支持中文）
- `clearFirst` (boolean, 可选): 是否先清除现有文本，默认 true
- `useUiAutomator2` (boolean, 可选): 使用 UiAutomator2 方法输入，默认 true（推荐）

### 6. swipe
执行滑动手势（支持人类化滑动）

**参数：**
- `startX` (number): 起始 X 坐标
- `startY` (number): 起始 Y 坐标
- `endX` (number): 结束 X 坐标
- `endY` (number): 结束 Y 坐标
- `duration` (number, 可选): 滑动持续时间（毫秒），默认 500
- `randomize` (boolean, 可选): 是否添加路径随机性，默认 true

### 7. start_app
启动 Android 应用

**参数：**
- `packageName` (string): 应用包名（如 com.example.app）
- `activity` (string, 可选): 具体 Activity 名称
- `stop` (boolean, 可选): 启动前是否停止应用，默认 false

### 8. stop_app
停止 Android 应用

**参数：**
- `packageName` (string): 应用包名

### 9. screenshot
截取设备屏幕

**参数：**
- `filename` (string, 可选): 截图文件名，默认自动生成

### 10. get_device_info
获取设备详细信息

**参数：** 无

### 11. get_app_current
获取当前运行应用信息

**参数：** 无

## 使用示例

### 自动安装和连接
```json
[
  {
    "name": "install_uiautomator2",
    "arguments": {}
  },
  {
    "name": "connect_device",
    "arguments": {
      "deviceId": "emulator-5554"
    }
  }
]
```

### 中文输入场景
```json
{
  "name": "input_text",
  "arguments": {
    "selector": {
      "resourceId": "com.example:id/search_input"
    },
    "text": "你好世界",
    "useUiAutomator2": true
  }
}
```

### 人类化点击操作
```json
{
  "name": "click_element",
  "arguments": {
    "selector": {
      "text": "登录按钮"
    },
    "randomize": true,
    "offset": {
      "x": 0.5,
      "y": 0.5
    }
  }
}
```

### 自然滑动操作
```json
{
  "name": "swipe",
  "arguments": {
    "startX": 500,
    "startY": 1500,
    "endX": 500,
    "endY": 500,
    "duration": 800,
    "randomize": true
  }
}
```

### 应用自动化流程
```json
[
  {
    "name": "start_app",
    "arguments": {
      "packageName": "com.tencent.mm",
      "stop": true
    }
  },
  {
    "name": "find_element",
    "arguments": {
      "selector": {
        "text": "搜索"
      }
    }
  },
  {
    "name": "click_element",
    "arguments": {
      "selector": {
        "text": "搜索"
      }
    }
  },
  {
    "name": "input_text",
    "arguments": {
      "selector": {
        "className": "android.widget.EditText"
      },
      "text": "联系人姓名"
    }
  }
]
```

## 技术原理

### 架构设计
```
MCP Client → MCP Server → Python Subprocess → UiAutomator2 → Android Device
```

### 核心机制
1. **动态脚本生成**：为每个操作生成对应的 Python 脚本
2. **进程隔离**：通过子进程执行 Python 命令，避免阻塞主线程
3. **设备状态管理**：维护设备连接状态和操作上下文
4. **错误恢复**：提供详细的错误信息和恢复建议

### 人类化算法
- **点击随机化**：`random_x = base_x ± 10%` 范围内随机
- **滑动自然化**：路径添加 ±5 像素的随机偏移
- **时间分布**：操作间隔模拟人类反应时间

### 工具路径管理
本实现采用与设备控制MCP服务器相同的工具路径管理机制：
- **自动检测**：自动检测系统PATH中的ADB工具
- **应用内打包**：优先使用应用内打包的ADB工具
- **路径管理**：通过`toolPathManager`统一管理工具路径
- **兼容性**：支持Windows、macOS和Linux平台

## 错误处理

所有工具调用都包含完整的错误处理机制：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: Device not connected. Please use connect_device first."
    }
  ],
  "isError": true
}
```

## 最佳实践

### 1. 连接管理
```json
// 检查设备连接
{
  "name": "get_device_info",
  "arguments": {}
}

// 重新连接
{
  "name": "connect_device",
  "arguments": {
    "deviceId": "your_device_serial"
  }
}
```

### 2. 元素选择策略
优先使用 `resourceId`，其次使用 `text`，避免使用可能变化的属性：

```json
{
  "selector": {
    "resourceId": "com.example:id/login_button",
    "text": "登录"
  }
}
```

### 3. 操作稳定性
- 使用 `find_element` 确认元素存在后再操作
- 设置适当的 `timeout` 值
- 启用 `randomize` 选项避免检测

### 4. 中文输入优化
始终使用 `useUiAutomator2: true` 进行中文输入：

```json
{
  "name": "input_text",
  "arguments": {
    "text": "中文内容",
    "useUiAutomator2": true
  }
}
```

## 注意事项

1. **设备兼容性**：支持 Android 5.0+ 设备
2. **权限要求**：需要 USB 调试权限和 ADB 访问
3. **网络环境**：设备可通过 USB 或网络连接
4. **性能考虑**：复杂操作建议分批执行
5. **安全限制**：某些应用可能限制自动化操作

## 故障排除

### 设备连接失败
```bash
# 检查设备连接
adb devices

# 重新初始化 uiautomator2
python -m uiautomator2 init --serial your_device_serial
```

### 元素查找失败
- 检查选择器条件是否准确
- 确认元素在屏幕上可见
- 增加 `timeout` 时间
- 使用 `find_element` 先验证元素存在

### 中文输入乱码
- 确保 `useUiAutomator2` 参数为 `true`
- 检查设备输入法设置
- 验证 UiAutomator2 框架安装正确

## 版本更新

### v2.0.0 (当前)
- ✅ 移除 uiautomator2-ts 依赖
- ✅ 实现直接 Python 调用
- ✅ 添加中文输入优化
- ✅ 支持人类化操作
- ✅ 增强错误处理

### v1.0.0
- 基于 uiautomator2-ts 的初始实现
