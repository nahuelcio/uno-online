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

test('stacks penalty cards without any cap across a long chain', () => {
  const hands = [
    [{ c: 'R', v: '+2' }, { c: 'G', v: '1' }],
    [{ c: 'W', v: '+4' }, { c: 'G', v: '1' }],
    [{ c: 'B', v: '+2' }, { c: 'G', v: '1' }],
    [{ c: 'W', v: '+4' }, { c: 'G', v: '1' }],
  ];
  const players = hands.map((h, i) => player(`p${i}`, h));
  const room = roomWith(players, {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 40 }, () => ({ c: 'B', v: '7' })),
  });

  const runningTotal = [2, 6, 8];
  players.forEach((p, i) => {
    assert.equal(playable(p.hand[0], room.pile.at(-1), room.color, room.pendingKind), true,
      `p${i} must be able to answer the stack`);
    room.play(p, 0, 'B');
    // The last play sends the turn back to p0, who cannot answer and eats the stack right away.
    if (i < runningTotal.length) assert.equal(room.pendingCards, runningTotal[i], `stack total after p${i}`);
  });

  assert.equal(players[0].hand.length, 1 + 12, 'p0 eats the full uncapped 12-card stack');
  assert.equal(room.pendingCards, 0);
  assert.equal(room.pendingKind, null);
});

test('UNO can be called during the grace window after the second-to-last card', () => {
  const first = player('first', [{ c: 'R', v: '1' }, { c: 'R', v: '2' }], false);
  const second = player('second', [{ c: 'G', v: '9' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 10 }, () => ({ c: 'B', v: '7' })),
  });

  room.play(first, 0);
  assert.equal(first.hand.length, 1, 'no instant +2: the window is still open');
  assert.equal(room.unoWindow.id, first.id);

  room.callUno(first);                                  // called from outside their turn, mid-window
  assert.equal(first.calledUno, true);
  assert.equal(room.unoWindow, null);

  room.closeUnoWindow(first);                           // timer fires late: already safe
  assert.equal(first.hand.length, 1);
});

test('missing the UNO grace window still costs +2', () => {
  const first = player('first', [{ c: 'R', v: '1' }, { c: 'R', v: '2' }], false);
  const second = player('second', [{ c: 'G', v: '9' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 10 }, () => ({ c: 'B', v: '7' })),
  });

  room.play(first, 0);
  room.closeUnoWindow(first);
  assert.equal(first.hand.length, 3, 'silence costs two cards');
});

test('another player can catch a silent UNO and force the +2', () => {
  const first = player('first', [{ c: 'R', v: '1' }, { c: 'R', v: '2' }], false);
  const second = player('second', [{ c: 'G', v: '9' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 10 }, () => ({ c: 'B', v: '7' })),
  });

  room.play(first, 0);
  room.catchUno(second, first.id);
  assert.equal(first.hand.length, 3, 'the caught player eats two cards');
  assert.equal(room.unoWindow, null);

  room.catchUno(second, first.id);                      // window is gone: no double dipping
  assert.equal(first.hand.length, 3);
});

test('a player cannot catch themselves and a called UNO is safe', () => {
  const first = player('first', [{ c: 'R', v: '1' }, { c: 'R', v: '2' }], false);
  const second = player('second', [{ c: 'G', v: '9' }]);
  const room = roomWith([first, second], {
    pile: [{ c: 'R', v: '5' }],
    deck: Array.from({ length: 10 }, () => ({ c: 'B', v: '7' })),
  });

  room.play(first, 0);
  room.catchUno(first, first.id);
  assert.equal(first.hand.length, 1, 'self-catch must be ignored');

  room.callUno(first);
  room.catchUno(second, first.id);
  assert.equal(first.hand.length, 1, 'calling UNO closes the hunt');
});

test('bots are only allowed at the TEST table', () => {
  const test = new Room('TEST');
  test.addBot();
  assert.equal(test.players.length, 1);
  assert.equal(test.players[0].bot, true);

  const real = new Room('MAIN');
  real.addBot();
  assert.equal(real.players.length, 0, 'a real table must stay human-only');
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

