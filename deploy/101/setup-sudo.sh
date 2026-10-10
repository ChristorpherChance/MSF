#!/usr/bin/env bash
# MSF 部署到 101（开发机）：一次性 sudo 安装（docker + git）
# 与 116 的差异：101 是开发机——不装 systemd 单元、不配 frpc；服务由开发者用 pnpm dev 前台起
# 前置：~/All-Projects/msf 已就位（本文件即在仓库内）
# 用法（Windows 管理机 Git Bash）：
#   ssh -t -i ~/.ssh/id_ed25519_superopen_192_168_0_143 -o IdentitiesOnly=yes \
#     -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_superopen_192_168_0_143 \
#     superopen@192.168.10.101 'sudo bash ~/All-Projects/msf/deploy/101/setup-sudo.sh'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }

echo "== 安装 docker.io + git =="
apt-get update -qq
apt-get install -y -qq docker.io git
systemctl enable --now docker
usermod -aG docker superopen

echo "== docker 镜像加速（与 116 同口径） =="
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
EOF
systemctl restart docker

echo "== 完成 =="
echo "docker 组需新 SSH 会话生效；101 无 msf-app systemd 单元——开发态服务用 pnpm dev 起"
