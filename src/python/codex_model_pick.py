import json, sys
path = sys.argv[1]
d = json.load(open(path))
models = d.get("codex_models") or []
if not models:
    print("")
    sys.exit(0)
cursor = (d.get("_codex_model_cursor", -1) + 1) % len(models)
d["_codex_model_cursor"] = cursor
with open(path, "w") as f:
    json.dump(d, f)
print(models[cursor])
