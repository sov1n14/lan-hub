import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, startHand, applyAction } from './engine.js';
import { scheduleActionTimer, checkTimers } from '../rooms.js';

function headsUp(chipsA, chipsB) {
  const gs = createGame();
  addPlayer(gs, 'a', 'A', chipsA);
  addPlayer(gs, 'b', 'B', chipsB);
  assert.equal(startHand(gs).ok, true);
  return gs;
}

// Capture the timer callback instead of waiting 30 real seconds.
function withCapturedTimer(fn) {
  const real = globalThis.setTimeout;
  const pending = [];
  globalThis.setTimeout = (cb) => { pending.push(cb); return pending.length; };
  try { fn(() => pending.pop()?.()); } finally { globalThis.setTimeout = real; }
}

test('both blinds all-in: board runs out instead of parking on BB', () => {
  const gs = headsUp(20, 40);
  assert.equal(gs.communityCards.length, 5);
  assert.ok(['showdown', 'hand_over'].includes(gs.stage));
});

test('timer checks when nothing to call, folds otherwise', () => withCapturedTimer((fire) => {
  const gs = headsUp(2000, 2000);
  const room = { gameState: gs, players: new Map(), spectators: new Map(), actionTimer: null };
  applyAction(gs, gs.players[gs.toActIdx].id, 'call');
  const bb = gs.players[gs.toActIdx];
  scheduleActionTimer(room);
  fire();
  assert.equal(bb.folded, false);
  assert.equal(gs.stage, 'flop');

  applyAction(gs, gs.players[gs.toActIdx].id, 'bet', 100);
  checkTimers(room);
  const second = gs.players[gs.toActIdx];
  fire();
  assert.equal(second.folded, true);
  assert.equal(gs.stage, 'hand_over');
}));

test('rescheduling for the same acting player keeps the running countdown', () => withCapturedTimer(() => {
  const gs = headsUp(2000, 2000);
  const room = { gameState: gs, players: new Map(), spectators: new Map(), actionTimer: null };
  scheduleActionTimer(room);
  const deadline = gs.turnDeadline;
  room.gameState.turnDeadline = deadline - 10_000;
  checkTimers(room);
  assert.equal(gs.turnDeadline, deadline - 10_000);
}));
