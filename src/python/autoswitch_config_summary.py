import json, sys
cfg = json.load(open(sys.argv[1]))
R='\033[0m'; B='\033[1m'; D='\033[2m'; CY='\033[36m'
for i, name in enumerate(cfg['order'], 1):
    thr = cfg['thresholds'].get(name, '?')
    print(f'    {D}{i}.{R} {name:<14} → switch at {CY}{thr}%{R}')
p = cfg['poll']
lo, hi, thr = p['low_minutes'], p['high_minutes'], p['high_threshold']
print(f'\n    {D}polling: {lo}min normal / {hi}min fast (fast above {thr}%){R}')
