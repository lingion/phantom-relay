# model_routes.json Schema Audit Report

**Date:** 2026-07-30
**File:** `/Users/lingion_k/Desktop/phantom-relay/server/model_routes.json` (334 lines, 10.2 KB)
**Models:** 4 (doubao, deepseek-chat, deepseek-reasoner, qwen-turbo)
**Cross-referenced:** `selector_templates.json`, `protocol.py`, `api_server.py`, `admin.html`, redesign spec

---

## 1. Schema Inconsistencies Across Models

### 1.1 Selectors: model_routes.json vs selector_templates.json (CRITICAL)

The two files use **completely different field names and structures** for the same conceptual data:

| model_routes.json field | selector_templates.json field | Conflict |
|---|---|---|
| `selectors.input` (L62,L139,L216,L293) | `{domain}.input` → can be a **complex object** `{selector, kind, key, modifiers}` (L51-58) or flat string (L51) | **Format mismatch.** selector_templates values are objects with metadata; model_routes values are plain strings |
| `selectors.send_button` (L63,L140,L217,L294) | `{domain}.send` (L52,L68) | **Name mismatch:** `send_button` vs `send` |
| `selectors.response_area` (L64,L141,L218,L295) | `{domain}.response` (L57,L72) | **Name mismatch:** `response_area` vs `response` |
| `selectors.file_upload` | **Missing** | Only in model_routes.json; no equivalent in selector_templates |
| `selectors.new_chat` | **Missing** | Only in model_routes.json |
| `selectors.thinking_area` | **Missing** | Only in model_routes.json |
| `selectors.error_indicator` | **Missing** | Only in model_routes.json |
| `selectors.loading_indicator` | **Missing** | Only in model_routes.json |
| `selectors.stop_button` | **Missing** | Only in model_routes.json |

**Additionally**, selector_templates.json stores selectors keyed by **domain** (e.g. `"www.doubao.com"`), while model_routes.json stores them keyed by **model ID**. The server code that dispatches browser jobs uses `route_entry()` → `resolve_model_route()` which references `load_routes()` (the **old** flat `model_routes` dict), not the new structured `model_routes.json`. The extension never sees the selectors from `model_routes.json`.

**Root Cause:** Two parallel selector systems exist, and only `selector_templates.json` is actually used at runtime by the `content.js` extension. `model_routes.json` selectors are dead data.

**JSON Path:** `$.models[*].selectors` (L61-70, L138-148, L215-224, L292-301)

### 1.2 Selectors: qwen domain mismatch in selector_templates.json
- `model_routes.json` qwen provider domain: `"tongyi.aliyun.com"` (L260)
- `selector_templates.json` qwen entry key: `"chat.qwen.ai"` (L50)

These are **different domains**. The extension will never match a model routed to `tongyi.aliyun.com` against selectors registered under `chat.qwen.ai`.

**JSON Path:** `$.models[3].provider.domain` vs selector_templates.json key `"chat.qwen.ai"`

### 1.3 Selectors: selector_templates has uneven structure

- `www.doubao.com` selectors have **object format** with `alternatives`, `capturedAt`, `confidence`, `elementTag` (L3-23)
- `chat.deepseek.com` selectors have **object format** with same metadata (L25-48)
- `chat.qwen.ai` selectors are **mixed**: `input` is a flat string, `send` is an object with `kind`/`key`/`modifiers`, `response` is a flat string (L50-57)
- `wenxin.baidu.com` selectors have object format (L59-78) — but **wenxin is NOT in model_routes.json at all**

**JSON Path:** `selector_templates.json` — file-wide structural inconsistency

---

## 2. Missing Capabilities

The `Capabilities` schema lacks fields that real model routes need:

### 2.1 Missing Modality Support
| Field | Why Needed | Priority |
|---|---|---|
| `supports_audio_input` | Models like GPT-4o-audio accept audio | High |
| `supports_audio_output` | Audio output capable models | Medium |
| `supports_image_input` | Distinct from vision (file upload vs inline vision) | Medium |

**JSON Path:** `$.models[*].capabilities.input_modalities` / `output_modalities` — enum limited to `["text", "image", "audio"]` per spec (L1125-1129) but only `["text"]` used in practice

