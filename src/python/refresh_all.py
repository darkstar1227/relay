import json, sys, datetime, urllib.request, urllib.parse, os

creds_dir, n = sys.argv[1], int(sys.argv[2])
names = sys.argv[3:3+n]
R='\033[0m'; B='\033[1m'; GR='\033[32m'; YL='\033[33m'; RD='\033[31m'

# ponytail: intentional copy of try_refresh() — self-contained heredoc scope
def try_refresh(name, cred_path):
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        rt = oauth.get('refreshToken', '')
        if not rt:
            return None
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': '9d1c250a-e61b-44d9-88ed-5944d1962f5e'}).encode()
        req = urllib.request.Request('https://api.anthropic.com/v1/oauth/token', data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0', 'anthropic-version': 'oauth-2025-04-20'})
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        oauth['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth['refreshToken'] = resp['refresh_token']
        oauth['expiresAt'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + resp.get('expires_in', 3600) * 1000
        d['claudeAiOauth'] = oauth
        open(cred_path, 'w').write(json.dumps(d))
        os.chmod(cred_path, 0o600)
        return oauth['accessToken']
    except Exception:
        return None

for name in names:
    cred_path = os.path.join(creds_dir, name + '.json')
    result = try_refresh(name, cred_path)
    if result:
        print(f'  {GR}✓{R}  {B}{name}{R}  refreshed')
    else:
        print(f'  {YL}⚠{R}  {B}{name}{R}  refresh failed (token may already be fresh or refreshToken expired)')
print()
