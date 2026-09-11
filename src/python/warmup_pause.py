import json, sys
cfg_path = sys.argv[1]
cfg = json.load(open(cfg_path))
cfg['warmup_enabled'] = False
json.dump(cfg, open(cfg_path, 'w'), indent=2)
