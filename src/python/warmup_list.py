import json, sys
cfg = json.load(open(sys.argv[1]))
if not cfg.get('warmup_enabled', True):
    print('  \033[33m⏸ warmup paused\033[0m — run \'relay warmup resume\' to re-enable')
entries = cfg.get('warmup', [])
if not entries:
    print('  No warmup entries. Run: relay warmup add <account> <HH:MM>')
    sys.exit(0)
try:
    state = json.load(open(sys.argv[2]))
except Exception:
    state = {}
labels = {
    'ok': '成功', 'ping_failed': 'ping 失敗', 'missed': '錯過',
    'missing_account': '帳號不存在',
}
for e in entries:
    acct, hhmm = e.get('account'), e.get('time')
    rec = state.get(f'{acct}|{hhmm}')
    if rec:
        status = labels.get(rec.get('status'), rec.get('status'))
        print(f"  {acct:<12} {hhmm}   最後: {rec.get('date')} {status}")
    else:
        print(f"  {acct:<12} {hhmm}   尚未觸發")
