#!/usr/bin/env python3
"""Generate an internal bridge secret without printing or replacing existing keys."""
from pathlib import Path
import os
import secrets
p=Path('/opt/astral-hub/.env')
old=p.read_text() if p.exists() else ''
values={line.split('=',1)[0]:line.split('=',1)[1] for line in old.splitlines() if '=' in line and not line.startswith('#')}
addition=[]
if not values.get('PI_BRIDGE_TOKEN'):
    addition.append('PI_BRIDGE_TOKEN='+secrets.token_hex(32))
if not values.get('PI_BRIDGE_URL'):
    addition.append('PI_BRIDGE_URL=http://pi:8790')
if addition:
    tmp=p.with_suffix('.env.new')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(old.rstrip()+'\n'+'\n'.join(addition)+'\n')
    os.replace(tmp,p)
os.chmod(p,0o600)
print('Pi bridge configuration ready; secrets were not displayed.')
