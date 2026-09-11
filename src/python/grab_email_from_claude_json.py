import json, sys
try:
    d = json.load(open(sys.argv[1]))
    acct = d.get('oauthAccount') or {}
    print(acct.get('emailAddress') or '')
except: print('')
