"""日志初始化工具。"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path


_FILE_HANDLER_FLAG = "_yibiao_file_logging_enabled"


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def setup_logging(enable_file_logging: bool) -> None:
    """初始化通用日志配置。"""
    if not enable_file_logging:
        return

    root_logger = logging.getLogger()
    if getattr(root_logger, _FILE_HANDLER_FLAG, False):
        return

    logs_dir = _backend_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    file_name = f"app-{datetime.now():%Y%m%d}-{os.getpid()}.log"
    file_handler = logging.FileHandler(logs_dir / file_name, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )

    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(file_handler)
    setattr(root_logger, _FILE_HANDLER_FLAG, True)
