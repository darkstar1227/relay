import json, sys, datetime

R='\033[0m'; B='\033[1m'; D='\033[2m'
GR='\033[32m'; YL='\033[33m'; RD='\033[31m'; CY='\033[36m'

lines = open(sys.argv[1]).readlines()
for line in lines[-20:]:
    try:
        e = json.loads(line)
        ts = datetime.datetime.fromtimestamp(e['ts']).strftime('%m/%d %H:%M')
        ev = e['event']
        if ev == 'switch':
            print(f'  {D}{ts}{R}  {GR}switch{R}     {e["frm"]} → {CY}{e["to"]}{R}  ({e.get("usage","?")}%)')
        elif ev == 'all_over_threshold':
            print(f'  {D}{ts}{R}  {YL}all_over{R}   → {CY}{e["selected"]}{R}  ({e.get("usage","?")}%) {YL}⚠{R}')
        elif ev == 'start':
            print(f'  {D}{ts}{R}  {D}daemon start{R}')
    except: pass
