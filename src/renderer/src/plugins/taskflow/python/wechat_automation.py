#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信自动化脚本
用于监听微信消息、发送消息、标记已读等操作
"""

import uiautomator2 as u2
import time
import logging
import json
import sys
import os
from typing import Dict, Any, Optional, List

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class WeChatAutomation:
    """微信自动化类"""

    def __init__(self):
        """初始化微信自动化"""
        self.device = None
        self.package_name = "com.tencent.mm"

    def connect_device(self) -> bool:
        """连接Android设备

        Returns:
            bool: 是否连接成功
        """
        try:
            logger.info("正在连接Android设备...")
            self.device = u2.connect()

            # 检查设备是否连接成功
            if self.device.info:
                logger.info(f"设备连接成功: {self.device.info}")
                return True
            else:
                logger.error("设备连接失败")
                return False

        except Exception as e:
            logger.error(f"连接设备失败: {str(e)}")
            return False

    def start_wechat(self) -> bool:
        """启动微信应用

        Returns:
            bool: 是否启动成功
        """
        try:
            if not self.device:
                logger.error("设备未连接")
                return False

            logger.info("正在启动微信...")
            self.device.app_start(self.package_name)

            # 等待微信启动
            time.sleep(3)

            # 检查微信是否成功启动
            if self.device(text="微信").exists(timeout=10):
                logger.info("微信启动成功")
                return True
            else:
                logger.error("微信启动失败")
                return False

        except Exception as e:
            logger.error(f"启动微信失败: {str(e)}")
            return False

    def listen_for_messages(self, contact_name: Optional[str] = None,
                           group_name: Optional[str] = None,
                           keywords: Optional[List[str]] = None,
                           timeout: int = 30) -> Dict[str, Any]:
        """监听微信消息

        Args:
            contact_name: 联系人名称，如果指定则只监听该联系人
            group_name: 群聊名称，如果指定则只监听该群聊
            keywords: 关键词列表，如果指定则只监听包含这些关键词的消息
            timeout: 监听超时时间（秒）

        Returns:
            Dict[str, Any]: 包含消息信息的字典
        """
        try:
            if not self.device:
                return {"success": False, "message": "设备未连接"}

            # 确保微信已启动
            if not self.device(text="微信").exists(timeout=5):
                if not self.start_wechat():
                    return {"success": False, "message": "微信启动失败"}

            # 进入聊天列表
            logger.info("进入聊天列表...")
            if self.device(text="微信").exists:
                self.device(text="微信").click()
                time.sleep(1)

            target_name = contact_name or group_name

            # 如果有指定联系人或群聊，点击进入
            if target_name:
                logger.info(f"查找联系人/群聊: {target_name}")

                # 滚动查找联系人
                found = False
                for _ in range(10):  # 最多滚动10次
                    if self.device(text=target_name).exists:
                        self.device(text=target_name).click()
                        found = True
                        break
                    # 向上滚动
                    self.device.swipe_ext("up", scale=0.5)
                    time.sleep(0.5)

                if not found:
                    logger.warning(f"未找到联系人/群聊: {target_name}")
                    # 返回聊天列表
                    self.device.press("back")
                    return {"success": False, "message": f"未找到联系人/群聊: {target_name}"}

            # 监听新消息
            logger.info("开始监听新消息...")
            start_time = time.time()

            while time.time() - start_time < timeout:
                # 检查是否有新消息提示
                if self.device(resourceId="com.tencent.mm:id/b4m").exists:
                    # 点击新消息
                    self.device(resourceId="com.tencent.mm:id/b4m").click()
                    time.sleep(1)

                    # 获取最新消息
                    messages = self.device(resourceId="com.tencent.mm:id/b4e")
                    if messages.count > 0:
                        latest_message = ""
                        try:
                            # 获取最后一条消息的内容
                            last_message = messages[-1]
                            if hasattr(last_message, 'info') and 'text' in last_message.info:
                                latest_message = last_message.info['text']
                            else:
                                # 尝试通过其他方式获取文本
                                latest_message = last_message.get_text() or "无法获取消息内容"
                        except Exception as e:
                            logger.warning(f"获取消息内容失败: {str(e)}")
                            latest_message = "无法获取消息内容"

                        # 检查关键词
                        if keywords:
                            keyword_match = any(keyword in latest_message for keyword in keywords)
                            if not keyword_match:
                                logger.info(f"消息不包含关键词: {latest_message}")
                                # 返回聊天列表继续监听
                                self.device.press("back")
                                time.sleep(1)
                                continue

                        logger.info(f"收到消息: {latest_message}")

                        # 返回聊天列表
                        self.device.press("back")
                        time.sleep(1)

                        return {
                            "success": True,
                            "message": latest_message,
                            "sender": target_name or "未知",
                            "timestamp": time.time()
                        }

                time.sleep(1)

            logger.info("监听超时")

            # 返回聊天列表
            self.device.press("back")

            return {"success": False, "message": "监听超时"}

        except Exception as e:
            logger.error(f"监听消息时出错: {str(e)}")
            return {"success": False, "message": str(e)}

    def send_message(self, contact_name: str, group_name: Optional[str] = None,
                     message: str = "", use_template: bool = False) -> Dict[str, Any]:
        """发送微信消息

        Args:
            contact_name: 联系人名称
            group_name: 群聊名称（可选，与contact_name二选一）
            message: 消息内容
            use_template: 是否使用模板

        Returns:
            Dict[str, Any]: 包含执行结果的字典
        """
        try:
            if not self.device:
                return {"success": False, "message": "设备未连接"}

            # 确保微信已启动
            if not self.device(text="微信").exists(timeout=5):
                if not self.start_wechat():
                    return {"success": False, "message": "微信启动失败"}

            # 点击搜索
            logger.info("点击搜索...")
            if self.device(description="搜索").exists:
                self.device(description="搜索").click()
                time.sleep(1)
            else:
                # 备选方案：点击右上角"+"然后选择"发起群聊"
                if self.device(description="更多功能按钮").exists:
                    self.device(description="更多功能按钮").click()
                    time.sleep(1)
                    if self.device(text="发起群聊").exists:
                        self.device(text="发起群聊").click()
                        time.sleep(1)

            # 输入联系人名称
            target_name = group_name or contact_name
            logger.info(f"搜索联系人/群聊: {target_name}")

            if self.device(resourceId="com.tencent.mm:id/bhn").exists:
                self.device(resourceId="com.tencent.mm:id/bhn").set_text(target_name)
                time.sleep(2)

            # 点击搜索结果
            if self.device(text=target_name).exists:
                self.device(text=target_name).click()
                time.sleep(1)

                # 输入消息
                logger.info("输入消息内容...")
                if self.device(resourceId="com.tencent.mm:id/b4a").exists:
                    self.device(resourceId="com.tencent.mm:id/b4a").set_text(message)
                    time.sleep(1)

                # 发送消息
                logger.info("发送消息...")
                if self.device(resourceId="com.tencent.mm:id/b8k").exists:
                    self.device(resourceId="com.tencent.mm:id/b8k").click()
                    time.sleep(1)

                logger.info("消息发送成功")
                return {"success": True, "message": "消息发送成功"}
            else:
                logger.error(f"未找到联系人/群聊: {target_name}")
                return {"success": False, "message": f"未找到联系人/群聊: {target_name}"}

        except Exception as e:
            logger.error(f"发送消息时出错: {str(e)}")
            return {"success": False, "message": str(e)}

    def mark_as_read(self, contact_name: Optional[str] = None,
                     group_name: Optional[str] = None) -> Dict[str, Any]:
        """标记微信消息为已读

        Args:
            contact_name: 联系人名称
            group_name: 群聊名称

        Returns:
            Dict[str, Any]: 包含执行结果的字典
        """
        try:
            if not self.device:
                return {"success": False, "message": "设备未连接"}

            # 确保微信已启动
            if not self.device(text="微信").exists(timeout=5):
                if not self.start_wechat():
                    return {"success": False, "message": "微信启动失败"}

            # 进入聊天列表
            logger.info("进入聊天列表...")
            if self.device(text="微信").exists:
                self.device(text="微信").click()
                time.sleep(1)

            target_name = contact_name or group_name

            if target_name:
                logger.info(f"查找联系人/群聊: {target_name}")

                # 滚动查找联系人
                found = False
                for _ in range(10):  # 最多滚动10次
                    if self.device(text=target_name).exists:
                        # 点击进入聊天
                        self.device(text=target_name).click()
                        time.sleep(1)

                        # 立即返回，相当于标记已读
                        self.device.press("back")
                        time.sleep(1)

                        found = True
                        break
                    # 向上滚动
                    self.device.swipe_ext("up", scale=0.5)
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

                # 查找所有未读消息标记
                unReadElements = self.device(resourceId="com.tencent.mm:id/b4m")
                if unReadElements.exists:
                    count = 0
                    for element in unReadElements:
                        element.click()
                        time.sleep(0.5)
                        self.device.press("back")
                        time.sleep(0.5)
                        count += 1

                    logger.info(f"已标记 {count} 个未读消息为已读")
                    return {"success": True, "message": f"已标记 {count} 个未读消息为已读"}
                else:
                    logger.info("没有未读消息")
                    return {"success": True, "message": "没有未读消息"}

        except Exception as e:
            logger.error(f"标记已读时出错: {str(e)}")
            return {"success": False, "message": str(e)}

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "message": "缺少操作参数"}))
        return

    action = sys.argv[1]
    wechat = WeChatAutomation()

    # 连接设备
    if not wechat.connect_device():
        print(json.dumps({"success": False, "message": "设备连接失败"}))
        return

    try:
        if action == "listen":
            # 监听消息
            contact_name = sys.argv[2] if len(sys.argv) > 2 else None
            group_name = sys.argv[3] if len(sys.argv) > 3 else None
            keywords = sys.argv[4].split(",") if len(sys.argv) > 4 and sys.argv[4] else None
            timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 30

            result = wechat.listen_for_messages(
                contact_name=contact_name,
                group_name=group_name,
                keywords=keywords,
                timeout=timeout
            )
            print(json.dumps(result))

        elif action == "send":
            # 发送消息
            if len(sys.argv) < 4:
                print(json.dumps({"success": False, "message": "缺少发送参数"}))
                return

            contact_name = sys.argv[2]
            message = sys.argv[3]
            group_name = sys.argv[4] if len(sys.argv) > 4 else None

            result = wechat.send_message(
                contact_name=contact_name,
                group_name=group_name,
                message=message
            )
            print(json.dumps(result))

        elif action == "mark_read":
            # 标记已读
            contact_name = sys.argv[2] if len(sys.argv) > 2 else None
            group_name = sys.argv[3] if len(sys.argv) > 3 else None

            result = wechat.mark_as_read(
                contact_name=contact_name,
                group_name=group_name
            )
            print(json.dumps(result))

        else:
            print(json.dumps({"success": False, "message": f"未知操作: {action}"}))

    except Exception as e:
        logger.error(f"执行操作时出错: {str(e)}")
        print(json.dumps({"success": False, "message": str(e)}))

if __name__ == "__main__":
    main()
