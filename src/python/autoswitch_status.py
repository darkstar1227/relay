import json, sys, os, time

cfg = json.load(open(sys.argv[1]))
current = sys.argv[2]
order = cfg.get('order', [])
thresholds = cfg.get('thresholds', {})
locks = cfg.get('locks', [])
relay_dir = os.path.expanduser('~/.claude-relay')
cache_file = os.path.join(relay_dir, 'usage_cache.json')

R='\033[0m'; B='\033[1m'; D='\033[2m'
GR='\033[32m'; YL='\033[33m'; RD='\033[31m'; CY='\033[36m'

try: cache = json.load(open(cache_file))
except: cache = {}

def get_util(name):
    entry = cache.get(name)
    if not entry: return None
    data = entry.get('data') if isinstance(entry, dict) else None
    if not isinstance(data, dict): return None
    fh = data.get('five_hour') or {}
    u = fh.get('utilization')
    return int(u) if u is not None else None

print(f'  {B}{"order":<4} {"account":<14} {"threshold":<12} {"cached usage":<14} {"lock":<6}{R}')
print(f'  {D}{"─"*58}{R}')
for i, name in enumerate(order, 1):
    cur = name == current
    marker = f'{GR}●{R}' if cur else ' '
    ncol = GR + B if cur else B
    thr = thresholds.get(name)
    thr_s = f'{thr}%' if thr is not None else f'{D}skipped{R}'
    util = get_util(name)
    util_s = f'{util}%' if util is not None else f'{D}—{R}'
    over = thr is not None and util is not None and util >= thr
    if over: util_s += f' {YL}⚠ over{R}'
    next_s = ''
    if not cur and not over:
        prev_over = all(
            (thresholds.get(order[j]) is not None and
             get_util(order[j]) is not None and
             get_util(order[j]) >= thresholds[order[j]])
            for j in range(i-1)
        )
        if prev_over: next_s = f' {CY}← next{R}'
    lock_s = f' {YL}🔒{R}' if name in locks else ''
    print(f'  {marker} {D}{i:<2}{R}{ncol}{name:<14}{R} {thr_s:<12} {util_s}{next_s}{lock_s}')

log_file = os.path.join(os.path.dirname(sys.argv[1]), 'autoswitch.log')
try:
    lines = open(log_file).readlines()
    for line in reversed(lines):
        e = json.loads(line)
        if e.get('event') == 'switch':
            print(f'\n  {B}Last switch:{R} {e["frm"]} → {e["to"]}')
            break
except: pass
