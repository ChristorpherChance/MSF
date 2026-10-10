#!/usr/bin/env bash
# MSF 101 数据恢复（无 sudo；前置：bootstrap-user.sh 完成）
# 数据来源=116 生产当前态回拷：
#   /tmp/msf-pg.dump        —— 116 上 docker exec msf-postgres pg_dump -U msf -Fc msf
#   /tmp/msf-minio.tar      —— 116 上 ~/msf-data/minio 打包
#   ~/.msf-116-key.tmp      —— 116 的 MSF_SECRET_KEY（600，管道传输未落聊天；本脚本用完即删）
# ① pg 灌库 ② minio 数据落位后起容器 ③ 密钥换根重加密（116 根 → 开发默认根） ④ 迁移兜底
set -euo pipefail
export PATH="$HOME/opt/node22/bin:$PATH"
MSF_HOME="$HOME/All-Projects/msf"
DATA="$HOME/msf-data"

echo "== 1/4 PG 灌库 =="
docker cp /tmp/msf-pg.dump msf-postgres:/tmp/msf-pg.dump
# 清空模板生成的空库再灌（docker 初始化已建空 msf 库）
docker exec -e PGPASSWORD=msf msf-postgres psql -U msf -d msf -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker exec -e PGPASSWORD=msf msf-postgres pg_restore -U msf -d msf --no-owner --no-privileges /tmp/msf-pg.dump
docker exec msf-postgres rm -f /tmp/msf-pg.dump
rm -f /tmp/msf-pg.dump

echo "== 2/4 MinIO 数据落位 + 起容器 =="
if [ -f /tmp/msf-minio.tar ]; then
  tar -xf /tmp/msf-minio.tar -C "$DATA/minio"
  rm -f /tmp/msf-minio.tar
fi
# minio 镜像被国内加速站封禁时：从 116 docker save 经管理机中转 docker load（见 README）
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-minio; then
  docker run -d --name msf-minio --restart=always \
    -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
    -e MINIO_ROOT_USER=msf -e MINIO_ROOT_PASSWORD=msfsecret \
    -v "$DATA/minio:/data" \
    quay.io/minio/minio server /data --console-address ':9001'
fi

echo "== 3/4 密钥换根重加密（旧根=116 的 MSF_SECRET_KEY → 新根=开发默认 msf-dev-secret-local-only） =="
OLD_KEY_FILE="$HOME/.msf-116-key.tmp"
[ -f "$OLD_KEY_FILE" ] || { echo "缺 $OLD_KEY_FILE（116 旧根，管道传输：见 README 第 3 步）"; exit 1; }
cd "$MSF_HOME/apps/server"
MSF_OLD_SECRET_KEY="$(cat "$OLD_KEY_FILE")" MSF_SECRET_KEY='msf-dev-secret-local-only' \
  node scripts/reencrypt-keys.mjs
rm -f "$OLD_KEY_FILE"
echo "116 旧根临时文件已删"

echo "== 4/4 迁移兜底（幂等；恢复库已全部应用则报列名冲突属正常，见 116 README 坑④） =="
node dist/db/migrate.js || echo "迁移报已存在类冲突=恢复库已含全 schema，属正常"

echo "完成。101 为开发机：无登录门（MSF_AUTH_* 未设=零鉴权，同本机 dev 口径）；"
echo "起服务：pnpm dev（web 需 --host 供 LAN 访问，见 README 日常开发节）"
