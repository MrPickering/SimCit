/**
 * PB RUNTIME — the two things every PickBits game must expose, in any renderer.
 *
 * Drop this in BEFORE your engine scripts:
 *     <script src="pb-runtime.js"></script>
 * or import it once from your entry module:
 *     import '../pb-runtime.js';
 *
 * It sets globals and exports nothing. It has no dependencies and no build step, so
 * the same file works in a classic <script> game (street-fury, kaiju, towers) and in a
 * bundled one (Mega/Phaser, the R3F games, anything on vite).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 1. THE LOUD-FAILURE CONTRACT — PB.missing()
 * ══════════════════════════════════════════════════════════════════════════════
 * Every engine in this arcade fakes missing art, and every one fakes it DIFFERENTLY.
 * A missing asset currently renders as:
 *
 *     an emoji ........................ cult-empire
 *     a text glyph .................... towers
 *     a red-tinted IDLE sprite ........ mega        (its entire death "animation")
 *     a complete procedural chibi ..... kaiju       (OBELISK rendered as GORGON)
 *     the WRONG character's art ....... street-fury (Hugo changed costume to walk)
 *     perfect STILLNESS ............... little-grove(three.js matches no clip)
 *     NOTHING AT ALL .................. DroneCombat (LoadBoundary fallback={null})
 *
 * Not one of them throws. Not one of them warns. Every single one LOOKS DELIBERATE,
 * which is why they all shipped. Six different silent fallbacks is the most expensive
 * thing in this codebase — every bug fixed this month was one of them.
 *
 * The fallback itself is usually FINE and often necessary: returning null from a draw
 * call tears a hole in the render loop mid-frame. The fallback is not the bug. The
 * SILENCE is the bug.
 *
 * So: keep your fallback, and announce it.
 *
 *     const sheet = cache[id] || cache.gorgon;
 *     if (!cache[id]) PB.missing('monster', id, 'rendering as GORGON');
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 2. THE DRIVE SURFACE — PB.drive()
 * ══════════════════════════════════════════════════════════════════════════════
 * Check 6 ("every declared frame is actually DRAWN in real gameplay") is the gate that
 * catches the most expensive class of bug we have: art that exists, is declared, and is
 * unreachable. It passes on ONE of nineteen games — and not because the other eighteen
 * are broken. It is because they have no scripted way to be driven.
 *
 * Register three functions and the whole arcade becomes gateable:
 *
 *     PB.drive({
 *       boot: () => { game.selectedCharacter = 0; game.startGame(); game.scene = 'playing'; },
 *       step: (n) => { for (let i = 0; i < n; i++) game.update(); },
 *       draw: () => game.render(),
 *     });
 *
 * `step` MUST advance the simulation without requestAnimationFrame — a harness kills
 * RAF before capturing, because otherwise the engine's own update() runs between the
 * state you set and the pixels you read, and you photograph an idle while calling it a
 * walk. (That happened. See install/verify-street-fury-walk.mjs.)
 */
(function (global) {
  "use strict";

  if (global.PB && global.PB.__v) return; // idempotent — a second include is a no-op

  // Every miss, in order, deduped. The harness reads this; so can you, in the console.
  var errors = (global.__pbAssetErrors = global.__pbAssetErrors || []);
  var seen = Object.create(null);

  var PB = {
    __v: 1,

    /**
     * Report a missing asset. Call this AT THE FALLBACK SITE, not instead of it.
     *   kind    'sheet' | 'frame' | 'clip' | 'model' | 'icon' | 'sprite' | ...
     *   id      what was asked for
     *   detail  what the engine is drawing instead — the part a human needs
     */
    missing: function (kind, id, detail) {
      var key = kind + ":" + id;
      if (seen[key]) return; // once per distinct problem, not once per frame
      seen[key] = 1;
      var rec = { kind: kind, id: id, detail: detail || "", t: errors.length };
      errors.push(rec);
      var msg = "[pb] MISSING " + kind + ' "' + id + '"' + (detail ? " — " + detail : "");
      // console.error, not warn: this is a shipped hole, not a style note.
      (global.console && global.console.error ? global.console.error : function () {})(msg);
      if (typeof PB.onMissing === "function") PB.onMissing(rec);
    },

    /** Everything reported so far. */
    errors: function () { return errors.slice(); },

    /** Reset — used by harnesses between scenarios. */
    reset: function () { errors.length = 0; seen = Object.create(null); },

    /**
     * Register this game's drive surface for check 6.
     *   boot()   put the game into a state where gameplay is drawable
     *   step(n)  advance the simulation n ticks WITHOUT requestAnimationFrame
     *   draw()   render one frame to the canvas
     */
    drive: function (surface) {
      global.__pb = global.__pb || {};
      if (surface.boot) global.__pb.boot = surface.boot;
      if (surface.step) global.__pb.step = surface.step;
      if (surface.draw) global.__pb.draw = surface.draw;
      global.__pb.ready = !!(global.__pb.boot && global.__pb.step && global.__pb.draw);
    },
  };

  global.PB = PB;
})(typeof window !== "undefined" ? window : globalThis);
