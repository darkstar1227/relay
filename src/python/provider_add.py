import json, os
path = os.environ["RELAY_PROVIDER_PATH"]
base_url = os.environ["RELAY_PROVIDER_BASE_URL"]
token = os.environ["RELAY_PROVIDER_TOKEN"]
model = os.environ.get("RELAY_PROVIDER_MODEL", "")
subagent_model = os.environ.get("RELAY_PROVIDER_SUBAGENT_MODEL", "")
discover = os.environ.get("RELAY_PROVIDER_DISCOVER", "")
agent = os.environ.get("RELAY_PROVIDER_AGENT", "")
d = {"base_url": base_url, "auth_token": token}
if model:
    d["model"] = model
if subagent_model:
    d["subagent_model"] = subagent_model
if discover == "1":
    d["discover_models"] = True
if agent == "codex":
    d["agent"] = "codex"
with open(path, "w") as f:
    json.dump(d, f)
os.chmod(path, 0o600)
