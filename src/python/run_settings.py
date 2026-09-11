import json, os
base_url = os.environ["RELAY_RUN_BASE_URL"]
token = os.environ["RELAY_RUN_TOKEN"]
model = os.environ.get("RELAY_RUN_MODEL", "")
subagent_model = os.environ.get("RELAY_RUN_SUBAGENT_MODEL", "")
discover = os.environ.get("RELAY_RUN_DISCOVER", "")
env = {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": token}
if model:
    env["ANTHROPIC_MODEL"] = model
if subagent_model:
    env["CLAUDE_CODE_SUBAGENT_MODEL"] = subagent_model
if discover == "1":
    env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
with open(os.environ["RELAY_RUN_SETTINGS_FILE"], "w") as f:
    json.dump({"env": env}, f)
