// Authoritative UNO server: rooms of 2-12 players over WebSockets.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 4321;   // 3000 collides with too much other tooling
const MAX_PLAYERS = 12;
const NUDGE_COOLDOWN_MS = 700;
const EMOTE_COOLDOWN_MS = 1200;
const BOT_DELAY_MS = 900;
const UNO_GRACE_MS = 3500;               // window to click UNO after dumping your second-to-last card
const CHAT_COOLDOWN_MS = 500;
const CHAT_MAX_LEN = 140;
const TEST_ROOM = "TEST";                // bots exist only at this table, so real games stay human-only
const EMOTES = ["\u{1F602}", "\u{1F621}", "\u{1F62D}", "\u{1F60E}", "\u{1F44F}", "\u{1F480}", "\u{1F914}", "\u{1F525}"];
const COLORS = ["R", "G", "B", "Y"];
const VALUES = [...Array(10).keys()].map(String).concat(["skip", "rev", "+2"]);

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const PUBLIC = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  const rel = (req.url || "/").split("?")[0];
  const file = path.join(PUBLIC, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();       // path traversal guard
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

function buildDeck() {
  const d = [];
  for (const c of COLORS) for (const v of VALUES) for (let k = 0; k < (v === "0" ? 1 : 2); k++) d.push({ c, v });
  for (let k = 0; k < 4; k++) d.push({ c: "W", v: "wild" }, { c: "W", v: "+4" });
  return shuffle(d);
}

const isDrawPenalty = (card) => card.v === "+2" || card.v === "+4";
const playable = (card, top, color, pending) =>
  pending ? isDrawPenalty(card) : card.c === "W" || card.c === color || card.v === top.v;

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];          // {id,name,ws,hand,calledUno,connected}
    this.started = false;
    this.winner = null;
  }

  add(ws, name) {
    if (this.started) return { error: "game already started" };
    if (this.players.length >= MAX_PLAYERS) return { error: "room is full" };
    const p = { id: Math.random().toString(36).slice(2, 8), name: name.slice(0, 16) || "player", ws, hand: [], calledUno: false, connected: true };
    this.players.push(p);
    return { player: p };
  }

  start() {
    if ((this.started && !this.winner) || this.players.length < 2) return;  // a finished game can be restarted
    this.deck = buildDeck();
    for (const p of this.players) { p.hand = this.deck.splice(0, 7); p.calledUno = false; }
    let start = this.deck.pop();
    while (start.c === "W") { this.deck.unshift(start); start = this.deck.pop(); }  // no wild starter
    this.pile = [start];
    this.color = start.c;
    this.turn = 0;
    this.step = 1;
    this.pendingKind = null;
    this.pendingCards = 0;
    clearTimeout(this.unoTimer);
    this.unoTimer = null;
    this.unoWindow = null;
    this.started = true;
    this.winner = null;
    this.log = [];
    this.say("Game started");
    this.settleTurn();
  }

  say(msg) { this.log = [...(this.log || []), msg].slice(-40); }

  /** Returns how many cards were actually dealt: the deck can legitimately run dry. */
  draw(p, k = 1) {
    let dealt = 0;
    for (let i = 0; i < k; i++) {
      if (!this.deck.length) {                       // reshuffle the discard pile, keep the top
        const top = this.pile.pop();
        this.deck = shuffle(this.pile.splice(0));
        this.pile = [top];
        if (!this.deck.length) break;                // nothing left to recycle: stop dealing
      }
      p.hand.push(this.deck.pop());
      dealt++;
    }
    if (dealt) p.calledUno = false;
    return dealt;
  }

  advance() { this.turn = (this.turn + this.step + this.players.length) % this.players.length; }

  legalFor(p) {
    const top = this.pile[this.pile.length - 1];
    return p.hand.filter((c) => playable(c, top, this.color, this.pendingKind));
  }

  /** A stacked +2/+4 must be answered or eaten before anything else happens. */
  eatStackIfNeeded() {
    const p = this.players[this.turn];
    if (this.pendingKind && !this.legalFor(p).length) {
      this.say(`${p.name} takes ${this.pendingCards} from the ${this.pendingKind} stack`);
      const packet = JSON.stringify({ type: "ate", who: p.id, cards: this.pendingCards, kind: this.pendingKind });
      for (const q of this.players) if (q.ws?.readyState === 1) q.ws.send(packet);
      this.draw(p, this.pendingCards);
      this.pendingKind = null;
      this.pendingCards = 0;
      this.advance();
    }
  }

  everyoneStuck() { return !this.deck.length && this.players.every((p) => !this.legalFor(p).length); }

  /** Deck and discard are both spent and nobody can move: fewest cards wins. */
  endOnExhaustedDeck() {
    const best = this.players.reduce((a, b) => (b.hand.length < a.hand.length ? b : a));
    this.winner = best.name;
    this.say(`Deck exhausted — ${best.name} WINS with the fewest cards`);
  }

  /** Resolve everything the next player has no choice about, then hand them the turn. */
  // ponytail: drawing is manual (drawTurn); the only forced move left is eating a stack.
  settleTurn() {
    this.eatStackIfNeeded();
    if (!this.winner && this.everyoneStuck()) this.endOnExhaustedDeck();
  }

  play(p, index, chosenColor) {
    if (!this.started || this.winner) return;
    if (this.players[this.turn] !== p) return;
    const card = p.hand[index];
    const top = this.pile[this.pile.length - 1];
    if (!card || !playable(card, top, this.color, this.pendingKind)) return;

    p.hand.splice(index, 1);
    this.pile.push(card);
    this.color = card.c === "W" ? (COLORS.includes(chosenColor) ? chosenColor : COLORS[(Math.random() * 4) | 0]) : card.c;
    this.say(`${p.name} played ${card.c === "W" ? card.v : card.c + card.v}${card.c === "W" ? " → " + this.color : ""}`);
    this.lastPlay = { card, by: p.id, at: Date.now() };

    if (!p.hand.length) { this.winner = p.name; this.say(`${p.name} WINS`); return this.broadcast(); }
    if (p.hand.length === 1 && !p.calledUno) this.openUnoWindow(p);

    if (card.v === "+2" || card.v === "+4") {
      this.pendingKind = card.v;
      this.pendingCards += card.v === "+2" ? 2 : 4;
    } else if (card.v === "rev") {
      if (this.players.length === 2) this.advance(); else this.step = -this.step;
    } else if (card.v === "skip") {
      this.advance();
    }
    this.advance();
    this.settleTurn();
    this.broadcast();
  }

  drawTurn(p) {
    if (!this.started || this.winner || this.players[this.turn] !== p || this.pendingKind) return;
    if (this.legalFor(p).length) return;
    if (!this.draw(p)) {                                 // deck spent: passing is the only move left
      this.say(`${p.name} passes`);
      this.advance();
      this.settleTurn();
      return this.broadcast();
    }
    this.say(`${p.name} drew a card`);
    const last = p.hand[p.hand.length - 1];
    if (!playable(last, this.pile[this.pile.length - 1], this.color, null)) { this.advance(); this.settleTurn(); }
    this.broadcast();
  }

  /** You are down to one card: call it before the window closes or eat +2. */
  openUnoWindow(p) {
    clearTimeout(this.unoTimer);
    this.unoWindow = { id: p.id, until: Date.now() + UNO_GRACE_MS };
    this.say(`${p.name} is on UNO — call it!`);
    this.unoTimer = setTimeout(() => this.closeUnoWindow(p), UNO_GRACE_MS);
    this.unoTimer.unref?.();
  }

  closeUnoWindow(p) {
    this.unoTimer = null;
    this.unoWindow = null;
    if (!this.players.includes(p) || p.calledUno || p.hand.length !== 1) return this.broadcast();
    this.say(`${p.name} forgot to call UNO → +2`);
    this.draw(p, 2);
    this.broadcast();
  }

  /** Callable while holding two cards, or during the grace window after playing the second-to-last. */
  callUno(p) {
    const armed = (p.hand.length === 2 && this.players[this.turn] === p)
      || (p.hand.length === 1 && this.unoWindow?.id === p.id);
    if (!armed) return;
    p.calledUno = true;
    if (this.unoWindow?.id === p.id) { clearTimeout(this.unoTimer); this.unoTimer = null; this.unoWindow = null; }
    this.say(`${p.name}: UNO!`);
    this.broadcast();
  }

  /** MSN-style nudge: shakes the target's screen. Rate limited so it stays a joke, not a weapon. */
  nudge(from, targetId) {
    const to = this.players.find((q) => q.id === targetId);
    if (!to || to === from) return;
    const now = Date.now();
    if (now - (from.lastNudge || 0) < NUDGE_COOLDOWN_MS) return;
    from.lastNudge = now;
    if (to.ws.readyState === 1) to.ws.send(JSON.stringify({ type: "nudge", from: from.name }));
    this.say(`${from.name} nudged ${to.name}`);
    this.broadcast();
  }

  /** Preset emotes only: no free text means no moderation and no XSS surface. */
  emote(from, e) {
    if (!EMOTES.includes(e)) return;
    const now = Date.now();
    if (now - (from.lastEmote || 0) < EMOTE_COOLDOWN_MS) return;
    from.lastEmote = now;
    const packet = JSON.stringify({ type: "emote", from: from.id, emote: e });
    for (const q of this.players) if (q.ws.readyState === 1) q.ws.send(packet);
  }

  /** Test mode: a seat with no socket that plays itself, so one person can try the game alone. */
  addBot() {
    if (this.code !== TEST_ROOM) return;
    if (this.started || this.players.length >= MAX_PLAYERS) return;
    const n = this.players.filter((p) => p.bot).length + 1;
    this.players.push({
      id: Math.random().toString(36).slice(2, 8), name: `Bot ${n}`, bot: true,
      ws: { readyState: 3, send() {} }, hand: [], calledUno: false, connected: true,
    });
    this.say(`Bot ${n} joined`);
  }

  /** Play the first legal card, or let settleTurn draw for us. */
  botMove() {
    this.botTimer = null;
    const p = this.players[this.turn];
    if (!p || !p.bot || !this.started || this.winner) return;
    const card = this.legalFor(p)[0];
    if (!card) return;                                 // settleTurn already handled draws and passes
    if (p.hand.length === 2) this.callUno(p);
    this.play(p, p.hand.indexOf(card), COLORS[(Math.random() * 4) | 0]);
  }

  scheduleBot() {
    if (this.botTimer || !this.started || this.winner) return;
    if (!this.players[this.turn]?.bot) return;
    this.botTimer = setTimeout(() => this.botMove(), BOT_DELAY_MS);
    this.botTimer.unref?.();                           // never hold the process open for a bot
  }

  /** Free text, so it is length-capped, rate limited, and only ever rendered as text on the client. */
  chat(from, text) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LEN);
    if (!clean) return;
    const now = Date.now();
    if (now - (from.lastChat || 0) < CHAT_COOLDOWN_MS) return;
    from.lastChat = now;
    const packet = JSON.stringify({ type: "chat", from: from.name, text: clean });
    for (const q of this.players) if (q.ws.readyState === 1) q.ws.send(packet);
  }

  remove(ws) {
    const i = this.players.findIndex((p) => p.ws === ws);
    if (i < 0) return;
    const [gone] = this.players.splice(i, 1);
    this.say(`${gone.name} left`);
    if (this.started && !this.winner) {
      if (this.players.filter((p) => !p.bot).length < 1 || this.players.length < 2) {
        this.started = false; this.winner = null; this.say("Not enough players — back to lobby");
      } else this.turn %= this.players.length;
    }
    if (!this.players.some((p) => !p.bot)) {           // only bots left: drop the room, not a ghost table
      clearTimeout(this.botTimer);
      rooms.delete(this.code);
    } else this.broadcast();
  }

  stateFor(p) {
    return {
      type: "state",
      code: this.code,
      you: p.id,
      started: this.started,
      winner: this.winner,
      color: this.color,
      top: this.started ? this.pile[this.pile.length - 1] : null,
      pendingKind: this.pendingKind || null,
      pendingCards: this.pendingCards || 0,
      unoWindow: this.unoWindow && this.unoWindow.until > Date.now() ? this.unoWindow : null,
      turn: this.turn,
      direction: this.step,
      lastPlay: this.lastPlay || null,
      hand: p.hand,
      canPlay: this.started && !this.winner && this.players[this.turn] === p
        ? p.hand.map((c) => playable(c, this.pile[this.pile.length - 1], this.color, this.pendingKind))
        : p.hand.map(() => false),
      players: this.players.map((q) => ({ id: q.id, name: q.name, cards: q.hand.length, uno: q.calledUno })),
      log: this.log || [],
    };
  }

  broadcast() {
    for (const p of this.players) {
      if (p.ws.readyState === 1) p.ws.send(JSON.stringify(this.stateFor(p)));
    }
    this.scheduleBot();
  }
}

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let room = null, me = null;
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "join") {
      const code = String(msg.code || "main").toUpperCase().slice(0, 6);
      if (!rooms.has(code)) rooms.set(code, new Room(code));
      const r = rooms.get(code);
      const { error, player } = r.add(ws, String(msg.name || ""));
      if (error) return ws.send(JSON.stringify({ type: "error", message: error }));
      room = r; me = player;
      r.say(`${me.name} joined`);
      if (r.code === TEST_ROOM && r.players.length === 1) r.addBot();   // solo test table: never wait for a human
      r.broadcast();
      return;
    }
    if (!room || !me) return;
    if (msg.type === "start") room.start(), room.broadcast();
    else if (msg.type === "addBot") room.addBot(), room.broadcast();
    else if (msg.type === "play") room.play(me, msg.index | 0, msg.color);
    else if (msg.type === "draw") room.drawTurn(me);
    else if (msg.type === "uno") room.callUno(me);
    else if (msg.type === "nudge") room.nudge(me, String(msg.to || ""));
    else if (msg.type === "emote") room.emote(me, String(msg.emote || ""));
    else if (msg.type === "chat") room.chat(me, String(msg.text || ""));
  });
  ws.on("close", () => room && room.remove(ws));
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`UNO on http://localhost:${PORT}`));
}

module.exports = { Room, playable };
