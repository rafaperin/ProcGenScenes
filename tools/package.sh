#!/bin/bash
# Builds index.html and produces the critic package in out/<round>/ : 6 poses @1440p, recording, contact sheets, consecutive-frame strips
T=/home/admin/Documents/ProcGenScenes/tools; cd $T; R=out/$1; mkdir -p $R
node build.mjs || exit 1
H=/home/admin/Documents/ProcGenScenes/index.html
node shots.mjs $H $R 2560 1440 64 -- pose1_narrow_tunnel=pose=0 pose2_tunnel_to_cavern=pose=1 pose3_vertical_shaft=pose=2 pose4_dark_void=pose=3 pose5_dense_formations=pose=4 pose6_lake=pose=5
node record.mjs $H $R 30 1280 720
python3 - $R <<'P'
import sys
from PIL import Image
R=sys.argv[1]
fr=lambda i: Image.open(f'{R}/frames/f{i:04d}.jpg')
for k in range(3):
    s=Image.new('RGB',(640*4,360*5))
    for j in range(20):
        t=k*20+j; s.paste(fr(t*30+15).resize((640,360),Image.LANCZOS),((j%4)*640,(j//4)*360))
    s.save(f'{R}/tour_sheet_{k+1}_t{k*20}-{k*20+19}s.jpg',quality=90)
# consecutive frames (1/30 s apart) to judge temporal stability
for name,f0 in (('squeeze',420),('cathedral',600),('lake',780),('chasm',1050),('collapse',1300),('shaft',1700)):
    s=Image.new('RGB',(1280*2,720*2))
    for j in range(4): s.paste(fr(f0+j),((j%2)*1280,(j//2)*720))
    s.save(f'{R}/consecutive_{name}.jpg',quality=92)
P
ls $R | grep -v frames
