import importlib.util
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "live_reliability_acceptance",
    ROOT / "scripts" / "live_reliability_acceptance.py",
)
assert SPEC and SPEC.loader
acceptance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = acceptance
SPEC.loader.exec_module(acceptance)


def test_matrix_counts_cover_directed_pairs_switchbacks_and_distinct_triples():
    counts = acceptance.matrix_counts(
        6,
        startup_repeats=6,
        path_repeats=3,
        alias_checks=7,
    )

    assert counts["hard_cold_requests"] == 36
    assert counts["immediate_crash_prepare_requests"] == 36
    assert counts["immediate_crash_recovery_requests"] == 36
    assert counts["directed_pair_paths"] == 30
    assert counts["switchback_paths"] == 30
    assert counts["all_distinct_triple_paths"] == 120
    assert counts["adjacent_distinct_triple_paths"] == 150
    assert counts["context_requests_per_path_repeat"] == 186
    assert counts["directed_pair_requests"] == 90
    assert counts["adjacent_distinct_triple_requests"] == 450
    assert counts["context_requests"] == 558
    assert counts["alias_route_requests"] == 7
    assert counts["full_requests"] == 679


def test_inventory_groups_shared_domain_routes_as_aliases():
    profile = {
        "profileId": "recorded-shared.example-v1",
        "domain": "shared.example",
        "input": {"selector": {"css": "#input"}},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": {"css": ".answer"},
            "identityVerification": {"status": "verified"},
        },
        "lifecycle": {"revision": 1, "state": "synced"},
    }
    routes = [
        {"id": "route-a", "domain": "shared.example", "url": "https://shared.example/a"},
        {"id": "route-b", "domain": "shared.example", "url": "https://shared.example/b"},
    ]

    models, blockers = acceptance.build_recorded_model_inventory(
        routes,
        aliases={},
        profiles_by_domain={"shared.example": profile},
    )

    assert blockers == []
    assert [(model.model_id, model.aliases) for model in models] == [
        ("route-a", ("route-b",)),
    ]


def test_inventory_only_attaches_explicit_alias_to_its_target():
    profile = {
        "profileId": "recorded-shared.example-v1",
        "domain": "shared.example",
        "input": {"selector": {"css": "#input"}},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": {"css": ".answer"},
            "identityVerification": {"status": "verified"},
        },
        "lifecycle": {"revision": 1, "state": "synced"},
    }
    routes = [
        {"id": "canonical", "domain": "shared.example", "url": "https://shared.example/chat"},
        {"id": "independent", "domain": "shared.example", "url": "https://shared.example/chat"},
    ]

    models, blockers = acceptance.build_recorded_model_inventory(
        routes,
        aliases={"friendly": "canonical"},
        profiles_by_domain={"shared.example": profile},
    )

    assert blockers == []
    assert [(model.model_id, model.aliases) for model in models] == [
        ("canonical", ("friendly", "independent")),
    ]


def test_inventory_prefers_domain_model_id_as_shared_domain_canonical():
    profile = {
        "profileId": "recorded-chat.example-v1",
        "domain": "chat.example",
        "input": {"selector": {"css": "#input"}},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": {"css": ".answer"},
            "identityVerification": {"status": "verified"},
        },
        "lifecycle": {"revision": 1, "state": "synced"},
    }
    routes = [
        {"id": "friendly", "domain": "chat.example", "url": "https://chat.example/chat"},
        {"id": "chat.example", "domain": "chat.example", "url": "https://chat.example/chat"},
        {"id": "legacy", "domain": "chat.example", "url": "https://chat.example/chat"},
    ]

    models, blockers = acceptance.build_recorded_model_inventory(
        routes,
        aliases={},
        profiles_by_domain={"chat.example": profile},
    )

    assert blockers == []
    assert [(model.model_id, model.aliases) for model in models] == [
        ("chat.example", ("friendly", "legacy")),
    ]


