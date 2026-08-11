"""Provider-neutral configuration registries.

The legacy ``model_routes.json`` mixed model metadata, site details, and CSS
selectors. This module defines the additive boundary used by the migration:

    model registry  -> what a model is and which profile it needs
    profile registry -> how a browser page is operated
    user bindings    -> which model/binding points at which profile

It is intentionally pure and has no Flask or filesystem side effects. The
server can therefore validate or migrate configuration before changing runtime
ownership.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re
from typing import Any
from urllib.parse import urlparse


class RegistryContractError(ValueError):
    """Raised when a registry crosses its boundary with an invalid shape."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _require_mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RegistryContractError("registry_invalid", f"{field} must be an object", {"field": field})
    return value


def _profile_id_for_domain(domain: str) -> str:
    normalized = _text(domain).lower()
    if not normalized:
        return ""
    return f"legacy-domain:{normalized}:v1"


def canonical_profile_payload(profile: dict[str, Any]) -> str:
    """Return the browser-compatible canonical profile JSON payload."""
    if not isinstance(profile, dict):
        raise RegistryContractError("profile_invalid", "profile must be an object")
    payload = deepcopy(profile)
    payload.pop("lifecycle", None)
    payload.pop("health", None)
    payload.pop("__normalizedProfile", None)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def profile_checksum(profile: dict[str, Any]) -> str:
    payload = canonical_profile_payload(profile)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _network_capture_is_executable(profile: dict[str, Any]) -> bool:
    capture = profile.get("capture") if isinstance(profile.get("capture"), dict) else {}
    if str(capture.get("mode") or "").strip().lower() not in {"network", "hybrid"}:
        return False
    response = capture.get("response") if isinstance(capture.get("response"), dict) else {}
    url = response.get("url") if isinstance(response.get("url"), dict) else {}
    origins = url.get("origins") if isinstance(url.get("origins"), list) else ([url.get("origin")] if url.get("origin") else [])
    paths = url.get("pathPatterns") if isinstance(url.get("pathPatterns"), list) else ([url.get("pathPattern")] if url.get("pathPattern") else [])
    mime_types = response.get("mimeTypes") if isinstance(response.get("mimeTypes"), list) else ([response.get("mimeType")] if response.get("mimeType") else [])
    parser = capture.get("parser") if isinstance(capture.get("parser"), dict) else {}
    text_rules = parser.get("textRules") if isinstance(parser.get("textRules"), list) else []
    finish_rules = parser.get("finishRules") if isinstance(parser.get("finishRules"), list) else []
    return bool(
        all(isinstance(item, str) and item.strip() for item in origins)
        and all(isinstance(item, str) and item.strip() for item in paths)
        and all(isinstance(item, str) and item.strip() for item in mime_types)
        and str(parser.get("eventFormat") or "sse").strip().lower() == "sse"
        and text_rules
        and (finish_rules or parser.get("allowLoadingFinished") is True)
    )


_GENERIC_IDENTITY_EXCLUDED = re.compile(
    r"(?:^|[-_:])(role|status|state|streaming|loading|busy|typing|generating|thinking|processing|pending|complete|completed|finished|active|current|selected|disabled|expanded|pressed|checked|open|closed|visible|hidden|focus|hover|animation|transition|test|qa|click|show|hide|base|share|delete|session|query|content|text|html|style|log|rank|index|position|order|offset|page|count|sort|spm|track|trace|analytics|telemetry|event|anchor|source|panel|layout|container|viewport)(?:[-_:]|$)",
    re.IGNORECASE,
)
_UUID_LITERAL = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_GENERATED_MESSAGE_LITERAL = re.compile(
    r"(?:message|response|reply|result|item|row|node|turn)[-:.]?(?:\d{6,}|[0-9a-f]{16,}|[a-z0-9]{12,})",
    re.IGNORECASE,
)
_SPECIFIC_ID_SELECTOR = re.compile(
    r"(?:^|[\s>+~,(])#[A-Za-z_][A-Za-z0-9_-]*|\[\s*id\s*(?:\^=|\$=|\*=|~=|\|=|=)\s*['\"][^'\"]+['\"]\s*\]",
    re.IGNORECASE,
)


def _stable_identity_attribute(value: Any) -> bool:
    name = _text(value).lower()
    if not re.fullmatch(r"(?:data-[a-z][a-z0-9_.:-]*|id)", name):
        return False
    return _GENERIC_IDENTITY_EXCLUDED.search(name) is None


def _selector_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, dict):
        return []
    alternatives = value.get("alternatives") if isinstance(value.get("alternatives"), list) else []
    return [item.strip() for item in [value.get("css") or value.get("selector"), *alternatives]
            if isinstance(item, str) and item.strip()]


