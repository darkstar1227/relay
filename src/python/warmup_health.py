import json, sys
from collections import defaultdict

cfg_path, log_path = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(cfg_path))
except Exception:
    sys.exit(0)
entries = cfg.get('warmup', [])
if not entries:
    sys.exit(0)

counts = defaultdict(lambda: {'total': 0, 'bad': 0})
try:
    with open(log_path) as f:
        lines = f.readlines()[-2000:]
except Exception:
    lines = []

for line in lines:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    ev = rec.get('event')
    if ev == 'warmup_missed':
        key = f"{rec.get('account')}|{rec.get('time')}"
        counts[key]['total'] += 1
        counts[key]['bad'] += 1
    elif ev == 'warmup_ping':
        acct = rec.get('account')
        for e in entries:
            if e.get('account') == acct:
                key = f"{acct}|{e.get('time')}"
                counts[key]['total'] += 1
                if not rec.get('ok'):
                    counts[key]['bad'] += 1

R='\033[0m'; YL='\033[33m'
for e in entries:
    key = f"{e.get('account')}|{e.get('time')}"
    c = counts.get(key)
    if c and c['total'] >= 3 and c['bad'] >= 3:
        print(f"  {YL}⚠ warmup: {e.get('account')} {e.get('time')} missed {c['bad']}/{c['total']} recent{R}")