def test_single_case_prompt_is_provider_neutral_and_requires_exact_marker_echo():
    model = acceptance.RecordedModel(
        domain="example.test",
        model_id="recorded-route",
        aliases=(),
        target_url="https://example.test/chat",
        profile_id="recorded-example-v1",
        profile_revision=1,
    )

    case = acceptance.single_case(
        model,
        phase="cold",
        run_id="run",
        index=1,
    )
    prompt = case.messages[0]["content"]

    assert "纯字符串处理任务" in prompt
    assert "不需要联网搜索" in prompt
    assert "不要引用资料" in prompt
    assert "不要调用工具" in prompt
    assert "不要解释" in prompt
    assert "原样复制" in prompt
    assert "逐字符保留" in prompt
    assert "不能修改" in prompt
    assert "不能省略" in prompt
    assert case.expected in prompt
    assert "REQ_" not in prompt
    assert case.expected.startswith("ACK")
    assert "example.test" not in prompt
    assert "豆包" not in prompt
    assert "文心" not in prompt
    assert "千问" not in prompt
    assert "DeepSeek" not in prompt


def test_single_case_marker_is_rendering_stable_ascii_alphanumeric():
    model = acceptance.RecordedModel(
        domain="chat.example.test",
        model_id="recorded-route",
        aliases=(),
        target_url="https://chat.example.test/chat",
        profile_id="recorded-example-v1",
        profile_revision=1,
    )

    case = acceptance.single_case(
        model,
        phase="alias_route",
        run_id="20260814T165013",
        index=1,
    )
    prompt = case.messages[0]["content"]

    assert case.expected.startswith("ACK")
    assert case.expected.isascii()
    assert case.expected.isalnum()
    assert len(case.expected) <= 20
    assert prompt.count(case.expected) == 1


def test_context_case_prompt_disables_external_task_behaviors_and_requires_exact_marker():
    model = acceptance.RecordedModel(
        domain="example.test",
        model_id="recorded-route",
        aliases=(),
        target_url="https://example.test/chat",
        profile_id="recorded-example-v1",
        profile_revision=1,
    )

    case = acceptance.context_case(
        model,
        phase="context_pair",
        case_id="context-pair-001",
        sequence=("source", "recorded-route"),
        prior_messages=[
            {"role": "user", "content": "请处理上下文中的标记。"},
        ],
        source_answer="CTXA_RUN_001",
        source_prefix="CTXA_",
        target_prefix="CTXB_",
    )
    prompt = case.messages[-1]["content"]

    assert "纯字符串处理任务" in prompt
    assert "不需要联网搜索" in prompt
    assert "不要引用资料" in prompt
    assert "不要调用工具" in prompt
    assert "逐字符复制" in prompt
    assert "唯一允许的改动" in prompt
    assert "后缀必须原样保留" in prompt
    assert "CTXA_" in prompt
    assert "CTXB_" in prompt
    assert case.expected == "CTXB_RUN_001"


def test_release_floor_repeats_every_startup_boundary_and_every_directed_path():
    repeats = acceptance.minimum_perfect_trials(threshold=0.95, confidence=0.95)
    counts = acceptance.matrix_counts(
        6,
        startup_repeats=repeats,
        path_repeats=repeats,
        alias_checks=7,
    )

    assert repeats == 59
    assert counts["hard_cold_requests"] == 354
    assert counts["immediate_crash_recovery_requests"] == 354
    assert counts["directed_pair_requests"] == 1770
    assert counts["adjacent_distinct_triple_requests"] == 8850
    assert counts["context_requests"] == 10974
    assert counts["full_requests"] == 12049


def test_adjacent_distinct_triples_include_switchback_and_all_distinct_paths():
    triples = acceptance.adjacent_distinct_triples(["a", "b", "c"])

    assert len(triples) == 12
    assert ("a", "b", "a") in triples
    assert ("a", "b", "c") in triples
    assert all(first != second and second != third for first, second, third in triples)


def test_marker_oracle_accepts_current_ack_with_explanation_but_not_user_challenge():
    expected = "ACK_COLD_RUN_MODEL_001"

    assert acceptance.marker_oracle(expected, expected) == (
        True,
        "current_marker_present_once",
        [],
    )
    assert acceptance.marker_oracle(f"result: {expected}", expected) == (
        True,
        "current_marker_present_once",
        [],
    )
    passed, reason, stale = acceptance.marker_oracle(
        "REQ_COLD_RUN_MODEL_001", expected
    )
    assert passed is False
    assert reason == "current_marker_missing"
    assert stale == []


