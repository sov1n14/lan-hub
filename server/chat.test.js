import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clients, rooms, leaveCurrentRoom } from './rooms.js';
import { handleMessage } from './handlers.js';

function fakeClient(id) {
  const ws = { readyState: 1, out: [], send(s) { this.out.push(JSON.parse(s)); } };
  const c = { id, ws, nickname: id.toUpperCase(), roomId: null, role: null, connected: true, graceTimer: null };
  clients.set(id, c);
  return c;
}
const chats = (c) => c.ws.out.filter((m) => m.type === 'chat').map((m) => m.system ? `*${m.text}` : `${m.from}:${m.text}`);
const lastHistory = (c) => c.ws.out.filter((m) => m.type === 'chat_history').at(-1).messages.map((m) => m.system ? `*${m.text}` : `${m.from}:${m.text}`);

test('room chat reaches players and spectators only; lobby chat reaches lobby only', () => {
  clients.clear(); rooms.clear();
  const host = fakeClient('h'), spec = fakeClient('s'), lobbyA = fakeClient('a'), lobbyB = fakeClient('b');
  handleMessage(host, { type: 'create_room', gameType: 'texas-holdem' });
  const roomId = [...rooms.keys()][0];
  handleMessage(spec, { type: 'join_room', roomId, as: 'spectator' });

  handleMessage(host, { type: 'chat', text: '  hi room  ' });
  handleMessage(lobbyA, { type: 'chat', text: 'hi lobby' });
  handleMessage(spec, { type: 'chat', text: '' });

  assert.deepEqual(chats(host), ['*S 進來旁觀', 'H:hi room']);
  assert.deepEqual(chats(spec), ['*S 進來旁觀', 'H:hi room']);
  assert.deepEqual(chats(lobbyA), ['A:hi lobby']);
  assert.deepEqual(chats(lobbyB), ['A:hi lobby']);
});

test('late joiner gets room history; leaving emits a system line and lobby history is separate', () => {
  clients.clear(); rooms.clear();
  const host = fakeClient('h'), late = fakeClient('l');
  handleMessage(host, { type: 'create_room', gameType: 'texas-holdem' });
  const roomId = [...rooms.keys()][0];
  handleMessage(host, { type: 'chat', text: 'before' });
  handleMessage(late, { type: 'join_room', roomId });
  handleMessage(late, { type: 'chat_history' });
  assert.deepEqual(lastHistory(late), ['H:before', '*L 加入了房間']);

  leaveCurrentRoom(late);
  assert.deepEqual(chats(host).at(-1), '*L 離開了房間');
  handleMessage(late, { type: 'chat_history' });
  assert.ok(!lastHistory(late).some((l) => l.startsWith('*') || l.startsWith('H:')));
});

test('chat text is trimmed to 200 chars', () => {
  clients.clear(); rooms.clear();
  const a = fakeClient('a');
  handleMessage(a, { type: 'chat', text: 'x'.repeat(500) });
  assert.equal(a.ws.out.at(-1).text.length, 200);
});
