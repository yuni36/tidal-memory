# 名字 · 天数 · 标题 · 头像

开源默认称呼是中性的 **User** / **Assistant**，避免把私人昵称写进仓库默认值。你自己部署后可以改成任何喜欢的名字。

## 四个可改项

| 项 | 前端显示 | 后端 / 记忆侧 | 当前改法 |
|---|---|---|---|
| 用户名字 `HUMAN_NAME` | 聊天页叙述、身份卡人类侧 | relay `RELAY_HUMAN_NAME`；`memory_config.user.name` | 改 `web/index.html` 的 `CONFIG.HUMAN_NAME`；要影响推送/工具文案再改 relay `.env`；要影响星图/抽取再改 `memory_config.json` |
| AI 名字 `AI_NAME` | 顶栏、登录页、身份卡 AI 侧 | relay `RELAY_AI_NAME`；`memory_config.ai.name` | 身份卡可改**当前浏览器**的备注；要全局改，改 `CONFIG.AI_NAME` + relay `.env` + `memory_config.json` |
| 应用名 `APP_NAME` | 主菜单大标题、浏览器标题 | — | 改 `CONFIG.APP_NAME`；同时改 `manifest.webmanifest` 的 `name` / `short_name` |
| 起点 `SINCE` | 主菜单 since / Days | — | 改 `CONFIG.SINCE`（`YYYY/MM/DD`；空 = 不显示） |

> **当前设置页没有身份区**。这四项不在设置页里，需要改前端 `CONFIG` 与对应服务配置。身份卡只能改 AI 备注，存在当前浏览器，不影响服务器与记忆侧。

## 前端 CONFIG

`web/index.html` 脚本顶部有一份启动配置：

```js
const CONFIG = {
  APP_NAME:   "Tidal",
  AI_NAME:    "Assistant",
  HUMAN_NAME: "User",
  SINCE:      "",
};
```

改完刷新页面（Service Worker 可能缓存旧壳，见 `web/sw.js` 的 `CACHE`）。

## 记忆侧双星

`memory_service/memory_config.json` 里的 `user.name` / `ai.name` 决定：

- 星图双星显示名；
- Scribe / Archivist 抽取时的主语；
- `{user}` / `{ai}` 占位符替换。

聊天显示名与星图星名可以不同，但第一次部署建议两边都保持中性。

## 推送 / 工具文案

`chat_relay/.env` 的 `RELAY_HUMAN_NAME` / `RELAY_AI_NAME` 影响推送标题与工具叙述里的称呼。改后重启 relay。

## 头像

- 默认用仓库内中性图（如 `web/avatar-sea.png`）。
- 身份卡可换本地头像（存在浏览器侧，不进 git）。
- 不要把私人照片当成仓库默认资源提交。

## 天数怎么算

有合法 `SINCE` 时，菜单用「今天 − 起点」显示 Days；格式不对或为空则不展示计数，避免假数字。
