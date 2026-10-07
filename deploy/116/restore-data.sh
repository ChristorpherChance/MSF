#!/usr/bin/env bash
# MSF 116 数据恢复（无 sudo；前置：bootstrap-user.sh 完成；dump 已 scp 到 /tmp/msf-pg.dump、/tmp/msf-minio.tar）
# ① pg 灌库 ② minio 数据落位后起容器 ③ 密钥换根重加密 ④ 迁移兜底
set -euo pipefail
export PATH="$HOME/opt/node22/bin:$PATH"
MSF_HOME="$HOME/All-Projects/msf"
DATA="$HOME/msf-data"
set -a; . "$MSF_HOME/deploy/116/msf.env"; set +a

echo "== 1/4 PG 灌库 =="
docker cp /tmp/msf-pg.dump msf-postgres:/tmp/msf-pg.dump
pg_pass="$(printf '%s' "$MSF_DATABASE_URL" | sed -E 's|.*://msf:([^@]+)@.*|\1|')"
# 清空模板生成的空库再灌（docker 初始化已建空 msf 库）
docker exec -e PGPASSWORD="$pg_pass" msf-postgres psql -U msf -d msf -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker exec -e PGPASSWORD="$pg_pass" msf-postgres pg_restore -U msf -d msf --no-owner --no-privileges /tmp/msf-pg.dump
docker exec msf-postgres rm -f /tmp/msf-pg.dump
rm -f /tmp/msf-pg.dump

echo "== 2/4 MinIO 数据落位 + 起容器 =="
if [ -f /tmp/msf-minio.tar ]; then
  tar -xf /tmp/msf-minio.tar -C "$DATA/minio"
  rm -f /tmp/msf-minio.tar
fi
# 注意：minio 镜像被国内 docker 镜像加速站封禁（2026-10-08 实测 daocloud/1ms/xuanyuan 全 403），
# 需从有镜像的机器 docker save → scp → docker load（见 README）
if ! docker ps -a --format '{{.Names}}' | grep -qx msf-minio; then
  docker run -d --name msf-minio --restart=always \
    -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
    -e MINIO_ROOT_USER="$MSF_MINIO_ACCESS_KEY" -e MINIO_ROOT_PASSWORD="$MSF_MINIO_SECRET_KEY" \
    -v "$DATA/minio:/data" \
    quay.io/minio/minio server /data --console-address ':9001'
fi

echo "== 3/4 密钥换根重加密（旧根=本机默认值 → 新根=msf.env 的 MSF_SECRET_KEY） =="
cd "$MSF_HOME/apps/server"
MSF_OLD_SECRET_KEY='msf-dev-secret-local-only' node scripts/reencrypt-keys.mjs

echo "== 4/4 迁移兜底（幂等；恢复库已全部应用则零改动） =="
node dist/db/migrate.js

echo "完成。剩：注入登录口令（sed msf.env 的 <登录口令> 占位）→ sudo systemctl start msf-app → 外网验证"
