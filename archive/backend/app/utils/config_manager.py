"""配置管理工具"""

import json
import logging
import os
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class ConfigManager:
    """用户配置管理器"""

    def __init__(self):
        # 配置文件路径 - 存储到用户家目录中
        self.config_dir = os.path.join(os.path.expanduser("~"), ".ai_write_helper")
        self.config_file = os.path.join(self.config_dir, "user_config.json")

        # 确保配置目录存在
        os.makedirs(self.config_dir, exist_ok=True)

    def load_config(self) -> Dict:
        """从本地JSON文件加载配置"""
        default_config = {"api_key": "", "base_url": "", "model_name": "gpt-3.5-turbo"}

        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    loaded_config = json.load(f)
                    default_config.update(loaded_config)
            except Exception as exc:
                logger.warning("读取配置文件失败，使用默认配置: %s", exc)

        return default_config

    def save_config(self, api_key: str, base_url: str, model_name: str) -> bool:
        """保存配置到本地JSON文件"""
        config = {"api_key": api_key, "base_url": base_url, "model_name": model_name}

        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
            return True
        except Exception as exc:
            logger.warning("保存配置文件失败: %s", exc)
            return False


# 全局配置管理器实例
config_manager = ConfigManager()