def test_marker_oracle_rejects_historical_ack_even_when_current_ack_is_present():
    passed, reason, stale = acceptance.marker_oracle(
        "ACK_OLD then ACK_CURRENT",
        "ACK_CURRENT",
        forbidden_markers=["ACK_OLD"],
    )

    assert passed is False
    assert reason == "historical_or_prompt_marker_returned"
    assert stale == ["ACK_OLD"]


def test_marker_oracle_rejects_current_request_challenge_echo_even_with_ack():
    passed, reason, stale = acceptance.marker_oracle(
        "ACK_CURRENT plus REQ_CURRENT",
        "ACK_CURRENT",
        forbidden_markers=["REQ_CURRENT"],
    )

    assert passed is False
    assert reason == "historical_or_prompt_marker_returned"
    assert stale == ["REQ_CURRENT"]


def test_request_challenge_markers_are_extracted_from_all_current_messages():
    messages = (
        {"role": "system", "content": "Transform REQ_SYSTEM_01."},
        {"role": "user", "content": "Use REQ_USER_A and REQ_USER_B, not REQ-INVALID."},
    )

    assert acceptance.request_challenge_markers(messages) == {
        "REQ_SYSTEM_01",
        "REQ_USER_A",
        "REQ_USER_B",
    }


def test_context_marker_transformation_does_not_put_expected_value_in_source():
    source = "CTXA_RUN_A"
    expected = acceptance.transformed_marker(source, "CTXA_", "CTXB_")

    assert expected == "CTXB_RUN_A"
    assert expected not in source


def test_context_marker_can_be_extracted_from_model_explanation():
    answer = "转换结果如下：CTXA_RUN_A。"

    assert acceptance.extract_unique_context_marker(answer, "CTXA_") == "CTXA_RUN_A"


def test_one_sided_exact_lower_bound_requires_59_perfect_trials_for_95_at_95():
    lower_58 = acceptance.clopper_pearson_lower(58, 58, 0.95)
    lower_59 = acceptance.clopper_pearson_lower(59, 59, 0.95)

    assert lower_58 < 0.95
    assert lower_59 >= 0.95


def test_summary_never_averages_critical_failure_away():
    results = [
        {"target_model": "a", "phase": "cold", "passed": True, "failure_class": None}
        for _ in range(99)
    ]
    results.append(
        {
            "target_model": "a",
            "phase": "cold",
            "passed": False,
            "failure_class": "wrong_or_stale_response",
        }
    )

    summary = acceptance.summarize(results, confidence=0.95, threshold=0.95)

    assert summary["overall"]["observed_success_rate"] == 0.99
    assert summary["critical_failure_count"] == 1
    assert summary["release_gate_passed"] is False


def test_summary_never_averages_a_failed_model_phase_away():
    results = [
        {"target_model": "a", "phase": "warm", "passed": True, "failure_class": None}
        for _ in range(500)
    ]
    results.extend(
        [
            {
                "target_model": "a",
                "phase": "cold",
                "passed": index >= 2,
                "failure_class": "browser_cold_wake_failed" if index < 2 else None,
            }
            for index in range(20)
        ]
    )

    summary = acceptance.summarize(results, confidence=0.95, threshold=0.95)

    assert summary["by_model"]["a"]["observed_success_rate"] > 0.99
    assert summary["by_model"]["a"]["confidence_threshold_met"] is True
    assert summary["by_model_phase"]["a::cold"]["observed_success_rate"] == 0.9
    assert summary["release_gate_passed"] is False


def test_summary_never_averages_a_failed_directed_sequence_away():
    results = [
        {
            "target_domain": "b.example",
            "target_model": "b",
            "phase": "context_pair",
            "sequence": ["a", "b"],
            "passed": True,
            "failure_class": None,
        }
        for _ in range(100)
    ]
    results.extend(
        [
            {
                "target_domain": "a.example",
                "target_model": "a",
                "phase": "context_pair",
                "sequence": ["b", "a"],
                "passed": False,
                "failure_class": "browser_timeout",
            }
            for _ in range(2)
        ]
    )

    summary = acceptance.summarize(results, confidence=0.95, threshold=0.95)

    assert summary["by_path"]["a -> b"]["observed_success_rate"] == 1.0
    assert summary["by_path"]["b -> a"]["observed_success_rate"] == 0.0
    assert summary["release_gate_passed"] is False


