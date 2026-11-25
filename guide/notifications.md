# 通知、推送与积温

> 先说结论：**没有域名 / HTTPS，只承诺页面内通知；锁屏推送要域名 + HTTPS。**  
> 积温的“主动来找”不需要 affect API；但“分析情绪”需要 Gemini flash lite（免费层）。

---

## 1. 三件不同的事

| 名字 | 是什么 | 依赖 |
|---|---|---|
| **浏览器通知** | 页面开着 / 后台标签弹横幅 | 通知权限 + 安全上下文 |
| **Web Push** | PWA 关掉也能收锁屏 | HTTPS + Service Worker + VAPID |
| **ntfy** | 自建推送通道 | 服务器 + 一个端口 + 手机 app |

不要把它们混成一个“推送开关”。没配 VAPID / ntfy 时聊天照常，只是没有后台锁屏推送。

---

## 2. 按场景选

| 场景 | 推送能做到 | 建议 |
|---|---|---|
| 本机 Windows（localhost） | 页面内通知；可测 Web Push | 先本机跑通 |
| 手机连家里电脑（HTTP） | 页面内提醒；HTTP 下通知可能被浏览器拦截 | 不承诺锁屏 |
| 云 + IP（无 HTTPS） | 页面内提醒；同上 | 先跑聊天 |
| 云 + 域名（HTTPS） | Web Push + VAPID；可选 ntfy | 维护者同款 |

现代浏览器要求**安全上下文**；`localhost` 是例外。局域网 IP / 公网 IP 的 HTTP 页面，通知、PWA、Service Worker 都可能不可用。

### 没有域名

- 只做**页面内提醒**：页面开着时尽量提醒；HTTP 非 localhost 下浏览器可能直接禁用通知。
- 不承诺手机锁屏；不把 VAPID / ntfy 当默认路径。本机 `localhost` 可以单独测 Web Push。
- 聊天、记忆、积温都不受影响。

### 有域名

1. DNS 指向服务器，开放 80 / 443。
2. 根目录 `.env` 的 `TIDAL_SITE_ADDRESS` 填域名（不要带 `https://`）。
3. Caddy 自动申请证书，页面走 HTTPS。
4. 在**服务器上**生成 VAPID，写入 `chat_relay/.env`，重启 relay。
5. 手机用 HTTPS 域名打开，加到主屏，再开通知。
6. 想更稳可加自建 ntfy（占一个端口），与 Web Push 并行。

维护者同款：

```text
VPS + 域名 + Caddy HTTPS
  + Web Push（VAPID）
  + 可选自建 ntfy（一个端口）
  + 手机把 PWA 加到主屏
```

部署步骤：[`../ops/run-cloud.md`](../ops/run-cloud.md)。

---

## 3. 积温怎么跑（代码口径）

积温不是“一个 API 开关”，它由几条路径组成：

| 路径 | 什么时候发生 | 要不要 affect API | 用哪个模型 |
|---|---|---|---|
| 数学时钟 | memory 每 5 分钟 tick | **不要** | 无 |
| 主动来找 | connection 到阈值 | **不要** | 聊天模型 |
| 情绪分析 | 用户每条消息（开关开） | **要** | Gemini flash lite |
| 语调染色 | 回复时 | **不要** | 本地 tone grid |
| 手动“发一条” | 设置页按钮 | 要记忆 Key | 记忆管线模型 |

### 开关

| 开关 | 默认 | 关掉会怎样 |
|---|---|---|
| 积温总闸 | 开 | 分析与语调不跑；**不等于关主动关怀** |
| 启用情绪分析 | **关** | 不调 LLM，只 reset connection |
| 启用语调染色 | 开 | 不注入 `styleGuidance` |
| 主动关怀 | 开 | 不主动来找 |

一句话：**想“不主动来找”关主动关怀；想“保留来找但不注入情绪”关分析 / 语调。**

### 没有 affect API

- tick 照跑，`connection` 随静默上涨；到阈值后仍会主动来找。
- 用户发消息时 `/affect/observe` 会跳过，只把 `connection` 归零；**不会产生 valence / arousal / pride 的 delta**。
- 语调染色默认仍开着，所以代码上可能仍注入一段**中性、静态**的语调；只是每轮差不多，看起来像“没注入情绪”。
- 想完全不要语调块：关“启用语调染色”。
- 主动来找是完整一轮聊天模型，所以**仍需要聊天 Key**（T2）。

### 有 affect API

- 打开“启用情绪分析”，配好 `affect_api_base_url` / `affect_api_key` / `affect_model`。
- 每条用户消息异步算五轴 delta；下一轮起注入语调 / 状态旁白。
- 分析失败只兜底 `connection -0.15`，不挡主聊。
- 免费层有 RPM / RPD 限额；超限 / 429 / 超时只做兜底，不自动切付费。

推荐：积温分析用 **Gemini flash lite 免费层**；记忆 / 事件线摘要用 DeepSeek。

### 手动“发一条” vs 自动

- **自动积温**：数学时钟到点 → 聊天模型开一轮。
- **手动按钮**：`/app/proactive_now` → memory `/proactive/compose` → 记忆管线模型。
- 手动按钮需要记忆 Key；它失败不代表自动积温坏了。

---

## 4. 本机怎么测

1. **页面通知**：打开 `http://127.0.0.1:3011`，允许通知权限，发一条消息看横幅。
2. **自动积温**：不建议改生产阈值硬测；看 `/affect/state` 的 `connection`、`triggers`，或等静默到点。
3. **手动按钮**：设置页“发一条主动关怀（进聊天 + 推送）”；需要记忆 Key，且会真的落库。
4. **锁屏级 Web Push**：配 VAPID 后重启 relay，再测；本机 `localhost` 可先验证权限。

`/affect/state` 示例：

```powershell
curl.exe -s http://127.0.0.1:3013/affect/state
```

重点看：

- `state.connection`：越静默越高；
- `triggers`：是否到阈值；
- `flags.canAnalyze`：分析是否配齐；
- `pending`：是否已排队。

---

## 5. 云上 / 手机锁屏

| 要求 | 说明 |
|---|---|
| HTTPS | PWA、Service Worker、Web Push 在生产上基本强制 |
| 加到主屏幕 | 尤其 iOS：从主屏图标进入再开通知 |
| VAPID | 在**服务器**上生成并写入 `chat_relay/.env`，私钥不进 git |
| 厂商杀后台 | 系统环境问题；可辅以自建 ntfy |

生成 VAPID：

```powershell
# Windows
.\.venv\Scripts\python.exe chat_relay\setup_vapid_env.py --sub mailto:you@example.com

# Linux
.venv/bin/python chat_relay/setup_vapid_env.py --sub mailto:you@example.com
```

会生成 `chat_relay/private_key.pem`（已 gitignore），并写入 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CLAIMS_SUB`。然后重启 relay。

Docker 部署没有宿主机 `.venv` 时：在本机仓库生成，把这三个值写进服务器的 `chat_relay/.env`，再重建 relay。

ntfy（可选）：

- 在 `chat_relay/.env` 填 `NTFY_URL`（完整 topic URL，topic 当密码用长随机串）；
- 与 Web Push 并行，不配则跳过；
- 国内手机后台更稳，但仍建议有 HTTPS 域名。

---

## 6. 隐私

设置里若提供“通知隐私模式”：开启后锁屏横幅只显示「Tidal / 收到一条新消息」，不泄露正文。适合公共场合亮屏。
