/* sidecar/steer-buffer.js — per-run LIVE STEERING buffers (POST /api/run/steer -> the loop's steer drain).

   Extracted from index.js (h1 audit 2026-09-22) so the endpoint's promise is testable without a sidecar. The UI
   answers a 200 with "Steering the live run — it will fold your note in on its next step", so a 200 must only ever
   be given for a note the loop can still read. Two gaps made that a lie:
     1. a note that arrived while the model streamed its FINAL (tool-free) answer sat in the buffer and was dropped
        at teardown with a console line — the loop now drains once more before ending (loop.js, steer extension);
     2. a note that arrived after the loop's last drain but before the host's teardown still got a 200. The loop now
        CLOSES the buffer as it ends (close(), wired as runAgentLoop's o.steerClose): anything still pending comes
        back to the loop, which says in the transcript that it was not applied, and every later POST gets an honest
        409 {ok:false, applied:false} — the frontend's /steer then falls back to queueing the note for the next run.

   makeSteerBuffers({ maxPending?, maxNoteChars?, maxClosed? }) -> {
     post(runId, text, live) -> { status, body },   // live = the run is still registered in-flight by the host
     drain(runId) -> string[],                       // the loop's per-iteration drain (unchanged semantics)
     close(runId) -> string[],                       // the loop's end: returns never-applied notes; later posts get 409
     drop(runId) -> string[],                        // host teardown: forget the run; returns leftovers (host logs the count)
     pending(runId) -> number, isClosed(runId) -> bool
   } */
'use strict';

function makeSteerBuffers(opts) {
  opts = opts || {};
  const maxPending = Number(opts.maxPending) > 0 ? Math.floor(Number(opts.maxPending)) : 8;
  const maxNoteChars = Number(opts.maxNoteChars) > 0 ? Math.floor(Number(opts.maxNoteChars)) : 2000;
  // closed ids are forgotten at drop(); the cap only bounds runs whose host path never tears down through drop()
  const maxClosed = Number(opts.maxClosed) > 0 ? Math.floor(Number(opts.maxClosed)) : 256;
  const buffers = new Map();   // runId -> [pending note text]
  const closed = new Set();    // runIds whose loop has ended: a note can no longer be applied

  function post(runId, text, live) {
    runId = String(runId || '');
    text = String(text == null ? '' : text).trim();
    if (!text) return { status: 400, body: { error: 'empty steering note' } };
    if (!runId || !live) return { status: 404, body: { error: 'no in-flight run for that id' } };
    if (closed.has(runId)) {
      return { status: 409, body: { ok: false, applied: false, error: 'the run has already finished its work — this steering note was not applied; send it as a new message' } };
    }
    const buf = buffers.get(runId) || [];
    if (buf.length >= maxPending) return { status: 429, body: { error: 'steer buffer full', pending: buf.length } };
    buf.push(text.slice(0, maxNoteChars));   // clamp a single note so one steer can't blow up the prompt
    buffers.set(runId, buf);
    return { status: 200, body: { ok: true, pending: buf.length } };
  }

  function drain(runId) {
    const b = buffers.get(runId);
    if (!b || !b.length) return [];
    buffers.set(runId, []);
    return b;
  }

  function close(runId) {
    runId = String(runId || '');
    const b = buffers.get(runId) || [];
    buffers.delete(runId);
    closed.add(runId);
    while (closed.size > maxClosed) closed.delete(closed.values().next().value);
    return b;
  }

  // Teardown: forget the run. Returns any never-drained notes so the host can log the count (index.js dropSteer). With
  // close() wired this is non-empty only for a run whose loop never started or never closed.
  function drop(runId) {
    const b = buffers.get(runId) || [];
    buffers.delete(runId);
    closed.delete(String(runId || ''));
    return b;
  }

  function pending(runId) { const b = buffers.get(runId); return b ? b.length : 0; }
  function isClosed(runId) { return closed.has(String(runId || '')); }

  return { post, drain, close, drop, pending, isClosed };
}

module.exports = { makeSteerBuffers };
