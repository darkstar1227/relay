import json, sys
path, csv = sys.argv[1], sys.argv[2]
models = [m.strip() for m in csv.split(",") if m.strip()]
d = json.load(open(path))
d["codex_models"] = models
d["_codex_model_cursor"] = -1
with open(path, "w") as f:
    json.dump(d, f)
