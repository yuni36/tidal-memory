# 开发原则（改代码前先读）

> 面向想改这个仓库的人（含 AI 助手）。这里只放慢变量；具体实现以代码为准。

---

## 1. 怎么干活

1. **一次只做一件可验收的事**；做完停，等确认再继续。不擅自扩范围。
2. **需求不清就问**（选择题更好）；架构取舍摸不准也问，不猜。
3. 用户点名的网页 / 仓库 / 官方文档：**先读再改**。不许凭记忆编外部 API 请求体。
4. 架构、运行、生产说明写在文档；行为变化写进 PR 说明 / commit message，不把决策只留在对话里。
5. 报错时给：可复制的修复命令 + 一两句原因。

### 1.1 修 bug vs 加功能

| | 修 bug | 加功能 |
|---|---|---|
| 默认 | 只动出事的那一块；不顺手重构 | 默认旁路：自己的配置/开关；失败可关 |
| 主循环 | 尽量不长新肉、不加双轨 | 不要焊进主循环；主循环「有就用、没有当没看见」 |
| 记录 | 根因 + 别再怎么做 | 行为变了就写清楚 |

相同：小步；可选功能出问题**不得拖死聊天**。

---

## 2. 设计原则

1. **简洁、不冗余**：能一条路径就不要两条；废路径删掉，不要「新旧并存以后再说」。
2. **低耦合、高内聚**：功能分组独立配置，禁止为省事互相覆盖。
3. **谨慎依赖 / 失败自降**：可选能力（天气、搜索、推送、积温等）没配、报错或关掉，只是该能力没有；**聊天核心仍可用**。
4. **向前兼容优先**：新能力用加字段 / 加开关 / 加旁路；不要改旧字段含义；少硬编码。
5. **不添加未要求的功能**；三个相似代码块优于一个过早的抽象。注释关键处用中文，不过度注释。
6. **UI**：原生 HTML/CSS/JS 为主，不引入重型前端框架。改 `web/` 壳必须 bump `web/sw.js` 的 `CACHE`。

---

## 3. 目录与文档角色

| 路径 | 角色 |
|---|---|
| `README.md` | 门面：功能、文档地图、快速开始、验收、协议 |
| `guide/` | 使用者：功能、名字/天数、壁纸、通知、桌面/手机/云 |
| `ops/` | 部署者：Windows 本机、Linux 云、配置、验收、费用、生产维护 |
| `advanced/` | 机制：架构地图、消息生命周期、缓存 |
| `prompts/` | 提示词槽位 |
| `test/` | 空库验收脚本与虚构素材 |
| `maintain/` | 贡献与协作 |

配置：**不**集中到 `config/`。各服务 `.env` + 清单见 [`../ops/configuration.md`](../ops/configuration.md)。

主目录：`chat_relay/` · `ai_brain/` · `memory_service/` · `web/` · `guide/` · `ops/` · `advanced/` · `deploy/`。不新增无意义文件夹。



---

## 4. 环境铁律

### 4.1 两套世界

| | Windows 本机 | Linux 云 |
|---|---|---|
| 启动 | `start.bat` | Docker Compose（[`../ops/run-cloud.md`](../ops/run-cloud.md)） |
| 数据/密钥 | 本机 db 与 `.env` | **另一套**；禁止与本机混写、禁止用本机文件覆盖远端 `.env` / `data/` / `chroma_data` |
| 额外 | 便携 Node、根目录 `.venv` | 备份、发版 snapshot、Caddy 证书卷 |

生产细节（排除项、chmod、SSH、只建谁）见 [`../ops/production.md`](../ops/production.md)。

### 4.2 Windows / Python / Node

1. **唯一 venv**：仓库根 `\.venv\`。chat_relay / ai_brain / chroma 均用 `\.venv\Scripts\python.exe`。禁止子目录另建 venv。
2. 装依赖：`python -m venv .venv` → `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`（一次装齐）。
3. **Node**：v22+；可用系统安装，或便携版放 `tools\nodejs\`（已 gitignore）。严禁 `npm install -g`。
4. Chroma：本机 `memory_service\chroma_data\`；Docker 挂仓库根 `chroma_data/`。
5. Python 启动前 `$env:PYTHONIOENCODING='utf-8'`；少用特殊 Unicode/emoji 进服务日志。
6. LLM 代理走 `HTTPS_PROXY` / `HTTP_PROXY`；本机 Gemini 需要本地代理时用显式 `TIDAL_LOCAL_PROXY`，**不写死** `127.0.0.1:7890`；海外生产机不设本地代理。

### 4.3 数据库

- 双库隔离：`chat_relay` → `tidal.db`（消息/设置）；`memory_service` → `sanctuary.db`（记忆）。配置经 relay API 同步，不是「单库同源」。
- `memory_service/database.js` 必须用 `__dirname` 拼绝对路径（默认 `data/sanctuary.db`，旧路径可回退）。禁止相对路径依赖 `cwd`。
- 密钥与 `.env`：**不进 git**、不在日志打全文。`.env` 均有 `.example`。

### 4.4 记忆与模型

- 聊天大脑与记忆流水线（及航海/事件线/积温等）**分组独立配置**，换聊天模型不丢记忆。
- 记忆检索/纠正等核心工具须保持可用；其它工具随功能开关，关掉不得挡聊天与固化。
- 「这轮是否自动注入相关记忆」由 `INJECT_RELATED_MEMORY`（默认 0）与功能开关共同决定；以代码为准。

---

## 5. 提交前自查

- [ ] 没有把 `.env`、`*.db`、`*.pem`、`uploads/` 实文件、`backups/`、`.bridge_state/` 加进 git
- [ ] 没有真实聊天、真实人名/域名/主机、真 API Key 进入文档或测试
- [ ] 改前端已 bump `web/sw.js` 的 `CACHE`
- [ ] 可选功能失败时主聊仍可用
- [ ] 相关文档已同步（行为变化至少写进 PR/commit）

贡献流程与改哪里找谁：[`collab.md`](collab.md)。
