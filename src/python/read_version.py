import json, sys; print(json.load(open(sys.argv[1]))["version"])
