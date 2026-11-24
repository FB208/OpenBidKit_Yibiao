from pathlib import Path


# 读取指定模型组的测试配置，缺项只提示键名。
def read_test_model(root: Path, group: str, url_field: str):
    keys = (f"{group}_API_KEY", f"{group}_{url_field}", f"{group}_MODEL_NAME")
    values = {}
    for line in (root / ".env.test").read_text(encoding="utf-8-sig").splitlines():
        key, _, value = line.partition("=")
        key = key.strip()
        if key in keys:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key] = value

    missing = [key for key in keys if not values.get(key)]
    if missing:
        raise SystemExit(f"请在 .env.test 填写：{', '.join(missing)}")
    return tuple(values[key] for key in keys)
