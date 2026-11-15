#!/bin/bash
# usage: [HTML=..] [RW= RH= SETTLE=] sheet.sh <sheetname> name=query ...
T=/home/admin/Documents/ProcGenScenes/tools
cd $T; name=$1; shift
node shots.mjs ${HTML:-/home/admin/Documents/ProcGenScenes/src/dev.html} out ${RW:-1280} ${RH:-720} ${SETTLE:-48} -- "$@" 2>&1
python3 - "$name" "$@" <<'P'
import sys
from PIL import Image
name=sys.argv[1]; names=[a.split('=')[0] for a in sys.argv[2:]]
n=len(names); cols=1 if n==1 else 2 if n<=4 else 3; rows=(n+cols-1)//cols; tw=1920//cols; th=tw*9//16
s=Image.new('RGB',(tw*cols,th*rows))
for i,nm in enumerate(names):
    s.paste(Image.open(f'out/{nm}.png').resize((tw,th),Image.LANCZOS),((i%cols)*tw,(i//cols)*th))
s.save(f'out/{name}.png')
P
