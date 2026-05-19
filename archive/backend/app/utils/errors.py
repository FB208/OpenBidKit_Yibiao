"""应用级异常定义。"""


class AppError(Exception):
    """用于在 service 层传递可预期的业务错误。"""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
