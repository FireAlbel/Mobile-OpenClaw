// LLM自动生成uiautomator2脚本的Prompt模板

export interface ScriptGenerationParams {
  intent: string
  messageContent: string
  deviceInfo?: {
    screenWidth: number
    screenHeight: number
    androidVersion: string
  }
  contactInfo?: {
    name: string
    type: 'contact' | 'group'
  }
}

// 生成uiautomator2脚本的系统提示词
export const SYSTEM_PROMPT = `你是一个专业的Android自动化测试工程师，精通uiautomator2库。
你的任务是生成高质量、可执行的Python uiautomator2脚本，用于自动化微信操作。

要求：
1. 脚本必须安全、稳定，避免封号风险
2. 使用明确的等待机制，确保元素加载完成
3. 添加适当的异常处理和重试机制
4. 代码结构清晰，注释详细
5. 遵循微信的UI结构和控件ID命名规范

请根据用户需求生成对应的uiautomator2 Python脚本。`

// 生成脚本的Prompt模板
export const SCRIPT_GENERATION_PROMPT = `请根据以下信息生成uiautomator2 Python脚本：

意图: {intent}
消息内容: {messageContent}
设备信息: {deviceInfo}
联系人信息: {contactInfo}

要求：
1. 生成的脚本必须是完整可执行的Python代码
2. 包含必要的导入语句
3. 添加详细的注释说明每一步操作
4. 使用适当的等待时间避免操作过快
5. 处理可能的异常情况
6. 确保脚本可以安全地在真实设备上运行

请直接返回Python代码，不要包含其他解释文本。`

// 生成监听消息的脚本
export const generateListenScript = (params: ScriptGenerationParams) => {
  const { contactInfo } = params

  return `# -*- coding: utf-8 -*-
import uiautomator2 as u2
import time
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def listen_wechat_message(contact_name=None, group_name=None, keywords=None):
    '''
    监听微信消息

    Args:
        contact_name: 联系人名称，如果指定则只监听该联系人
        group_name: 群聊名称，如果指定则只监听该群聊
        keywords: 关键词列表，如果指定则只监听包含这些关键词的消息

    Returns:
        dict: 包含消息信息的字典
    '''

    try:
        # 连接设备
        logger.info("正在连接设备...")
        d = u2.connect()

        # 启动微信
        logger.info("启动微信...")
        d.app_start("com.tencent.mm")
        time.sleep(3)

        # 等待微信主界面加载
        if not d(text="微信").exists(timeout=10):
            logger.error("微信启动失败")
            return {"success": False, "message": "微信启动失败"}

        # 进入聊天列表
        logger.info("进入聊天列表...")
        d(text="微信").click()
        time.sleep(1)

        # 如果有指定联系人或群聊，点击进入
        target_name = contact_name or group_name
        if target_name:
            logger.info(f"查找联系人/群聊: {target_name}")
            # 滚动查找联系人
            found = False
            for _ in range(10):  # 最多滚动10次
                if d(text=target_name).exists:
                    d(text=target_name).click()
                    found = True
                    break
                # 向上滚动
                d.swipe_ext("up", scale=0.5)
                time.sleep(0.5)

            if not found:
                logger.warning(f"未找到联系人/群聊: {target_name}")
                return {"success": False, "message": f"未找到联系人/群聊: {target_name}"}

        # 监听新消息
        logger.info("开始监听新消息...")
        start_time = time.time()
        timeout = 30  # 30秒超时

        while time.time() - start_time < timeout:
            # 检查是否有新消息提示
            if d(resourceId="com.tencent.mm:id/b4m").exists:
                # 点击进入聊天
                d(resourceId="com.tencent.mm:id/b4m").click()
                time.sleep(1)

                # 获取最新消息
                messages = d(resourceId="com.tencent.mm:id/b4e")
                if messages.count > 0:
                    latest_message = messages[-1].info['text'] if hasattr(messages[-1], 'info') else "无法获取消息内容"

                    # 检查关键词
                    if keywords:
                        keyword_match = any(keyword in latest_message for keyword in keywords)
                        if not keyword_match:
                            logger.info(f"消息不包含关键词: {latest_message}")
                            # 返回聊天列表继续监听
                            d.press("back")
                            time.sleep(1)
                            continue

                    logger.info(f"收到消息: {latest_message}")

                    # 返回聊天列表
                    d.press("back")
                    time.sleep(1)

                    return {
                        "success": True,
                        "message": latest_message,
                        "sender": target_name or "未知",
                        "timestamp": time.time()
                    }

            time.sleep(1)

        logger.info("监听超时")
        return {"success": False, "message": "监听超时"}

    except Exception as e:
        logger.error(f"监听消息时出错: {str(e)}")
        return {"success": False, "message": str(e)}

    finally:
        # 这里不关闭微信，保持监听状态
        pass

if __name__ == "__main__":
    # 示例用法
    result = listen_wechat_message(
        contact_name="${contactInfo?.name || ''}",
        keywords=${JSON.stringify(params.intent.split(' '))}
    )
    print(result)
`
}

