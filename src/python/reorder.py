import json, sys
cfg_path, order_str = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
cfg['order'] = order_str.split(',')
json.dump(cfg, open(cfg_path, 'w'), indent=2)
