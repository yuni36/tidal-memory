# 给 AI 的 Tidal 施工与验收单

> **默认上手文件。** 目标：Windows 10/11 本机跑起来。  
> Linux 云 / Docker 不在这份验收范围，见 [`ops/run-cloud.md`](ops/run-cloud.md)。  
> 人类也可以照着本文件手动做；AI 执行时按 §4 回报。

最短路径：**S0 → S1 → S2 → S3 → S4（T1）**；T2 再加 S5 一发一收；T3 再加记忆脚本。  
只做 T1/T2 时，§6 和附录可以最后再看；卡住直接跳 §5。

---

## 0. 先问人类（30 秒）

1. **验收层级**：
   - **T1 部署**：只证明四进程起来，**不需要 API Key**。
   - **T2 最小可用**：部署 + 一发一收，需要 1 个聊天 Key。
   - **T3 推荐基线**：T2 + 记忆脚本；聊天 Key 必需，记忆 Key 建议（本地 ONNX 通常能跑）。
2. 这台 Windows 装好 **Python 3.10+ / Node 22+** 了吗？
3. 聊天 Key 是否已经由人类自己写进 `ai_brain/.env`？
4. 是否允许你发 1–2 条测试消息？（会消耗 token，通常 < ¥0.1）
5. 用 Gemini 吗？如果用，本机是否有可用代理？

如果人类只选 T1：**不要主动填 Key、不要发测试消息**，到健康检查为止。

---

## 1. 人类准备（按层级）

| 项 | T1 | T2 | T3 |
|---|---|---|---|
| Windows 10/11 | ✓ | ✓ | ✓ |
| Python 3.10+ / Node 22+ | ✓ | ✓ | ✓ |
| 磁盘 ≥ 2 GB；3011 / 3013 / 7707 空闲 | ✓ | ✓ | ✓ |
| 网络能访问 DeepSeek / GitHub；Gemini 另备代理 | ✓ | ✓ | ✓ |
| 聊天 Key | — | ✓ | ✓ |
| 记忆 Key | — | — | 建议（可同聊天） |
| `SANCTUARY_ENCRYPTION_KEY` | ✓ | ✓ | ✓ |
| 允许发 1–2 条测试消息 | — | ✓ | ✓ |
| 测试预算 | — | < ¥0.1 | < ¥0.5 |

**Key 由人类自己写进 `.env`。** AI 只检查“不是占位符”，不要打印、不要写进命令历史 / 回报 / 聊天。

---

## 2. 硬约束（AI 必须遵守）

```text
- 不 commit / push；不改业务代码；不扩范围
- 不打印任何 Key、token、.relay_secret 内容
- 不覆盖 chat_relay/data、memory_service/data、chroma_data、uploads
- 不装全局 Python 包；只用仓库 .venv
- 不静默跳过失败；每步先报告，再继续
- 端口被占用时，先报告占用进程，不要杀无关进程
- T1 模式不要主动发测试消息；T2/T3 发消息前先确认
```

---

## 3. 施工步骤（S0–S5）

### S0 环境探测

```powershell
python --version
node -v
git --version   # 可选；zip 解压也行
Get-NetTCPConnection -LocalPort 3011,3013,7707 -ErrorAction SilentlyContinue
```

确认：

- Python ≥ 3.10，Node ≥ 22；
- 仓库放在没有中文 / 空格 / OneDrive 同步的路径（建议 `D:\Tidal`）；
- 三个端口空闲。

### S1 依赖

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd memory_service
npm install
cd ..
```

成功标志：

- `.venv\Scripts\python.exe` 存在；
- `memory_service\node_modules` 存在。

`npm install` 可能较慢；单独执行，给足时间，失败原样报告。

### S2 配置

> 只对全新安装执行；已有 `.env` 不要覆盖，先备份。

```powershell
copy ai_brain\.env.example ai_brain\.env
copy memory_service\.env.example memory_service\.env
copy chat_relay\.env.example chat_relay\.env
```

让人类自己填（T1 可不填聊天 / 记忆 Key；下表是 T2 / T3 的必填）：

| 文件 | 必填 | 说明 |
|---|---|---|
| `ai_brain/.env` | `CHAT_API_KEY_1` | DeepSeek / OpenAI 兼容；Gemini 原生另按设置页填 Base / Model |
| `memory_service/.env` | `DEEPSEEK_API_KEY`、`API_KEY`、`SANCTUARY_ENCRYPTION_KEY` | 两个 Key 填同一把；Gemini 记忆用 `GEMINI_API_KEY` |
| `chat_relay/.env` | 本机默认 `RELAY_SECRET=0` 即可 | VAPID 可选；改密后重启 |

生成加密钥：

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))"
```

