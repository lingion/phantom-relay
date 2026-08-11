import importlib.util
from pathlib import Path
from pathlib import Path

from selenium.common.exceptions import (
    InvalidSessionIdException,
    NoSuchWindowException,
    WebDriverException,
)


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bidi_browser_host.py"
SPEC = importlib.util.spec_from_file_location("phantom_relay_bidi_host", MODULE_PATH)
HOST = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(HOST)


def test_ready_same_domain_page_is_reused_without_navigation():
    status = {
        "clients": {
            "tab-1": {
                "domain": "wenxin.baidu.com",
                "ready": True,
                "input_ready": True,
                "send_ready": True,
            }
        }
    }

    assert HOST.ready_client_for_domain(status, "wenxin.baidu.com") is True
    assert HOST.ready_client_for_domain(status, "www.doubao.com") is False


def test_missing_or_partial_client_does_not_block_navigation():
    status = {
        "clients": {
            "tab-1": {
                "domain": "wenxin.baidu.com",
                "ready": True,
                "input_ready": True,
                "send_ready": False,
            }
        }
    }

    assert HOST.ready_client_for_domain(status, "wenxin.baidu.com") is False


def test_bidi_host_is_disabled_without_explicit_opt_in_and_owner():
    assert HOST.bidi_host_activation_allowed({}) is False
    assert HOST.bidi_host_activation_allowed({"PHANTOM_RELAY_ENABLE_BIDI_HOST": "1", "PHANTOM_RELAY_ACTIVATION_OWNER": "api"}) is False


def test_bidi_host_requires_bidi_activation_owner_even_when_enabled():
    assert HOST.bidi_host_activation_allowed({"PHANTOM_RELAY_ENABLE_BIDI_HOST": "1", "PHANTOM_RELAY_ACTIVATION_OWNER": "bidi"}) is True


def test_bidi_navigation_requires_a_second_explicit_opt_in():
    env = {"PHANTOM_RELAY_ENABLE_BIDI_HOST": "1", "PHANTOM_RELAY_ACTIVATION_OWNER": "bidi"}
    assert HOST.bidi_navigation_allowed(env) is False
    env["PHANTOM_RELAY_BIDI_NAVIGATION"] = "1"
    assert HOST.bidi_navigation_allowed(env) is True


def test_bidi_harness_requires_the_api_to_share_the_bidi_owner():
    assert HOST.bidi_owner_matches_api("bidi") is True
    assert HOST.bidi_owner_matches_api("api") is False
    assert HOST.bidi_owner_matches_api("") is False


def test_bidi_harness_rechecks_the_api_owner_after_startup(monkeypatch):
    monkeypatch.setattr(HOST, "api_activation_owner", lambda _api=None: "bidi")
    assert HOST.api_still_grants_bidi_ownership() is True
    monkeypatch.setattr(HOST, "api_activation_owner", lambda _api=None: "api")
    assert HOST.api_still_grants_bidi_ownership() is False


def test_ready_page_is_preserved_only_for_same_domain_navigation():
    assert HOST.same_target_domain(
        "https://www.doubao.com/chat/old", "https://www.doubao.com/chat/new"
    ) is True
    assert HOST.same_target_domain(
        "https://www.doubao.com/chat/", "https://wenxin.baidu.com/"
    ) is False


def test_same_domain_unready_page_is_not_navigated_again():
    assert HOST.should_navigate_to_target(
        "https://wenxin.baidu.com/", "https://wenxin.baidu.com/search/one"
    ) is False
    assert HOST.should_navigate_to_target(
        "https://wenxin.baidu.com/search/one", "https://www.doubao.com/chat/"
    ) is True
    assert HOST.should_navigate_to_target(
        "about:blank", "https://wenxin.baidu.com/"
    ) is True


def test_blank_page_retries_are_suppressed_after_one_attempt_for_same_target():
    assert HOST.should_suppress_blank_navigation_retry(
        "about:blank",
        "https://recorded.example/chat",
        "",
    ) is False
    assert HOST.should_suppress_blank_navigation_retry(
        "about:blank",
        "https://recorded.example/chat",
        "https://recorded.example/chat",
    ) is True
    assert HOST.should_suppress_blank_navigation_retry(
        "https://recorded.example/chat",
        "https://recorded.example/chat",
        "https://recorded.example/chat",
    ) is False


