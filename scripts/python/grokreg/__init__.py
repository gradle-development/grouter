"""Grok (xAI) auto-register — vendored from maxucheng0/grok-auto-register.

CLI: python -m grokreg register [--proxy URL] [--mail-provider cloudflare] ...
Stdout JSON (one line):
  {"status":"success","email":"...","password":"...","sso":"..."}
  {"status":"failed","error":"..."}
"""

from .runner import run_register_once

__all__ = ["run_register_once"]
