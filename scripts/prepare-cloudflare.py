#!/usr/bin/env python3
"""Prepare the existing strict deployment profile for a local Cloudflare Tunnel."""
import argparse
import importlib.util
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("oracle_profile", ROOT / "scripts/prepare-oracle.py")
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)

parser = argparse.ArgumentParser()
parser.add_argument("--hostname", required=True)
args = parser.parse_args()
profile.prepare(args.hostname)
path = ROOT / ".deploy/compose.yaml"
config = yaml.safe_load(path.read_text())
config["name"] = "obbianlab-cloudflare"
config["services"].pop("caddy")
config["volumes"].pop("caddy-data")
config["volumes"].pop("caddy-config")
config["services"]["web"]["ports"] = ["127.0.0.1:3000:3000"]
provider_path = ROOT / ".deploy/openai-provider.json"
provider = json.loads(provider_path.read_text()) if provider_path.exists() else {}
if provider.get("enabled") is True:
    api_key, model = provider["api_key"], provider["model"]
    if not isinstance(api_key, str) or not api_key or not isinstance(model, str) or not model:
        raise ValueError("Invalid private OpenAI configuration")
    config["services"]["ai"]["environment"].update(
        AI_PROVIDER_MODE="hosted",
        LLM_BASE_URL="https://api.openai.com",
        LLM_API_KEY=api_key,
        LLM_MODEL=model,
        EMBEDDING_BASE_URL="https://api.openai.com",
        EMBEDDING_API_KEY=api_key,
        EMBEDDING_MODEL="text-embedding-3-small",
        ASR_API_KEY="",
    )
    config["services"]["web"]["environment"].update(
        AI_PROVIDER_MODE="hosted", ASSESSMENT_MODE="true",
    )
path.write_text(yaml.safe_dump(config, sort_keys=False))
path.chmod(0o600)
print("Cloudflare profile ready; only the web port is bound to localhost:3000.")
