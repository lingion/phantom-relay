/* Provider-neutral resolution of the page used for profile recording. */
(function attachRouteTarget(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayRouteTarget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function hostnameOf(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function routeDomain(value, fallback = '') {
    if (value && typeof value === 'object') {
      const declared = String(value.domain || '').trim();
      if (declared) return declared.toLowerCase();
      value = value.target_url || value.url || '';
    }
    return hostnameOf(value) || String(fallback || '').trim().toLowerCase();
  }

  function safeRouteTargetUrl(value, domain) {
    const expectedDomain = String(domain || '').trim().toLowerCase();
    if (!expectedDomain) return '';
    try {
      const parsed = new URL(String(value || '').trim() || `https://${expectedDomain}/`);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== expectedDomain) {
        return `https://${expectedDomain}/`;
      }
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (_) {
      return `https://${expectedDomain}/`;
    }
  }

  function routeValue(value) {
    if (value && typeof value === 'object') {
      const domain = routeDomain(value);
      return domain ? { domain, url: safeRouteTargetUrl(value.target_url || value.url, domain) } : null;
    }
    const domain = routeDomain(value);
    return domain ? { domain, url: safeRouteTargetUrl(value, domain) } : null;
  }

  function profileRouteValue(value) {
    if (!value || typeof value !== 'object') return null;
    const envelope = value.active || value.pending || value;
    const profile = envelope?.profile || envelope;
    if (!profile || typeof profile !== 'object') return null;
    const domain = routeDomain(profile.domain || profile.origin || profile.url);
    if (!domain) return null;
    return { domain, url: safeRouteTargetUrl(profile.origin || profile.url, domain) };
  }

  function currentPage(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
      return { domain: parsed.hostname.toLowerCase(), url: safeRouteTargetUrl(parsed.toString(), parsed.hostname) };
    } catch (_) {
      return null;
    }
  }

  function resolveRecordingTarget({ model = '', domain = '', currentUrl = '', routes = {}, profiles = {} } = {}) {
    const modelName = String(model || '').trim().toLowerCase();
    const currentDomain = String(domain || '').trim().toLowerCase() || currentPage(currentUrl)?.domain || '';
    const routeEntries = routes && typeof routes === 'object' ? routes : {};
    let selected = modelName ? routeValue(routeEntries[modelName]) : null;
    let source = selected ? 'model_route' : '';

    if (!selected && currentDomain) {
      const match = Object.values(routeEntries).find(value => routeDomain(value) === currentDomain);
      selected = routeValue(match);
      source = selected ? 'domain_route' : '';
    }

    const profileEntries = profiles && typeof profiles === 'object' ? Object.values(profiles) : [];
    if (!selected && modelName) {
      // A profile id or model alias may be the only durable record left after
      // an older route binding was removed. Profiles are data, never provider
      // names, so this fallback stays provider-neutral.
      const match = profileEntries.find(value => {
        const profile = value?.active?.profile || value?.pending?.profile || value?.profile || value;
        return String(profile?.profileId || '').trim().toLowerCase() === modelName;
      });
      selected = profileRouteValue(match);
      source = selected ? 'profile_model' : source;
    }
    if (!selected && currentDomain) {
      const match = profileEntries.find(value => profileRouteValue(value)?.domain === currentDomain);
      selected = profileRouteValue(match);
      source = selected ? (valueHasActiveProfile(match) ? 'profile_active' : 'profile_pending') : source;
    }

    if (selected) {
      const page = currentPage(currentUrl);
      return {
        ok: true,
        source,
        targetUrl: selected.url,
        targetDomain: selected.domain,
        matchesCurrentPage: page?.domain === selected.domain,
      };
    }

    const page = currentPage(currentUrl);
    if (page) {
      return {
        ok: true,
        source: 'current_tab',
        targetUrl: page.url,
        targetDomain: page.domain,
        matchesCurrentPage: true,
      };
    }

    return { ok: false, error: 'recording_route_missing' };
  }

  function valueHasActiveProfile(value) {
    return !!(value?.active?.profile);
  }

  return { hostnameOf, routeDomain, safeRouteTargetUrl, resolveRecordingTarget, profileRouteValue };
});
