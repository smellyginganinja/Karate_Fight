# Karate Fight

An original two-fighter karate game for the browser. Score clean hits for half and full points: the first to 2 full points takes the round, best of 3 rounds wins. Play the CPU, a friend on the same computer, or a friend online.

## Play
- **Online:** https://smellyginganinja.github.io/karate_fight/ (once GitHub Pages is switched on for this repo)
- **In a browser:** double-click `index.html` (Safari or Chrome).

## Modes
- **1 player vs CPU** with Easy, Normal and Hard levels.
- **2 players on one computer**, sharing the keyboard or with game controllers.
- **Online versus:** choose Online versus, then host a room and share its 4-letter code, or type a friend's code and join. Press **V** in the room or during the fight for voice chat. Players connect directly to each other, using the free PeerJS service only to find each other (same approach as Drift Rivals).

## Controls
| | 1 player / online | 2 players: P1 | 2 players: P2 |
|---|---|---|---|
| Move | Arrows or W A S D | A / D | ← / → |
| Jump / crouch | ↑ / ↓ (or W / S) | W / S | ↑ / ↓ |
| Punch | Z, F or . | F | . |
| Kick | X, G or / | G | / |

P or Esc pauses, M mutes. Controllers: stick or d-pad to move, X/Square punch, B/Circle or Y/Triangle kick, A/Cross jump, Start pause. In 2-player mode with one controller, the controller is Player 2 and Player 1 uses the keyboard; with two controllers each player gets one.

## Moves
| Move | How | Points |
|---|---|---|
| Jab | Punch | half |
| Lunge punch | Forward + punch | half |
| Low punch | Down + punch | half |
| Front kick | Kick | half |
| Roundhouse | Forward + kick | full |
| Spin kick | Away + kick | full |
| Sweep | Down + kick | full (jump over it or crouch-block) |
| Flying kick | Jump, then punch or kick | full |

Hold away from your opponent to block high and mid attacks; hold down + away to block low and mid.

## For developers
- Code lives in `src/js/`: `util.js` (canvas, keyboard), `audio.js`, `gamepad.js`, `fight.js` (all game rules, no drawing), `ai.js` (CPU), `render.js` (all match drawing), `net.js` (online play and voice, shared with Drift Rivals) and `game.js` (menus, modes, online lobby, main loop). `src/js/lib/peerjs.min.js` is PeerJS 1.5.4 (MIT licence).
- Online play is host-authoritative: the host runs the fight and sends snapshots 30 times a second; the joiner sends its controls, including press counts so quick taps are never lost.
- After changing anything, run `python3 build.py`. It rebuilds `dist/index.html` and `index.html` as single self-contained files.
- Add `?net=local` to the URL to test online play between two windows on one computer.
- `tools/smoke-test.js` runs CPU-vs-CPU matches and an online match between two windows in headless Chromium (Playwright): serve the folder with `python3 -m http.server 8765`, then `node tools/smoke-test.js`.
