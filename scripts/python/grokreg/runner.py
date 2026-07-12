"""
Grok register CLI — mirrors autoclaw subprocess contract.

Usage:
    python -m grokreg register \\
        [--proxy URL] \\
        [--mail-provider cloudflare|duckmail|yyds] \\
        [--cloudflare-api-base URL] \\
        [--cloudflare-api-key KEY] \\
        [--cloudflare-auth-mode none|bearer|x-api-key|x-admin-auth|query-key] \\
        [--domain DOMAIN] \\
        [--duckmail-api-key KEY] \\
        [--enable-cpa] [--enable-nsfw]

Stdout JSON:
    {"status":"success","email":"...","password":"...","sso":"...","access_token":"?","refresh_token":"?"}
    {"status":"failed","error":"..."}
    {"status":"needs_retry","error":"..."}

Progress logs go to stderr as [step] message (Node manager streams them).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

# Package dir first so `cpa_export` / `cpa_xai` resolve for vendored upstream.
_PKG_DIR = Path(__file__).resolve().parent
if str(_PKG_DIR) not in sys.path:
    sys.path.insert(0, str(_PKG_DIR))


def _log(step: str, message: str) -> None:
    print(f"[{step}] {message}", file=sys.stderr, flush=True)


def _extract_oauth_tokens(payload: dict[str, Any]) -> tuple[str, str]:
    """Pull access/refresh from CPA xai-*.json (nested shapes)."""
    if not isinstance(payload, dict):
        return "", ""
    candidates = [
        payload,
        payload.get("auth") if isinstance(payload.get("auth"), dict) else None,
        payload.get("token") if isinstance(payload.get("token"), dict) else None,
        payload.get("oauth") if isinstance(payload.get("oauth"), dict) else None,
    ]
    for obj in candidates:
        if not obj:
            continue
        access = (
            obj.get("access_token")
            or obj.get("AccessToken")
            or obj.get("accessToken")
            or ""
        )
        refresh = (
            obj.get("refresh_token")
            or obj.get("RefreshToken")
            or obj.get("refreshToken")
            or ""
        )
        if access and refresh:
            return str(access), str(refresh)
    return "", ""


def _output(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _import_upstream():
    try:
        from . import _upstream as u
        return u
    except ImportError as e:
        raise SystemExit(
            json.dumps(
                {
                    "status": "failed",
                    "error": (
                        "Missing Python deps for grokreg. Install: "
                        "pip install DrissionPage curl_cffi requests  "
                        f"({e})"
                    ),
                },
                ensure_ascii=False,
            )
        ) from e


def _apply_config(args: argparse.Namespace) -> None:
    u = _import_upstream()

    cfg = u.config
    if args.proxy:
        cfg["proxy"] = args.proxy
    if args.mail_provider:
        cfg["email_provider"] = args.mail_provider
    if args.cloudflare_api_base:
        cfg["cloudflare_api_base"] = args.cloudflare_api_base.rstrip("/")
    if args.cloudflare_api_key is not None:
        cfg["cloudflare_api_key"] = args.cloudflare_api_key
    if args.cloudflare_auth_mode:
        cfg["cloudflare_auth_mode"] = args.cloudflare_auth_mode
    path_accounts = getattr(args, "cloudflare_path_accounts", None)
    if path_accounts:
        cfg["cloudflare_path_accounts"] = path_accounts
    if args.domain:
        cfg["defaultDomains"] = args.domain
    if args.duckmail_api_key:
        cfg["duckmail_api_key"] = args.duckmail_api_key
    if args.yyds_api_key:
        cfg["yyds_api_key"] = args.yyds_api_key
    if args.yyds_jwt:
        cfg["yyds_jwt"] = args.yyds_jwt

    cfg["enable_nsfw"] = bool(args.enable_nsfw)
    cfg["cpa_export_enabled"] = bool(args.enable_cpa)
    cfg["cpa_mint_async"] = False  # subprocess: wait for CPA if enabled
    cfg["grok2api_auto_add_local"] = False
    cfg["grok2api_auto_add_remote"] = False
    cfg["log_level"] = "info"
    if args.headless:
        # DrissionPage has no true headless flag in this vendor; keep for future.
        cfg["cpa_headless"] = True


def run_register_once(
    *,
    proxy: str | None = None,
    mail_provider: str = "cloudflare",
    cloudflare_api_base: str = "",
    cloudflare_api_key: str = "",
    cloudflare_auth_mode: str = "none",
    cloudflare_path_accounts: str = "",
    domain: str = "",
    duckmail_api_key: str = "",
    yyds_api_key: str = "",
    yyds_jwt: str = "",
    enable_cpa: bool = False,
    enable_nsfw: bool = False,
    cancel_callback=None,
) -> dict[str, Any]:
    """Register one Grok account. Returns status dict (not printed)."""
    u = _import_upstream()

    class _Args:
        pass

    args = _Args()
    args.proxy = proxy or ""
    args.mail_provider = mail_provider
    args.cloudflare_api_base = cloudflare_api_base
    args.cloudflare_api_key = cloudflare_api_key
    args.cloudflare_auth_mode = cloudflare_auth_mode
    args.cloudflare_path_accounts = cloudflare_path_accounts or ""
    args.domain = domain
    args.duckmail_api_key = duckmail_api_key
    args.yyds_api_key = yyds_api_key
    args.yyds_jwt = yyds_jwt
    args.enable_cpa = enable_cpa
    args.enable_nsfw = enable_nsfw
    args.headless = False
    _apply_config(args)

    def log_fn(msg: str) -> None:
        text = str(msg or "")
        step = "register"
        low = text.lower()
        if "signup" in low or "open signup" in low or "current url" in low:
            step = "open_signup"
        elif "email" in low or "address" in low:
            step = "email"
        elif "code" in low or "verify" in low:
            step = "verify_code"
        elif "profile" in low:
            step = "profile"
        elif "sso" in low:
            step = "sso_cookie"
        elif "turnstile" in low or "cloudflare" in low:
            step = "turnstile"
        elif "cpa" in low:
            step = "cpa_mint"
        elif "nsfw" in low:
            step = "nsfw"
        elif text.startswith("[!]") or "error" in low or "fail" in low:
            step = "warn"
        _log(step, text)

    stop_fn = cancel_callback or (lambda: False)
    email = ""
    password = ""
    sso = ""
    access_token = ""
    refresh_token = ""

    try:
        u.start_browser(log_callback=log_fn)
        max_mail_retry = 3
        code = ""
        mail_ok = False
        for mail_try in range(1, max_mail_retry + 1):
            if stop_fn():
                return {"status": "cancelled", "error": "cancelled"}
            log_fn(f"[*] open signup (try {mail_try}/{max_mail_retry})")
            u.open_signup_page(log_callback=log_fn, cancel_callback=stop_fn)
            log_fn("[*] create email + submit")
            email, dev_token = u.fill_email_and_submit(
                log_callback=log_fn, cancel_callback=stop_fn
            )
            log_fn(f"[*] email={email}")
            try:
                code = u.fill_code_and_submit(
                    email,
                    dev_token,
                    log_callback=log_fn,
                    cancel_callback=stop_fn,
                )
                mail_ok = True
                break
            except Exception as mail_exc:
                msg = str(mail_exc)
                if "code" in msg.lower() and mail_try < max_mail_retry:
                    log_fn(f"[!] no code, rotate email: {msg}")
                    u.restart_browser(log_callback=log_fn)
                    u.sleep_with_cancel(1, stop_fn)
                    continue
                raise
        if not mail_ok:
            return {"status": "failed", "error": "verification code phase failed"}

        log_fn(f"[*] code={code}")
        log_fn("[*] fill profile")
        profile = u.fill_profile_and_submit(
            log_callback=log_fn, cancel_callback=stop_fn
        )
        password = str(profile.get("password") or "")
        log_fn("[*] wait sso cookie")
        sso = u.wait_for_sso_cookie(log_callback=log_fn, cancel_callback=stop_fn)
        sso = u._normalize_sso_token(sso)

        if u.config.get("enable_nsfw"):
            log_fn("[*] enable nsfw")
            try:
                ok, msg = u.enable_nsfw_for_token(sso, log_callback=log_fn)
                log_fn(f"[*] nsfw ok={ok}: {msg}")
            except Exception as e:
                log_fn(f"[!] nsfw failed: {e}")

        if u.config.get("cpa_export_enabled"):
            log_fn("[*] cpa mint (sync)")
            try:
                cpa = u.export_cpa_xai_for_account(
                    email,
                    password,
                    sso=sso,
                    log_callback=log_fn,
                    page=None,
                )
                if cpa.get("ok"):
                    path = cpa.get("path")
                    if path and os.path.isfile(path):
                        with open(path, encoding="utf-8") as f:
                            payload = json.load(f)
                        access_token, refresh_token = _extract_oauth_tokens(payload)
                    # mint_and_export may also embed tokens on result
                    if not access_token:
                        access_token = str(cpa.get("access_token") or "")
                    if not refresh_token:
                        refresh_token = str(cpa.get("refresh_token") or "")
                    log_fn(f"[+] cpa ok path={path} has_tokens={bool(access_token and refresh_token)}")
                else:
                    log_fn(f"[!] cpa fail: {cpa.get('error')}")
                    return {
                        "status": "failed",
                        "error": f"CPA mint failed: {cpa.get('error') or cpa}",
                        "email": email,
                        "password": password,
                        "sso": sso,
                    }
            except Exception as e:
                log_fn(f"[!] cpa exception: {e}")
                return {
                    "status": "failed",
                    "error": f"CPA mint exception: {e}",
                    "email": email,
                    "password": password,
                    "sso": sso,
                }

            if not access_token or not refresh_token:
                return {
                    "status": "failed",
                    "error": "CPA mint wrote no access_token/refresh_token",
                    "email": email,
                    "password": password,
                    "sso": sso,
                }

        result: dict[str, Any] = {
            "status": "success",
            "email": email,
            "password": password,
            "sso": sso,
            "access_token": access_token,
            "refresh_token": refresh_token,
        }
        return result
    except u.AccountRetryNeeded as e:
        return {"status": "needs_retry", "error": str(e), "email": email}
    except u.RegistrationCancelled:
        return {"status": "cancelled", "error": "cancelled", "email": email}
    except Exception as e:
        err = str(e) or type(e).__name__
        low = err.lower()
        # Session residue / CF blocks often recover with fresh browser+IP
        if any(
            k in low
            for k in (
                "cloudflare",
                "turnstile",
                "tos-gate",
                "email registration",
                "timeout",
                "disconnected",
            )
        ):
            return {"status": "needs_retry", "error": err, "email": email}
        return {
            "status": "failed",
            "error": err,
            "email": email,
            "trace": traceback.format_exc()[-800:],
        }
    finally:
        try:
            u.stop_browser()
        except Exception:
            pass


def _normalize_sso(raw: str) -> str:
    token = str(raw or "").strip()
    if token.startswith("sso="):
        token = token[4:]
    return token.strip()


def run_mint_from_sso(
    *,
    email: str,
    password: str,
    sso: str,
    proxy: str | None = None,
) -> dict[str, Any]:
    """Mint grok-cli OAuth from existing email/password/sso (no register)."""
    email = str(email or "").strip()
    password = str(password or "")
    sso = _normalize_sso(sso)
    if not email or not password or not sso:
        return {"status": "failed", "error": "email, password, and sso are required"}

    u = _import_upstream()
    cfg = u.config
    if proxy:
        cfg["proxy"] = proxy
    cfg["cpa_export_enabled"] = True
    cfg["cpa_mint_async"] = False
    cfg["cpa_mint_required"] = True
    cfg["cpa_headless"] = False

    def log_fn(msg: str) -> None:
        text = str(msg or "")
        step = "cpa_mint"
        low = text.lower()
        if "turnstile" in low or "cloudflare" in low:
            step = "turnstile"
        elif "sso" in low or "cookie" in low:
            step = "sso_cookie"
        elif text.startswith("[!]") or "error" in low or "fail" in low:
            step = "warn"
        _log(step, text)

    log_fn(f"[*] mint-sso email={email}")
    try:
        cpa = u.export_cpa_xai_for_account(
            email,
            password,
            sso=sso,
            log_callback=log_fn,
            page=None,
        )
    except Exception as e:
        return {
            "status": "failed",
            "error": f"CPA mint exception: {e}",
            "email": email,
            "sso": sso,
        }

    access_token = ""
    refresh_token = ""
    if cpa.get("ok"):
        path = cpa.get("path")
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                payload = json.load(f)
            access_token, refresh_token = _extract_oauth_tokens(payload)
        if not access_token:
            access_token = str(cpa.get("access_token") or "")
        if not refresh_token:
            refresh_token = str(cpa.get("refresh_token") or "")

    if not access_token or not refresh_token:
        return {
            "status": "failed",
            "error": f"CPA mint failed: {cpa.get('error') or 'no access_token/refresh_token'}",
            "email": email,
            "sso": sso,
        }

    return {
        "status": "success",
        "email": email,
        "password": password,
        "sso": sso,
        "access_token": access_token,
        "refresh_token": refresh_token,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Grok (xAI) auto-register")
    sub = parser.add_subparsers(dest="cmd", required=True)

    reg = sub.add_parser("register", help="Register one Grok account")
    reg.add_argument("--proxy", default=os.environ.get("PROXY_URL") or "")
    reg.add_argument(
        "--mail-provider",
        choices=["cloudflare", "duckmail", "yyds", "cf-email"],
        default=os.environ.get("GROK_MAIL_PROVIDER") or "cloudflare",
    )
    reg.add_argument(
        "--cloudflare-api-base",
        default=os.environ.get("GROK_CF_MAIL_API") or "",
    )
    reg.add_argument(
        "--cloudflare-api-key",
        default=os.environ.get("GROK_CF_MAIL_KEY") or "",
    )
    reg.add_argument(
        "--cloudflare-auth-mode",
        default=os.environ.get("GROK_CF_MAIL_AUTH") or "none",
    )
    reg.add_argument(
        "--cloudflare-path-accounts",
        default=os.environ.get("GROK_CF_MAIL_ACCOUNTS_PATH") or "",
    )
    reg.add_argument(
        "--domain",
        default=os.environ.get("GROK_MAIL_DOMAIN") or "",
        help="Temp-mail default domain (cloudflare defaultDomains)",
    )
    reg.add_argument(
        "--duckmail-api-key",
        default=os.environ.get("GROK_DUCKMAIL_KEY") or "",
    )
    reg.add_argument(
        "--yyds-api-key",
        default=os.environ.get("GROK_YYDS_KEY") or "",
    )
    reg.add_argument(
        "--yyds-jwt",
        default=os.environ.get("GROK_YYDS_JWT") or "",
    )
    reg.add_argument("--enable-cpa", action="store_true", help="Also mint grok-cli OAuth tokens")
    reg.add_argument("--enable-nsfw", action="store_true")
    reg.add_argument("--headless", action="store_true")

    mint = sub.add_parser("mint-sso", help="Mint grok-cli OAuth from email/password/sso")
    mint.add_argument("--email", required=True)
    mint.add_argument("--password", required=True)
    mint.add_argument("--sso", required=True, help="sso cookie value (with or without sso= prefix)")
    mint.add_argument("--proxy", default=os.environ.get("PROXY_URL") or "")

    args = parser.parse_args()
    if args.cmd == "mint-sso":
        result = run_mint_from_sso(
            email=args.email,
            password=args.password,
            sso=args.sso,
            proxy=args.proxy or None,
        )
        _output(result)
        sys.exit(0 if result.get("status") == "success" else 1)

    if args.cmd != "register":
        parser.error(f"unknown cmd {args.cmd}")

    if args.mail_provider == "cloudflare" and not args.cloudflare_api_base:
        _output(
            {
                "status": "failed",
                "error": "cloudflare mail requires --cloudflare-api-base (temp-email worker URL)",
            }
        )
        sys.exit(2)

    result = run_register_once(
        proxy=args.proxy or None,
        mail_provider=args.mail_provider,
        cloudflare_api_base=args.cloudflare_api_base,
        cloudflare_api_key=args.cloudflare_api_key or "",
        cloudflare_auth_mode=args.cloudflare_auth_mode,
        cloudflare_path_accounts=args.cloudflare_path_accounts or "",
        domain=args.domain or "",
        duckmail_api_key=args.duckmail_api_key or "",
        yyds_api_key=args.yyds_api_key or "",
        yyds_jwt=args.yyds_jwt or "",
        enable_cpa=bool(args.enable_cpa),
        enable_nsfw=bool(args.enable_nsfw),
    )

    _output(result)
    sys.exit(0 if result.get("status") == "success" else 1)


if __name__ == "__main__":
    main()
