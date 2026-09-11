import json, sys, datetime, urllib.request, urllib.parse

creds_path, name, email = sys.argv[1], sys.argv[2], sys.argv[3]
R='\033[0m'; B='\033[1m'; D='\033[2m'
GR='\033[32m'; YL='\033[33m'; RD='\033[31m'; CY='\033[36m'

print(f'  {B}Account:{R} {GR}{B}{name}{R}')
print(f'  {B}Email:{R}   {email}')

# ponytail: intentional copy of try_refresh() — cmd_status has its own heredoc scope
def _try_refresh(cred_path):
    try:
        d2 = json.load(open(cred_path))
        oauth2 = d2.get('claudeAiOauth') or {}
        rt = oauth2.get('refreshToken', '')
        if not rt:
            return None
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': '9d1c250a-e61b-44d9-88ed-5944d1962f5e'}).encode()
        req2 = urllib.request.Request('https://api.anthropic.com/v1/oauth/token', data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0', 'anthropic-version': 'oauth-2025-04-20'})
        with urllib.request.urlopen(req2, timeout=10) as r2:
            resp = json.loads(r2.read())
        oauth2['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth2['refreshToken'] = resp['refresh_token']
        oauth2['expiresAt'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + resp.get('expires_in', 3600) * 1000
        d2['claudeAiOauth'] = oauth2
        import os; open(cred_path, 'w').write(json.dumps(d2)); os.chmod(cred_path, 0o600)
        return oauth2['accessToken']
    except Exception:
        return None

try:
    d = json.load(open(creds_path))
    oauth = d.get('claudeAiOauth') or {}
    tok = oauth.get('accessToken', '')
    if not tok:
        print(f'\n  {YL}⚠ No access token — please log in again{R}'); sys.exit(0)
    expires_at_ms = oauth.get('expiresAt', 0)
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    if expires_at_ms and now_ms > expires_at_ms - 300000:
        new_tok = _try_refresh(creds_path)
        if new_tok:
            tok = new_tok
        elif now_ms > expires_at_ms:
            print(f'\n  {YL}⚠ Token expired — run: relay refresh {name}{R}'); sys.exit(0)
    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        u = json.loads(r.read())
except Exception as e:
    print(f'\n  {RD}✗ Usage query failed: {e}{R}'); sys.exit(0)

def color(x): return GR if x < 50 else (YL if x < 80 else RD)
def bar(x, w=24):
    f = round(x/100*w); return '█'*f + '░'*(w-f)
def til(iso):
    try:
        ts = datetime.datetime.fromisoformat(iso.replace('Z','+00:00'))
        s = (ts - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if s <= 0: return 'resetting now'
        h, rem = divmod(int(s), 3600)
        return f'resets in {h}h {rem//60:02d}m'
    except Exception: return '—'

fh = u.get('five_hour') or {}
u5 = int(fh.get('utilization', 0) or 0)
c5 = color(u5)
print(f'\n  {B}5hr usage:{R}')
print(f'    {c5}[{bar(u5)}]{R} {c5}{B}{u5}%{R}')
print(f'    {D}{til(fh.get("resets_at",""))}{R}')

sd = u.get('seven_day') or {}
if sd and sd.get('utilization') is not None:
    u7 = int(sd['utilization']); c7 = color(u7)
    print(f'\n  {B}7d usage:{R}')
    print(f'    {c7}[{bar(u7)}]{R} {c7}{u7}%{R}')
    if sd.get('resets_at'):
        print(f'    {D}{til(sd["resets_at"])}{R}')

print()
if u5 >= 90:   print(f'  {RD}{B}⚠  Approaching limit — consider switching: !relay <other>{R}')
elif u5 >= 70: print(f'  {YL}⚡ Usage is high — watch for rate limits{R}')
else:          print(f'  {GR}✓  Usage is normal{R}')
