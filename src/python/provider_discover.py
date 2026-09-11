import json,sys; print("1" if json.load(open(sys.argv[1])).get("discover_models") else "")
