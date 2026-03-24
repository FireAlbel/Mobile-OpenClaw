#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
脚本执行器
用于执行生成的uiautomator2脚本
"""

import os
import sys
import tempfile
import subprocess
import json
import logging
from typing import Dict, Any

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class ScriptExecutor:
    """脚本执行器类"""

    def __init__(self):
        """初始化脚本执行器"""
        self.temp_dir = tempfile.mkdtemp(prefix="taskflow_")
        logger.info(f"临时目录: {self.temp_dir}")

    def execute_script(self, script_content: str, timeout: int = 60) -> Dict[str, Any]:
        """执行Python脚本

        Args:
            script_content: 脚本内容
            timeout: 执行超时时间（秒）

        Returns:
            Dict[str, Any]: 执行结果
        """
        try:
            # 创建临时脚本文件
            script_path = os.path.join(self.temp_dir, "temp_script.py")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_content)

            logger.info(f"创建临时脚本: {script_path}")

            # 执行脚本
            logger.info("开始执行脚本...")
            result = subprocess.run(
                [sys.executable, script_path],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self.temp_dir
            )

            # 解析结果
            output = result.stdout.strip()
            error = result.stderr.strip()

            # 尝试解析JSON输出
            try:
                if output.startswith('{') and output.endswith('}'):
                    output_data = json.loads(output)
                else:
                    output_data = {"output": output}
            except json.JSONDecodeError:
                output_data = {"output": output}

            # 返回结果
            return {
                "success": result.returncode == 0,
                "result": output_data,
                "error": error if error else None,
                "return_code": result.returncode
            }

        except subprocess.TimeoutExpired:
            logger.error("脚本执行超时")
            return {
                "success": False,
                "error": "脚本执行超时",
                "result": None
            }
        except Exception as e:
            logger.error(f"执行脚本时出错: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "result": None
            }

    def execute_file(self, script_path: str, timeout: int = 60) -> Dict[str, Any]:
        """执行Python脚本文件

        Args:
            script_path: 脚本文件路径
            timeout: 执行超时时间（秒）

        Returns:
            Dict[str, Any]: 执行结果
        """
        try:
            if not os.path.exists(script_path):
                return {
                    "success": False,
                    "error": f"脚本文件不存在: {script_path}",
                    "result": None
                }

            logger.info(f"执行脚本文件: {script_path}")

            # 执行脚本
            result = subprocess.run(
                [sys.executable, script_path],
                capture_output=True,
                text=True,
                timeout=timeout
            )

            # 解析结果
            output = result.stdout.strip()
            error = result.stderr.strip()

            # 尝试解析JSON输出
            try:
                if output.startswith('{') and output.endswith('}'):
                    output_data = json.loads(output)
                else:
                    output_data = {"output": output}
            except json.JSONDecodeError:
                output_data = {"output": output}

            # 返回结果
            return {
                "success": result.returncode == 0,
                "result": output_data,
                "error": error if error else None,
                "return_code": result.returncode
            }

        except subprocess.TimeoutExpired:
            logger.error("脚本执行超时")
            return {
                "success": False,
                "error": "脚本执行超时",
                "result": None
            }
        except Exception as e:
            logger.error(f"执行脚本时出错: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "result": None
            }

    def cleanup(self):
        """清理临时文件"""
        try:
            import shutil
            shutil.rmtree(self.temp_dir)
            logger.info(f"清理临时目录: {self.temp_dir}")
        except Exception as e:
            logger.warning(f"清理临时目录失败: {str(e)}")

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "message": "缺少操作参数"}))
        return

    action = sys.argv[1]
    executor = ScriptExecutor()

    try:
        if action == "execute_content":
            # 执行脚本内容
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "message": "缺少脚本内容"}))
                return

            script_content = sys.argv[2]
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 60

            result = executor.execute_script(script_content, timeout)
            print(json.dumps(result))

        elif action == "execute_file":
            # 执行脚本文件
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "message": "缺少脚本文件路径"}))
                return

            script_path = sys.argv[2]
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 60

            result = executor.execute_file(script_path, timeout)
            print(json.dumps(result))

        else:
            print(json.dumps({"success": False, "message": f"未知操作: {action}"}))

    except Exception as e:
        logger.error(f"执行操作时出错: {str(e)}")
        print(json.dumps({"success": False, "message": str(e)}))

    finally:
        executor.cleanup()

if __name__ == "__main__":
    main()

    try:
        if action == "execute_content":
            # 执行脚本内容
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "message": "缺少脚本内容"}))
                return

            script_content = sys.argv[2]
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 60

            result = executor.execute_script(script_content, timeout)
            print(json.dumps(result))

        elif action == "execute_file":
            # 执行脚本文件
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "message": "缺少脚本文件路径"}))
                return

            script_path = sys.argv[2]
            timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 60

            result = executor.execute_file(script_path, timeout)
            print(json.dumps(result))

        else:
            print(json.dumps({"success": False, "message": f"未知操作: {action}"}))

    except Exception as e:
        logger.error(f"执行操作时出错: {str(e)}")
        print(json.dumps({"success": False, "message": str(e)}))

    finally:
        executor.cleanup()

if __name__ == "__main__":
    main()
