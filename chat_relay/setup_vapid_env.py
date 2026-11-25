#!/usr/bin/env python3
"""生成或读取 chat_relay PEM，写成 URL-safe Base64 写入本目录 .env。

用法（仓库根或本目录均可）:
    python chat_relay/setup_vapid_env.py --sub mailto:admin@your.site
    python chat_relay/setup_vapid_env.py --sub https://your.site

没有 private_key.pem / public_key.pem 时会当场生成（不进 git）。
生产必须传 --sub（mailto: 或 https:），填你自己的域名；占位 your.site 仅作文档示例。
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import stat
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid

DIR = Path(__file__).resolve().parent
PRIV_PEM = DIR / "private_key.pem"
PUB_PEM = DIR / "public_key.pem"
ENV_PATH = DIR / ".env"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _read_env_value(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.strip())
        if m and m.group(1) == key:
            return m.group(2).strip().strip('"').strip("'")
    return ""


def _upsert_env(path: Path, updates: dict[str, str]) -> None:
    lines: list[str] = []
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()

    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.strip())
        if m and m.group(1) in updates:
            key = m.group(1)
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            out.append(line)

    for key, val in updates.items():
        if key not in seen:
            out.append(f"{key}={val}")

    text = "\n".join(out).rstrip() + "\n"
    path.write_text(text, encoding="utf-8")


def _generate_pem() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    PRIV_PEM.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    PUB_PEM.write_bytes(
        key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    try:
        os.chmod(PRIV_PEM, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Write VAPID keys into chat_relay/.env")
    parser.add_argument(
        "--sub",
        default="",
        help="VAPID claims sub: mailto:you@domain 或 https://your.site（生产必填，勿用 example.com）",
    )
    args = parser.parse_args()

    claims = (
        (args.sub or "").strip()
        or _read_env_value(ENV_PATH, "VAPID_CLAIMS_SUB")
        or os.environ.get("VAPID_CLAIMS_SUB", "").strip()
    )
    if not claims or "example.com" in claims.lower():
        raise SystemExit(
            "请传入真实 --sub（例如 mailto:admin@your.site 或 https://your.site），不要用 example.com"
        )
    if not (claims.startswith("mailto:") or claims.startswith("https://")):
        raise SystemExit("--sub 必须以 mailto: 或 https:// 开头")

    if not PRIV_PEM.exists() or not PUB_PEM.exists():
        _generate_pem()
        print(f"[OK] 已生成 {PRIV_PEM.name} / {PUB_PEM.name}（勿提交 git）")

    vapid = Vapid.from_pem(PRIV_PEM.read_bytes())
    pub_raw = vapid.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    priv_raw = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")

    public_key = _b64url(pub_raw)
    private_key = _b64url(priv_raw)

    updates = {
        "VAPID_PUBLIC_KEY": public_key,
        "VAPID_PRIVATE_KEY": private_key,
        "VAPID_PRIVATE_PEM": "private_key.pem",
        "VAPID_CLAIMS_SUB": claims,
        "VAPID_SUBJECT": claims,
    }
    _upsert_env(ENV_PATH, updates)
    print(f"[OK] 已写入 {ENV_PATH.name}")
    print(f"     VAPID_PUBLIC_KEY 长度={len(public_key)}")
    print(f"     VAPID_PRIVATE_KEY 长度={len(private_key)}")
    print(f"     VAPID_CLAIMS_SUB={claims}")
    print("     请重启 chat_relay 使配置生效。")


if __name__ == "__main__":
    main()
