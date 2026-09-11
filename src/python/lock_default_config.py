import json, sys, os
creds_dir, cfg_path = sys.argv[1], sys.argv[2]
order_file = os.path.join(os.path.dirname(creds_dir), 'order')
on_disk = set(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json'))
accounts = []
if os.path.exists(order_file):
    for line in open(order_file):
        n = line.strip()
        if n in on_disk and n not in accounts:
            accounts.append(n)
for n in sorted(on_disk):
    if n not in accounts:
        accounts.append(n)
with open(order_file, 'w') as f:
    f.write('\n'.join(accounts) + ('\n' if accounts else ''))
config = {
    'order': accounts,
    'thresholds': {a: 80 for a in accounts},
    'locks': [],
    'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
}
json.dump(config, open(cfg_path, 'w'), indent=2)
