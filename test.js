// Smoke test: boots the server, plays full bot games over real sockets.
const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 3999;
const URL = `ws://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bot(name, room, stats) {
  return new Promise((resolve) => {
    const w = new WebSocket(URL);
    w.on("open", () => w.send(JSON.stringify({ type: "join", name, code: room })));
    w.on("message", (m) => {
      const s = (w.last = JSON.parse(m));
      for (const line of s.log || []) if (/takes (\d+)/.test(line)) stats.stacks.add(line);
      if (!s.started || s.winner || s.players[s.turn].id !== s.you) return;
      let i = s.hand.findIndex((c, k) => s.canPlay[k] && (c.v === "+2" || c.v === "+4"));
      if (i < 0) i = s.canPlay.indexOf(true);
      if (i < 0) { stats.stalled++; return w.send(JSON.stringify({ type: "draw" })); }
      if (s.hand.length === 2) w.send(JSON.stringify({ type: "uno" }));
      w.send(JSON.stringify({ type: "play", index: i, color: "R" }));
    });
    resolve(w);
  });
}

(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT }, stdio: "ignore" });
  await wait(1200);
  const stats = { stacks: new Set(), stalled: 0 };
  try {
    for (const n of [2, 4, 8]) {
      const room = `T${n}${Date.now()}`;
      const players = [];
      for (let k = 0; k < n; k++) players.push(await bot(`p${k}`, room, stats));
      await wait(150);
      players[0].send(JSON.stringify({ type: "start" }));
      await wait(3000);
      assert.ok(players[0].last.winner, `${n}-player game never finished`);
      console.log(`  ✓ ${n} players → ${players[0].last.winner} wins`);
      players.forEach((p) => p.close());
    }
    const amounts = [...stats.stacks].map((l) => +/takes (\d+)/.exec(l)[1]);
    assert.ok(amounts.some((a) => a > 4), "draw stacking never accumulated past a single card");
    console.log(`  ✓ stacking accumulates: ${[...new Set(amounts)].sort((a, b) => a - b).join(", ")} cards`);
    assert.strictEqual(stats.stalled, 0, "a turn was left with no playable card and no auto-draw");
    console.log("  ✓ auto-draw left no stalled turn");
    console.log("\nok");
  } finally {
    srv.kill();
  }
  process.exit(0);
})();
