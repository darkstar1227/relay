import urllib.request, json, sys
def fetch(url, headers={}):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=6) as r:
        return json.loads(r.read())
try:
    d = fetch('https://api.github.com/repos/darkstar1227/relay/releases/latest',
              {'User-Agent': 'relay-update'})
    print(d['tag_name'].lstrip('v')); sys.exit(0)
except Exception:
    pass
try:
    d = fetch('https://registry.npmjs.org/@dst-justin%2frelay/latest')
    print(d['version'])
except Exception:
    sys.exit(1)
