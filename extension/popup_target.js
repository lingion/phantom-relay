/* Provider-neutral target selection for popup and tab-hosted recording UI. */
(function attachPopupTarget(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayPopupTarget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function explicitTabIdFromSearch(search) {
    try {
      const value = Number(new URLSearchParams(String(search || '')).get('tab_id'));
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (_) {
      return null;
    }
  }

  function isUsableRecordingTab(tab) {
    const tabId = Number(tab?.id);
    if (!Number.isInteger(tabId) || tabId <= 0) return false;
    try {
      const parsed = new URL(String(tab?.url || ''));
      return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname;
    } catch (_) {
      return false;
    }
  }

  function selectRecordingTab({
    explicitTabId = null,
    explicitTab = null,
    activeTab = null,
    rememberedTab = null,
  } = {}) {
    if (Number.isInteger(explicitTabId) && explicitTabId > 0) {
      if (Number(explicitTab?.id) === explicitTabId && isUsableRecordingTab(explicitTab)) {
        return { ok: true, source: 'explicit', tab: explicitTab };
      }
      return { ok: false, error: 'recording_target_tab_unavailable' };
    }
    if (isUsableRecordingTab(activeTab)) {
      return { ok: true, source: 'active', tab: activeTab };
    }
    if (isUsableRecordingTab(rememberedTab)) {
      return { ok: true, source: 'remembered', tab: rememberedTab };
    }
    return { ok: false, error: 'recording_target_tab_missing' };
  }

  return { explicitTabIdFromSearch, isUsableRecordingTab, selectRecordingTab };
});

