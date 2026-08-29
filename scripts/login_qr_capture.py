#!/usr/bin/env python3
"""Open a visible Canary login page using the cloned authenticated profile."""
from pathlib import Path
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

ROOT = Path(__file__).resolve().parents[1]
BROWSER = "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
DRIVER = ROOT / ".tools/chromedriver-152.0.7962.0/chromedriver"
PROFILE = Path(os.environ.get("PHANTOM_RELAY_BROWSER_PROFILE", "/tmp/phantom-relay-canary-auth"))
URL = os.environ.get("PHANTOM_RELAY_LOGIN_URL", "https://chat.deepseek.com/")
OUT = Path(os.environ.get("PHANTOM_RELAY_LOGIN_SCREENSHOT", "/tmp/phantom-relay-login.png"))

opts = Options()
opts.binary_location = BROWSER
opts.add_argument(f"--user-data-dir={PROFILE}")
opts.add_argument("--no-first-run")
opts.add_argument("--no-default-browser-check")
opts.add_argument("--disable-gpu")
opts.page_load_strategy = "eager"
driver = webdriver.Chrome(service=Service(str(DRIVER)), options=opts)
driver.set_page_load_timeout(25)
try:
    driver.get(URL)
except Exception as exc:
    print(json.dumps({"navigation_error": type(exc).__name__, "message": str(exc)[:300]}, ensure_ascii=False), flush=True)
time.sleep(8)
try:
    driver.save_screenshot(str(OUT))
except Exception as exc:
    print(json.dumps({"screenshot_error": type(exc).__name__, "message": str(exc)[:300]}, ensure_ascii=False), flush=True)
print(json.dumps({"url": driver.current_url, "title": driver.title, "screenshot": str(OUT), "size": OUT.stat().st_size if OUT.exists() else 0}, ensure_ascii=False), flush=True)
print("LOGIN_WINDOW_READY", flush=True)
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    driver.quit()
