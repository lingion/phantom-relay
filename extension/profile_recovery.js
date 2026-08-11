/* Provider-neutral startup recovery for locally pending profile envelopes. */
(function attachProfileRecovery(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  async function recoverPendingProfiles(store, syncPendingProfile, onRecovered) {
    let current = store || { profiles: {} };
    const recovered = [];
    const failed = [];
    const profiles = current.profiles && typeof current.profiles === 'object' ? current.profiles : {};
    const pendingIds = Object.entries(profiles)
      .filter(([, entry]) => entry?.pending)
      .map(([profileId]) => profileId);

    for (const profileId of pendingIds) {
      try {
        const result = await syncPendingProfile(profileId);
        if (result?.store) current = result.store;
        const envelope = current.profiles?.[profileId]?.active || null;
        if (result?.state !== 'synced' || !envelope) {
          failed.push(profileId);
          continue;
        }
        if (typeof onRecovered === 'function') await onRecovered({ profileId, envelope });
        recovered.push(profileId);
      } catch (error) {
        if (error?.store) current = error.store;
        failed.push(profileId);
      }
    }

    return { store: current, recovered, failed };
  }

  return { recoverPendingProfiles };
});
