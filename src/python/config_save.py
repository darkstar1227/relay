import fcntl, json, os, sys, tempfile

path = sys.argv[1]
incoming = json.load(sys.stdin)
if not isinstance(incoming, dict):
    raise ValueError("configuration must be a JSON object")
with os.fdopen(os.open(path + ".lock", os.O_WRONLY | os.O_CREAT, 0o600), "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path) as source:
            cfg = json.load(source)
    except FileNotFoundError:
        cfg = {}
    if not isinstance(cfg, dict):
        raise ValueError("configuration must be a JSON object")
    cfg.update(incoming)
    encoded = json.dumps(cfg, indent=2).encode()
    fd, temporary = tempfile.mkstemp(prefix=".relay-config-", dir=os.path.dirname(path) or ".")
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
