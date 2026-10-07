#!/usr/bin/env bash
# MSF 部署到 116：一次性 sudo 安装（docker + systemd 单元 + frp 子域名）
# 前置：~/All-Projects/msf 已由部署脚本就位（本文件即在仓库内）
# 用法（Windows 管理机 Git Bash）：
#   ssh -t -i ~/.ssh/id_ed25519_superopen_192_168_10_116 -o IdentitiesOnly=yes \
#     -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_superopen_192_168_10_116 \
#     superopen@192.168.10.116 'sudo bash ~/All-Projects/msf/deploy/116/setup-sudo.sh'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }

echo "== 安装 docker.io =="
apt-get update -qq
apt-get install -y -qq docker.io
systemctl enable --now docker
usermod -aG docker superopen

echo "== docker 镜像加速（国内直连不稳时生效） =="
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

echo "== 安装 msf-app systemd 单元 =="
install -m 644 /home/superopen/All-Projects/msf/deploy/116/msf-app.service /etc/systemd/system/msf-app.service
systemctl daemon-reload
systemctl enable msf-app
# 注意：不在此 start——env/数据由部署脚本随后备齐，齐后 sudo systemctl start msf-app

echo "== frpc 追加 cc-msf 子域名（→ 127.0.0.1:18920） =="
if ! grep -q 'cc-msf' /home/superopen/frpc/frpc.toml; then
  cat >> /home/superopen/frpc/frpc.toml <<'EOF'

[[proxies]]
name = "cc-msf"
localIP = "127.0.0.1"
localPort = 18920
subdomain = "cc-msf"
EOF
  systemctl restart frpc
  echo "frpc 已重载"
else
  echo "cc-msf 已存在，跳过"
fi

echo "== 完成 =="
echo "docker 组需新 SSH 会话生效；后续：部署脚本备齐数据后执行 sudo systemctl start msf-app"