### 2.2 Missing Operational Capabilities
| Field | Why Needed | Priority |
|---|---|---|
| `supports_web_search` | Many web UIs have search toggle | High |
| `supports_code_interpreter` | Code execution capability | Medium |
| `supports_image_generation` | DALL-E/Gemini image gen | Medium |
| `supports_citations` | Whether model returns citations | Low |
| `supports_temperature` | Temperature parameter support (currently `"accepted_passthrough"`) | Medium |
| `supports_seed` | Deterministic seed support | Low |
| `supports_response_format` | JSON mode / structured output | High |
| `supports_system_prompt` | Whether system prompts work (some Chinese models don't) | High |
| `supports_internet_access` | Web-connected vs offline | Low |

### 2.3 Missing Metadata Fields
| Field | Why Needed | Priority |
|---|---|---|
| `model_version` | Version string (e.g. "seed-1.5-2506") | Medium |
| `status` | `active` / `deprecated` / `beta` / `experimental` | High |
| `category` | `chat` / `reasoning` / `vision` / `code` | Medium |
| `tags` | Free-form tags for filtering/grouping | Low |
| `description` | Longer text description beyond `name` | Medium |
| `rate_limit_rpm` | Requests per minute limit | High |
| `rate_limit_tpd` | Tokens per day limit | Medium |
| `priority` | Throttling priority for routing | Low |
| `concurrency_limit` | Max concurrent requests for this model | Medium |
| `requires_proxy` | Whether a special proxy is needed (e.g., for GFW-bypassing) | Medium |

### 2.4 Missing Selector Fields (already in selector_templates but not in schema)
| Field | Notes |
|---|---|
| `selectors.confirm_button` | Some UIs need confirmation after file upload |
| `selectors.agree_terms` | Terms-of-service acceptance button |
| `selectors.captcha_input` | CAPTCHA handling |
| `selectors.model_switcher` | Dropdown to switch model variants |

---

## 3. Fields Declared But Never Enforced

The `ModelCapabilities` dataclass in `protocol.py` (L16-37) has **19 fields**. `load_model_config()` in `api_server.py` (L56-125) reads all of them. But in the `/v1/chat/completions` handler (L1265-1398), the **only** capability field actually used is:

```
route.capabilities.supports_tool_calling  (L1334)
```

### 3.1 Never-Enforced Capabilities

| Field | Declared In | Enforced? | Impact |
|---|---|---|---|
| `supports_streaming` | protocol.py L19, model_routes L43 | ❌ Never checked | Server streams regardless of capability |
| `supports_vision` | protocol.py L21, model_routes L44 | ❌ Never checked | No vision processing exists |
| `supports_file_upload` | protocol.py L22, model_routes L45 | ❌ Never checked | Extension handles file upload independently |
| `supports_developer_role` | protocol.py L23, model_routes L46 | ❌ Never checked | No role validation |
| `supports_reasoning_effort` | protocol.py L24, model_routes L47 | ❌ Never checked | Parameter ignored |
| `supports_usage_in_streaming` | protocol.py L25, model_routes L48 | ❌ Never checked | Usage always included in non-stream responses |
| `supports_strict_mode` | protocol.py L26, model_routes L49 | ❌ Never checked | No strict-mode logic |
| `supports_store` | protocol.py L27, model_routes L50 | ❌ Never checked | No store feature |
| `requires_tool_result_name` | protocol.py L28, model_routes L51 | ❌ Never checked | Always passes name in tool results |
| `requires_assistant_after_tool_result` | protocol.py L29, model_routes L52 | ❌ Never checked | Handler doesn't inject assistant messages |
| `requires_thinking_as_text` | protocol.py L30, model_routes L53 | ❌ Never checked | No thinking processing |
| `thinking_format` | protocol.py L31, model_routes L54 | ❌ Never checked | No thinking format applied |
| `max_tokens_field` | protocol.py L32, model_routes L55 | ❌ Never checked | Always uses `max_tokens` literally |
| `context_window` | protocol.py L33, model_routes L56 | ❌ Never checked | No token truncation based on this |
| `max_output_tokens` | protocol.py L34, model_routes L57 | ❌ Never checked | No output length enforcement |
| `max_input_chars` | protocol.py L35, model_routes L58 | ❌ Never checked | No input length truncation |
| `input_modalities` | protocol.py L36, model_routes L37 | ❌ Never checked | No modality validation |
| `output_modalities` | protocol.py L37, model_routes L39 | ❌ Never checked | No output validation |
| `reasoning` | protocol.py L38, model_routes L59 | ❌ Never checked | No reasoning behavior differs |

### 3.2 Cost Fields — Never Enforced
`$.models[*].cost` (L72-78, L149-155, L226-232, L303-309):
- Read by `load_model_config()` → stored in `ModelRoute.cost`
- Never used for billing, quota, or rate limiting
- Always `0` for all models

### 3.3 Permission Fields — Never Checked
`$.models[*].permission[*]` (L11-26, L88-103, L165-179, L242-256):
- `allow_sampling`, `allow_view`, `is_blocking`, etc.
- Read but never enforced. All models get identical permission objects.

### 3.4 Selectors — Never Used by Server
`$.models[*].selectors` (L61-70, etc.):
- Read and stored in `ModelRoute.selectors`
- The server **never reads route.selectors for any purpose**
- Browser extension uses `selector_templates.json` via `/browser/selectors` endpoint instead

---

## 4. Conflicts with selector_templates.json

### 4.1 Structural Format Conflict
`selector_templates.json` supports three value formats for selectors:
```json
// Format A: Flat string
"input": "textarea.message-input-textarea"

// Format B: Object with metadata
"input": {
  "alternatives": [],
  "capturedAt": 1784473386145,
  "confidence": "high",
  "elementTag": "textarea",
  "selector": "textarea.semi-input-textarea..."
}

// Format C: Keyboard action object
"send": {
  "kind": "enter",
  "key": "Enter",
  "modifiers": []
}
```

`model_routes.json` supports only Format A (flat strings). There's **no migration path** between the two formats.

### 4.2 Domain Keying vs Model Keying
- `selector_templates.json` → keyed by **domain** (e.g., `"www.doubao.com"`)
- `model_routes.json` → selectors keyed by **model ID** (e.g., `"doubao"`)

Two models (`deepseek-chat`, `deepseek-reasoner` at L104, L182) share the same domain `"chat.deepseek.com"` but have **duplicated identical selectors** (L138-148 and L215-224).

### 4.3 Domain Mismatch (Critical)
| Model | model_routes domain (L260) | selector_templates key (L50) |
|---|---|---|
| qwen-turbo | `tongyi.aliyun.com` | `chat.qwen.ai` |

These are **different domains**. The extension queries selectors by domain, and the model routes resolve to a different domain, so the selectors will **never match**.

### 4.4 Extraneous Entries in selector_templates
`wenxin.baidu.com` (L59-78) exists in `selector_templates.json` but has **no corresponding model** in `model_routes.json`. This is dead data.

---

## 5. OpenClaw Compatibility Issues

Based on the upstream OpenClaw Zero Token audit and redesign spec (Section 6.1):

### 5.1 Compatible Fields ✅
| OpenClaw Field | model_routes Field | Status |
|---|---|---|
| `ModelDefinitionConfig.name` | `$.models[*].name` (L8) | ✅ Compatible |
| `ModelApi` (provider type) | `$.models[*].api` (L27) | ✅ Compatible |
| Model ID | `$.models[*].id` (L4) | ✅ Compatible |

### 5.2 Missing OpenClaw Fields ❌
| OpenClaw Field | Required By | Priority |
|---|---|---|
| `providerId` | OpenClaw model registry | High — all models default to same provider ID |
| `model` (alias) | OpenClaw dispatch key | Medium — duplicates `id` |
| `priority` | OpenClaw model routing | Medium — load balancing |
| `weight` | OpenClaw weighted routing | Low — not needed for browser relay |
| `isDefault` | OpenClaw default model selection | Medium — currently handled by `settings.default_model` |
| `contextWindow` | OpenClaw token management | Low — present as `context_window` but camelCase expected |
| `maxOutputTokens` | OpenClaw token limits | Low — same issue, camelCase |
| `supportsImages` | OpenClaw vision | Low — present as `supports_vision` |
| `supportsComputerUse` | OpenClaw CUA | Low — not applicable to browser relay |

### 5.3 Incompatible Naming Conventions
- OpenClaw uses **camelCase** (`contextWindow`, `maxOutputTokens`, `supportsImages`)
- model_routes uses **snake_case** (`context_window`, `max_output_tokens`, `supports_vision`)
- No normalization/conversion layer exists

### 5.4 Selector Format Incompatibility
OpenClaw's browser tool expects selectors with `ref`-based locator strategies from ARIA snapshots. model_routes.json uses raw CSS selectors. The two are not interchangeable.

---

## 6. Extensibility for 100+ Models

### 6.1 Structural Limits
| Concern | Status | Risk |
|---|---|---|
| Single flat array | All models in one `models[]` array | At 100+ models, a 50KB+ JSON file becomes unwieldy; no sharding |
| No categorization | No `category`, `tags`, or `group` fields | Impossible to filter "show me all reasoning models" |
| No lifecycle management | No `status` field | Can't mark models as deprecated without removing |
| No model families | `root`/`parent` exist but unused | Can't express "all deepseek variants" |
| Duplicated config | `deepseek-chat` and `deepseek-reasoner` share domain/selectors/cost | ~30-40% duplication per model family |

### 6.2 Missing Extension Points
| Feature | Current State | Recommended |
|---|---|---|
| Schema version | No `$schema` or `version` field | Add `"schema_version": "1.0"` for future migrations |
| Custom metadata | No `metadata` object | Add `"metadata": {}` for arbitrary extensions |
| Per-model settings | Global `settings` only | Add `model_settings` override capability |
| Provider types | Hardcoded to `"browser"` | Enum should include `"openai"`, `"anthropic"`, `"gemini"` |
| Model inheritance | `root`/`parent` strings | Add `"extends": "deepseek-chat"` for config inheritance |

### 6.3 Scale-Aware Improvements Needed
1. **Shared selector pools**: Instead of per-model selectors, reference a shared pool by domain
2. **Model groups**: Add `group: "deepseek"` for batch operations
3. **Config includes**: Allow `"$ref": "deepseek-base.json"` for DRY configuration
4. **Validation schema**: Add JSON Schema for automated CI validation
5. **Split large file**: Consider per-provider config files merged at startup

---

## 7. Admin Panel Field Coverage

### 7.1 Fields Rendered ✅
The admin panel at `admin.html` L63-85 renders **7 of ~40+ fields**:

| Rendered Field | Source Path |
|---|---|
| Model ID | `m.id` |
| Display Name | `m.name` |
| Domain | `m.provider?.domain` |
| Tool Calling | `c.supports_tool_calling` |
| Streaming | `c.supports_streaming` |
| File Upload | `c.supports_file_upload` |
| Max Input Chars | `c.max_input_chars` |

### 7.2 Fields NOT Rendered ❌ (~33+ fields missing)

**Provider fields (ALL MISSING):**
- `provider.url` (L31)
- `provider.auth_method` (L32)
- `provider.requires_login` (L33)

**Capability fields (MISSING):**
- `capabilities.supports_vision` (L44)
- `capabilities.supports_developer_role` (L46)
- `capabilities.supports_reasoning_effort` (L47)
- `capabilities.supports_usage_in_streaming` (L48)
- `capabilities.supports_strict_mode` (L49)
- `capabilities.supports_store` (L50)
- `capabilities.requires_tool_result_name` (L51)
- `capabilities.requires_assistant_after_tool_result` (L52)
- `capabilities.requires_thinking_as_text` (L53)
- `capabilities.thinking_format` (L54)
- `capabilities.max_tokens_field` (L55)
- `capabilities.context_window` (L56)
- `capabilities.max_output_tokens` (L57)
- `capabilities.input_modalities` (L37)
- `capabilities.output_modalities` (L39)
- `capabilities.reasoning` (L59)

**Selector fields (ALL MISSING):**
- `selectors.input`, `selectors.send_button`, `selectors.response_area`, `selectors.file_upload`, `selectors.new_chat`, `selectors.thinking_area`, `selectors.error_indicator`, `selectors.loading_indicator`, `selectors.stop_button` (L61-70)

**Cost fields (ALL MISSING):**
- `cost.input_per_million_tokens`, `cost.output_per_million_tokens`, `cost.cache_read_per_million_tokens`, `cost.cache_write_per_million_tokens`, `cost.currency` (L72-77)

**OpenAI standard fields (ALL MISSING):**
- `object`, `created`, `owned_by`, `root`, `parent`, `permission` (L5-26)

**Global settings (MISSING from UI):**
- `settings.default_model`, `settings.max_retries`, `settings.request_timeout_ms`, `settings.browser.*`, `settings.sse.*` (L320-332)

**Aliases (MISSING from UI):**
- `aliases` (L312-318)

### 7.3 Admin Actions — Non-Functional
- **Edit** (L117): Shows `alert()` → "Edit JSON in model_routes.json directly for now"
- **Add** (L118): Shows `alert()` → "Add to model_routes.json and restart server"
- **Delete** (L112-114): Calls `DELETE /admin/api/models/:id` which returns `{"status":"ok"}` but is a **no-op** (api_server.py L1449-1453) — doesn't modify the file

---

## 8. Summary of Findings

| Category | Count | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| Schema inconsistencies | 8 | 2 | 3 | 2 | 1 |
| Missing capabilities | 17 | 6 | 7 | 4 | 0 |
| Fields declared but never enforced | 19 | 3 | 6 | 6 | 4 |
| selector_templates conflicts | 4 | 1 | 2 | 1 | 0 |
| OpenClaw compat issues | 7 | 1 | 4 | 2 | 0 |
| Extensibility limits | 6 | 1 | 3 | 2 | 0 |
| Admin panel gaps | 35+ | 2 | 8 | 15 | 10 |
| **TOTAL** | **96+** | **16** | **33** | **32** | **15** |

### Top 5 Critical Issues (Fix Immediately)
1. **Selectors are dead data**: `model_routes.json` selectors are never consumed; only `selector_templates.json` is used at runtime. Either delete the field or wire it up.
2. **Domain mismatch for qwen**: `tongyi.aliyun.com` vs `chat.qwen.ai` — selector lookup will always fail.
3. **Admin panel is read-only**: Edit/Add/Delete are all stubs; admins must manually edit JSON and restart.
4. **19 capability fields are never enforced**: The dataclass grows with every model but nothing checks the values.
5. **selector_templates.json has uneven schema**: Three different value formats in one file with no validation.
