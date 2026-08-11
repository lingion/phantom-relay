'use strict';

// Provider-neutral request-boundary and candidate selection helpers. These
// helpers only use transport metadata and parsed text held in memory.
(function attachNetworkCandidate(global) {
  function requestTime(request) {
    // Candidate ownership is proved by the request start, not by the time
    // its response happened to arrive. A pre-boundary request may finish
    // after the send boundary, so falling back to responseAt would accept an
    // old stream as the reply to the new send.
    return Number(request?.requestAt || 0);
  }

  function isAfterBoundary(request, boundaryAt) {
    const boundary = Number(boundaryAt || 0);
    const started = requestTime(request);
    return Number.isFinite(started) && started > 0 && started >= boundary;
  }

  function chooseCandidate(candidates, boundaryAt) {
    const eligible = (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && candidate.text && isAfterBoundary(candidate, boundaryAt))
      .filter(candidate => candidate.finished);
    if (!eligible.length) return null;
    // A transport contract does not prove which of several same-shaped
    // responses belongs to this send. Only accept multiple candidates when
    // they converge to the exact same parsed text; otherwise fail closed and
    // let a hybrid profile use its DOM response contract.
    const distinctText = new Set(eligible.map(candidate => String(candidate.text || '')));
    if (distinctText.size > 1) return null;
    return eligible.sort((left, right) => requestTime(right) - requestTime(left))[0] || null;
  }

  global.PhantomRelayNetworkCandidate = { requestTime, isAfterBoundary, chooseCandidate };
})(globalThis);