// 生成发送消息的脚本
export const generateSendScript = (params: ScriptGenerationParams) => {
  const { messageContent, contactInfo } = params

  return `# -*- coding: utf-8 -*-
import uiautomator2 as u2
import time
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def send_wechat_message(contact_name, group_name=None, message_content=""):
    '''
    发送微信消息

    Args:
        contact_name: 联系人名称
        group_name: 群聊名称（可选，与contact_name二选一）
        message_content: 消息内容

    Returns:
        dict: 包含执行结果的字典
    '''

    try:
        # 连接设备
        logger.info("正在连接设备...")
        d = u2.connect()

        # 启动微信
        logger.info("启动微信...")
        d.app_start("com.tencent.mm")
        time.sleep(3)

        # 等待微信主界面加载
        if not d(text="微信").exists(timeout=10):
            logger.error("微信启动失败")
            return {"success": False, "message": "微信启动失败"}

        # 点击搜索
        logger.info("点击搜索...")
        d(description="搜索").click()
        time.sleep(1)

        # 输入联系人名称
        target_name = group_name or contact_name
        logger.info(f"搜索联系人/群聊: {target_name}")
        d(resourceId="com.tencent.mm:id/bhn").set_text(target_name)
        time.sleep(2)

        # 点击搜索结果
        if d(text=target_name).exists:
            d(text=target_name).click()
            time.sleep(1)

            # 输入消息
            logger.info("输入消息内容...")
            d(resourceId="com.tencent.mm:id/b4a").set_text(message_content)
            time.sleep(1)

            # 发送消息
            logger.info("发送消息...")
            d(resourceId="com.tencent.mm:id/b8k").click()
            time.sleep(1)

            logger.info("消息发送成功")
            return {"success": True, "message": "消息发送成功"}
        else:
            logger.error(f"未找到联系人/群聊: {target_name}")
            return {"success": False, "message": f"未找到联系人/群聊: {target_name}"}

    except Exception as e:
        logger.error(f"发送消息时出错: {str(e)}")
        return {"success": False, "message": str(e)}

    finally:
        # 返回主界面
        try:
            d.press("back")
            time.sleep(1)
            d.press("back")
        except:
            pass

if __name__ == "__main__":
    # 示例用法
    result = send_wechat_message(
        contact_name="${contactInfo?.name || ''}",
        message_content="${messageContent}"
    )
    print(result)
`
}

