import json, sys
cfg_path, name, hhmm = sys.argv[1], sys.argv[2], (sys.argv[3] or None)
cfg = json.load(open(cfg_path))
entries = cfg.get('warmup', [])
if hhmm:
    remaining = [e for e in entries if not (e.get('account') == name and e.get('time') == hhmm)]
else:
    remaining = [e for e in entries if e.get('account') != name]
removed = len(entries) - len(remaining)
cfg['warmup'] = remaining
json.dump(cfg, open(cfg_path, 'w'), indent=2)
print(removed)
