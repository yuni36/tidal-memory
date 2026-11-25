# Windows 本机运行（细节与排错）

> **首次安装请先走 [`../AI-HANDOFF.md`](../AI-HANDOFF.md)（T1–T3）。** 本页保留依赖细节、可选能力和排错。  
> 只覆盖 Windows 10+ 本机。Linux 上云见 [`run-cloud.md`](run-cloud.md)。  
> 两套数据、两套密钥，禁止本机与 Docker 同时写同一套 `tidal.db` / `sanctuary.db`。

---

## 1. 依赖

| 组件 | 要求 |
|---|---|
| Python | 3.10+；仓库根目录一个 `.venv`，四个 Python 进程共用 |
| Node.js | v22+；可用系统安装，或便携版放到 `tools\nodejs\`（该目录已 gitignore） |
| Chroma | 由 `memory_service/chroma_server.py` 启动，不需要单独安装 |

```powershell
# 仓库根目录
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

cd memory_service
npm install
cd ..

copy ai_brain\.env.example ai_brain\.env
copy memory_service\.env.example memory_service\.env
copy chat_relay\.env.example chat_relay\.env
# 编辑三份 .env：填聊天/记忆 Key、SANCTUARY_ENCRYPTION_KEY
# SANCTUARY_ENCRYPTION_KEY 在第一次写入记忆前定好；有数据后换钥要先备份 sanctuary.db。
# 生成方式：.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))"
```

版本细节与三份 `.env` 分工见 [`env-and-versions.md`](env-and-versions.md)。

---

## 2. 环境自检

```bat
check_env.bat
```

会检查 `.venv`、Node、`node_modules`、三份 `.env`；缺什么会打印对应安装命令。

> 脚本末尾有 `pause`。AI / 自动化调用时用 `cmd /c "echo.|check_env.bat"`，否则会挂住。

---

## 3. 一键启动

```bat
start.bat
```

启动顺序：Chroma `:7707` → chat_relay `:3011` → memory_service `:3013` → ai_brain（SSE 客户端）。Chroma 就绪后才启动后续服务。

> `start.bat` 末尾也有 `pause`；AI / 自动化调用时用 `cmd /c "echo.|start.bat"`。  
> 它开的是最小化窗口，验收请看 `/healthz` / API，不靠看窗口日志。

停止本目录的服务：

```bat
stop.bat
```

`stop.bat` 只结束本目录启动的进程，不会误杀其他文件夹里的 Tidal。

浏览器打开 `http://127.0.0.1:3011`，用连接密钥登录。

`RELAY_SECRET` 解析顺序：环境变量 → `chat_relay/.relay_secret` → 开发默认 `0`。设置页改过连接密钥后，必须 `stop.bat` 再 `start.bat`。

---

## 4. Web Push / VAPID（可选）

未配置时聊天照常；配置后，PWA 不在前台且 AI 回复时推锁屏通知。  
本机 `localhost` 可先测；手机锁屏推送需要 HTTPS 域名，没有域名只承诺页面内通知。

```powershell
.\.venv\Scripts\python.exe chat_relay\setup_vapid_env.py --sub mailto:you@example.com
```

会生成 `chat_relay/private_key.pem`（已 gitignore），并写入 `chat_relay/.env` 的
`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_CLAIMS_SUB`。然后重启 relay（或 `stop.bat` → `start.bat`）。

生产/手机推送用真实站点联系人，不要用示例域名。手机端需要 HTTPS 域名并把 PWA 加到主屏。

---

## 5. 本机 Gemini 网络（代理）

DeepSeek 直连，不需要代理。本机用 **Gemini 原生** 时需要能访问 Google，按你的网络环境二选一：

```powershell
# 方式一：标准环境变量（Clash/V2Ray 等一般都用这个）
$env:HTTPS_PROXY='http://127.0.0.1:7890'

# 方式二：写进 ai_brain/.env，只影响本机 Gemini
TIDAL_LOCAL_PROXY=http://127.0.0.1:7890
```

两个都没设 → 直连，不会静默走 7890。海外云主机不要设置任何指向本机的代理。

---

## 6. 启动后验收

按 [`../AI-HANDOFF.md`](../AI-HANDOFF.md) 的 T1–T3：

1. **T1**：三个 health 200；relay `/healthz` 的 `plugin_subs >= 1`。
2. **T2**：登录 + 一发一收；需要聊天 Key。
3. **T3**：`test/scripts/05_e2e_timing.py` 咖啡压过烧烤。
4. 可选：积温 / 推送见 [`../guide/notifications.md`](../guide/notifications.md)。

更完整证据与耗时：[`verify.md`](verify.md)。

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 端口被占用 | 查占用 `3011` / `3013` / `7707` 的进程并结束，再 `start.bat` |
| AI 不回复 | 看 brain 终端：Key、模型名、网络/代理 |
| 中文乱码 | 启动前 `PYTHONIOENCODING=utf-8`（`start.bat` 已处理） |
| 记忆向量弱 | 等 Chroma `:7707` 健康再聊；未就绪时会降级 |
| `ModuleNotFoundError` | 回到仓库根目录重跑 `pip install -r requirements.txt` |

API 槽位：[`usage-apis.md`](usage-apis.md)。花费：[`usage-and-cost.md`](usage-and-cost.md)。云部署：[`run-cloud.md`](run-cloud.md)。