def test_initial_navigation_is_skipped_when_chrome_was_started_on_same_origin_target():
    assert HOST.initial_navigation_needed(
        "https://wenxin.baidu.com/search/123",
        "https://wenxin.baidu.com/search/123",
    ) is False
    assert HOST.initial_navigation_needed(
        "https://wenxin.baidu.com/",
        "https://wenxin.baidu.com/search/123",
    ) is False
    assert HOST.initial_navigation_needed(
        "about:blank",
        "https://wenxin.baidu.com/search/123",
    ) is True


def test_startup_navigation_retry_is_not_encoded_as_a_second_driver_get():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert "driver.get(url)" in source
    assert source.count("driver.get(url)") == 1
    assert "alert.accept()\n                    driver.get(url)" not in source


def test_host_observes_browser_url_after_page_internal_navigation():
    class Driver:
        current_url = "https://wenxin.baidu.com/search/123?enter_type=chat_url"

    assert HOST.observed_current_url(Driver(), "https://wenxin.baidu.com/") == Driver.current_url


def test_host_falls_back_when_browser_url_is_not_web_navigation():
    class Driver:
        current_url = "chrome://newtab/"

    assert HOST.observed_current_url(Driver(), "https://wenxin.baidu.com/") == "https://wenxin.baidu.com/"


def test_dead_webdriver_session_is_classified_for_host_restart():
    assert HOST.driver_session_is_lost(InvalidSessionIdException("invalid session id")) is True
    assert HOST.driver_session_is_lost(WebDriverException("disconnected: not connected to DevTools")) is True


def test_ordinary_navigation_error_does_not_force_host_restart():
    assert HOST.driver_session_is_lost(WebDriverException("timeout receiving message from renderer")) is False


def test_chrome_host_keeps_pages_visible_when_the_test_window_is_occluded():
    command = HOST.build_chrome_args(Path("/tmp/phantom-relay-test-profile"), 9335, "")

    assert "--disable-features=CalculateNativeWinOcclusion" in command
    assert "--disable-backgrounding-occluded-windows" in command


def test_host_rebinds_to_a_live_web_window_when_the_current_window_closed():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            if handle == "closed":
                raise NoSuchWindowException("target window already closed")
            self.driver.active_handle = handle

    class Driver:
        window_handles = ["closed", "live"]

        def __init__(self):
            self.active_handle = "closed"
            self.switch_to = Switch(self)

        @property
        def current_url(self):
            if self.active_handle == "closed":
                raise NoSuchWindowException("target window already closed")
            return "https://wenxin.baidu.com/search/123"

        def execute_cdp_cmd(self, command, params):
            assert command == "Target.getTargets"
            assert params == {}
            return {
                "targetInfos": [
                    {"targetId": "live", "type": "page", "url": "https://wenxin.baidu.com/search/123"},
                ]
            }

    result = HOST.rebind_to_web_window(Driver(), preferred_url="https://wenxin.baidu.com/")

    assert result == {"handle": "live", "url": "https://wenxin.baidu.com/search/123"}


def test_host_ignores_non_web_windows_when_rebinding():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            self.driver.active_handle = handle

    class Driver:
        window_handles = ["extension", "newtab", "live"]

        def __init__(self):
            self.active_handle = "extension"
            self.switch_to = Switch(self)

        @property
        def current_url(self):
            return {
                "extension": "chrome-extension://id/popup.html",
                "newtab": "chrome://newtab/",
                "live": "https://example.test/chat",
            }[self.active_handle]

        def execute_cdp_cmd(self, command, params):
            assert command == "Target.getTargets"
            assert params == {}
            return {
                "targetInfos": [
                    {"targetId": "extension", "type": "page", "url": "chrome-extension://id/popup.html"},
                    {"targetId": "newtab", "type": "page", "url": "chrome://newtab/"},
                    {"targetId": "live", "type": "page", "url": "https://example.test/chat"},
                ]
            }

    result = HOST.rebind_to_web_window(Driver(), preferred_url="https://example.test/")

    assert result == {"handle": "live", "url": "https://example.test/chat"}


def test_a_closed_window_is_recoverable_and_does_not_force_host_restart():
    assert HOST.driver_session_is_lost(
        NoSuchWindowException("target window already closed")
    ) is False


def test_host_creates_a_new_tab_when_no_web_window_survives():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, _handle):
            raise NoSuchWindowException("target window already closed")

        def new_window(self, kind):
            assert kind == "tab"
            self.driver.window_handles = ["new"]
            self.driver.active_handle = "new"

    class Driver:
        window_handles = ["closed"]

        def __init__(self):
            self.active_handle = "closed"
            self.switch_to = Switch(self)

        @property
        def current_window_handle(self):
            return self.active_handle

        @property
        def current_url(self):
            if self.active_handle == "closed":
                raise NoSuchWindowException("target window already closed")
            return "about:blank"

    result = HOST.ensure_web_window(Driver(), preferred_url="https://example.test/")

    assert result == {"handle": "new", "url": ""}


