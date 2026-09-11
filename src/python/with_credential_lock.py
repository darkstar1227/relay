import fcntl, sys
lockfile, ready_fifo, release_fifo = sys.argv[1], sys.argv[2], sys.argv[3]
with open(lockfile, "a") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    with open(ready_fifo, "w") as ready:
        ready.write("ready\n")
    open(release_fifo, "r").read()
