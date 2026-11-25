# 配置与数据路径

> 本仓库**不**把散落的 `.env` 搬进根目录 `config/`。Windows 本机、Linux Docker 都对准下面三份服务配置。  
> 敏感值不进 git；模板见各目录 `.env.example`。

---

## 1. 三份服务 `.env`

| 文件 | 谁读 | 管什么 |
|---|---|---|
| `chat_relay/.env` | `chat_relay/app.py` | 端口、库路径、uploads、VAPID（可选） |
| `ai_brain/.env` | `ai_brain/bridge.py` | 中继地址、聊天模型槽、代理、Gemini 缓存参数 |
| `memory_service/.env` | `memory_service/server.js` | 记忆管线 Key、`SANCTUARY_ENCRYPTION_KEY`、Chroma/relay 地址 |

根目录 `.env` **只用于 Docker Compose 插值**（`RELAY_SECRET`、`TIDAL_SITE_ADDRESS`、`TZ`），不是第四份服务配置。

### 与设置页的关系

聊天模型、温度、API Key、人设、记忆开关等可在设置页改的项，写入 `chat_relay/data/tidal.db` 的 `settings` 表，热更新，不需要改 `.env`。

`.env` 是进程启动默认值与中继密钥；改**连接密钥**后必须重启四进程：

- Windows 本机：`stop.bat` → `start.bat`
- Docker：改根 `.env` 后 `docker compose up -d`

---

## 2. `RELAY_SECRET` 解析顺序

1. 启动脚本/Compose 已导出的环境变量
2. `chat_relay/.relay_secret`（设置页改密后写入，已 gitignore）
3. 开发默认 `0`

生产必须使用高熵随机值，禁止把 `0` 打进镜像。Windows 本机改过密后，浏览器与 curl 都要用新密钥。

---

## 3. 数据目录

| 产物 | Windows 本机 | Docker（宿主机） |
|---|---|---|
| 聊天 SQLite | `chat_relay/data/tidal.db`（旧 `chat_relay/tidal.db` 回退） | `./chat_relay/data` |
| 上传 | `chat_relay/uploads/` | `./chat_relay/uploads` |
| 记忆 SQLite | `memory_service/data/sanctuary.db`（旧文件回退） | `./memory_service/data` |
| 向量库 | `memory_service/chroma_data/` | `./chroma_data` |
| 记忆备份 | 仓库根 `backups/` | `./backups` |
| Brain 游标 | `ai_brain/.bridge_state/` | `./ai_brain/.bridge_state` |
| 密钥 sidecar | `chat_relay/.relay_secret` | 根 `.env` 注入 |

两库隔离：`tidal.db` 存消息/设置，`sanctuary.db` 存记忆；不要合并，也不要用一份库同时给本机和 Docker 写。

---

## 4. 端口

| 服务 | 端口 | 说明 |
|---|---|---|
| Chroma | `7707` | 向量库 |
| chat_relay | `3011` | 唯一对外 HTTP 入口（同时提供 `web/`） |
| memory_service | `3013` | 记忆流水线 |
| ai_brain | 无 | 连 relay 的 SSE 客户端 |

Docker 只对宿主机映射 Caddy 的 `80/443`；容器内地址：

```text
RELAY_URL=http://relay:3011
MEMORY_URL=http://memory:3013
CHROMA_URL=http://chroma:7707
```

监听：`TIDAL_BIND` 默认 `127.0.0.1`（Windows/裸机）；Compose 设 `0.0.0.0`。

---

## 5. 代理

LLM 代理走环境变量：

- `HTTPS_PROXY` / `HTTP_PROXY`：标准代理，所有非 DeepSeek 路由优先使用；
- `TIDAL_LOCAL_PROXY`：仅本机 Gemini 的显式本地代理（如 `http://127.0.0.1:7890`）；
- DeepSeek 始终直连；
- 两者都没设 → 直连，不会静默回退到 7890。

海外云主机不要设置指向本机的代理。不要在配置里写死本机代理端口。

---

## 6. 上云前检查

- [ ] 根 `.env` 的 `RELAY_SECRET` 不是 `0`，浏览器登录用的也是它
- [ ] `SANCTUARY_ENCRYPTION_KEY` 不是 `.env.example` 里的占位
- [ ] 三份服务 `.env` 都已从 `.env.example` 复制并填好
- [ ] `chat_relay/data`、`memory_service/data`、`chroma_data` 是目录，不是同名文件
- [ ] `.env` / `.relay_secret` / `*.db` / `*.pem` 不进 git
- [ ] 只对公网暴露 80/443

部署步骤见 [`run-cloud.md`](run-cloud.md)，备份与恢复见 [`production.md`](production.md)。
