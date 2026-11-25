# Linux 云部署（Docker Compose）

> 适用：一台 Linux VPS / 云主机，用 Docker 跑四服务 + Caddy，手机通过 HTTPS 访问。  
> Windows 本机开发不要用这套，继续 [`run-desktop.md`](run-desktop.md)。两套数据、两套密钥，禁止互相覆盖。

本仓库自带 4 个部署文件，不需要额外脚本：

```text
Dockerfile                 # Python 服务共用镜像
docker-compose.yml         # chroma / relay / memory / brain / caddy
compose.env.example        # 根目录 .env 模板（RELAY_SECRET、站点地址）
deploy/Caddyfile           # Caddy 反代配置
```

---

## 1. 机器要求

- Linux（如 Ubuntu 22.04+）
- Docker Engine + Docker Compose v2（能执行 `docker compose version`）
- 开放 80 端口；要 HTTPS 再开放 443
- 域名可选：没有域名先用 `http://服务器IP`

---

## 2. 首次部署

### 2.1 把代码放到服务器

```bash
# 任选一种：git clone，或本机 rsync/scp 到 /opt/tidal
git clone <你的仓库地址> /opt/tidal
cd /opt/tidal
```

不要用 Windows 本机的 `chat_relay/data`、`memory_service/data`、`chroma_data`、`.env` 覆盖服务器上的同名内容。

### 2.2 根目录 .env：连接密钥 + 站点地址

```bash
cp compose.env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
# 把输出填进 .env 的 RELAY_SECRET
# TIDAL_SITE_ADDRESS 先保持 :80；有域名再改
```

`RELAY_SECRET` 生产环境禁止为 `0`。

### 2.3 三份服务 .env

```bash
cp chat_relay/.env.example chat_relay/.env
cp ai_brain/.env.example ai_brain/.env
cp memory_service/.env.example memory_service/.env
```

按需编辑：

| 文件 | 必填 |
|---|---|
| `ai_brain/.env` | 聊天模型 Base / Key / Model（DeepSeek、Gemini 或其它 OpenAI 兼容） |
| `memory_service/.env` | 记忆管线 Key、`SANCTUARY_ENCRYPTION_KEY`（不要用示例占位） |
| `chat_relay/.env` | 可留默认；`RELAY_SECRET` 以根目录 `.env` 为准，VAPID 可选 |

> `chat_relay/.env` 只放 VAPID 等中继配置；连接密钥由根目录 `.env` 注入，改根 `.env` 后 `docker compose up -d`。

### 2.4 建数据目录（只建空目录）

```bash
mkdir -p chat_relay/data chat_relay/uploads memory_service/data \
         chroma_data backups logs ai_brain/.bridge_state
```

注意：

- `chat_relay/data` 必须挂成**目录**，不要先 `touch chat_relay/data/tidal.db`（Docker 可能把它建成文件夹）。
- 已有旧库时先停容器，再迁移数据；不要对空 `data/` 直接 `up`。

### 2.5 启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f --tail 80
```

浏览器打开 `http://服务器IP`，用根目录 `.env` 里的 `RELAY_SECRET` 登录。
如果 `.env` 里已经填了聊天/记忆 Key，可以直接发消息；否则进设置页补 Key。

---

## 3. 有域名后开 HTTPS

DNS A 记录指向服务器 IP，然后：

```bash
# 根目录 .env
TIDAL_SITE_ADDRESS=your.domain.com
```

```bash
docker compose up -d
```

Caddy 会自动申请证书。值里不要带 `https://`。手机 PWA 和锁屏推送需要 HTTPS。  
推送方式与域名边界：[`../guide/notifications.md`](../guide/notifications.md)。

---

## 4. 数据与备份

| 宿主机 | 容器内 |
|---|---|
| `chat_relay/data/`（`tidal.db` + wal/shm） | `/app/chat_relay/data` |
| `chat_relay/uploads/` | 附件 |
| `memory_service/data/`（`sanctuary.db`） | `/app/memory_service/data` |
| `chroma_data/` | `/app/memory_service/chroma_data` |
| `backups/` | 生命周期与手工备份 |
| `ai_brain/.bridge_state/` | Brain 游标 |

只挂数据目录，不挂整个源码目录。备份/恢复/换钥的通用步骤见 [`production.md`](production.md)。

---

## 5. 更新与停止

```bash
# 拉新代码后，只重建改过的服务
docker compose up -d --build relay
docker compose up -d --build brain

# 全部重建
docker compose up -d --build

# 停止（不要加 -v，否则会删 Caddy 证书卷）
docker compose down

# 看日志
docker compose logs -f --tail 100 relay
```

更新时**不要覆盖**服务器上的根 `.env`、三份服务 `.env`、`data/`、`chroma_data/`、`uploads/`。

---

## 6. 常见问题

| 现象 | 先查 |
|---|---|
| `docker compose` 报变量未设置 | 根目录 `.env` 是否由 `compose.env.example` 复制，`RELAY_SECRET` 是否为空 |
| relay 起不来 | `chat_relay/.env` 是否存在；`docker compose logs relay` |
| memory 起不来 | `SANCTUARY_ENCRYPTION_KEY` 是否填了；`docker compose logs memory` |
| 页面能开但登录失败 | 浏览器输入的连接密钥与根 `.env` 的 `RELAY_SECRET` 是否一致 |
| 中文/时区不对 | 根 `.env` 设 `TZ=Asia/Shanghai`，重建容器 |
| 证书申请失败 | 域名 A 记录、80/443 是否放行；看 `docker compose logs caddy` |

---

## 7. 安全底线

- 根 `.env`、三份服务 `.env`、`*.pem`、数据库、uploads 实文件都不进 git。
- `RELAY_SECRET` 用高熵随机值，三端一致（根 `.env` 注入）。
- 海外机不要设指向本机的 `HTTP(S)_PROXY`。
- 不要 `docker compose down -v`；证书卷删了要重新申请。
- 单用户模型：一把连接密钥代表“只有你和你的 AI”。
