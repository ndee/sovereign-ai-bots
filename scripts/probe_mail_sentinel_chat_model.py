#!/usr/bin/env python3

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "bots" / "mail-sentinel" / "sovereign-bot.json"


def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def probe_openrouter(model: str) -> dict:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
      return {
          "ok": False,
          "skipped": True,
          "reason": "OPENROUTER_API_KEY is not set",
      }

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with ok."}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "ping",
                    "description": "Return pong",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                        },
                        "required": ["value"],
                    },
                },
            }
        ],
        "tool_choice": "auto",
        "max_tokens": 32,
    }
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/ndee/sovereign-ai-bots",
            "X-Title": "Mail Sentinel chat model probe",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.load(response)
        choice = (body.get("choices") or [{}])[0]
        return {
            "ok": True,
            "skipped": False,
            "finish_reason": choice.get("finish_reason"),
            "id": body.get("id"),
        }
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "skipped": False,
            "status": error.code,
            "detail": detail,
        }


def main() -> int:
    manifest = load_manifest()
    model = manifest["agentTemplate"]["model"]
    result = {
        "manifest": str(MANIFEST_PATH),
        "model": model,
        "probe": probe_openrouter(model),
    }
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0 if result["probe"].get("ok") or result["probe"].get("skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
