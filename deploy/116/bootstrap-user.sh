#!/usr/bin/env bash
# MSF 116 用户态引导（无 sudo；前置：源码已在 ~/All-Projects/msf，setup-sudo.sh 已跑完且新 SSH 会话）
# 幂等设计：已存在的步骤跳过。密钥在服务器侧生成写入 msf.env（600），不回显。
set -euo pipefail
export PATH="$HOME/opt/node22/bin:$PATH"
MSF_HOME="$HOME/All-Projects/msf"
DATA="$HOME/msf-data"

echo "== 1/9 Node v22.19.0（用户态） =="
if [ ! -x "$HOME/opt/node22/bin/node" ]; then
  mkdir -p "$HOME/opt"
  wget -q --tries=3 -O /tmp/node22.tar.xz \
    https://registry.npmmirror.com/-/binary/node/v22.19.0/node-v22.19.0-linux-x64.tar.xz
  mkdir -p "$HOME/opt/node22"
  tar -xJf /tmp/node22.tar.xz -C "$HOME/opt/node22" --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
node -v

echo "== 2/9 pnpm 10.6.1（corepack，走 npmmirror） =="
export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
corepack enable --install-directory "$HOME/opt/node22/bin" 2>/dev/null || true
corepack prepare pnpm@10.6.1 --activate
pnpm -v

echo "== 3/9 依赖安装 + 构建（npmmirror） =="
cd "$MSF_HOME"
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
pnpm build

echo "== 4/9 数据目录 =="
mkdir -p "$DATA/pg" "$DATA/minio" "$DATA/redis"
chmod 700 "$DATA"

echo "== 5/9 生成密钥并写 msf.env（600） =="
ENV_FILE="$MSF_HOME/deploy/116/msf.env"
if [ ! -f "$ENV_FILE" ]; then
  rand() { head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }
  PG_PASS="$(rand 32)"
  MINIO_AK="msf$(rand 8 | tr 'A-Z' 'a-z')"
  MINIO_SK="$(rand 40)"
  SECRET="$(rand 64)"
  # 登录口令由部署者单独注入（见 README，不留在本脚本/历史）：boot 后 sed 占位符
  sed -e "s|<PG密码>|$PG_PASS|" \
      -e "s|<MINIO_ACCESS>|$MINIO_AK|" \
      -e "s|<MINIO_SECRET>|$MINIO_SK|" \
      -e "s|<64位强随机>|$SECRET|" \
      deploy/116/msf.env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "msf.env 已生成（MSF_AUTH_PASS 仍为占位符，待注入）"
else
  echo "msf.env 已存在，跳过（不覆盖）"
fi
set -a; . "$ENV_FILE"; set +a

echo "== 6/9 起 infra 容器（pg/minio/redis，bind 挂载 $DATA） =="
docker network create msf_sandbox 2>/dev/null || true
pg_pass="$(printf '%s' "$MSF_DATABASE_URL" | sed -E 's|.*://msf:([^@]+)@.*|\1|')"
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-postgres; then
  docker run -d --name msf-postgres --restart=always \
    -p 127.0.0.1:5432:5432 \
    -e POSTGRES_USER=msf -e POSTGRES_PASSWORD="$pg_pass" -e POSTGRES_DB=msf \
    -v "$DATA/pg:/var/lib/postgresql/data" \
    postgres:16
fi
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-redis; then
  docker run -d --name msf-redis --restart=always \
    -p 127.0.0.1:6379:6379 \
    -v "$DATA/redis:/data" \
    redis:7 --appendonly yes
fi
# minio 在数据恢复后再启动（bootstrap 第二步由恢复脚本负责）

echo "== 7/9 沙箱镜像 =="
docker pull alpine:3.20 || echo "alpine 拉取失败（可稍后重试，不影响主流程）"

echo "== 8/9 等 PG 就绪 =="
for i in $(seq 1 30); do
  docker exec msf-postgres pg_isready -U msf >/dev/null 2>&1 && break
  sleep 1
done
docker exec msf-postgres pg_isready -U msf

echo "== 9/9 完成 =="
echo "下一步（restore-data.sh）：灌 pg dump + minio 数据 + 起 minio + 重加密 + 迁移 + 注入登录口令"
