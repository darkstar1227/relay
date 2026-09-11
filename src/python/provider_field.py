import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")
