# 环境与版本

> 首次安装走 [`../AI-HANDOFF.md`](../AI-HANDOFF.md)；本页是版本与配置细节。

## 1. 需要什么

| 组件 | 版本 / 说明 |
|---|---|
| OS | Windows 10+（本机）；Linux（云上 Docker） |
| Python | **3.10+**；仓库根目录一个 `.venv`，Python 服务共用 |
| Node.js | **v22+**；Windows 可用系统安装，或把便携版放进 `tools\nodejs\`（已 gitignore） |
| 浏览器 | **Microsoft Edge（推荐）**；手机 PWA 用系统浏览器（Android Edge / Chrome，iOS Safari） |

可选：Bun（仅当你自行构建前端；默认 `web/` 无构建步骤）。

Linux **不提供**裸机启动脚本，统一走 Docker：[`run-cloud.md`](run-cloud.md)。

---

## 2. 四个进程 + Chroma

| 进程 | 运行时 | 默认端口 |
|---|---|---|
| ChromaDB | Python `memory_service/chroma_server.py` | **7707** |
| chat_relay | Python FastAPI | **3011**（对外 HTTP + 静态页） |
| memory_service | Node `server.js` | **3013** |
| ai_brain | Python `bridge.py` | 无（SSE 客户端） |

---

## 3. 配置文件

| 文件 | 谁读 | 管什么 |
|---|---|---|
| `chat_relay/.env` | relay | 端口、库路径、uploads、VAPID（可选） |
| `ai_brain/.env` | brain | 中继地址、聊天模型槽、代理 |
| `memory_service/.env` | memory | 记忆管线 Key、`SANCTUARY_ENCRYPTION_KEY`、Chroma/relay 地址 |
| 根目录 `.env` | Docker Compose | `RELAY_SECRET`、`TIDAL_SITE_ADDRESS`、`TZ`（仅云上） |

模板：各目录 `.env.example` → 复制为 `.env` 再填。**已填写的 `.env` 永不进 git。**

设置页可改的模型 / Key / 人设等写在 `chat_relay/data/tidal.db` 的 `settings` 表，热更新；**改连接密钥后必须重启进程**。

更细的路径与 Docker volume 对照见 [`configuration.md`](configuration.md)。

---

## 4. 首次准备（Windows 摘要）

```text
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd memory_service && npm install && cd ..
copy 三份 .env.example 为 .env，填 Key
check_env.bat
start.bat
```

细节命令见 [`run-desktop.md`](run-desktop.md)。云上见 [`run-cloud.md`](run-cloud.md)。

---

## 5. 密钥与生产底线

- 开发可用 `RELAY_SECRET=0`；生产必须高熵随机，三端一致。
- `SANCTUARY_ENCRYPTION_KEY` 不要用 example 占位上生产，并与 `sanctuary.db` 成对备份。
- 海外云主机不要设指向本机的 `HTTP(S)_PROXY`。
- API Key、数据库、uploads 实文件、私钥 pem：**不进公开树**。