def test_path_confidence_is_evaluated_per_directed_path():
    results = []
    for source, target, trials in (("a", "b", 59), ("b", "a", 58)):
        results.extend(
            {
                "outcome": "PASS",
                "target_domain": f"{target}.example",
                "target_model": target,
                "phase": "context_pair",
                "sequence": [source, target],
                "passed": True,
                "failure_class": None,
            }
            for _ in range(trials)
        )

    summary = acceptance.summarize(results, confidence=0.95, threshold=0.95)

    assert summary["by_path"]["a -> b"]["confidence_threshold_met"] is True
    assert summary["by_path"]["b -> a"]["confidence_threshold_met"] is False
    assert summary["release_gate_passed"] is False


def test_unproven_cases_do_not_enter_success_rate_denominator_or_pass_coverage():
    results = [
        {
            "outcome": "PASS",
            "target_model": "a",
            "phase": "crash_prepare",
            "sequence": ["a"],
            "passed": True,
        },
        {
            "outcome": "FAIL",
            "target_model": "a",
            "phase": "crash_prepare",
            "sequence": ["a"],
            "passed": False,
            "failure_class": "browser_timeout",
        },
        {
            "outcome": "UNPROVEN",
            "target_model": "a",
            "phase": "crash",
            "sequence": ["a"],
            "passed": False,
            "failure_class": None,
            "unproven_reason": "prerequisite_failed",
        },
    ]

    summary = acceptance.summarize(results, confidence=0.95, threshold=0.95)

    assert summary["overall"]["scheduled"] == 3
    assert summary["overall"]["trials"] == 2
    assert summary["overall"]["unproven"] == 1
    assert summary["overall"]["observed_success_rate"] == 0.5
    assert summary["release_gate_passed"] is False


def test_crash_recovery_case_requires_its_prepare_case_to_pass():
    model = acceptance.RecordedModel(
        domain="a.example",
        model_id="a",
        aliases=("a",),
        target_url="https://a.example/",
        profile_id="recorded-a-v1",
        profile_revision=1,
    )

    cases = acceptance.qualification_cases(
        [model],
        run_id="run",
        startup_repeats=1,
        seed=5550,
    )
    prepare = next(case for case in cases if case.phase == "crash_prepare")
    crash = next(case for case in cases if case.phase == "crash")

    assert crash.prerequisite_case_id == prepare.case_id


def test_unproven_result_preserves_boundary_and_prerequisite_evidence():
    case = acceptance.AcceptanceCase(
        case_id="crash-a-001",
        phase="crash",
        sequence=("a",),
        target_model="a",
        target_domain="a.example",
        messages=({"role": "user", "content": "test"},),
        expected="ACK_TEST",
        prerequisite_case_id="crash-prepare-a-001",
    )

    result = acceptance.unproven_result(
        case,
        reason="prerequisite_failed",
        prerequisite={"case_id": "crash-prepare-a-001", "outcome": "FAIL"},
    )

    assert result["outcome"] == "UNPROVEN"
    assert result["unproven_reason"] == "prerequisite_failed"
    assert result["prerequisite"]["case_id"] == "crash-prepare-a-001"
    assert set(result["boundary_outcomes"].values()) == {"UNPROVEN"}


def test_advertised_route_without_profile_blocks_release():
    results = [
        {"target_model": "a", "phase": "cold", "passed": True, "failure_class": None}
        for _ in range(100)
    ]

    summary = acceptance.summarize(
        results,
        confidence=0.95,
        threshold=0.95,
        inventory_blockers=[{"model_ids": ["unrecorded"]}],
    )

    assert summary["inventory_blockers"] == [{"model_ids": ["unrecorded"]}]
    assert summary["release_gate_passed"] is False


def test_ready_client_requires_current_build_and_claimed_tab_identity():
    snapshot = {
        "clients": {
            "old-tab": {
                "domain": "example.test",
                "tab_id": 101,
                "last_seen": 200.0,
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "state": "ready",
                "source": "content-ready",
                "background_version": "old-build",
                "capabilities": {"can_execute": True, "can_observe": True},
            },
            "wrong-tab": {
                "domain": "example.test",
                "tab_id": 202,
                "last_seen": 200.0,
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "state": "ready",
                "source": "content-ready",
                "background_version": "current-build",
                "capabilities": {"can_execute": True, "can_observe": True},
            },
            "current-tab": {
                "domain": "example.test",
                "tab_id": 303,
                "last_seen": 200.0,
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "state": "ready",
                "source": "content-ready",
                "background_version": "current-build",
                "runtime_session_id": "runtime-current",
                "capabilities": {"can_execute": True, "can_observe": True},
            },
        }
    }

    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        tab_id=303,
    )["runtime_session_id"] == "runtime-current"
    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        tab_id=101,
    ) is None


