import json, sys
cfg_path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
locks = cfg.get('locks', [])
if name not in locks:
    print(f'  not locked: {name}')
    sys.exit(0)
locks.remove(name)
cfg['locks'] = locks
json.dump(cfg, open(cfg_path, 'w'), indent=2)
