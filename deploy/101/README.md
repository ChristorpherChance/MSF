# MSF 部署到 101（开发机）操作手册

> 2026-10-10 首装。定位：**101 = 开发机**（Claude Code 直接在 101 上跑），116 仍是生产（cc-msf.ikvein.com）。
> 架构：dev 三件套 `pnpm dev`（nest watch :8080 + vite :5173 + shared tsc watch）+ Docker 三件套
> （postgres:16 / minio / redis:7，bind 挂载 ~/msf-data，全部 127.0.0.1）。
> 数据 = **116 生产当前态回拷**（pg_dump + minio tar），密钥换根到开发默认根。
>
> 与 116 手册（deploy/116/README.md）的差异：**无 systemd 单元、无 frpc、无登录门、无随机密钥**
> ——全部沿用仓库 dev 默认值，与本机 Windows 开发口径一致。

## 端口分配（101）

| 用途 | 端口 | 绑定 |
| --- | --- | --- |
| vite dev（Windows 浏览器入口） | 5173 | 0.0.0.0（`vite --host`；LAN 直访 http://192.168.10.101:5173） |
| msf api（nest watch） | 8080 | 0.0.0.0（vite 代理 /api→localhost:8080） |
| postgres | 5432 | 127.0.0.1（docker msf-postgres） |
| minio api/console | 9000/9001 | 127.0.0.1（docker msf-minio；文件读写走应用代理 MSF_FILES_PROXY=1） |
| redis | 6379 | 127.0.0.1（docker msf-redis） |

## 首装步骤（实际执行顺序）

1. **Windows 管理机**：`git bundle create .tmp/msf-repo.bundle --all` → scp 到 101 →
   `git clone msf-repo.bundle ~/All-Projects/msf`（完整历史，101 仓库即为日后开发主库）。
2. **116 数据回拷**（116 上执行）：
   - `docker exec msf-postgres pg_dump -U msf -Fc msf > /tmp/msf-pg.dump`
   - `tar -cf /tmp/msf-minio.tar -C ~/msf-data minio`（minio 运行中打包；写低频可接受，dev 副本容忍）
   - 两件经 Windows 管理机中转 scp 到 101 `/tmp/`。
3. **116 密钥根管道传输**（不落聊天、不落 Windows 盘）：
   `ssh <116> 'grep ^MSF_SECRET_KEY= ~/All-Projects/msf/deploy/116/msf.env | cut -d= -f2' | ssh <101> 'cat > ~/.msf-116-key.tmp && chmod 600 ~/.msf-116-key.tmp'`
4. **sudo 一次**：`sudo bash ~/All-Projects/msf/deploy/101/setup-sudo.sh`（docker.io+git+镜像加速+docker 组）。
5. 新开 SSH 会话（docker 组生效）：`bash ~/All-Projects/msf/deploy/101/bootstrap-user.sh`
   （node22/pnpm/依赖/构建/起 pg+redis/dev 凭据 msf.env）。
6. `bash ~/All-Projects/msf/deploy/101/restore-data.sh`（灌库+minio 落位起容器+换根重加密到开发默认根+迁移兜底；
   116 旧根临时文件用完即删）。
7. **minio 镜像若拉不到**（国内加速站封禁，同 116 坑②）：
   `ssh <116> 'docker save quay.io/minio/minio' | ssh <101> 'docker load'`。
8. 验证：`wget -qO- localhost:8080/health`；Windows 浏览器开 `http://192.168.10.101:5173`
   （vite 需 `--host` 起，见下）；项目列表/文档/原型预览（代理链路）/AI 对话冒烟。
9. **Claude Code**：`npm i -g @anthropic-ai/claude-code`（用户态 node22 全局）。
   **首次登录是交互动作，由用户本人在 101 的 SSH 终端里跑 `claude` 完成授权**（或配置 ANTHROPIC_API_KEY）。

## 日常开发（101）

- 起服务：`cd ~/All-Projects/msf && pnpm dev`（三件套并行）。
  Windows 浏览器可达需 vite 绑 0.0.0.0：`pnpm --filter @msf/web dev -- --host`
  （或拆开跑：先 `pnpm dev`，另窗 vite 加 --host）。
- env：`deploy/101/msf.env`（600）只有 `MSF_FILES_PROXY=1`——**nest watch 进程需带着它起**
  （`set -a; . deploy/101/msf.env; set +a; pnpm dev`）。
- 代码同步：101 仓库为开发主库；116 生产升级 = 101 上 `git archive`/`git push` 走 116 手册的升级路径
  （101→116 的 SSH 授权按「新增密钥不复制旧私钥」纪律另行建立）。
- Redis 不回拷（缓存态，dev 重建即可）。

## 踩坑预防（101 首装实测 + 继承 116 实录）

- **minio tar 嵌套**（101 首装踩中）：tar 是 `-C ~/msf-data minio` 打的（顶层带 `minio/` 包裹），
  restore 必须 `--strip-components=1`（已修进脚本）；否则 bucket 全空且首次启动会初始化出一份新 .minio.sys。
- Windows 编辑的 `.sh`/`.env` scp 到 Linux 后 `sed -i 's/\r$//'`（CRLF 灾难，116 坑①⑤）。
- env 文件注释独立行（systemd 不支持行内注释；101 虽无 systemd，保持纪律）。
- 迁移脚本对已含全 schema 的恢复库报列名冲突=正常（116 坑④）。
- 重启长驻进程前 `ss -tlnp` 确认端口真释放（vite 旧进程陷阱同理适用于 101）。
