// Smoke test: boots the server, plays full bot games over real sockets.
const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 3999;
const URL = `ws://localhost:${PORT}`;
const waitFor = (condition, timeout = 5000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeout;
  const check = () => {
    if (condition()) return resolve();
    if (Date.now() >= deadline) return reject(new Error("condition timed out"));
    setTimeout(check, 20);
  };
  check();
});

function bot(name, room, stats) {
  return new Promise((resolve) => {
    const w = new WebSocket(URL);
    let joined = false;
    w.on("open", () => w.send(JSON.stringify({ type: "join", name, code: room })));
    w.on("message", (m) => {
      const s = (w.last = JSON.parse(m));
      if (!joined) { joined = true; resolve(w); }
      if (!s.started || s.winner || s.players[s.turn].id !== s.you) return;
      let i = s.hand.findIndex((c, k) => s.canPlay[k] && (c.v === "+2" || c.v === "+4"));
      if (i < 0) i = s.canPlay.indexOf(true);
      if (i < 0) { stats.stalled++; return w.send(JSON.stringify({ type: "draw" })); }
      if (s.hand.length === 2) w.send(JSON.stringify({ type: "uno" }));
      w.send(JSON.stringify({ type: "play", index: i, color: "R" }));
    });
  });
}

(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("UNO on")) resolve();
    });
  });
  const stats = { stalled: 0 };
  try {
    for (const n of [2, 4, 8]) {
      const room = `T${n}${Date.now()}`;
      const players = [];
      for (let k = 0; k < n; k++) players.push(await bot(`p${k}`, room, stats));
      await waitFor(() => players[0].last?.players.length === n);
      players[0].send(JSON.stringify({ type: "start" }));
      await waitFor(() => players[0].last?.winner);
      console.log(`  ✓ ${n} players → ${players[0].last.winner} wins`);
      players.forEach((p) => p.close());
    }
    assert.strictEqual(stats.stalled, 0, "a turn was left with no playable card and no auto-draw");
    console.log("  ✓ auto-draw left no stalled turn");
    console.log("\nok");
  } finally {
    srv.kill();
  }
  process.exit(0);
})();
