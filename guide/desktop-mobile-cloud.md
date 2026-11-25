# 桌面 · 手机 · 云

三种用法叠在同一套服务上，差在「浏览器怎么进」和「要不要 HTTPS」。

> 还没装？先走 [`../AI-HANDOFF.md`](../AI-HANDOFF.md)（T1–T3）。

## 本机桌面（开发 / 日常）

1. 按 [`../AI-HANDOFF.md`](../AI-HANDOFF.md) 起四进程；细节 / 排错见 [`../ops/run-desktop.md`](../ops/run-desktop.md)。
2. 浏览器打开 `http://127.0.0.1:3011`（同源由 relay 提供 `web/`）。
3. 登录用连接密钥（开发常为 `0`；改过密则以设置页 / `.relay_secret` 为准）。
4. 本机桌面通知：localhost 算安全上下文，可先测通知权限；锁屏级 Web Push 仍建议配 VAPID（见 [`notifications.md`](notifications.md)）。

**不要**让本机 `start.bat` 与云上 Docker **同时写同一份** `tidal.db` / `sanctuary.db`。

## 手机（同一台电脑的局域网，或已上云的站点）

| 场景 | 怎么进 | 注意 |
|------|--------|------|
| 只在家里碰本机 | 手机浏览器访问电脑的局域网 IP:3011 | 许多浏览器对「非 HTTPS 的局域网」限制通知 / 部分 PWA 能力 |
| 正式当 App 用 | 用 **HTTPS 域名** 打开站点 →「添加到主屏幕」 | iOS 需从主屏图标打开，通知才稳 |
| 数据在哪 | 始终在你的服务器 / 本机，不经过第三方聊天托管 | 单用户一把 `RELAY_SECRET` |

星图在窄屏上可用，但复杂浏览更适合桌面宽屏。

## 云（VPS / Docker）

- 目标：手机随时聊、锁屏能推、数据与本机隔离。
- 部署步骤：[`../ops/run-cloud.md`](../ops/run-cloud.md)。
- 要点：高熵 `RELAY_SECRET`、域名 + HTTPS（Caddy 等）、VAPID 在**服务器上**生成、海外机不要套本机代理。

## 怎么选

```text
先本机跑通聊天与记忆
    → 再考虑手机加主屏（最好已有 HTTPS）
    → 需要外出使用再上云，另开一套库与 Key
```
