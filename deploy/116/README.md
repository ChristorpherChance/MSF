# MSF 部署到 116（cc-msf.ikvein.com）操作手册

> 2026-10-08 首装。架构：单进程 Node（web 静态 + /api 同端口 18920，MSF_WEB_DIST 托管）+ Docker 三件套（postgres:16 / minio/minio / redis:7，bind 挂载 ~/msf-data）+ frpc 子域名 cc-msf → 18920。登录=env 门控简易登录（差异登记条目 35）。

## 端口分配（116）

| 用途 | 端口 | 绑定 |
| --- | --- | --- |
| msf web+api | 18920 | 0.0.0.0（LAN 可达；公网经 frp） |
| postgres | 5432 | 127.0.0.1（docker msf-postgres） |
| minio api/console | 9000/9001 | 127.0.0.1（docker msf-minio） |
| redis | 6379 | 127.0.0.1（docker msf-redis） |

## 首装步骤（实际执行顺序）

1. Windows 管理机：`git archive` 源码 → scp 到 116 解开至 `~/All-Projects/msf`；pg_dump + minio 数据 tar → scp 到 116 `/tmp/`。
2. **sudo 一次**（116 本机或 `ssh -t`）：`sudo bash ~/All-Projects/msf/deploy/116/setup-sudo.sh` —— 装 docker.io+镜像加速、加 docker 组、装 msf-app.service、frpc 追加 cc-msf 并重载。
3. 新开 SSH 会话（docker 组生效）：`bash ~/All-Projects/msf/deploy/116/bootstrap-user.sh` —— 用户态 node22/pnpm/依赖/构建/起 pg+redis 容器/生成 msf.env（600，随机密钥）。
4. `bash ~/All-Projects/msf/deploy/116/restore-data.sh` —— 灌 pg dump、minio 数据落位起容器、密钥换根重加密、迁移兜底。
5. 注入登录口令（口令只由人经手，不进脚本/历史明文持久化）：
   `sed -i 's|<登录口令>|实际口令|' ~/All-Projects/msf/deploy/116/msf.env`
6. **sudo 第二次**：`sudo systemctl start msf-app`（此后开机自启）。
7. 验证：`curl localhost:18920/health`；外网 `https://cc-msf.ikvein.com` 出登录页 → 登录 → 工作台。
8. 设置页确认 AI 连接：CPA（随库迁移已带，密钥重加密后即用）+ 新增 116 本机 CCR（http://127.0.0.1:3456/v1，key 读 `~/.config/cs02-ai/gateway.key`）。

## 日常运维

- 应用日志：`journalctl -u msf-app -f`；infra：`docker logs msf-postgres|msf-minio|msf-redis`
- 升级：Windows 侧构建验证后 `git archive` 或 git pull → `pnpm install --frozen-lockfile && pnpm build` → `sudo systemctl restart msf-app`
- 备份：`docker exec msf-postgres pg_dump -U msf -Fc msf` + `~/msf-data/minio` 打包
- 数据目录：`~/msf-data/{pg,minio,redis}`（700）；env：`~/All-Projects/msf/deploy/116/msf.env`（600）
