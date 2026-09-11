import urllib.request, sys, os, stat, tempfile, subprocess, re
script_path, version = sys.argv[1], sys.argv[2]
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
    print('  invalid release version', file=sys.stderr); sys.exit(1)
url = f'https://raw.githubusercontent.com/darkstar1227/relay/v{version}/relay'
tmp = None
try:
    with urllib.request.urlopen(url, timeout=15) as r:
        content = r.read()
    if not content.startswith(b'#!/usr/bin/env bash\n'):
        raise ValueError('download is not a relay Bash script')
    with tempfile.NamedTemporaryFile(prefix='.relay-update-', dir=os.path.dirname(script_path), delete=False) as f:
        tmp = f.name
        f.write(content)
    syntax = subprocess.run(['/bin/bash', '-n', tmp], capture_output=True)
    if syntax.returncode:
        raise ValueError('downloaded script failed Bash syntax validation')
    # New releases embed a version; older pre-modular releases do not.
    embedded = re.search(rb"^RELAY_BUILD_VERSION='([^']+)'$", content, re.MULTILINE)
    if embedded and embedded.group(1).decode() != version:
        raise ValueError('downloaded script version does not match the release')
    os.chmod(tmp, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    os.replace(tmp, script_path)
except Exception as e:
    print(f'  download failed: {e}', file=sys.stderr); sys.exit(1)
finally:
    if tmp and os.path.exists(tmp):
        os.unlink(tmp)