// 生成标记已读的脚本
export const generateMarkReadScript = (params: ScriptGenerationParams) => {
  return `# -*- coding: utf-8 -*-
import uiautomator2 as u2
import time
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def mark_wechat_message_read(contact_name=None, group_name=None):
    '''
    标记微信消息为已读

    Args:
        contact_name: 联系人名称
        group_name: 群聊名称

    Returns:
        dict: 包含执行结果的字典
    '''

    try:
        # 连接设备
        logger.info("正在连接设备...")
        d = u2.connect()

        # 启动微信
        logger.info("启动微信...")
        d.app_start("com.tencent.mm")
        time.sleep(3)

        # 等待微信主界面加载
        if not d(text="微信").exists(timeout=10):
            logger.error("微信启动失败")
            return {"success": False, "message": "微信启动失败"}

        # 进入聊天列表
        logger.info("进入聊天列表...")
        d(text="微信").click()
        time.sleep(1)

        # 查找联系人
        target_name = contact_name or group_name
        if target_name:
            logger.info(f"查找联系人/群聊: {target_name}")

            # 滚动查找联系人
            found = False
            for _ in range(10):  # 最多滚动10次
                if d(text=target_name).exists:
                    # 点击进入聊天
                    d(text=target_name).click()
                    time.sleep(1)

                    # 立即返回，相当于标记已读
                    d.press("back")
                    time.sleep(1)

                    found = True
                    break
                # 向上滚动
                d.swipe_ext("up", scale=0.5)
                time.sleep(0.5)

            if found:
                logger.info(f"已标记 {target_name} 的消息为已读")
                return {"success": True, "message": f"已标记 {target_name} 的消息为已读"}
            else:
                logger.warning(f"未找到联系人/群聊: {target_name}")
                return {"success": False, "message": f"未找到联系人/群聊: {target_name}"}
        else:
            # 如果没有指定联系人，标记所有未读消息
            logger.info("标记所有未读消息为已读...")
            unReadElements = d(resourceId="com.tencent.mm:id/b4m")
            if unReadElements.exists:
                for element in unReadElements:
                    element.click()
                    time.sleep(0.5)
                    d.press("back")
                    time.sleep(0.5)

            logger.info("已标记所有未读消息为已读")
            return {"success": True, "message": "已标记所有未读消息为已读"}

    except Exception as e:
        logger.error(f"标记已读时出错: {str(e)}")
        return {"success": False, "message": str(e)}

    finally:
        # 返回主界面
        try:
            d.press("back")
            time.sleep(1)
        except:
            pass

if __name__ == "__main__":
    # 示例用法
    result = mark_wechat_message_read(
        contact_name="${params.contactInfo?.name || ''}"
    )
    print(result)
`
}

// 根据意图选择生成相应的脚本
export const generateScriptByIntent = (params: ScriptGenerationParams) => {
  const { intent } = params

  if (intent.includes('监听') || intent.includes('接收')) {
    return generateListenScript(params)
  } else if (intent.includes('发送') || intent.includes('回复')) {
    return generateSendScript(params)
  } else if (intent.includes('标记') || intent.includes('已读')) {
    return generateMarkReadScript(params)
  } else {
    // 默认生成发送脚本
    return generateSendScript(params)
  }
}

// LLM调用函数
export const callLLMForScriptGeneration = async (params: ScriptGenerationParams, apiConfig: any) => {
  const { intent, messageContent, deviceInfo, contactInfo } = params

  const prompt = SCRIPT_GENERATION_PROMPT.replace('{intent}', intent)
    .replace('{messageContent}', messageContent)
    .replace('{deviceInfo}', JSON.stringify(deviceInfo || {}))
    .replace('{contactInfo}', JSON.stringify(contactInfo || {}))

  try {
    // 调用LLM API
    const response = await fetch(apiConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: apiConfig.model || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: apiConfig.temperature || 0.7,
        max_tokens: apiConfig.maxTokens || 2000
      })
    })

    if (!response.ok) {
      throw new Error(`API调用失败: ${response.statusText}`)
    }

    const data = await response.json()
    const script = data.choices[0].message.content

    // 验证脚本安全性
    const safeScript = validateScriptSafety(script)

    return {
      success: true,
      script: safeScript,
      model: apiConfig.model || 'gpt-3.5-turbo'
    }
  } catch (error) {
    console.error('LLM调用失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// 验证脚本安全性
export const validateScriptSafety = (script: string): string => {
  // 检查是否包含危险操作
  const dangerousPatterns = [
    /os\.system\(/gi,
    /subprocess\./gi,
    /eval\(/gi,
    /exec\(/gi,
    /__import__/gi,
    /globals\(/gi,
    /locals\(/gi,
    /open\(/gi,
    /file\(/gi,
    /input\(/gi,
    /raw_input\(/gi
  ]

  let safeScript = script

  // 移除或替换危险模式
  dangerousPatterns.forEach((pattern) => {
    safeScript = safeScript.replace(pattern, '# 安全警告: 潜在危险操作已被注释')
  })

  return safeScript
}

// 格式化脚本
export const formatScript = (script: string): string => {
  // 简单的代码格式化
  return script
    .replace(/\\n\\n+/g, '\\n\\n') // 移除多余的空行
    .replace(/\\t/g, '    ') // 将制表符转换为4个空格
    .trim()
}
