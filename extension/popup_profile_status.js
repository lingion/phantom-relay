/*
 * Phantom Relay — pure popup profile-status presentation helpers.
 *
 * The renderer receives lifecycle metadata only. It deliberately has no page
 * or conversation input so the popup cannot accidentally display captured
 * content while showing a health diagnosis.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayPopupProfileStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_LABELS = Object.freeze({
    recorded: '已录制',
    sync_pending: '等待同步',
    synced: '已同步',
    verified: '已验证',
    degraded: '部分降级',
    invalid: '不可用',
    archived: '已归档',
    legacy_recorded: '旧格式录制',
    unavailable: '未建立 Profile'
  });

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function profileStatusLabel(state, reasonCodes = []) {
    const normalized = String(state || 'unavailable');
    const label = STATE_LABELS[normalized] || normalized;
    const firstReason = Array.isArray(reasonCodes) ? String(reasonCodes[0] || '') : '';
    return firstReason ? `${label} · ${firstReason}` : label;
  }

  function renderProfileStatus(status = {}) {
    const profileId = String(status.profileId || status.profile_id || '—');
    const revision = Number.isInteger(Number(status.revision)) && Number(status.revision) > 0
      ? String(Number(status.revision)) : '—';
    const state = String(status.state || 'unavailable');
    const reasonCodes = Array.isArray(status.reasonCodes)
      ? status.reasonCodes.filter(Boolean).map(String)
      : Array.isArray(status.reason_codes) ? status.reason_codes.filter(Boolean).map(String) : [];
    const lastVerifiedAt = status.lastVerifiedAt || status.last_verified_at || '尚未验证';
    const reasonMarkup = reasonCodes.length
      ? `<div class="profile-status-reasons" role="status"><span>诊断：</span><code>${escapeHtml(reasonCodes.join(', '))}</code></div>`
      : '<div class="profile-status-reasons" role="status">无结构化诊断</div>';
    return `<div class="profile-status-card" data-profile-state="${escapeHtml(state)}">` +
      `<div class="profile-status-heading"><span>Profile 生命周期</span><span class="profile-state-badge">${escapeHtml(profileStatusLabel(state, reasonCodes))}</span></div>` +
      '<dl class="profile-status-grid">' +
        `<div><dt>Profile ID</dt><dd>${escapeHtml(profileId)}</dd></div>` +
        `<div><dt>Revision</dt><dd>${escapeHtml(revision)}</dd></div>` +
        `<div><dt>状态</dt><dd>${escapeHtml(state)}</dd></div>` +
        `<div><dt>最近验证</dt><dd>${escapeHtml(lastVerifiedAt)}</dd></div>` +
      '</dl>' +
      reasonMarkup +
      '</div>';
  }

  return { STATE_LABELS, profileStatusLabel, renderProfileStatus };
});
