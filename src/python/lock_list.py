import json, sys
cfg = json.load(open(sys.argv[1]))
locks = cfg.get('locks', [])
R='\033[0m'; B='\033[1m'; D='\033[2m'; YL='\033[33m'
if not locks:
    print(f'  {D}No accounts locked.{R}')
else:
    for name in locks:
        print(f'  {YL}🔒{R}  {B}{name}{R}')
print()
