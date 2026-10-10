#!/usr/bin/env bash
# MSF 101 用户态引导（无 sudo；前置：源码已在 ~/All-Projects/msf，setup-sudo.sh 已跑完且新 SSH 会话）
# 与 116 的差异：开发机用仓库默认 dev 凭据（pg msf/msf、minio msf/msfsecret、密钥根=代码默认值），
# 不生成随机密钥；msf.env 只有覆盖项（MSF_FILES_PROXY=1）。
# 幂等设计：已存在的步骤跳过。
set -euo pipefail
export PATH="$HOME/opt/node22/bin:$PATH"
MSF_HOME="$HOME/All-Projects/msf"
DATA="$HOME/msf-data"

echo "== 1/8 Node v22.19.0（用户态） =="
if [ ! -x "$HOME/opt/node22/bin/node" ]; then
  mkdir -p "$HOME/opt"
  wget -q --tries=3 -O /tmp/node22.tar.xz \
    https://registry.npmmirror.com/-/binary/node/v22.19.0/node-v22.19.0-linux-x64.tar.xz
  mkdir -p "$HOME/opt/node22"
  tar -xJf /tmp/node22.tar.xz -C "$HOME/opt/node22" --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
node -v

echo "== 2/8 pnpm 10.6.1（corepack，走 npmmirror） =="
export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
corepack enable --install-directory "$HOME/opt/node22/bin" 2>/dev/null || true
corepack prepare pnpm@10.6.1 --activate
pnpm -v

echo "== 3/8 依赖安装 + 构建（npmmirror；build 验证工具链且 migrate/reencrypt 需要 dist） =="
cd "$MSF_HOME"
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
pnpm build

echo "== 4/8 数据目录 =="
mkdir -p "$DATA/pg" "$DATA/minio" "$DATA/redis"
chmod 700 "$DATA"

echo "== 5/8 msf.env（dev 覆盖项；无密钥） =="
ENV_FILE="$MSF_HOME/deploy/101/msf.env"
if [ ! -f "$ENV_FILE" ]; then
  cp deploy/101/msf.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "msf.env 已生成"
else
  echo "msf.env 已存在，跳过（不覆盖）"
fi

echo "== 6/8 起 infra 容器（pg/redis，dev 默认凭据，bind 挂载 $DATA） =="
docker network create msf_sandbox 2>/dev/null || true
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-postgres; then
  docker run -d --name msf-postgres --restart=always \
    -p 127.0.0.1:5432:5432 \
    -e POSTGRES_USER=msf -e POSTGRES_PASSWORD=msf -e POSTGRES_DB=msf \
    -v "$DATA/pg:/var/lib/postgresql/data" \
    postgres:16
fi
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-redis; then
  docker run -d --name msf-redis --restart=always \
    -p 127.0.0.1:6379:6379 \
    -v "$DATA/redis:/data" \
    redis:7 --appendonly yes
fi
# minio 在数据恢复后再启动（restore-data.sh 负责）

echo "== 7/8 沙箱镜像 =="
docker pull alpine:3.20 || echo "alpine 拉取失败（可稍后重试，不影响主流程）"

echo "== 8/8 等 PG 就绪 =="
for i in $(seq 1 30); do
  docker exec msf-postgres pg_isready -U msf >/dev/null 2>&1 && break
  sleep 1
done
docker exec msf-postgres pg_isready -U msf

echo "完成。下一步：restore-data.sh（灌 116 回拷的 pg dump + minio 数据 + 密钥换根重加密）"
