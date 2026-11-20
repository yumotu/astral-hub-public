#!/bin/sh
set -eu
# The root API binds only to Docker's private gateway and requires a separate token.
[ "$(id -u)" = 0 ] || { echo '请以 root 安装主机终端服务。'; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo '此安装脚本当前固定 Linux x64 Node 构建。'; exit 1; }
terminal_dir=/opt/astral-terminal
terminal_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
terminal_archive=${1:-/tmp/astral-node26-linux-x64.tar.xz}
printf '%s  %s\n' '982aa24dd8be4c889c6a8ab337ddff3b0896645b20f4239356e80552c16277ee' "$terminal_archive" | sha256sum -c -
umask 077
mkdir -p "$terminal_dir/runtime"
tar -xJf "$terminal_archive" -C "$terminal_dir/runtime"
terminal_node="$terminal_dir/runtime/node-v26.7.0-linux-x64"
cp "$terminal_source/pi/terminal-host.mjs" "$terminal_source/pi/terminal-runtime.mjs" "$terminal_dir/"
cp "$terminal_source/terminal/package.json" "$terminal_source/terminal/package-lock.json" "$terminal_dir/"
PATH="$terminal_node/bin:$PATH"; export PATH
cd "$terminal_dir"
npm ci --ignore-scripts --omit=dev --no-audit
node "$terminal_node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild --directory="$terminal_dir/node_modules/node-pty" --nodedir="$terminal_node"
node --input-type=module -e "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);require('./node_modules/node-pty');console.log('Host PTY module ready')"
terminal_gateway=$(docker network inspect astral-hub_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
TERMINAL_PRIVATE_GATEWAY="$terminal_gateway" python3 - <<'PY'
from pathlib import Path
import os,secrets
root=Path('/opt/astral-terminal')
env=root/'terminal.env'
values={}
if env.exists():
 for line in env.read_text().splitlines():
  if '=' in line:
   k,v=line.split('=',1);values[k]=v
values.update(TERMINAL_BIND=os.environ['TERMINAL_PRIVATE_GATEWAY'],TERMINAL_PORT='8791',ASTRAL_TERMINAL_PTY=str(root/'node_modules/node-pty'))
values.setdefault('TERMINAL_BRIDGE_TOKEN',secrets.token_hex(32))
env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));env.chmod(0o600)
app=Path('/opt/astral-hub/.env')
backup=root/'app-env-before-terminal.env'
if not backup.exists():backup.write_bytes(app.read_bytes());backup.chmod(0o600)
updates={'TERMINAL_BRIDGE_URL':'http://'+values['TERMINAL_BIND']+':8791','TERMINAL_BRIDGE_TOKEN':values['TERMINAL_BRIDGE_TOKEN']}
lines=[]
for line in app.read_text().splitlines():
 if line.split('=',1)[0] not in updates:lines.append(line)
lines.extend(k+'='+v for k,v in updates.items())
app.write_text('\n'.join(lines)+'\n');app.chmod(0o600)
PY
cat > /etc/systemd/system/astral-terminal.service <<EOF
[Unit]
Description=Astral private host terminal bridge
After=network.target docker.service
Requires=docker.service
[Service]
Type=simple
User=root
WorkingDirectory=$terminal_dir
EnvironmentFile=$terminal_dir/terminal.env
Environment=PATH=$terminal_node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$terminal_node/bin/node $terminal_dir/terminal-host.mjs
Restart=on-failure
RestartSec=3
MemoryMax=512M
TasksMax=128
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now astral-terminal.service
systemctl restart astral-terminal.service
printf '主机终端服务已启动，仅绑定 Docker 私有网关。\n'
