# YBT_chatbot — Balloon avatar motion prototype

An AI chatbot avatar that communicates through **one balloon, continuously transforming** between states. Low visual anthropomorphism, high behavioural personality: the character is only a yellow balloon, two eyes and a knot. The personality comes from how it moves.

The look is **flat**, with no gradients, shading or outlines. It uses one balloon colour (`#FEBE2C`) and white eyes, on a cream backdrop (`#FEF6E2`). Its proportions were measured from the character reference: a soft egg body (top half 1.02 × the half-width, bottom half 1.08 ×), a short pinch into a flared, rounded knot, and tall oval eyes set 47% of the half-width apart.

```
Idle → lean → stretch → twist → flower → untwist → inflate → Idle
```

| State | What the balloon does |
| --- | --- |
| **Idle** | Round balloon floating in a small radius. The knot trails the drift like a pendulum, it breathes a little, blinks, and glances at your pointer. |
| **Listening** | Perks up. The body stretches a little taller and its top tips toward the speaker while the knot stays put. The head tilts the other way, eyes up toward the sound. Three short dashes pop out behind it, and it nods and twitches with each keystroke. |
| **Working** | Thinking and working are one state. The balloon stretches and twists, loop by loop, into a four-loop flower that turns with a ratcheting rhythm. A pulse travels around the loops as they expand and contract. |
| **Complete** | The loops unwind, the tube retracts and the balloon re-inflates with an overshoot. Then a happy hop, a wiggle, `∩ ∩` eyes and two cheer dashes, and it settles back to Idle. |

## Run it

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```sh
npx serve .        # or: python3 -m http.server
```

On the page:

- **State buttons** (or keys `1`–`5`) jump to any state from any state.
- **Play full sequence** runs Idle → Listening → Working → Complete → Idle.
- **Send** simulates a chat turn: Listening → Working → Complete → Idle, then the balloon replies.
- **Typing** in the message box makes the balloon listen.
- **Poke** the balloon to make it squish, dodge and wobble.
- **Slow-mo** runs time at 0.3×. **Show rig** overlays the spine (solid), its target (dashed) and the head centre.

## How the continuity works

The balloon is never swapped for another drawing and nothing crossfades. It is a single **spine of 86 points plus a thickness profile**, rendered as round-capped SVG strokes. Every state is a different *target shape* for the same spine:

1. **Pose functions** (`MOTIONS.<state>.pose`) write the target spine for the current time. There is one self-contained animation function per state.
2. **Mixer.** `setState()` pushes a new layer and blends into it with per-point weights:
   - **`polar`** blending moves points *around the head* (angle + radius). The balloon visibly winds up into the flower and unwinds out of it, instead of morphing.
   - **`stagger` / `order`** run the change head→tail or tail→head, so it twists progressively.
   - **`lead`** splits each point's move into two beats: radius first gives *stretch, then curl*; angle first gives *unwind, then retract*.
3. **Rig.** Springs add reactive motion: squash & stretch, wobble, hop, air pressure, nudges.
4. **Body.** Every spine point follows its target through a damped spring. The head is stiff and the tail soft, which gives inertia, overshoot and follow-through. **Air is conserved**: the tube radius comes from the current length, so a stretched balloon gets thinner and a retracting one re-inflates. Because of this the four-loop flower still reads as the same balloon.
5. **Renderer.** Every spine point owns one smooth stroke "piece" (a quadratic curve between the midpoints on either side of it), at twice its radius. Together the pieces form one flat silhouette, whatever the shape: the egg or the four loops. The head bulb is a row of circles sized like an ellipse's inscribed circles, so it's always a smooth egg and never a flat-sided pill. The knot, the eyes and the accent dashes are drawn on top.

Animation principles used: anticipation (squash before stretching), squash & stretch, overshoot (`outBack` easing, underdamped springs, inflation pop), inertia and follow-through (per-point springs), and spring-like settling everywhere.

## Connecting real AI events

The avatar only needs to hear about lifecycle changes:

```js
// user starts typing
balloon.setState('listening');
// request sent: reasoning, tool calls, streaming
balloon.setState('working');
// response finished (returns to idle by itself)
balloon.setState('complete');
```

`window.BalloonAI` wraps these as `userTyping()`, `requestSent()`, `working()`, `responseDone()` and `reset()`.

Other API on `window.balloon`:

```js
balloon.play([{ state: 'listening', hold: 1 }, { state: 'working', hold: 4 }, { state: 'complete' }]);
balloon.on('statechange', ({ state, from, label, caption, source }) => { /* … */ });
balloon.setState('listening', { side: -1 }); // lean left instead of right
balloon.poke(x, y);  // SVG units
balloon.nudge();     // tiny reaction, e.g. per keystroke
balloon.timeScale = 0.3;
```

## Tuning

Everything lives in `script.js`:

- `MOTIONS`: per-state shape and motion (float radius, lean angle, loop length, spin speed, eye expression).
- `TRANSITIONS`: per state-pair `mode`, `dur`, `stagger`, `order`, `lead`, `headAt`, `ease` and the `kick` impulse.
- `K` / `ZETA`: spring stiffness along the balloon (head leads, tail follows).
- `COLOR`: the balloon colour and the eye colour.
- `KNOT`, `EYE` and `BURSTS`: the knot outline, the eye expressions (open, focus, happy, blink) and the accent dashes.

`BalloonAvatar.MOTIONS` and `BalloonAvatar.TRANSITIONS` are exposed, so you can tweak live in the browser console.

`prefers-reduced-motion` is respected: the float, wobble and spin are toned down, and the state changes are kept.
