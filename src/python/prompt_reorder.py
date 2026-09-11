import sys, re
raw = sys.argv[1].strip()
accts = sys.argv[2:]
if not raw:
    result = accts
elif raw.isdigit() and not re.search(r'[\s,]', raw) and len(accts) <= 9:
    # concatenated shorthand, e.g. "312" -> [3, 1, 2], only unambiguous for <=9 accounts
    result = []
    for ch in raw:
        idx = int(ch) - 1
        if 0 <= idx < len(accts):
            result.append(accts[idx])
else:
    tokens = re.split(r'[\s,]+', raw)
    result = []
    for t in tokens:
        t = t.strip()
        if t.isdigit():
            idx = int(t) - 1
            if 0 <= idx < len(accts):
                result.append(accts[idx])
        elif t:
            result.append(t)
print(','.join(result))
