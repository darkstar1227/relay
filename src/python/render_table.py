import sys, os, json, glob, datetime, urllib.request, urllib.error, urllib.parse, platform, subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

mode, creds_dir, meta_dir, current = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
no_usage = '--no-usage' in sys.argv
relay_dir = os.path.dirname(creds_dir)
cache_file = os.path.join(relay_dir, 'usage_cache.json')

# Load locks from autoswitch config (best-effort, no error if missing)
_locks = []
try:
    _as_cfg = json.load(open(os.path.join(relay_dir, 'autoswitch.json')))
    _locks = _as_cfg.get('locks', [])
except Exception:
    pass
CACHE_TTL = 120  # seconds

R='\033[0m'; B='\033[1m'; D='\033[2m'
CY='\033[36m'; GR='\033[32m'; YL='\033[33m'; RD='\033[31m'; MG='\033[35m'

def color(u): return GR if u < 50 else (YL if u < 80 else RD)

def bar(u, w=10):
    f = round(u/100*w)
    return color(u) + '[' + '█'*f + '░'*(w-f) + ']' + R

def reset_in(iso):
    try:
        ts = datetime.datetime.fromisoformat(iso.replace('Z','+00:00'))
        s = (ts - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if s <= 0: return 'resetting'
        h, rem = divmod(int(s), 3600)
        return f'{h}h{rem//60:02d}m'
    except Exception:
        return '—'

def read_order(creds_dir):
    relay_dir = os.path.dirname(creds_dir)
    order_file = os.path.join(relay_dir, 'order')
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

names = read_order(creds_dir)
if not names:
    print(f'  \033[33m⚠\033[0m No accounts yet. Run: {B}relay add <name>{R}')
    sys.exit(0)

def get_email(name):
    p = os.path.join(meta_dir, name)
    try:
        return open(p).read().strip() or '—'
    except Exception:
        return '—'

def update_live_creds(content):
    if platform.system() == 'Darwin':
        user = subprocess.run(['whoami'], capture_output=True, text=True).stdout.strip()
        svc = 'Claude Code-credentials'
        subprocess.run(['security', 'delete-generic-password', '-s', svc, '-a', user], capture_output=True)
        subprocess.run(['security', 'add-generic-password', '-s', svc, '-a', user, '-w', content], capture_output=True)
    else:
        live = os.path.join(os.path.expanduser('~'), '.claude', '.credentials.json')
        with open(live, 'w') as f: f.write(content)
        os.chmod(live, 0o600)

def try_refresh(name, cred_path):
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        refresh_tok = oauth.get('refreshToken', '')
        if not refresh_tok:
            return None
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': refresh_tok, 'client_id': '9d1c250a-e61b-44d9-88ed-5944d1962f5e'}).encode()
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/oauth/token',
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0', 'anthropic-version': 'oauth-2025-04-20'})
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        oauth['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth['refreshToken'] = resp['refresh_token']
        expires_in = resp.get('expires_in', 3600)
        oauth['expiresAt'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + expires_in * 1000
        d['claudeAiOauth'] = oauth
        content = json.dumps(d)
        with open(cred_path, 'w') as f: f.write(content)
        os.chmod(cred_path, 0o600)
        # Re-read CURRENT_FILE freshly — do_switch() may have fired during the
        # parallel fetch, making the captured `current` arg stale. Writing
        # keychain with a stale current would clobber a concurrent account switch.
        current_file = os.path.join(relay_dir, 'current')
        live_current = open(current_file).read().strip() if os.path.exists(current_file) else ''
        if name == live_current:
            update_live_creds(content)
        return oauth['accessToken']
    except Exception:
        return None

_cache = None
def load_cache():
    global _cache
    if _cache is not None:
        return _cache
    try:
        _cache = json.load(open(cache_file))
    except Exception:
        _cache = {}
    return _cache

def save_cache(c):
    try:
        with open(cache_file, 'w') as f: json.dump(c, f)
    except Exception:
        pass

def fetch(name, _retried=False):
    cred_path = os.path.join(creds_dir, name + '.json')
    was_refreshed = False
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        tok = oauth.get('accessToken', '')
        if not tok:
            return name, None

        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
        # Pre-emptive: refresh 5 minutes before expiry (300000ms)
        if expires_at_ms and now_ms > expires_at_ms - 300000:
            new_tok = try_refresh(name, cred_path)
            if new_tok:
                tok = new_tok
                was_refreshed = True
            elif now_ms > expires_at_ms:
                return name, 'expired'
            # else: pre-emptive window, refresh failed, token still valid — fall through

        c = load_cache()
        entry = c.get(name)
        if entry and now_ms / 1000 - entry.get('ts', 0) < CACHE_TTL and not was_refreshed:
            return name, entry.get('data')

        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read())
        c[name] = {'ts': now_ms / 1000, 'data': data}
        save_cache(c)
        return name, data
    except urllib.error.HTTPError as e:
        if e.code == 401 and not _retried:
            new_tok = try_refresh(name, cred_path)
            if new_tok:
                return fetch(name, _retried=True)
            return name, 'expired'
        return name, None
    except Exception:
        return name, None

usage = {}
if not no_usage:
    sys.stderr.write('  \033[2mfetching usage...\033[0m\r')
    sys.stderr.flush()
    with ThreadPoolExecutor(max_workers=min(len(names), 6)) as ex:
        for fut in as_completed([ex.submit(fetch, n) for n in names]):
            n, d = fut.result()
            usage[n] = d
    sys.stderr.write(' ' * 30 + '\r')
    sys.stderr.flush()

def u5_str(d):
    if d == 'expired': return f'{YL}⚠ token expired{R}'
    if not d: return '—'
    fh = d.get('five_hour') or {}
    u = int(fh.get('utilization', 0) or 0)
    t = reset_in(fh.get('resets_at', ''))
    c = color(u)
    return f'{bar(u)} {c}{u:3d}%{R} {D}({t}){R}'

def u7_str(d, name=''):
    if d == 'expired': return f'{YL}relay refresh {name}{R}' if name else f'{YL}relay refresh <name>{R}'
    if not d: return '—'
    sd = d.get('seven_day') or {}
    u = sd.get('utilization')
    if u is None: return '—'
    u = int(u)
    c = color(u)
    f = round(u/100*8)
    return f'{c}[' + '█'*f + '░'*(8-f) + f']{R} {c}{u}%{R}'

if mode == 'quick':
    print(f'\n  {B}{MG}relay{R} {D}— switch account{R}')
    print(f'  {D}' + '─'*45 + R)
    for i, name in enumerate(names, 1):
        cur = name == current
        marker = f'{GR}{B}●{R}' if cur else f'{D}{i}{R}'
        ncol = GR + B if cur else B
        email = get_email(name)
        u = u5_str(usage.get(name)) if not no_usage else ''
        lock_badge = f' {YL}🔒{R}' if name in _locks else ''
        print(f'  {marker}  {ncol}{name:<12}{R}  {D}{email:<26}{R}  {u}{lock_badge}')
    print()
    print(f'  {D}switch:{R} {CY}!relay <index or name>{R}   {D}details:{R} {CY}!relay status{R}')
    print()
else:
    print(f'  {B}{"#":<3}{"account":<13} {"email":<28} {"5hr usage":<34} 7d usage{R}')
    print(f'  {D}' + '─'*88 + R)
    for i, name in enumerate(names, 1):
        cur = name == current
        marker = f'{GR}●{R}' if cur else ' '
        ncol = GR + B if cur else B
        email = get_email(name)
        d = usage.get(name)
        u5 = u5_str(d) if not no_usage else '—'
        u7 = u7_str(d, name) if not no_usage else '—'
        lock_badge = f' {YL}🔒{R}' if name in _locks else ''
        # ANSI codes don't consume display width — pad manually for alignment
        print(f'  {marker} {D}{i:<2}{R}{ncol}{name:<12}{R} {email:<28} {u5:<52} {u7}{lock_badge}')
    print()
    n_warn = sum(1 for d in usage.values() if isinstance(d, dict) and (d.get('five_hour') or {}).get('utilization', 0) >= 80)
    if n_warn:
        print(f'  {RD}⚠ {n_warn} account(s) above 80% usage{R}')
