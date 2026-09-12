#!/usr/bin/env python3
"""relay autoswitch daemon — runs in background, switches accounts by usage threshold."""
import fcntl, json, os, sys, time, datetime, urllib.request, urllib.error, platform, subprocess, signal, shutil
from contextlib import contextmanager

RELAY_DIR    = os.path.expanduser('~/.claude-relay')
CONFIG_FILE  = os.path.join(RELAY_DIR, 'autoswitch.json')
LOCK_FILE    = os.path.join(RELAY_DIR, 'autoswitch.lock')
CREDENTIAL_LOCK_FILE = os.path.join(RELAY_DIR, 'credential.lock')
LOG_FILE     = os.path.join(RELAY_DIR, 'autoswitch.log')
MANUAL_FILE  = os.path.join(RELAY_DIR, 'manual_switch')
CURRENT_FILE = os.path.join(RELAY_DIR, 'current')
CREDS_DIR    = os.path.join(RELAY_DIR, 'credentials')
CACHE_FILE   = os.path.join(RELAY_DIR, 'usage_cache.json')
CACHE_TTL    = 120  # seconds — same as render_table
WARMUP_STATE_FILE = os.path.join(RELAY_DIR, 'warmup_state.json')

# ── lock ──────────────────────────────────────────────────────────
def write_lock():
    with open(LOCK_FILE, 'w') as f: f.write(str(os.getpid()))

def remove_lock():
    try: os.remove(LOCK_FILE)
    except: pass

def lock_pid():
    try: return int(open(LOCK_FILE).read().strip())
    except: return None

def is_running(pid):
    try: os.kill(pid, 0); return True
    except: return False

def check_single_instance():
    pid = lock_pid()
    if pid and is_running(pid):
        print(f'daemon already running (pid {pid})', file=sys.stderr); sys.exit(1)
    write_lock()

signal.signal(signal.SIGTERM, lambda *_: (remove_lock(), sys.exit(0)))

# ── log ───────────────────────────────────────────────────────────
def rotate_log():
    """Keep last 200 lines if log exceeds 500 lines. Called once at startup."""
    try:
        lines = open(LOG_FILE).readlines()
        if len(lines) > 500:
            with open(LOG_FILE, 'w') as f: f.writelines(lines[-200:])
    except: pass

def log_event(event, **kwargs):
    entry = {'ts': int(time.time()), 'event': event, **kwargs}
    with open(LOG_FILE, 'a') as f: f.write(json.dumps(entry) + '\n')

# ── notify ────────────────────────────────────────────────────────
def notify(title, msg):
    try:
        p = platform.system()
        if p == 'Darwin':
            subprocess.run(['osascript', '-e',
                f'display notification "{msg}" with title "{title}"'],
                capture_output=True, timeout=3)
        elif p == 'Linux':
            subprocess.run(['notify-send', title, msg],
                capture_output=True, timeout=3)
        # Windows: called from .ps1 wrapper, not this script
    except: pass