def _volatile_selector_literal(value: Any) -> bool:
    selector = _text(value)
    return bool(selector and (_UUID_LITERAL.search(selector) or _GENERATED_MESSAGE_LITERAL.search(selector)))


def _selector_binds_specific_id(value: Any) -> bool:
    return any(_SPECIFIC_ID_SELECTOR.search(selector) for selector in _selector_values(value))


_SEMANTIC_RESPONSE_BOUNDARY = re.compile(
    r"(?:^|[-_.\s>#])(message|response|reply|assistant|answer|output|completion|result)(?:[-_.\s>#]|$)",
    re.IGNORECASE,
)
_GENERIC_RESPONSE_BOUNDARY = re.compile(
    r"(?:^|[-_.\s>#])(app|root|conversation|chat|flow|history|list|container|wrapper|scroll|layout|panel|page|viewport|body|main|content)(?:[-_.\s>#]|$)",
    re.IGNORECASE,
)


def _semantic_response_boundary(value: Any) -> bool:
    for selector in _selector_values(value):
        if _volatile_selector_literal(selector):
            continue
        if _SEMANTIC_RESPONSE_BOUNDARY.search(selector):
            return True
    return False


def _structural_response_selector(value: Any) -> bool:
    for selector in _selector_values(value):
        if _volatile_selector_literal(selector):
            continue
        if _GENERIC_RESPONSE_BOUNDARY.search(selector) and not _SEMANTIC_RESPONSE_BOUNDARY.search(selector):
            return True
    return False


def _profile_is_executable(profile: dict[str, Any]) -> bool:
    if not isinstance(profile, dict):
        return False
    response = profile.get("response") if isinstance(profile.get("response"), dict) else {}
    identity = response.get("identity") if isinstance(response.get("identity"), dict) else {}
    capture_mode = str(profile.get("capture", {}).get("mode") or "dom").strip().lower() if isinstance(profile.get("capture"), dict) else "dom"
    selector = response.get("selector") or response.get("containerSelector")
    attributes = identity.get("attributes") if isinstance(identity.get("attributes"), list) else []
    verification_attributes = (
        response.get("identityVerification", {}).get("attributes")
        if isinstance(response.get("identityVerification"), dict)
        else []
    )
    identity_verification = response.get("identityVerification") if isinstance(response.get("identityVerification"), dict) else {}
    dynamic_identity = (
        "id" in {_text(attribute).lower() for attribute in attributes}
        and identity_verification.get("method") == "dom-unique-at-recording"
        and identity_verification.get("identityKind") == "unique-per-message"
        and _semantic_response_boundary(response.get("containerSelector") or response.get("selector"))
    )
    origin = _text(profile.get("origin"))
    origin_domain = (urlparse(origin).hostname or "").lower() if origin else ""
    selectors = _selector_values(response.get("selector")) + _selector_values(response.get("containerSelector"))
    return bool(
        _text(profile.get("profileId"))
        and origin
        and _text(profile.get("domain")).lower()
        and origin_domain == _text(profile.get("domain")).lower()
        and profile.get("input")
        and profile.get("send")
        and capture_mode not in {"network", "hybrid"}
        and selector
        and (attributes or _text(identity.get("path")))
        and all(_stable_identity_attribute(attribute) for attribute in attributes)
        and all(_stable_identity_attribute(attribute) for attribute in verification_attributes)
        and not ("id" in {_text(attribute).lower() for attribute in attributes}
                 and _structural_response_selector(response.get("selector")))
        and ("id" not in {_text(attribute).lower() for attribute in attributes}
             or dynamic_identity
             or any(_selector_binds_specific_id(value) for value in (response.get("selector"), response.get("containerSelector"))))
        and not any(_volatile_selector_literal(value) for value in selectors)
        and identity_verification.get("status") == "verified"
    )


