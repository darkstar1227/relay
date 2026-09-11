import json,sys; d=json.load(sys.stdin); print((d.get('claudeAiOauth') or {}).get('accessToken',''))
