# Isolated live harness

`scripts/run_isolated_live_case.py` is the only supported entry point for a
local live browser acceptance case. It is provider-neutral: the target URL is
read from the recorded profile, and the model/domain/profile are explicit
inputs.

## Default: read-only preflight

```bash
PYTHONPATH=. python3 scripts/run_isolated_live_case.py \
  --api-url http://127.0.0.1:8765 \
  --domain example.test \
  --profile /absolute/path/to/profile.json \
  --model fixture-model \
  --browser-profile-dir /tmp/phantom-relay-live-example \
  --cdp-port 0
```

Preflight checks the API health endpoint, profile/domain/origin consistency,
the response identity contract, the extension manifest, an unused local CDP
port, and an isolated browser profile path. It does not create a browser
profile, launch a browser, read browser storage, or read credentials.

## Explicit isolated launch

```bash
PYTHONPATH=. python3 scripts/run_isolated_live_case.py \
  --api-url http://127.0.0.1:8765 \
  --domain example.test \
  --profile /absolute/path/to/profile.json \
  --model fixture-model \
  --browser-profile-dir /tmp/phantom-relay-live-example \
  --cdp-port 0 \
  --chrome-binary /absolute/path/to/chromium \
  --run
```

`--run` is deliberately opt-in and launches Chromium with only the explicit
profile directory, CDP port, and profile-derived target URL. It then attaches
to that isolated browser through Selenium WebDriver BiDi and installs the
current extension with `webextension.install`, followed by a fresh navigation
so the content script is injected. This installation path is required by
current branded Chrome/Chrome Canary builds that ignore command-line
`--load-extension` in this mode. The harness reads the selected browser's
exact four-part version and resolves
`.tools/chromedriver-<browser-version>/chromedriver`. Override it with
`--chromedriver` or `PHANTOM_RELAY_CHROMEDRIVER` only when the environment
provides a deliberately selected driver.

The persistent `browser_host_launcher.sh` / `scripts/bidi_browser_host.py`
path has one additional safety gate: the API health response must report
`browser_activation_owner=bidi`. The normal product API owner is `api`; do not
run the BiDi host beside that process, because two independent owners can open
or navigate different browser pages and recreate an `about:blank` race. A
harness-only API must be started explicitly with
`PHANTOM_RELAY_ACTIVATION_OWNER=bidi`.

The harness never attaches to the current shared browser and never uses the
project's existing `.chrome-*` directories. Stop it with `Ctrl-C`; the harness
terminates only the process it started. CDP is exposed for read-only inspection
and is never used to type, click, press Enter, or post a browser result.

The harness is an isolation and preflight gate, not proof of cross-site
reliability. Named-site acceptance remains blocked until the generic fixture
matrix and the profile recorder's isolated DOM execution tests pass.
