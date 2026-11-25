# 生产维护（更新 / 备份 / 恢复 / 换钥）

> 本文只讲通用流程，不含任何具体主机、域名、SSH 密钥或私有备份路径。  
> 首次部署见 [`run-cloud.md`](run-cloud.md)；日常本机见 [`run-desktop.md`](run-desktop.md)。

---

## 1. 更新代码

```bash
cd /opt/tidal          # 你的部署目录
git pull               # 或 rsync/scp 同步新代码

# 只重建改动过的服务，不要顺手重建数据容器
docker compose up -d --build relay
docker compose up -d --build brain
```

注意：

- 不要覆盖服务器上的根 `.env`、三份服务 `.env`、`data/`、`chroma_data/`、`uploads/`。
- 只改前端时重建 `relay`（`web/` 打在 relay 镜像里）。
- 改 `web/sw.js` 的 `CACHE` 后，已装到主屏的客户端才会换新壳。

---

## 2. 备份

### 2.1 热备份（推荐，服务不停）

宿主机安装 `sqlite3`：

```bash
sudo apt-get install -y sqlite3
```

```bash
STAMP=$(date +%F-%H%M)
mkdir -p "backups/$STAMP"

# SQLite 用 .backup，避免直接拷 WAL 中的半写状态
sqlite3 chat_relay/data/tidal.db ".backup 'backups/$STAMP/tidal.db'"
sqlite3 memory_service/data/sanctuary.db ".backup 'backups/$STAMP/sanctuary.db'"

# 向量库与附件
tar czf "backups/$STAMP/files.tar.gz" chroma_data chat_relay/uploads

ls -lh "backups/$STAMP"
```

### 2.2 冷备份（最稳，短暂停机）

```bash
docker compose stop
STAMP=$(date +%F-%H%M)
tar czf "backups/cold-$STAMP.tar.gz" \
    chat_relay/data chat_relay/uploads \
    memory_service/data chroma_data
docker compose start
```

### 2.3 必须一起备份的东西

- `chat_relay/data/`、`memory_service/data/`、`chroma_data/`、`chat_relay/uploads/`
- 根 `.env` 与三份服务 `.env`
- `SANCTUARY_ENCRYPTION_KEY`：**和 `sanctuary.db` 成对保存**，换钥解不开旧库

---

## 3. 恢复

```bash
docker compose down

# 先用当前文件做一次保底备份
mv chat_relay/data chat_relay/data.bak
mv memory_service/data memory_service/data.bak

mkdir -p chat_relay/data memory_service/data
cp "backups/<时间>/tidal.db" chat_relay/data/tidal.db
cp "backups/<时间>/sanctuary.db" memory_service/data/sanctuary.db

docker compose up -d
```

恢复后确认：

- `docker compose ps` 全部 healthy
- 能登录、能看到旧消息与星图
- `SANCTUARY_ENCRYPTION_KEY` 与备份时一致

---

## 4. 更换连接密钥

```bash
# 1. 编辑根目录 .env
RELAY_SECRET=<新的高熵随机值>

# 2. 重建读取该变量的服务
docker compose up -d

# 3. 浏览器/手机用新密钥重新登录
```

生成密钥：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

---

## 5. 查看状态与日志

```bash
docker compose ps
docker compose logs -f --tail 100
docker compose logs -f --tail 100 relay
docker compose logs -f --tail 100 memory
```

健康检查：

```bash
curl -sf http://127.0.0.1:3011/healthz   # 容器内或映射后
curl -sf http://127.0.0.1:3013/healthz
curl -sf http://127.0.0.1:7707/health
```

---

## 6. 磁盘与证书

- `chroma_data/`、`uploads/`、`backups/` 会持续增长；定期清理旧备份。
- **不要**执行 `docker compose down -v`：会删除 `caddy_data` 证书卷，HTTPS 需要重新申请。
- 备份文件不要放在公开静态目录。

---

## 7. 安全底线

- 只对公网暴露 80/443；不要映射 3011/3013/7707。
- 根 `.env`、服务 `.env`、`*.pem`、数据库、uploads 不进 git。
- SSH 用密钥登录，禁用密码登录（按你的云厂商文档配置）。
- 单用户模型：一把 `RELAY_SECRET` 代表“只有你和你的 AI”，泄露等于对话全暴露。
