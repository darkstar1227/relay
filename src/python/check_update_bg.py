import urllib.request, json, sys
def fetch(url, h={}):
    r = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(r, timeout=6) as resp:
        return json.loads(resp.read())
try:
    d = fetch('https://api.github.com/repos/darkstar1227/relay/releases/latest',
              {'User-Agent': 'relay-update'})
    print(d['tag_name'].lstrip('v')); sys.exit(0)
except Exception: pass
try:
    d = fetch('https://registry.npmjs.org/@dst-justin%2frelay/latest')
    print(d['version'])
except Exception: sys.exit(1)
