import json, sys
cfg_path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
cfg['order'] = [n for n in cfg.get('order', []) if n != name]
cfg['thresholds'] = {k: v for k, v in cfg.get('thresholds', {}).items() if k != name}
cfg['locks'] = [n for n in cfg.get('locks', []) if n != name]
json.dump(cfg, open(cfg_path, 'w'), indent=2)