def test_host_reuses_an_existing_blank_window_when_no_request_has_a_target():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            self.driver.active_handle = handle

        def new_window(self, _kind):
            raise AssertionError("must not create tabs without a target")

    class Driver:
        window_handles = ["blank"]

        def __init__(self):
            self.active_handle = "blank"
            self.switch_to = Switch(self)

        @property
        def current_window_handle(self):
            return self.active_handle

        @property
        def current_url(self):
            return "about:blank"

    result = HOST.ensure_web_window(Driver(), preferred_url="")

    assert result == {"handle": "blank", "url": ""}


def test_steady_state_window_reuses_blank_tab_without_creating_another_tab():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            self.driver.active_handle = handle

        def new_window(self, _kind):
            raise AssertionError("steady-state host must not create tabs")

    class Driver:
        window_handles = ["blank"]

        def __init__(self):
            self.active_handle = "blank"
            self.switch_to = Switch(self)

        @property
        def current_window_handle(self):
            return self.active_handle

        @property
        def current_url(self):
            return "about:blank"

    result = HOST._ensure_web_window(
        Driver(), preferred_url="https://wenxin.baidu.com/", create_if_missing=False
    )

    assert result == {"handle": "blank", "url": ""}


def test_browser_process_must_still_be_alive_and_debug_port_reachable(monkeypatch):
    class Chrome:
        def __init__(self, exit_code):
            self.exit_code = exit_code

        def poll(self):
            return self.exit_code

    monkeypatch.setattr(HOST, "port_is_open", lambda port: port == 9335)

    assert HOST.browser_process_is_reconnectable(Chrome(None), 9335) is True
    assert HOST.browser_process_is_reconnectable(Chrome(75), 9335) is False
    assert HOST.browser_process_is_reconnectable(Chrome(None), 9336) is False


def test_host_waits_for_a_real_target_before_starting_chrome(monkeypatch):
    targets = iter(["", "", "https://example.test/chat"])
    monkeypatch.setattr(HOST, "target_url", lambda: next(targets))
    monkeypatch.setattr(HOST.time, "sleep", lambda _seconds: None)

    assert HOST.wait_for_target_url() == "https://example.test/chat"


def test_rebind_does_not_switch_away_from_the_current_live_web_window():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            self.driver.switches.append(handle)
            self.driver.active_handle = handle

    class Driver:
        window_handles = ["about", "live"]

        def __init__(self):
            self.active_handle = "live"
            self.switches = []
            self.switch_to = Switch(self)

        @property
        def current_window_handle(self):
            return self.active_handle

        @property
        def current_url(self):
            return {
                "about": "about:blank",
                "live": "https://wenxin.baidu.com/search/123",
            }[self.active_handle]

    driver = Driver()

    result = HOST.rebind_to_web_window(
        driver,
        preferred_url="https://wenxin.baidu.com/",
    )

    assert result == {
        "handle": "live",
        "url": "https://wenxin.baidu.com/search/123",
    }
    assert driver.switches == []


def test_rebind_recovers_from_about_blank_using_target_metadata_only():
    class Switch:
        def __init__(self, driver):
            self.driver = driver

        def window(self, handle):
            self.driver.switches.append(handle)
            self.driver.active_handle = handle

    class Driver:
        window_handles = ["about", "live"]

        def __init__(self):
            self.active_handle = "about"
            self.switches = []
            self.switch_to = Switch(self)

        @property
        def current_window_handle(self):
            return self.active_handle

        @property
        def current_url(self):
            return {
                "about": "about:blank",
                "live": "https://wenxin.baidu.com/search/123",
            }[self.active_handle]

        def execute_cdp_cmd(self, command, params):
            assert command == "Target.getTargets"
            assert params == {}
            return {
                "targetInfos": [
                    {"targetId": "about", "type": "page", "url": "about:blank"},
                    {
                        "targetId": "live",
                        "type": "page",
                        "url": "https://wenxin.baidu.com/search/123",
                    },
                ]
            }

    driver = Driver()

    result = HOST.rebind_to_web_window(
        driver,
        preferred_url="https://wenxin.baidu.com/",
    )

    assert result == {
        "handle": "live",
        "url": "https://wenxin.baidu.com/search/123",
    }
    assert driver.switches == ["live"]
