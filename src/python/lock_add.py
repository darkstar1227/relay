import json, sys
cfg_path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
locks = cfg.get('locks', [])
if name in locks:
    print(f'  already locked: {name}')
    sys.exit(0)
locks.append(name)
cfg['locks'] = locks
json.dump(cfg, open(cfg_path, 'w'), indent=2)
