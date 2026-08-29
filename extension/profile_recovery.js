/* Provider-neutral startup recovery for locally pending profile envelopes. */
(function attachProfileRecovery(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const REMOTE_STATES = new Set(['synced', 'verified', 'degraded', 'invalid']);

  function recoveryError(code, message, details = {}) {
    return Object.assign(new Error(message || code), { code, details });
  }

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

  function isBackendReconciliationComplete(result) {
    return result?.attempted === true && result?.completed === true;
  }

  function repairDecision(action, reason, localRevision, remoteRevision) {
    return { action, reason, localRevision, remoteRevision };
  }

  function currentEntryDecision(candidateEntry, currentEntry) {
    const candidateActive = candidateEntry?.active;
    const currentActive = currentEntry?.active;
    const localRevision = Number(candidateActive?.lifecycle?.revision || 0);
    if (currentEntry?.pending) {
      return repairDecision('conflict', 'local_pending_preserved', localRevision, 0);
    }
    const candidateProfileId = String(candidateActive?.profile?.profileId || '');
    const currentProfileId = String(currentActive?.profile?.profileId || '');
    const candidateChecksum = String(candidateActive?.lifecycle?.checksum || '');
    const currentChecksum = String(currentActive?.lifecycle?.checksum || '');
    if (!currentActive
      || currentProfileId !== candidateProfileId
      || Number(currentActive.lifecycle?.revision || 0) !== localRevision
      || currentChecksum !== candidateChecksum) {
      return repairDecision(
        'conflict',
        'local_active_changed',
        Number(currentActive?.lifecycle?.revision || localRevision || 0),
        0,
      );
    }
    return { action: 'current', entry: currentEntry };
  }

  async function validateRemoteProfileReplica(raw, expectedProfileId, expectedDomain) {
    const Profile = root?.PhantomRelayProfile;
    const Lifecycle = root?.PhantomRelayProfileLifecycle;
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ok !== true) {
        throw new Error('remote profile response must be an object with ok=true');
      }
      const profileId = String(raw.profile_id || '').trim();
      if (!profileId || profileId !== String(expectedProfileId || '').trim()) {
        throw new Error('remote profile identity does not match the requested profile');
      }
      if (!raw.profile || typeof raw.profile !== 'object' || Array.isArray(raw.profile)) {
        throw new Error('remote profile content is missing');
      }
      if (!Profile?.normalizeProfile || !Lifecycle?.computeProfileChecksum) {
        throw new Error('profile validation dependencies are unavailable');
      }
      const profile = Profile.normalizeProfile(raw.profile);
      const domain = String(profile.domain || '').trim().toLowerCase();
      const requestedDomain = String(expectedDomain || '').trim().toLowerCase();
      let origin;
      try {
        origin = new URL(String(profile.origin || '').trim());
      } catch (_) {
        throw new Error('remote profile origin is invalid');
      }
      if (profile.profileId !== profileId
        || domain !== requestedDomain
        || !['http:', 'https:'].includes(origin.protocol)
        || origin.hostname.toLowerCase() !== domain
        || origin.hostname.toLowerCase() !== requestedDomain) {
        throw new Error('remote profile content identity does not match the request');
      }
      if (!Profile.hasRecordedIdentityVerification(profile)) {
        throw new Error('remote profile lacks recorded identity verification');
      }
      const revision = Number(raw.revision);
      const checksum = String(raw.checksum || '');
      const state = String(raw.state || '');
      if (!Number.isInteger(revision) || revision < 1) {
        throw new Error('remote profile revision is invalid');
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
        throw new Error('remote profile checksum is invalid');
      }
      if (!REMOTE_STATES.has(state)) {
        throw new Error('remote profile state is invalid');
      }
      if (await Lifecycle.computeProfileChecksum(profile) !== checksum) {
        throw new Error('remote profile checksum does not match profile content');
      }
      return { ...raw, profile, profile_id: profileId, revision, checksum, state };
    } catch (error) {
      if (error?.code === 'backend_profile_invalid') throw error;
      throw recoveryError('backend_profile_invalid', error?.message || String(error));
    }
  }

  function planActiveProfileBackendRepair(entry, remote) {
    const active = entry?.active;
    const localRevision = Number(active?.lifecycle?.revision || 0);
    const remoteRevision = remote == null ? 0 : Number(remote?.revision || 0);
    const localChecksum = String(active?.lifecycle?.checksum || '');
    const remoteChecksum = remote == null ? '' : String(remote?.checksum || '');

    if (!active?.profile || !Number.isInteger(localRevision) || localRevision < 1 || !localChecksum) {
      return repairDecision('conflict', 'local_active_invalid', localRevision, remoteRevision);
    }
    if (entry?.pending) {
      return repairDecision('conflict', 'local_pending_preserved', localRevision, remoteRevision);
    }
    if (remote == null) {
      return repairDecision('republish_active', 'backend_profile_missing', localRevision, 0);
    }
    if (!Number.isInteger(remoteRevision) || remoteRevision < 1 || !remoteChecksum) {
      return repairDecision('conflict', 'backend_profile_invalid', localRevision, remoteRevision);
    }
    if (localRevision > remoteRevision) {
      return repairDecision('republish_active', 'backend_revision_behind', localRevision, remoteRevision);
    }
    if (localRevision < remoteRevision) {
      return repairDecision('conflict', 'backend_revision_ahead', localRevision, remoteRevision);
    }
    if (localChecksum !== remoteChecksum) {
      return repairDecision('conflict', 'profile_checksum_conflict', localRevision, remoteRevision);
    }
    return repairDecision('matched', 'profile_matches', localRevision, remoteRevision);
  }

  function isActiveProfileRepairAcknowledged(active, acknowledgement) {
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
      return false;
    }
    const profileId = String(active?.profile?.profileId || '');
    const revision = Number(active?.lifecycle?.revision || 0);
    const checksum = String(active?.lifecycle?.checksum || '');
    const acknowledgementRevision = Number(acknowledgement.revision);
    const acknowledgementChecksum = String(acknowledgement.checksum || '');
    return acknowledgement.ok === true
      && profileId.length > 0
      && String(acknowledgement.profile_id || '') === profileId
      && String(acknowledgement.state || '') === 'synced'
      && Number.isInteger(revision)
      && revision > 0
      && Number.isInteger(acknowledgementRevision)
      && acknowledgementRevision === revision
      && /^sha256:[0-9a-f]{64}$/.test(checksum)
      && /^sha256:[0-9a-f]{64}$/.test(acknowledgementChecksum)
      && acknowledgementChecksum === checksum;
  }

  async function recoverActiveProfileReplica(options = {}) {
    const candidateEntry = options.candidateEntry;
    const getCurrentEntry = options.getCurrentEntry;
    if (typeof getCurrentEntry !== 'function' || typeof options.loadRemote !== 'function') {
      throw recoveryError('profile_backend_repair_dependencies_missing');
    }

    let remote = null;
    let remoteResponse;
    try {
      remoteResponse = await options.loadRemote();
    } catch (error) {
      throw recoveryError('backend_unreachable', error?.message || String(error));
    }
    if (Number(remoteResponse?.status) === 404) {
      remote = null;
    } else if (!remoteResponse?.ok) {
      throw recoveryError(`profile_lookup_failed:${Number(remoteResponse?.status || 0)}`);
    } else {
      let payload;
      try {
        payload = await remoteResponse.json();
      } catch (error) {
        return repairDecision(
          'conflict',
          'backend_profile_invalid',
          Number(candidateEntry?.active?.lifecycle?.revision || 0),
          0,
        );
      }
      try {
        remote = await validateRemoteProfileReplica(
          payload,
          options.profileId,
          options.expectedDomain,
        );
      } catch (error) {
        return repairDecision(
          'conflict',
          error?.code || 'backend_profile_invalid',
          Number(candidateEntry?.active?.lifecycle?.revision || 0),
          Number(payload?.revision || 0),
        );
      }
    }

    let current = currentEntryDecision(candidateEntry, getCurrentEntry());
    if (current.action === 'conflict') return current;
    let replica = planActiveProfileBackendRepair(current.entry, remote);
    if (replica.action === 'conflict') return replica;

    if (replica.action === 'republish_active') {
      current = currentEntryDecision(candidateEntry, getCurrentEntry());
      if (current.action === 'conflict') return current;
      if (typeof options.publishActive !== 'function') {
        throw recoveryError('profile_backend_repair_publisher_missing');
      }
      const acknowledgement = await options.publishActive(current.entry.active);
      if (!isActiveProfileRepairAcknowledged(current.entry.active, acknowledgement)) {
        throw recoveryError('profile_backend_repair_ack_mismatch');
      }
      current = currentEntryDecision(candidateEntry, getCurrentEntry());
      if (current.action === 'conflict') return current;
      replica = {
        action: 'repaired',
        reason: replica.reason,
        localRevision: replica.localRevision,
        remoteRevision: replica.remoteRevision,
      };
    }

    let selectorsNeedRepair = replica.action === 'repaired';
    if (!selectorsNeedRepair && typeof options.inspectSelectors === 'function') {
      selectorsNeedRepair = await options.inspectSelectors(current.entry.active) === true;
    }
    if (!selectorsNeedRepair) return { ...replica, selectorsRepaired: false };

    current = currentEntryDecision(candidateEntry, getCurrentEntry());
    if (current.action === 'conflict') return current;
    if (typeof options.applySelectors !== 'function') {
      throw recoveryError('profile_selector_repair_missing');
    }
    await options.applySelectors(current.entry.active);
    return { ...replica, selectorsRepaired: true };
  }

  function canReuseRecordedSelectorView(options = {}) {
    const activeChecksum = String(options.activeChecksum || '');
    const incomingChecksum = String(options.incomingChecksum || '');
    const existingChecksum = String(options.existingChecksum || '');
    return options.existingExecutable === true
      && options.selectorBundleMatches === true
      && activeChecksum.length > 0
      && activeChecksum === incomingChecksum
      && existingChecksum === incomingChecksum;
  }

  return {
    recoverPendingProfiles,
    isBackendReconciliationComplete,
    planActiveProfileBackendRepair,
    validateRemoteProfileReplica,
    isActiveProfileRepairAcknowledged,
    recoverActiveProfileReplica,
    canReuseRecordedSelectorView,
  };
});
