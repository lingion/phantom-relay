/* Provider-neutral recovery candidates for recorded selectors with volatile IDs. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelaySelectorRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function selectorText(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    if (typeof value.css === 'string') return value.css.trim();
    if (typeof value.selector === 'string') return value.selector.trim();
    if (value.selector && typeof value.selector.css === 'string') return value.selector.css.trim();
    return '';
  }

  function cssAttributeValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function deriveAlternatives(value) {
    const css = selectorText(value);
    const match = css.match(/^#([A-Za-z_][\w-]*)$/);
    if (!match) return [];
    const id = match[1];
    const suffix = id.match(UUID_SUFFIX);
    if (!suffix) return [];
    const prefix = id.slice(0, id.length - suffix[0].length + 1);
    if (prefix.length < 3) return [];
    return [`[id^="${cssAttributeValue(prefix)}"]`];
  }

  return { selectorText, deriveAlternatives };
});
