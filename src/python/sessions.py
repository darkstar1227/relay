import os, sys, glob, datetime
base = sys.argv[1]
R='\033[0m'; B='\033[1m'; D='\033[2m'; CY='\033[36m'; GR='\033[32m'
total = 0
for proj in sorted(os.listdir(base)):
    pdir = os.path.join(base, proj)
    if not os.path.isdir(pdir): continue
    files = sorted(glob.glob(os.path.join(pdir, '*.jsonl')),
                   key=os.path.getmtime, reverse=True)
    if not files: continue
    print(f'\n  {D}{proj}{R}')
    for i, f in enumerate(files):
        sid = os.path.basename(f)[:-6]
        ts = datetime.datetime.fromtimestamp(os.path.getmtime(f)).strftime('%m/%d %H:%M')
        sz = os.path.getsize(f)
        szs = f'{sz/1048576:.1f}M' if sz > 1048576 else f'{sz//1024}K'
        mark = f'  {GR}← latest{R}' if total == 0 and i == 0 else ''
        print(f'  {CY}{sid:<40}{R} {ts:<12} {szs}{mark}')
        total += 1
print()
print(f'  {total} session(s)' if total else '  No sessions found')
