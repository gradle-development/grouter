#!/usr/bin/env python3
"""
Cloudflare signup with Turnstile bypass via nodriver.
Called as subprocess from Node.js (cloudflareBulkImportManager.js).

Usage:
    python3 cf_signup.py --email foo@bar.com --password Pass123 --proxy http://... --headless

Outputs JSON to stdout:
    {"success": true, "account_id": "abc...", "cookies": [...], "error": ""}
"""

import argparse
import asyncio
import json
import re
import sys
import os

import nodriver as uc


async def signup(email: str, password: str, proxy: str = None, headless: bool = False) -> dict:
    browser = None
    try:
        # find chrome binary: CloakBrowser's Chromium first, then system Chrome
        chrome_path = None
        cb_dir = os.path.expanduser("~/.cloakbrowser")
        if os.path.isdir(cb_dir):
            for d in sorted(os.listdir(cb_dir), reverse=True):
                candidate = os.path.join(cb_dir, d, "chrome")
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    chrome_path = candidate
                    break
        if not chrome_path:
            for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
                p = os.popen(f"which {name} 2>/dev/null").read().strip()
                if p:
                    chrome_path = p
                    break

        browser = await uc.start(
            headless=headless,
            lang="en-US",
            proxy=proxy,
            sandbox=False,
            browser_executable_path=chrome_path,
        )
        page = await browser.get("https://dash.cloudflare.com/sign-up")
        await asyncio.sleep(8)

        # fill email
        email_input = await page.select('input[name="email"]', timeout=15)
        if not email_input:
            return {"success": False, "error": "Email input not found"}
        await email_input.click()
        await asyncio.sleep(0.5)
        await email_input.send_keys(email)
        await asyncio.sleep(1)

        # fill password
        pw_input = await page.select('input[name="password"]', timeout=5)
        if not pw_input:
            return {"success": False, "error": "Password input not found"}
        await pw_input.click()
        await asyncio.sleep(0.5)
        await pw_input.send_keys(password)
        await asyncio.sleep(2)

        # scroll to make Turnstile visible
        await page.evaluate("window.scrollBy(0, 400)")
        await asyncio.sleep(3)

        # solve Turnstile via nodriver verify_cf (OpenCV template matching + CDP click)
        for attempt in range(3):
            try:
                await page.verify_cf()
                await asyncio.sleep(5)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"Turnstile attempt {attempt+1} failed: {e}", file=sys.stderr)
                await asyncio.sleep(3)

        # submit form
        submit_btn = await page.select('button[type="submit"]', timeout=5)
        if not submit_btn:
            return {"success": False, "error": "Submit button not found"}
        await submit_btn.scroll_into_view()
        await asyncio.sleep(1)
        await submit_btn.click()

        # wait for redirect (leave signup page)
        account_id = None
        for _ in range(30):
            await asyncio.sleep(1)
            url = await page.evaluate("location.href")
            if "/sign-up" not in url:
                match = re.search(r"/([a-f0-9]{32})", url)
                if match:
                    account_id = match.group(1)
                break

        await asyncio.sleep(5)

        # extract cookies via CDP
        cookies = []
        try:
            cdp_cookies = await page.send(uc.cdp.network.get_cookies())
            for c in cdp_cookies:
                cookies.append({
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain,
                    "path": c.path or "/",
                    "secure": c.secure,
                    "httpOnly": c.http_only,
                    "sameSite": (c.same_site.value if c.same_site else "Lax"),
                    "expires": c.expires if c.expires != -1 else -1,
                })
        except Exception as e:
            print(f"Cookie extraction error: {e}", file=sys.stderr)

        if account_id:
            return {
                "success": True,
                "account_id": account_id,
                "cookies": cookies,
                "error": "",
            }

        # check for error messages
        url = await page.evaluate("location.href")
        error_msgs = await page.evaluate("""
            Array.from(document.querySelectorAll('p, [role="alert"]'))
                .map(e => e.textContent.trim())
                .filter(t => t.includes('unable') || t.includes('limit') || t.includes('Incorrect'))
        """)
        error = error_msgs[0] if error_msgs else f"Redirect failed: {url[:80]}"
        return {"success": False, "error": error, "cookies": cookies}

    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        if browser:
            try:
                browser.stop()
            except Exception:
                pass
            await asyncio.sleep(2)


def main():
    parser = argparse.ArgumentParser(description="Cloudflare signup with Turnstile bypass")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--proxy", default=None)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    result = asyncio.run(signup(args.email, args.password, args.proxy, args.headless))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