def test_ready_client_requires_the_client_that_claimed_the_current_job():
    snapshot = {
        "clients": {
            "wrong-client": {
                "client_id": "wrong-client",
                "domain": "example.test",
                "tab_id": 303,
                "last_seen": 200.0,
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "state": "ready",
                "source": "content-ready",
                "background_version": "current-build",
                "runtime_session_id": "runtime-current",
                "content_script_version": "current-content",
                "capabilities": {"can_execute": True, "can_observe": True},
            }
        }
    }

    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
        expected_client_id="job-client",
        tab_id=303,
    ) is None

    snapshot["clients"]["wrong-client"]["client_id"] = "job-client"
    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
        expected_client_id="job-client",
        tab_id=303,
    )["client_id"] == "job-client"


def test_runtime_evidence_requires_claimed_client_to_match_terminal_job():
    client = {
        "client_id": "job-client",
        "tab_id": 303,
        "background_version": "current-build",
        "content_script_version": "current-content",
        "runtime_session_id": "runtime-current",
    }
    terminal = {"status": "completed", "tab_id": 303, "client_id": "job-client"}

    assert acceptance.runtime_evidence_ok(
        client,
        terminal,
        expected_client_id="job-client",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
    ) is True
    assert acceptance.runtime_evidence_ok(
        client,
        {**terminal, "client_id": ""},
        expected_client_id="job-client",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
    ) is False
    assert acceptance.runtime_evidence_ok(
        client,
        {**terminal, "client_id": "other-client"},
        expected_client_id="job-client",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
    ) is False


def test_cold_runtime_evidence_requires_a_new_session_but_warm_may_reuse_one():
    client = {
        "client_id": "job-client",
        "tab_id": 303,
        "background_version": "current-build",
        "content_script_version": "current-content",
        "runtime_session_id": "runtime-before-request",
    }
    terminal = {"status": "completed", "tab_id": 303, "client_id": "job-client"}
    common = {
        "expected_client_id": "job-client",
        "expected_background_version": "current-build",
        "expected_content_script_version": "current-content",
        "preexisting_runtime_session_ids": {"runtime-before-request"},
    }

    assert acceptance.runtime_evidence_ok(
        client,
        terminal,
        require_new_runtime=False,
        **common,
    ) is True
    assert acceptance.runtime_evidence_ok(
        client,
        terminal,
        require_new_runtime=True,
        **common,
    ) is False

    client["runtime_session_id"] = "runtime-after-request"
    assert acceptance.runtime_evidence_ok(
        client,
        terminal,
        require_new_runtime=True,
        **common,
    ) is True


def test_ready_client_requires_actual_current_content_script_version():
    client = {
        "domain": "example.test",
        "tab_id": 303,
        "last_seen": 200.0,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "background_version": "current-build",
        "content_script_version": "old-content",
        "runtime_session_id": "runtime-current",
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    snapshot = {"clients": {"current-tab": client}}

    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
        tab_id=303,
    ) is None

    client["content_script_version"] = "current-content"
    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
        tab_id=303,
    )["content_script_version"] == "current-content"


def test_ready_client_rejects_missing_content_script_version():
    snapshot = {
        "clients": {
            "current-tab": {
                "domain": "example.test",
                "tab_id": 303,
                "last_seen": 200.0,
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "state": "ready",
                "source": "content-ready",
                "background_version": "current-build",
                "runtime_session_id": "runtime-current",
                "capabilities": {"can_execute": True, "can_observe": True},
            }
        }
    }

    assert acceptance.ready_client(
        snapshot,
        "example.test",
        expected_background_version="current-build",
        expected_content_script_version="current-content",
        tab_id=303,
    ) is None


def test_current_background_version_reads_the_live_extension_build_identity():
    assert acceptance.current_background_version() == "2026-08-20.09-heartbeat-business-ack"


def test_current_content_script_version_reads_the_live_extension_content_identity():
    assert acceptance.current_content_script_version() == "2026-08-20.09"