def validate_profile_envelope(envelope: dict[str, Any], expected_domain: str | None = None) -> dict[str, Any]:
    """Validate a profile upload without coupling it to a model/provider."""
    source = _require_mapping(envelope, "profile_envelope")
    profile = source.get("profile")
    if not isinstance(profile, dict):
        raise RegistryContractError("profile_incomplete", "profile is required", {"field": "profile"})
    profile = deepcopy(profile)
    profile_id = _text(profile.get("profileId") or profile.get("profile_id"))
    if not profile_id:
        raise RegistryContractError("profile_incomplete", "profileId is required", {"field": "profileId"})
    profile["profileId"] = profile_id
    domain = _text(profile.get("domain")).lower()
    origin = _text(profile.get("origin"))
    if expected_domain and domain != _text(expected_domain).lower():
        raise RegistryContractError(
            "profile_domain_mismatch",
            "profile domain does not match the existing binding",
            {"expected_domain": _text(expected_domain).lower(), "actual_domain": domain},
        )
    response = profile.get("response") if isinstance(profile.get("response"), dict) else {}
    identity = response.get("identity") if isinstance(response.get("identity"), dict) else {}
    # Storage accepts a complete network capture contract for calibration and
    # comparison.  Runtime execution still uses _profile_is_executable(),
    # which deliberately rejects network/hybrid as the primary DOM path.
    dom_executable = _profile_is_executable(profile)
    network_capture_complete = _network_capture_is_executable(profile)
    if not dom_executable and not network_capture_complete:
        reason = "response_contract_missing" if not identity.get("attributes") and not identity.get("path") else "profile_incomplete"
        raise RegistryContractError(reason, "profile is not executable", {"profile_id": profile_id})
    if not domain or not origin or (urlparse(origin).hostname or "").lower() != domain:
        raise RegistryContractError("profile_domain_mismatch", "profile origin and domain must match", {"profile_id": profile_id})
    revision = int(source.get("revision") or (profile.get("lifecycle") or {}).get("revision") or 0)
    if revision < 1:
        raise RegistryContractError("profile_revision_invalid", "profile revision must be positive", {"revision": revision})
    supplied_checksum = _text(source.get("checksum") or (profile.get("lifecycle") or {}).get("checksum"))
    expected_checksum = profile_checksum(profile)
    if supplied_checksum != expected_checksum:
        raise RegistryContractError(
            "profile_checksum_mismatch",
            "profile checksum does not match canonical profile content",
            {"expected": expected_checksum, "actual": supplied_checksum},
        )
    return {"profile": profile, "profile_id": profile_id, "revision": revision, "checksum": expected_checksum}


def normalize_model_registry(value: dict[str, Any]) -> dict[str, Any]:
    source = _require_mapping(value, "model_registry")
    models = source.get("models", [])
    if not isinstance(models, list):
        raise RegistryContractError("registry_invalid", "model_registry.models must be an array", {"field": "models"})
    normalized_models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(models):
        model = _require_mapping(raw, f"model_registry.models[{index}]")
        model_id = _text(model.get("id"))
        if not model_id:
            raise RegistryContractError("registry_invalid", "model id is required", {"index": index})
        if model_id in seen:
            raise RegistryContractError("registry_invalid", "model ids must be unique", {"id": model_id})
        if "selectors" in model:
            raise RegistryContractError(
                "model_selector_leakage",
                "model registry entries must not contain selectors",
                {"id": model_id},
            )
        seen.add(model_id)
        normalized_models.append(deepcopy(model))
    aliases = source.get("aliases", {})
    settings = source.get("settings", {})
    if not isinstance(aliases, dict) or not isinstance(settings, dict):
        raise RegistryContractError("registry_invalid", "aliases and settings must be objects")
    return {
        "version": int(source.get("version", 1)),
        "models": normalized_models,
        "aliases": { _text(key).lower(): _text(value) for key, value in aliases.items() if _text(key) and _text(value) },
        "settings": deepcopy(settings),
    }


def normalize_profile_registry(value: dict[str, Any]) -> dict[str, Any]:
    source = _require_mapping(value, "profile_registry")
    profiles = source.get("profiles", {})
    if not isinstance(profiles, dict):
        raise RegistryContractError("registry_invalid", "profile_registry.profiles must be an object", {"field": "profiles"})
    normalized: dict[str, Any] = {}
    for key, raw in profiles.items():
        profile_id = _text(key)
        if not profile_id:
            continue
        profile = _require_mapping(raw, f"profile_registry.profiles.{profile_id}")
        declared_id = _text(profile.get("profileId") or profile.get("profile_id") or profile_id)
        if declared_id != profile_id:
            raise RegistryContractError(
                "profile_id_mismatch",
                "profile key and profileId must match",
                {"key": profile_id, "profileId": declared_id},
            )
        normalized[profile_id] = {**deepcopy(profile), "profileId": profile_id}
    return {"version": int(source.get("version", 1)), "profiles": normalized}


def normalize_user_bindings(value: dict[str, Any]) -> dict[str, Any]:
    source = _require_mapping(value, "user_bindings")
    bindings = source.get("bindings", {})
    if not isinstance(bindings, dict):
        raise RegistryContractError("registry_invalid", "user_bindings.bindings must be an object", {"field": "bindings"})
    normalized: dict[str, Any] = {}
    for key, raw in bindings.items():
        binding_key = _text(key).lower()
        binding = _require_mapping(raw, f"user_bindings.bindings.{binding_key}")
        profile_id = _text(binding.get("profile_id") or binding.get("profileId"))
        if not binding_key or not profile_id:
            raise RegistryContractError(
                "binding_invalid",
                "each binding requires a key and profile_id",
                {"key": binding_key},
            )
        normalized[binding_key] = {**deepcopy(binding), "profile_id": profile_id}
    return {"version": int(source.get("version", 1)), "bindings": normalized}