注意：

- `SANCTUARY_ENCRYPTION_KEY` **在第一次写入记忆前定好**；有记忆数据后不要随便换，换之前先备份 `sanctuary.db`。
- `start.bat` 会自动把缺失的 `.env.example` 复制成 `.env`；**看到 `.env` 存在不等于配好了**，要检查占位符。
- 如果之前用设置页保存过 Key，设置库优先于 `.env`。

检查占位符（只匹配占位文本，不打印真 Key）：

```powershell
Select-String -Path ai_brain\.env, memory_service\.env -Pattern 'sk-your-|your-api-key|a1b2c3d4'
```

命中 = 还没填。

T1 模式可以不填聊天 / 记忆 Key；但 `SANCTUARY_ENCRYPTION_KEY` 建议一开始就生成，不要留 example 占位。

### S3 启动

```powershell
cmd /c "echo.|check_env.bat"
cmd /c "echo.|start.bat"
```

`check_env.bat` / `start.bat` 末尾有 `pause`；AI 直接前台运行会挂住，用上面的管道。

成功标志（窗口输出）：

```text
[1/4] ChromaDB :7707 ... OK
[2/4] Chat Relay :3011 ... OK
[3/4] Memory :3013 ... OK
[4/4] AI Brain ...
```

`start.bat` 会开最小化窗口，AI 拿不到日志；**验收靠下面的 health / API，不靠看窗口**。

### S4 健康检查（T1）

```powershell
curl.exe -s http://127.0.0.1:3011/healthz
curl.exe -s http://127.0.0.1:3013/healthz
curl.exe -s http://127.0.0.1:7707/health
```

通过标准：

- 三个都返回 200；
- relay 的 `/healthz` 里 **`plugin_subs >= 1`**（brain 已连上）；
- 刚启动等 3–5 秒再查；仍为 0 就是 brain 没连上，页面能开但发消息没人回。

T1 到这里结束；**不要**继续发消息。

### S5 验收（T2 / T3）

#### T2：一发一收

```powershell
$base = "http://127.0.0.1:3011"
# 本机默认 0；设置页改过连接密钥就用新密钥
$secret = "0"
if (Test-Path .\chat_relay\.relay_secret) {
  $secret = (Get-Content .\chat_relay\.relay_secret -Raw).Trim()
}
$h = @{ Authorization = "Bearer $secret" }

# 鉴权
Invoke-RestMethod "$base/app/history?limit=1" -Headers $h

# 发一条测试消息（用英文短句，避开 PowerShell 5.1 的中文编码坑）
$sent = Invoke-RestMethod -Method Post "$base/app/send" `
  -Headers ($h + @{ "Content-Type" = "application/json" }) `
  -Body '{"text":"ping"}'

# 最多轮询 60 秒；只看比刚才这条更新的 AI 回复
$deadline = (Get-Date).AddSeconds(60)
$out = $null
do {
  Start-Sleep 2
  $hist = Invoke-RestMethod "$base/app/history?order=desc&limit=6" -Headers $h
  $out = $hist.messages |
    Where-Object { $_.id -gt $sent.id -and $_.from -eq "ai" -and $_.text } |
    Select-Object -First 1
} while (-not $out -and (Get-Date) -lt $deadline)

$out | ConvertTo-Json -Depth 6
```

通过：

- 返回的 messages 里有 `from = "ai"`；
- `text` 非空；
- 60 秒内出现。

