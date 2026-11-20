#!/bin/sh
# 安装为服务器 /usr/local/bin/pi；CLI 的权限限于 Pi 容器。
set -eu
cd /opt/astral-hub
if [ -t 0 ] && [ -t 1 ]; then
    exec docker compose --env-file .env -f deploy/compose.tunnel.yml exec --workdir /workspace pi pi --provider astral-deepseek --model "${DEEPSEEK_MODEL:-deepseek-flash}" "$@"
else
    exec docker compose --env-file .env -f deploy/compose.tunnel.yml exec -T --workdir /workspace pi pi --provider astral-deepseek --model "${DEEPSEEK_MODEL:-deepseek-flash}" "$@"
fi
