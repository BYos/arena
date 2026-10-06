/*
 * ARENA EAT – authoritative game engine.
 * Runs on the Node server (real multiplayer) and in the browser (offline practice vs bots).
 * The client never decides size, eating, bonuses, death or victory – only this engine does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArenaEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Tunables (balance lives here) ----------
  const CONFIG = {
    MAX_PLAYERS: 20,
    MIN_HUMANS_TO_START: 1,
    FILL_WITH_BOTS: true,      // fill empty slots with bots so matches always feel full
    BOT_FILL_AFTER: 5,         // seconds of lobby before bots start joining
    BOT_JOIN_INTERVAL: [0.3, 0.9],
    LOBBY_TIME: 15,            // max wait in lobby (s)
    FULL_COUNTDOWN: 5,         // countdown once the room is full
    TICK_RATE: 25,             // server simulation + snapshot rate (Hz)

    MAP_W: 3600, MAP_H: 3600,
    ROCKS: 26, BUSHES: 14,

    START_SIZE: 20,
    MIN_SIZE: 8,
    EAT_RATIO: 1.2,            // must be 20% bigger to eat (prevents near-equal accidents)
    EAT_GAIN: 0.8,             // share of the victim's size the eater gains
    BASE_SPEED: 250,
    MIN_SPEED: 95,
    SPEED_EXP: 0.28,           // bigger = slower

    FOOD_COUNT: 380,
    BONUS_INTERVAL: [6, 14],
    BONUS_MAX: 3,
    GROW_FLAT: 20, GROW_PCT: 0.10,   // +max(20, 10%) – flat part favours small players
    SPEED_MULT: 1.6, SPEED_TIME: 5,

    BUSH_SIZE_LIMIT: 110,      // above this size, bushes slow you down
    BUSH_SLOW: 0.45,

    ZONE_DELAY: 50,            // seconds before the safe zone starts shrinking
    ZONE_SHRINK: 300,          // seconds to shrink to ZONE_END_R  -> matches end within ~3–7 min
    ZONE_END_R: 0,
    ZONE_DMG_PCT: 0.06, ZONE_DMG_MIN: 1.5,
    BIG_DECAY: 0.004, BIG_DECAY_FROM: 300,

    SPAWN_GRACE: 8,            // seconds at match start where nobody can be eaten
    END_LINGER: 40             // seconds a finished match stays alive for spectators
  };

  const PALETTE = ['#ff5a5f', '#ffb400', '#00c2a8', '#4f7cff', '#b05cff', '#ff7ac6', '#3ddc84', '#ff8c42',
    '#00b4d8', '#8ac926', '#6a4cff', '#f9c74f', '#e76f51', '#9b5de5', '#00d4b0', '#ef476f', '#43aa8b',
    '#ff006e', '#3a86ff', '#fb8500'];

  const CHARACTERS = ['blob', 'cat', 'frog', 'robot', 'ninja', 'devil', 'chick', 'bear'];

  // Bot difficulty: awareness (skill), aim wobble, reaction time, appetite for chasing
  const DIFFICULTY = {
    easy:   { skill: [0.45, 0.7], noise: [0.35, 0.6], think: [0.3, 0.5], chase: 0.55 },
    medium: { skill: [0.65, 1.0], noise: [0.08, 0.3], think: [0.14, 0.28], chase: 1 },
    hard:   { skill: [1.0, 1.3], noise: [0.0, 0.08], think: [0.06, 0.12], chase: 1.3 }
  };

  const BOT_NAMES = ['DragonX', 'Wolf', 'Ninja', 'Blobby', 'Zigzag', 'Comet', 'Pixel', 'Mango', 'Turbo', 'Luna',
    'Rex', 'Shadow', 'Kiwi', 'Nova', 'Bolt', 'Gizmo', 'Yuki', 'Tank', 'Pepper', 'Orbit', 'Viper', 'Biscuit',
    'Storm', 'Chomp', 'Noodle', 'Ace', 'Fizz', 'Rocket', 'Momo', 'Jinx'];

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const radiusOf = (size) => 8 + Math.sqrt(size) * 3;
  function sanitizeName(n) {
    n = String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return n || 'Player';
  }
  // Room settings chosen by whoever creates the game
  function normalizeSettings(s) {
    s = s || {};
    const maxPlayers = clamp(Math.round(Number(s.maxPlayers) || 20), 2, 30);
    let bots = s.bots == null || s.bots === '' ? maxPlayers - 1 : Math.round(Number(s.bots) || 0);
    bots = clamp(bots, 0, maxPlayers - 1);
    const difficulty = DIFFICULTY[s.difficulty] ? s.difficulty : 'medium';
    return { maxPlayers, bots, difficulty };
  }
  function normalizeChar(c) {
    c = c || {};
    return { type: CHARACTERS.includes(c.type) ? c.type : 'blob', color: PALETTE.includes(c.color) ? c.color : null };
  }

  class Match {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, CONFIG, opts.config || {});
      this.settings = normalizeSettings(opts.settings);
      const c = this.cfg, n = this.settings.maxPlayers;
      c.MAX_PLAYERS = n;
      // arena scales with the room size so 4 players aren't lost and 30 aren't crammed
      const side = Math.round(clamp(3600 * Math.sqrt(n / 20), 1800, 4800));
      const area = (side / 3600) ** 2;
      c.MAP_W = c.MAP_H = side;
      c.FOOD_COUNT = Math.round(CONFIG.FOOD_COUNT * area);
      c.ROCKS = Math.max(8, Math.round(CONFIG.ROCKS * area));
      c.BUSHES = Math.max(5, Math.round(CONFIG.BUSHES * area));
      this.hostCid = null;
      this.send = opts.send || (() => {});   // send(toClientIdOrNull, type, data)
      this.id = opts.id || 'match';
      this.state = 'lobby';
      this.players = [];
      this.byCid = new Map();
      this.pid = 1; this.fid = 1; this.bid = 1;
      this.lobbyTimer = this.cfg.LOBBY_TIME;
      this.lobbyAge = 0;
      this.botJoinTimer = rand(...this.cfg.BOT_JOIN_INTERVAL);
      this.lobbySendTimer = 0;
      this.endTimer = 0;
      this.colors = shuffle(PALETTE.slice());
      this.botNames = shuffle(BOT_NAMES.slice());
    }

    // ---------- membership ----------
    humanCount() { let n = 0; for (const p of this.players) if (p.cid) n++; return n; }
    canJoin() { return this.state === 'lobby' && this.humanCount() < this.cfg.MAX_PLAYERS; }
    botTarget() { return Math.min(this.settings.bots, this.cfg.MAX_PLAYERS - this.humanCount()); }
    plannedCount() { return this.humanCount() + this.botTarget(); }
    startNow(cid) {
      if (this.state === 'lobby' && cid === this.hostCid && this.plannedCount() >= 2) this.lobbyTimer = Math.min(this.lobbyTimer, 3);
    }
    summary() {
      const host = this.byCid.get(this.hostCid);
      return {
        id: this.id, host: host ? host.name : '', max: this.cfg.MAX_PLAYERS, bots: this.settings.bots, difficulty: this.settings.difficulty,
        humans: this.players.filter((p) => !p.bot).map((p) => [p.name, p.type, p.color]),
        countdown: this.plannedCount() >= 2 ? Math.max(0, Math.ceil(this.lobbyTimer)) : null
      };
    }
    isFinished() {
      if (this.state === 'ended') return this.endTimer > this.cfg.END_LINGER || this.humanCount() === 0;
      return this.humanCount() === 0;
    }

    makePlayer(name, bot, cid, ch) {
      ch = normalizeChar(ch);
      // every player gets a unique colour: the requested one if it's free, otherwise the next free one
      const used = new Set(this.players.map((q) => q.color));
      const color = ch.color && !used.has(ch.color) ? ch.color : (this.colors.find((c) => !used.has(c)) || this.colors[this.players.length % this.colors.length]);
      const type = bot ? CHARACTERS[(Math.random() * CHARACTERS.length) | 0] : ch.type;
      const d = DIFFICULTY[this.settings.difficulty];
      const p = {
        id: this.pid++, cid: cid || null, name, bot, color, type,
        thinkR: d.think, chase: d.chase,
        x: 0, y: 0, vx: 0, vy: 0, size: this.cfg.START_SIZE, r: radiusOf(this.cfg.START_SIZE), peak: this.cfg.START_SIZE,
        alive: true, kills: 0, inA: 0, inT: 0, speedT: 0,
        think: 0, skill: rand(...d.skill), aimNoise: rand(...d.noise), wanderA: rand(0, 6.28)
      };
      this.players.push(p);
      return p;
    }

    addHuman(cid, name, ch) {
      if (!this.canJoin()) return null;
      // a bot gives up its seat for a real player
      if (this.players.length >= this.cfg.MAX_PLAYERS) {
        const b = this.players.findIndex((q) => q.bot);
        if (b >= 0) this.players.splice(b, 1);
      }
      const p = this.makePlayer(sanitizeName(name), false, cid, ch);
      this.byCid.set(cid, p);
      if (!this.hostCid) this.hostCid = cid;
      this.lobbySendTimer = 0;
      return p;
    }

    addBot() {
      const used = new Set(this.players.map((p) => p.name));
      let name = this.botNames.find((n) => !used.has(n)) || 'Bot' + this.pid;
      return this.makePlayer(name, true, null);
    }

    removeHuman(cid) {
      const p = this.byCid.get(cid);
      if (!p) return;
      this.byCid.delete(cid);
      if (this.hostCid === cid) this.hostCid = this.byCid.size ? this.byCid.keys().next().value : null;
      if (this.state === 'lobby') {
        this.players.splice(this.players.indexOf(p), 1);
        this.lobbySendTimer = 0;
      } else {
        p.cid = null;
        p.bot = true; // a bot takes over so the match stays fair for everyone else
      }
    }

    setInput(cid, a, t) {
      const p = this.byCid.get(cid);
      if (!p || p.bot) return;
      if (!Number.isFinite(a) || !Number.isFinite(t)) return;
      p.inA = a; p.inT = clamp(t, 0, 1);
    }

    // ---------- loop ----------
    update(dt) {
      if (this.state === 'lobby') this.updateLobby(dt);
      else if (this.state === 'playing') this.updatePlaying(dt);
      else this.endTimer += dt;
    }

    updateLobby(dt) {
      const c = this.cfg;
      if (!this.humanCount()) return;
      this.lobbyAge += dt;
      const target = this.botTarget();
      let bots = this.players.filter((p) => p.bot).length;
      while (bots > target) { this.players.splice(this.players.findIndex((p) => p.bot), 1); bots--; this.lobbySendTimer = 0; }
      if (c.FILL_WITH_BOTS && this.lobbyAge >= c.BOT_FILL_AFTER && bots < target) {
        this.botJoinTimer -= dt;
        if (this.botJoinTimer <= 0) { this.addBot(); this.botJoinTimer = rand(...c.BOT_JOIN_INTERVAL); this.lobbySendTimer = 0; }
      }
      // a match needs at least 2 participants; with bots off we wait for another human
      const ready = this.plannedCount() >= 2;
      if (ready) this.lobbyTimer -= dt; else this.lobbyTimer = c.LOBBY_TIME;
      if (this.players.length >= c.MAX_PLAYERS) this.lobbyTimer = Math.min(this.lobbyTimer, c.FULL_COUNTDOWN);
      this.lobbySendTimer -= dt;
      if (this.lobbySendTimer <= 0) {
        this.lobbySendTimer = 0.25;
        const list = this.players.map((p) => [p.id, p.name, p.type, p.color, p.bot ? 1 : 0, p.cid && p.cid === this.hostCid ? 1 : 0]);
        const base = { players: this.players.length, max: c.MAX_PLAYERS, countdown: ready ? Math.max(0, Math.ceil(this.lobbyTimer)) : null, list, settings: this.settings };
        for (const p of this.players) if (p.cid) this.send(p.cid, 'lobby', Object.assign({ you: p.id, host: p.cid === this.hostCid }, base));
      }
      if (ready && this.lobbyTimer <= 0 && this.humanCount() >= c.MIN_HUMANS_TO_START) this.start();
    }

    start() {
      const c = this.cfg;
      if (c.FILL_WITH_BOTS) { const t = this.botTarget(); while (this.players.filter((p) => p.bot).length < t) this.addBot(); }
      this.state = 'playing';
      this.t = 0;
      this.R0 = Math.hypot(c.MAP_W, c.MAP_H) / 2;
      this.zone = { x: c.MAP_W / 2, y: c.MAP_H / 2, r: this.R0 };
      this.genMap();
      this.food = new Map();
      this.events = []; this.fa = []; this.fr = [];
      for (let i = 0; i < c.FOOD_COUNT; i++) this.spawnFood();
      this.fa = [];
      this.bonuses = [];
      this.bonusTimer = rand(3, 6);
      const placed = [];
      for (const p of this.players) {
        let best = null, bestD = -1;
        for (let k = 0; k < 30; k++) {
          const s = this.freeSpot(p.r + 20, 200);
          let d = Infinity;
          for (const q of placed) d = Math.min(d, Math.hypot(q.x - s.x, q.y - s.y));
          if (d > bestD) { bestD = d; best = s; }
          if (d > 600) break;
        }
        p.x = best.x; p.y = best.y; placed.push(best);
        p.inA = Math.atan2(c.MAP_H / 2 - p.y, c.MAP_W / 2 - p.x);
      }
      this.alive = this.players.length;
      this.total = this.alive;
      this.events.push({ e: 'banner', k: 'go' });
      const common = {
        map: { w: c.MAP_W, h: c.MAP_H, rocks: this.rocks, bushes: this.bushes },
        players: this.players.map((p) => [p.id, p.name, p.color, p.type]),
        food: [...this.food.values()].map((f) => [f.id, f.x, f.y, f.v]),
        total: this.total,
        cfg: { EAT_RATIO: c.EAT_RATIO, ZONE_DELAY: c.ZONE_DELAY, ZONE_SHRINK: c.ZONE_SHRINK, START_SIZE: c.START_SIZE, BUSH_SIZE_LIMIT: c.BUSH_SIZE_LIMIT, TICK_RATE: c.TICK_RATE }
      };
      for (const p of this.players) if (p.cid) this.send(p.cid, 'start', Object.assign({ you: p.id }, common));
    }

    genMap() {
      const c = this.cfg;
      this.rocks = []; this.bushes = [];
      for (let i = 0, tries = 0; i < c.ROCKS && tries < 2000; tries++) {
        const r = Math.round(rand(35, 95));
        const x = Math.round(rand(150, c.MAP_W - 150)), y = Math.round(rand(150, c.MAP_H - 150));
        if (this.rocks.some((k) => Math.hypot(k.x - x, k.y - y) < k.r + r + 140)) continue;
        this.rocks.push({ x, y, r }); i++;
      }
      for (let i = 0, tries = 0; i < c.BUSHES && tries < 2000; tries++) {
        const r = Math.round(rand(110, 190));
        const x = Math.round(rand(200, c.MAP_W - 200)), y = Math.round(rand(200, c.MAP_H - 200));
        if (this.rocks.some((k) => Math.hypot(k.x - x, k.y - y) < k.r + r + 30)) continue;
        if (this.bushes.some((k) => Math.hypot(k.x - x, k.y - y) < k.r + r + 80)) continue;
        this.bushes.push({ x, y, r, s: (Math.random() * 1000) | 0 }); i++;
      }
    }

    freeSpot(rad, margin = 60, inZone = false) {
      const c = this.cfg;
      for (let k = 0; k < 40; k++) {
        let x, y;
        if (inZone && this.zone && this.zone.r < this.R0 * 0.95) {
          const a = rand(0, Math.PI * 2), d = Math.sqrt(Math.random()) * Math.max(this.zone.r * 0.92, 40);
          x = this.zone.x + Math.cos(a) * d; y = this.zone.y + Math.sin(a) * d;
        } else { x = rand(margin, c.MAP_W - margin); y = rand(margin, c.MAP_H - margin); }
        x = clamp(x, margin, c.MAP_W - margin); y = clamp(y, margin, c.MAP_H - margin);
        if (!this.rocks.some((r) => Math.hypot(r.x - x, r.y - y) < r.r + rad + 8)) return { x: Math.round(x), y: Math.round(y) };
      }
      return { x: c.MAP_W / 2, y: c.MAP_H / 2 };
    }

    spawnFood(at) {
      const s = at || this.freeSpot(8, 40, true);
      const roll = Math.random();
      const f = { id: this.fid++, x: Math.round(s.x), y: Math.round(s.y), v: roll < 0.08 ? 3 : roll < 0.3 ? 2 : 1 };
      this.food.set(f.id, f);
      this.fa.push([f.id, f.x, f.y, f.v]);
    }

    speedOf(p) {
      const c = this.cfg;
      return Math.max(c.MIN_SPEED, c.BASE_SPEED * Math.pow(p.size / c.START_SIZE, -c.SPEED_EXP));
    }
    inBush(p) { return this.bushes.some((b) => (p.x - b.x) ** 2 + (p.y - b.y) ** 2 < b.r * b.r); }

    updatePlaying(dt) {
      const c = this.cfg, z = this.zone;
      this.t += dt;
      if (this.t > c.ZONE_DELAY) {
        const k = Math.min(1, (this.t - c.ZONE_DELAY) / c.ZONE_SHRINK);
        z.r = this.R0 + (c.ZONE_END_R - this.R0) * k;
      }
      const alive = this.players.filter((p) => p.alive);

      // bonuses
      this.bonusTimer -= dt;
      if (this.bonusTimer <= 0) {
        this.bonusTimer = rand(...c.BONUS_INTERVAL);
        if (this.bonuses.length < c.BONUS_MAX && z.r > 120) {
          const s = this.freeSpot(30, 120, true);
          this.bonuses.push({ id: this.bid++, type: Math.random() < 0.65 ? 'grow' : 'speed', x: s.x, y: s.y });
        }
      }

      for (const p of alive) {
        if (p.bot) { p.think -= dt; if (p.think <= 0) { this.botThink(p, alive); p.think = rand(...p.thinkR); } }
        this.movePlayer(p, dt);
      }

      // food
      for (const f of this.food.values()) {
        for (const p of alive) {
          const dx = p.x - f.x, dy = p.y - f.y;
          if (dx * dx + dy * dy < p.r * p.r) {
            p.size += f.v; p.r = radiusOf(p.size);
            this.food.delete(f.id); this.fr.push(f.id);
            break;
          }
        }
      }
      const target = Math.max(60, c.FOOD_COUNT * Math.max(0.25, z.r / this.R0));
      for (let i = 0; i < 6 && this.food.size < target; i++) this.spawnFood();

      // bonus pickup – first one to touch it wins
      for (let i = this.bonuses.length - 1; i >= 0; i--) {
        const b = this.bonuses[i];
        const p = alive.find((q) => q.alive && Math.hypot(q.x - b.x, q.y - b.y) < q.r + 16);
        if (!p) continue;
        this.bonuses.splice(i, 1);
        let v = 0;
        if (b.type === 'grow') { v = Math.round(Math.max(c.GROW_FLAT, p.size * c.GROW_PCT)); p.size += v; p.r = radiusOf(p.size); }
        else p.speedT = c.SPEED_TIME;
        this.events.push({ e: 'bonus', id: p.id, k: b.type, v, x: b.x, y: b.y });
      }

      // eating: biggest first (not during the spawn grace period)
      if (this.t >= c.SPAWN_GRACE) alive.sort((a, b) => b.size - a.size);
      for (let i = 0; this.t >= c.SPAWN_GRACE && i < alive.length; i++) {
        const A = alive[i];
        if (!A.alive) continue;
        for (let j = i + 1; j < alive.length; j++) {
          const B = alive[j];
          if (!B.alive || A.size < B.size * c.EAT_RATIO) continue;
          const d = Math.hypot(A.x - B.x, A.y - B.y);
          if (d < A.r - B.r * 0.35) this.eat(A, B);
        }
      }

      // zone damage, big-player decay
      for (const p of alive) {
        if (!p.alive) continue;
        if (p.size > c.BIG_DECAY_FROM) p.size -= (p.size - c.BIG_DECAY_FROM) * c.BIG_DECAY * dt;
        if (Math.hypot(p.x - z.x, p.y - z.y) > z.r) {
          p.size -= (p.size * c.ZONE_DMG_PCT + c.ZONE_DMG_MIN) * dt;
          if (p.size < c.MIN_SIZE) {
            if (this.alive > 1) {
              for (let k = 0; k < 6; k++) this.spawnFood({ x: clamp(p.x + rand(-40, 40), 20, c.MAP_W - 20), y: clamp(p.y + rand(-40, 40), 20, c.MAP_H - 20) });
              this.kill(p, null);
              continue;
            }
            p.size = c.MIN_SIZE;
          }
        }
        p.r = radiusOf(p.size);
        if (p.size > p.peak) p.peak = p.size;
      }

      this.broadcastState();
      if (this.alive <= 1) this.finish();
    }

    movePlayer(p, dt) {
      const c = this.cfg;
      let sp = this.speedOf(p);
      if (p.speedT > 0) { p.speedT -= dt; sp *= c.SPEED_MULT; }
      if (p.size > c.BUSH_SIZE_LIMIT && this.inBush(p)) sp *= c.BUSH_SLOW;
      const tx = Math.cos(p.inA) * sp * p.inT, ty = Math.sin(p.inA) * sp * p.inT;
      const k = Math.min(1, dt * 7);
      p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;
      p.x += p.vx * dt; p.y += p.vy * dt;
      for (const r of this.rocks) {
        const dx = p.x - r.x, dy = p.y - r.y, min = r.r + p.r * 0.6;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d;
          p.x = r.x + nx * min; p.y = r.y + ny * min;
          const dot = p.vx * nx + p.vy * ny;
          if (dot < 0) { p.vx -= dot * nx; p.vy -= dot * ny; }
        }
      }
      const m = p.r * 0.5;
      p.x = clamp(p.x, m, c.MAP_W - m); p.y = clamp(p.y, m, c.MAP_H - m);
    }

    eat(A, B) {
      const gain = B.size * this.cfg.EAT_GAIN;
      A.size += gain; A.r = radiusOf(A.size); A.kills++;
      this.events.push({ e: 'eat', a: A.id, b: B.id, x: Math.round(B.x), y: Math.round(B.y), v: Math.round(gain) });
      this.kill(B, A);
    }

    kill(p, killer) {
      if (!p.alive) return;
      p.alive = false;
      const place = this.alive;
      this.alive--;
      this.events.push({ e: 'death', id: p.id, by: killer ? killer.id : 0, x: Math.round(p.x), y: Math.round(p.y) });
      if (p.cid) this.send(p.cid, 'dead', {
        place, total: this.total, survived: Math.round(this.t), kills: p.kills,
        size: Math.round(p.size), peak: Math.round(p.peak), by: killer ? killer.name : null
      });
      if (this.alive === 3) this.events.push({ e: 'banner', k: 'final3' });
      if (this.alive === 2) this.events.push({ e: 'banner', k: 'duel' });
    }

    broadcastState() {
      const z = this.zone, ps = [];
      for (const p of this.players) if (p.alive) ps.push([p.id, Math.round(p.x), Math.round(p.y), Math.round(p.size * 10) / 10, p.speedT > 0 ? 1 : 0]);
      this.send(null, 'state', {
        t: Math.round(this.t * 100) / 100, p: ps, z: [Math.round(z.x), Math.round(z.y), Math.round(z.r)], al: this.alive,
        b: this.bonuses.map((b) => [b.id, b.type, b.x, b.y]), ev: this.events, fa: this.fa, fr: this.fr
      });
      this.events = []; this.fa = []; this.fr = [];
    }

    finish() {
      this.state = 'ended';
      const w = this.players.find((p) => p.alive) || null;
      this.send(null, 'end', w ? { winner: w.id, name: w.name, size: Math.round(w.size), kills: w.kills, survived: Math.round(this.t) } : { winner: 0 });
    }

    // ---------- bots ----------
    botThink(p, alive) {
      const c = this.cfg, z = this.zone;
      let vx = 0, vy = 0, threat = false, prey = null, preyGap = Infinity;
      for (const q of alive) {
        if (q === p || !q.alive) continue;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, gap = d - p.r - q.r;
        if (q.size >= p.size * c.EAT_RATIO && gap < (170 + q.r) * p.skill) {
          const w = 1 / Math.max(gap, 15); vx -= (dx / d) * w; vy -= (dy / d) * w; threat = true;
        } else if (p.size >= q.size * c.EAT_RATIO && gap < 460 * p.skill * p.chase && gap < preyGap &&
          Math.hypot(q.x - z.x, q.y - z.y) < z.r) { prey = q; preyGap = gap; }
      }
      let ax, ay;
      if (threat) { const l = Math.hypot(vx, vy) || 1; ax = vx / l; ay = vy / l; }
      else if (prey) { const tx = prey.x + prey.vx * 0.35 - p.x, ty = prey.y + prey.vy * 0.35 - p.y, l = Math.hypot(tx, ty) || 1; ax = tx / l; ay = ty / l; }
      else {
        let tgt = null, best = Infinity;
        for (const b of this.bonuses) { const d = Math.hypot(b.x - p.x, b.y - p.y); if (d < 700 && d < best) { best = d; tgt = b; } }
        if (!tgt) for (const f of this.food.values()) {
          const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 - f.v * 4000;
          if (d < best && Math.hypot(f.x - z.x, f.y - z.y) < z.r) { best = d; tgt = f; }
        }
        if (tgt && best < 650 * 650) { const tx = tgt.x - p.x, ty = tgt.y - p.y, l = Math.hypot(tx, ty) || 1; ax = tx / l; ay = ty / l; }
        else { p.wanderA += rand(-0.6, 0.6); ax = Math.cos(p.wanderA); ay = Math.sin(p.wanderA); }
      }
      // stay inside the safe zone
      const dz = Math.hypot(p.x - z.x, p.y - z.y);
      const pull = clamp((dz - (z.r - 220 - p.r)) / 180, 0, threat ? 1.2 : 3);
      if (pull > 0 && dz > 1) { ax += ((z.x - p.x) / dz) * pull; ay += ((z.y - p.y) / dz) * pull; }
      let a = Math.atan2(ay, ax) + rand(-1, 1) * p.aimNoise;
      // steer around rocks
      const px = p.x + Math.cos(a) * (p.r + 70), py = p.y + Math.sin(a) * (p.r + 70);
      for (const r of this.rocks) {
        if (Math.hypot(px - r.x, py - r.y) < r.r + p.r * 0.6) {
          const cross = Math.cos(a) * (r.y - p.y) - Math.sin(a) * (r.x - p.x);
          a += cross > 0 ? -1.1 : 1.1; break;
        }
      }
      p.inA = a; p.inT = threat || prey ? 1 : 0.9;
    }
  }

  return { Match, CONFIG, PALETTE, CHARACTERS, DIFFICULTY, radiusOf, sanitizeName, normalizeSettings };
});
