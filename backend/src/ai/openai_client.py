#!/usr/bin/env python3
"""OpenAI Responses API bridge for the Node backend's `codex-py` AI backend.

Reads a prompt from stdin, runs it through client.responses.create, prints the
text to stdout. Keeps the OpenAI dependency in Python (a venv) so the Node
service doesn't need the OpenAI Node SDK — handy when the server's Node/glibc
is finicky.

Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-5.5),
     OPENAI_BASE_URL (optional, for compatible gateways).
Setup:  python3 -m venv ~/openai-venv && ~/openai-venv/bin/pip install -U openai
Then point the Node backend at it via PYTHON_BIN=~/openai-venv/bin/python.
"""
import os
import sys


def main() -> int:
    prompt = sys.stdin.read()
    if not prompt.strip():
        sys.stderr.write("empty prompt\n")
        return 2
    try:
        from openai import OpenAI
    except ImportError:
        sys.stderr.write("openai SDK 未安装:pip install -U openai\n")
        return 4

    model = os.environ.get("OPENAI_MODEL") or "gpt-5.5"
    client = OpenAI()  # OPENAI_API_KEY / OPENAI_BASE_URL from env
    resp = client.responses.create(model=model, input=prompt)
    text = (getattr(resp, "output_text", "") or "").strip()
    if not text:
        sys.stderr.write("empty response from OpenAI\n")
        return 3
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 干净地把错误交给 Node 侧
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)
