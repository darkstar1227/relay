import json, sys
d = json.load(open(sys.argv[1]))
print(",".join(d.get("codex_models") or []))