# ── credentials ───────────────────────────────────────────────────
def kc_read():
    p = platform.system()
    if p == 'Darwin':
        r = subprocess.run(['security', 'find-generic-password',
            '-s', 'Claude Code-credentials', '-a', subprocess.run(
                ['whoami'], capture_output=True, text=True).stdout.strip(), '-w'],
            capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else ''
    else:
        live = os.path.join(os.path.expanduser('~'), '.claude', '.credentials.json')
        try: return open(live).read()
        except: return ''

def kc_write(content):
    p = platform.system()
    if p == 'Darwin':
        user = subprocess.run(['whoami'], capture_output=True, text=True).stdout.strip()
        svc = 'Claude Code-credentials'
        subprocess.run(['security', 'delete-generic-password', '-s', svc, '-a', user], capture_output=True)
        subprocess.run(['security', 'add-generic-password', '-s', svc, '-a', user, '-w', content], capture_output=True)
    else:
        live = os.path.join(os.path.expanduser('~'), '.claude', '.credentials.json')
        with open(live, 'w') as f: f.write(content)
        os.chmod(live, 0o600)

@contextmanager
def credential_lock():
    os.makedirs(RELAY_DIR, exist_ok=True)
    with open(CREDENTIAL_LOCK_FILE, 'w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)

def do_switch(name):
    with credential_lock():
        cred = os.path.join(CREDS_DIR, name + '.json')
        current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
        if current and os.path.exists(os.path.join(CREDS_DIR, current + '.json')):
            live = kc_read()
            if live:
                with open(os.path.join(CREDS_DIR, current + '.json'), 'w') as f: f.write(live)
        with open(CURRENT_FILE, 'w') as f: f.write(name)
        content = open(cred).read()
        kc_write(content)

def load_warmup_state():
    try: return json.load(open(WARMUP_STATE_FILE))
    except: return {}

def save_warmup_state(s):
    save_json_atomic(WARMUP_STATE_FILE, s)

def get_claude_bin():
    try:
        p = open(os.path.join(RELAY_DIR, 'claude_bin')).read().strip()
        if p and os.path.exists(p): return p
    except: pass
    return shutil.which('claude') or 'claude'

def do_warmup(acct):
    current_before = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
    do_switch(acct)
    log_event('warmup_switch', account=acct)
    try:
        r = subprocess.run([get_claude_bin(), '-p', 'ping', '--output-format', 'text'],
                            capture_output=True, timeout=30)
        ok = (r.returncode == 0)
        log_event('warmup_ping', account=acct, ok=ok)
        notify('relay', f'warmup: {acct} 已完成 5hr session 預熱' if ok
                         else f'warmup: {acct} ping 失敗')
        return ok
    except Exception as e:
        log_event('warmup_ping', account=acct, ok=False, err=str(e))
        return False
    finally:
        if current_before and current_before != acct and os.path.exists(os.path.join(CREDS_DIR, current_before + '.json')):
            do_switch(current_before)
            log_event('warmup_restore', account=current_before)

def check_warmup(entries):
    if not entries: return
    state = load_warmup_state()
    now = datetime.datetime.now()
    today = now.strftime('%Y-%m-%d')
    changed = False
    for entry in entries:
        acct, hhmm = entry.get('account'), entry.get('time')
        if not acct or not hhmm: continue
        key = f'{acct}|{hhmm}'
        if (state.get(key) or {}).get('date') == today:
            continue
        try:
            h, m = map(int, hhmm.split(':'))
            scheduled = now.replace(hour=h, minute=m, second=0, microsecond=0)
        except: continue
        if now < scheduled:
            continue
        if (now - scheduled).total_seconds() > 900:  # 15 min grace window
            state[key] = {'date': today, 'status': 'missed'}
            log_event('warmup_missed', account=acct, time=hhmm)
            changed = True; continue
        if not os.path.exists(os.path.join(CREDS_DIR, acct + '.json')):
            log_event('warmup_pending', account=acct, reason='missing_account')
            continue
        ok = do_warmup(acct)
        state[key] = {'date': today, 'status': 'ok' if ok else 'ping_failed'}
        changed = True
    if changed: save_warmup_state(state)

# ── usage fetch ───────────────────────────────────────────────────
def load_cache():
    try: return json.load(open(CACHE_FILE))
    except: return {}

def save_json_atomic(path, data):
    try:
        tmp = path + '.tmp'
        with open(tmp, 'w') as f: json.dump(data, f)
        os.replace(tmp, path)
    except: pass

def save_cache(c):
    save_json_atomic(CACHE_FILE, c)

# ponytail: intentional copy of try_refresh() — daemon is a standalone extracted script
def try_refresh_daemon(name, cred_path):
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        rt = oauth.get('refreshToken', '')
        if not rt:
            return None
        import urllib.parse
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': '9d1c250a-e61b-44d9-88ed-5944d1962f5e'}).encode()
        req = urllib.request.Request('https://api.anthropic.com/v1/oauth/token', data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0', 'anthropic-version': 'oauth-2025-04-20'})
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        oauth['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth['refreshToken'] = resp['refresh_token']
        oauth['expiresAt'] = int(time.time() * 1000) + resp.get('expires_in', 3600) * 1000
        d['claudeAiOauth'] = oauth
        content = json.dumps(d)
        open(cred_path, 'w').write(content)
        os.chmod(cred_path, 0o600)
        with credential_lock():
            current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
            if name == current:
                kc_write(content)  # critical: update keychain so do_switch() doesn't clobber
        return oauth['accessToken']
    except Exception:
        return None

def fetch_usage(name):
    cred_path = os.path.join(CREDS_DIR, name + '.json')
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        tok = oauth.get('accessToken', '')
        if not tok: return None

        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = time.time() * 1000
        if expires_at_ms and now_ms > expires_at_ms - 300000:
            new_tok = try_refresh_daemon(name, cred_path)
            if new_tok:
                tok = new_tok
            elif now_ms > expires_at_ms:
                return 'expired'

        c = load_cache()
        entry = c.get(name)
        if entry and time.time() - entry.get('ts', 0) < CACHE_TTL:
            return entry.get('data')

        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read())
        c[name] = {'ts': time.time(), 'data': data}
        save_cache(c)
        return data
    except urllib.error.HTTPError as e:
        return 'expired' if e.code == 401 else None
    except: return None

def get_utilization(usage_data):
    """Return 5hr utilization % or None."""
    if not isinstance(usage_data, dict): return None
    fh = usage_data.get('five_hour') or {}
    u = fh.get('utilization')
    return int(u) if u is not None else None

def is_blocked(name, thr_map, locks_list, usage_map):
    """True if account is locked AND at or over its threshold — skip as switch target."""
    if name not in locks_list:
        return False
    util = get_utilization(usage_map.get(name))
    threshold = thr_map.get(name, 80)
    return util is not None and util >= threshold

# ── manual switch protection ───────────────────────────────────────
def get_manual_switch():
    try: return json.load(open(MANUAL_FILE))
    except: return None

def clear_manual_switch():
    try: os.remove(MANUAL_FILE)
    except: pass

# ── main loop ─────────────────────────────────────────────────────
def load_raw_config():
    """Read autoswitch.json's raw contents, or {} if missing/corrupt. Used so
    'warmup' entries work even when load_config()'s auto-default path (which
    omits 'warmup') would otherwise apply."""
    try:
        return json.load(open(CONFIG_FILE))
    except FileNotFoundError:
        return {}
    except Exception as e:
        log_event('config_parse_error', error=str(e))
        return {}

def _read_order(creds_dir):
    order_file = os.path.join(os.path.dirname(creds_dir), 'order')
    on_disk = set(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json')) if os.path.isdir(creds_dir) else set()
    ordered = []
    if os.path.exists(order_file):
        for line in open(order_file):
            n = line.strip()
            if n in on_disk and n not in ordered:
                ordered.append(n)
    for n in sorted(on_disk):
        if n not in ordered:
            ordered.append(n)
    with open(order_file, 'w') as f:
        f.write('\n'.join(ordered) + ('\n' if ordered else ''))
    return ordered

def load_config():
    try:
        return json.load(open(CONFIG_FILE))
    except:
        # Auto-default: 2+ accounts → enable with 80% threshold, no explicit config needed
        if not os.path.isdir(CREDS_DIR):
            return None
        accounts = _read_order(CREDS_DIR)
        if len(accounts) < 2:
            return None
        return {
            'order': accounts,
            'thresholds': {a: 80 for a in accounts},
            'locks': [],
            'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
        }

def main():
    check_single_instance()
    rotate_log()
    log_event('start')
    last_refresh_ts = 0

    while True:
        # Proactive refresh: every 30 minutes, refresh all account tokens
        if time.time() - last_refresh_ts > 1800:
            if os.path.isdir(CREDS_DIR):
                for cred_file in os.listdir(CREDS_DIR):
                    if cred_file.endswith('.json'):
                        acct = cred_file[:-5]
                        try_refresh_daemon(acct, os.path.join(CREDS_DIR, cred_file))
            last_refresh_ts = time.time()

        cfg = load_config()
        raw_cfg = load_raw_config()
        if raw_cfg.get('warmup_enabled', True):
            check_warmup(raw_cfg.get('warmup', []))
        if not cfg:
            time.sleep(60); continue

        order = cfg.get('order', [])
        thresholds = cfg.get('thresholds', {})
        locks = cfg.get('locks', [])
        poll = cfg.get('poll', {})
        low_min   = int(poll.get('low_minutes', 10))
        high_min  = int(poll.get('high_minutes', 2))
        high_thr  = int(poll.get('high_threshold', 50))

        if not order:
            time.sleep(60); continue

        current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''

        usage = {name: fetch_usage(name) for name in order}

        cur_util = get_utilization(usage.get(current))
        sleep_sec = high_min * 60 if (cur_util is not None and cur_util >= high_thr) else low_min * 60

        manual = get_manual_switch()
        if manual and manual.get('account') == current:
            threshold = thresholds.get(current)
            if threshold is not None and cur_util is not None and cur_util >= threshold:
                clear_manual_switch()
            else:
                time.sleep(sleep_sec); continue

        cur_threshold = thresholds.get(current)
        if cur_threshold is None or cur_util is None or cur_util < cur_threshold:
            time.sleep(sleep_sec); continue

        # Ordered cycling: walk order[] from current position, skip blocked accounts.
        # When current isn't in order (removed from the list while still active),
        # every entry is a legitimate candidate -- not just order[1:].
        target = None
        if current in order:
            idx = order.index(current)
            candidates = [order[(idx + i) % len(order)] for i in range(1, len(order))]
        else:
            candidates = order
        for candidate in candidates:
            if not is_blocked(candidate, thresholds, locks, usage):
                target = candidate
                break

        if target is None:
            # All candidates are locked + over threshold — stay put
            log_event('all_blocked', current=current)
            notify('relay', 'All accounts at limit — staying on current account')
            time.sleep(sleep_sec)
            continue

        target_util = get_utilization(usage.get(target))
        log_event('switch', frm=current, to=target, usage=cur_util)
        notify('relay', f'switched {current} → {target} ({current} at {cur_util}%)')
        do_switch(target)
        time.sleep(sleep_sec)

if __name__ == '__main__':
    main()