`$out` 为空 = 失败。先看 `plugin_subs`、`.env` 里的 Key / 模型名、Gemini 代理；**T2 没过不要继续 T3**。

#### T3：记忆闭环

```powershell
.\.venv\Scripts\python.exe test\scripts\05_e2e_timing.py
```

通过：

- 打印 `rank coffee=0`，bbq 为 1 或 None；
- 没有 `embedding failed` / `vector storage failed`；
- TOTAL 约 6–12 秒（冷启动可更慢）。

注意：脚本会写入并删除测试记忆；用空库 / 测试库，**不要用生产库**。

---

## 4. 验收判定与回报

| 层级 | 通过标准 |
|---|---|
| T1 | 三个 health 200；relay `plugin_subs >= 1` |
| T2 | T1 + `/app/send` 后 60s 内 history 出现非空 `from = "ai"` |
| T3 | T2 + `05_e2e_timing.py` 咖啡压过烧烤 |

回报模板：

```text
模式：T2
环境：Windows 11 / Python 3.12.x / Node 22.x
PASS  T1 三端口健康（relay plugin_subs=1）
PASS  T2 鉴权 / 一发一收（8.4s，deepseek-flash）
SKIP  T3 记忆（本次未要求）
异常：无
未做：浏览器视觉确认（需人工）
结论：本机可用；下一步建议 ...
```

不要贴 Key、token、`.relay_secret` 原文。

---

## 5. 失败处理

| 现象 | 先查 |
|---|---|
| `python` 不是命令 | 安装 Python 3.10+ 并勾 PATH；或 `py -3` |
| `node` 不是命令 | 安装 Node 22+，或解压便携版到 `tools\nodejs\` |
| 端口被占用 | `Get-NetTCPConnection -LocalPort 3011`，先报告进程 |
| `.venv` 缺失 | 回 S1 重新建 |
| `npm install` 慢 / 失败 | 单独重跑，给足时间；原样报告错误 |
| 401 / 403 | `.env` 还是占位符，或 Key / 模型名不对 |
| 能发不收 | `/healthz` 的 `plugin_subs` 是否为 0 |
| Chroma 超时 | 先等 `:7707/health`；未就绪时向量会降级 |
| memory 起不来 | `memory_service/.env` 是否存在、`SANCTUARY_ENCRYPTION_KEY` 是否填 |
| 登录 401 | 浏览器密钥与 `RELAY_SECRET` / `.relay_secret` 不一致 |
| `.bat` 挂住 | `pause`；用 `cmd /c` 管道喂回车（见 §3 S3） |
| Gemini 403 / 超时 | 本机代理；DeepSeek 不需要代理 |

---

## 6. 可选能力（不算 T1–T3）

- **积温**：不配 affect API 也会按静默主动来找；要分析情绪，再配 Gemini flash lite 免费层。  
  设置页“发一条主动关怀”走记忆管线 Key，和自动积温不是同一条路。
- **搜索**：仅 Gemini Google Search grounding；需要 Gemini Key + 代理。
- **推送**：没有域名只做页面内提醒，不承诺锁屏；锁屏要 HTTPS + 域名 + VAPID；ntfy 可选。
- **云**：Linux + Docker + 域名，见 [`ops/run-cloud.md`](ops/run-cloud.md)。

---

## 附录 A：人类手动模式

不用 AI 时：

1. 按 §3 的 S0–S5 逐条复制执行。
2. 先过 T1，再 T2，最后 T3。
3. 用 §4 的对应标准自检；不要跳过 T1 直接配记忆。
4. 卡住看 §5，或 [`ops/run-desktop.md`](ops/run-desktop.md)。

---

## 附录 B：一键检查清单

```text
[ ] 三份 .env 存在，且占位符已替换
[ ] SANCTUARY_ENCRYPTION_KEY 是 64 位 hex，不是示例值
[ ] /healthz 三个都 200
[ ] relay healthz 的 plugin_subs >= 1
[ ] T2：/app/send 后 60s 内有 out
[ ] T3：05_e2e_timing.py 咖啡 rank 0，bbq 1/None
[ ] 没有把 Key / 数据库 / uploads 提交进 git
```
