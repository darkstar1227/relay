import json, sys
cfg_path, name, hhmm = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(cfg_path))
entries = cfg.get('warmup', [])
if not any(e.get('account') == name and e.get('time') == hhmm for e in entries):
    entries.append({'account': name, 'time': hhmm})
cfg['warmup'] = entries
json.dump(cfg, open(cfg_path, 'w'), indent=2)
