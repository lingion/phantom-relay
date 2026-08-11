'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Recovery = require('../extension/profile_recovery.js');

function storeWithPending() {
  return {
    version: 1,
    profiles: {
      good: {
        active: null,
        pending: { profile: { profileId: 'good', domain: 'good.example' } },
        lastError: null
      },
      bad: {
        active: null,
        pending: { profile: { profileId: 'bad', domain: 'bad.example' } },
        lastError: null
      },
      empty: { active: null, pending: null, lastError: null }
    }
  };
}

test('recovery retries every pending profile and applies only successful active profiles', async () => {
  const applied = [];
  const calls = [];
  const result = await Recovery.recoverPendingProfiles(storeWithPending(), async (profileId) => {
    calls.push(profileId);
    if (profileId === 'bad') throw new Error('offline');
    return {
      state: 'synced',
      store: {
        version: 1,
        profiles: {
          good: {
            active: { profile: { profileId: 'good', domain: 'good.example' } },
            pending: null,
            lastError: null
          },
          bad: {
            active: null,
            pending: { profile: { profileId: 'bad', domain: 'bad.example' } },
            lastError: { code: 'profile_sync_failed' }
          }
        }
      }
    };
  }, ({ profileId, envelope }) => applied.push({ profileId, envelope }));

  assert.deepEqual(calls.sort(), ['bad', 'good']);
  assert.equal(result.recovered.length, 1);
  assert.deepEqual(result.failed, ['bad']);
  assert.equal(applied[0].profileId, 'good');
  assert.equal(applied[0].envelope.profile.domain, 'good.example');
});

test('recovery is a no-op when there are no pending profiles', async () => {
  const result = await Recovery.recoverPendingProfiles({ profiles: {} }, async () => {
    throw new Error('must not be called');
  });

  assert.deepEqual(result.recovered, []);
  assert.deepEqual(result.failed, []);
});

console.log('PROFILE_RECOVERY_TESTS_DEFINED');