def split_legacy_config(legacy: dict[str, Any]) -> dict[str, Any]:
    """Convert the old mixed config into additive registry documents.

    Legacy selectors are not promoted into complete profiles because they do
    not contain response identity or freshness semantics. They are reported as
    migration hints instead of silently becoming executable profiles.
    """
    source = _require_mapping(legacy, "legacy_config")
    model_entries = source.get("models", [])
    if not isinstance(model_entries, list):
        raise RegistryContractError("registry_invalid", "legacy models must be an array")
    models: list[dict[str, Any]] = []
    bindings: dict[str, dict[str, Any]] = {}
    hints: list[dict[str, Any]] = []
    for index, raw in enumerate(model_entries):
        model = _require_mapping(raw, f"legacy.models[{index}]")
        model_id = _text(model.get("id"))
        if not model_id:
            continue
        provider = model.get("provider") if isinstance(model.get("provider"), dict) else {}
        domain = _text(provider.get("domain"))
        profile_id = _profile_id_for_domain(domain)
        migrated = {key: deepcopy(value) for key, value in model.items() if key != "selectors"}
        if profile_id:
            migrated["profile_id"] = profile_id
            bindings[model_id.lower()] = {"profile_id": profile_id, "source": "legacy-model-route"}
        if model.get("selectors"):
            hints.append({
                "model_id": model_id,
                "profile_id": profile_id,
                "reason": "legacy selectors lack response identity contract",
                "selector_fields": sorted(model["selectors"].keys()) if isinstance(model["selectors"], dict) else [],
            })
        models.append(migrated)
    model_registry = normalize_model_registry({
        "version": 1,
        "models": models,
        "aliases": source.get("aliases", {}),
        "settings": source.get("settings", {}),
    })
    profile_registry = {"version": 1, "profiles": {}}
    user_bindings = normalize_user_bindings({"version": 1, "bindings": bindings})
    return {
        "model_registry": model_registry,
        "profile_registry": profile_registry,
        "user_bindings": user_bindings,
        "migration_hints": hints,
    }


def merge_recorded_profiles(
    profile_registry: dict[str, Any],
    selector_templates: dict[str, Any],
) -> dict[str, Any]:
    """Promote only complete profiles already recorded by the extension.

    Old selector templates are deliberately not promoted. A template becomes
    executable only when its ``profile`` field contains the response identity
    contract generated by the extension/profile recorder.
    """
    normalized = normalize_profile_registry(profile_registry)
    profiles = normalized["profiles"]
    for domain, template in (selector_templates.items() if isinstance(selector_templates, dict) else []):
        if not isinstance(template, dict) or not isinstance(template.get("profile"), dict):
            continue
        profile = deepcopy(template["profile"])
        profile_id = _text(profile.get("profileId") or profile.get("profile_id"))
        if not profile_id:
            continue
        profile["profileId"] = profile_id
        profile.setdefault("domain", _text(domain).lower())
        profiles[profile_id] = profile
    return {"version": normalized["version"], "profiles": profiles}


def build_migration_documents(
    legacy_model_config: dict[str, Any],
    selector_templates: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build separate documents without mutating either legacy input."""
    split = split_legacy_config(legacy_model_config)
    profile_registry = merge_recorded_profiles(
        split["profile_registry"], selector_templates or {}
    )
    split["profile_registry"] = profile_registry
    missing_profiles = []
    for binding_key, binding in split["user_bindings"]["bindings"].items():
        profile_id = _text(binding.get("profile_id"))
        if profile_id and profile_id not in profile_registry["profiles"]:
            missing_profiles.append({"binding": binding_key, "profile_id": profile_id})
    split["migration_hints"].extend(
        {"reason": "profile_missing_for_binding", **entry} for entry in missing_profiles
    )
    return split


def resolve_binding(model_id: str, model_registry: dict[str, Any], user_bindings: dict[str, Any]) -> dict[str, Any] | None:
    models = { _text(item.get("id")).lower(): item for item in model_registry.get("models", []) if isinstance(item, dict) }
    aliases = model_registry.get("aliases", {}) if isinstance(model_registry.get("aliases"), dict) else {}
    requested = _text(model_id).lower()
    resolved = _text(aliases.get(requested) or requested).lower()
    model = models.get(resolved)
    if not model:
        return None
    bindings = user_bindings.get("bindings", {}) if isinstance(user_bindings, dict) else {}
    binding = bindings.get(resolved) or bindings.get(requested) or {}
    profile_id = _text(binding.get("profile_id") or model.get("profile_id")) if isinstance(binding, dict) else _text(model.get("profile_id"))
    return {"model_id": resolved, "profile_id": profile_id, "model": deepcopy(model)}
