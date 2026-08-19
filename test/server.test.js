const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, playable } = require('../server');

const socket = () => ({ readyState: 1, send() {} });
const player = (name, hand, calledUno = true) => ({ id: name, name, hand, calledUno, ws: socket() });

function roomWith(players, { pile, color = 'R', deck = [], turn = 0 } = {}) {
  const room = new Room('TEST');
  room.players = players;
  room.started = true;
  room.pile = pile;
  room.color = color;
  room.deck = deck;
  room.turn = turn;
  room.step = 1;
  room.pendingKind = null;
  room.pendingCards = 0;
  room.log = [];
  return room;
}

test('allows mixed +2 and +4 stacking and applies the accumulated penalty', () => {
  const first = player('first', [{ c: 'R', v: '+2' }, { c: 'G', v: '1' }]);
  const second = player('second', [{ c: 'W', v: '+4' }, { c: 'G', v: '2' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 6 }, () => ({ c: 'B', v: '7' })),
  });

  room.play(first, 0);
  assert.equal(room.pendingCards, 2);
  assert.equal(room.turn, 1);
  assert.equal(playable(second.hand[0], room.pile.at(-1), room.color, room.pendingKind), true);

  room.play(second, 0, 'B');
  assert.equal(first.hand.length, 7);
  assert.equal(room.pendingCards, 0);
  assert.equal(room.pendingKind, null);
});

test('rejects a manual draw while the active player has a legal card', () => {
  const first = player('first', [{ c: 'R', v: '1' }]);
  const second = player('second', [{ c: 'G', v: '2' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: [{ c: 'B', v: '9' }],
  });

  room.drawTurn(first);
  assert.equal(first.hand.length, 1);
  assert.equal(room.turn, 0);
});
