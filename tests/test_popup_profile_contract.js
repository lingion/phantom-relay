'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const PopupProfile = require('../extension/popup_profile_contract.js');

const recordedResponse = {
  selector: '[data-message-id]',
  identity: { attributes: ['data-message-id'] }
};

test('network-only calibration preserves an existing DOM response contract', () => {
  const result = PopupProfile.mergeCalibrationResponse(recordedResponse, {
    capture: { mode: 'network' },
    response: {}
  });

  assert.deepEqual(result, recordedResponse);
});

test('hybrid calibration uses its stable DOM fallback', () => {
  const calibrated = {
    selector: '[data-row-key]',
    identity: { path: '/data-row-key' }
  };

  const result = PopupProfile.mergeCalibrationResponse(recordedResponse, {
    capture: { mode: 'hybrid' },
    response: calibrated
  });

  assert.deepEqual(result, calibrated);
});

test('hybrid calibration with an incomplete DOM fallback preserves the recorded one', () => {
  const result = PopupProfile.mergeCalibrationResponse(recordedResponse, {
    capture: { mode: 'hybrid' },
    response: { selector: '[data-message]' }
  });

  assert.deepEqual(result, recordedResponse);
});

test('network-only calibration without a previous DOM response remains empty', () => {
  assert.equal(PopupProfile.mergeCalibrationResponse(null, {
    capture: { mode: 'network' },
    response: {}
  }), null);
});

test('network-only calibration preserves the legacy selector view', () => {
  const legacySelector = {
    selector: '#assistant-message'
  };

  assert.deepEqual(PopupProfile.mergeCalibrationResponse(legacySelector, {
    capture: { mode: 'network' },
    response: {}
  }), legacySelector);
});

console.log('POPUP_PROFILE_CONTRACT_TESTS_DEFINED');
