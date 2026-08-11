from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_launch_script_runs_api_with_repository_on_python_path():
    script = (ROOT / "launch.sh").read_text(encoding="utf-8")

    assert 'PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"' in script
    assert 'python3 "$ROOT/server/api_server.py"' in script


def test_server_run_api_script_exports_repository_python_path():
    script = (ROOT / "server" / "run-api.sh").read_text(encoding="utf-8")

    assert 'PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"' in script
    assert '"$ROOT/server/api_server.py"' in script


def test_server_run_api_script_has_no_author_machine_paths():
    script = (ROOT / "server" / "run-api.sh").read_text(encoding="utf-8")

    assert '/Users/' not in script
    assert '/Library/Frameworks/' not in script
    assert 'ROOT="$(cd "$(dirname "$0")/.." && pwd)"' in script
    assert 'PHANTOM_RELAY_PYTHON' in script


def test_browser_host_launcher_handles_restart_exit_without_set_e_erasing_status():
    script = (ROOT / "browser_host_launcher.sh").read_text(encoding="utf-8")

    assert 'if "$PYTHON" "$ROOT/scripts/bidi_browser_host.py" >>"$LOG" 2>&1; then' in script
    assert 'exit_code=0' in script
    assert 'exit_code=$?' in script
    assert '[ "$exit_code" -eq 75 ] || exit "$exit_code"' in script


def test_browser_host_launcher_has_a_bounded_restart_budget():
    script = (ROOT / "browser_host_launcher.sh").read_text(encoding="utf-8")

    assert 'PHANTOM_RELAY_HOST_MAX_RESTARTS' in script
    assert 'host_restart_budget_exhausted' in script
    assert 'PHANTOM_RELAY_HOST_MAX_RESTARTS:-0' in script
    assert 'while true' not in script


def test_browser_host_launcher_is_opt_in_and_requires_the_bidi_activation_owner():
    script = (ROOT / "browser_host_launcher.sh").read_text(encoding="utf-8")

    assert "PHANTOM_RELAY_ENABLE_BIDI_HOST" in script
    assert "PHANTOM_RELAY_ACTIVATION_OWNER" in script
    assert "bidi_host_disabled" in script
    assert "PHANTOM_RELAY_BIDI_NAVIGATION" in script


def test_browser_host_launcher_requires_shared_api_bidi_owner():
    script = (ROOT / "browser_host_launcher.sh").read_text(encoding="utf-8")

    assert '"$API/health"' in script
    assert "bidi_api_owner_conflict" in script
    assert "bidi_api_owner_unknown" in script
    assert 'browser_activation_owner":"bidi' in script


def test_background_wake_helper_is_not_a_persistent_daemon():
    helper = (ROOT / "browser_wake_helper.sh").read_text(encoding="utf-8")

    assert 'while true' not in helper
    assert 'refusing to open a blank browser tab' in helper
