import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";

const FONT = '500 24px "EB Garamond", Garamond, Georgia, serif';
const LINE_HEIGHT = 36;

const PARAGRAPH = `A curious scribe wrote this passage to prove a simple wonder: letters can behave like thread when the eye and hand agree to play. Each character is tied to the next by invisible tension, so a gentle pull at the tail can wake the entire line and coax it into motion. Touch the final character, drag it toward the lower edge, and watch the sentence loosen, drift, and settle like inked cord on old parchment.

In the quiet hour before dawn, the manuscript room keeps its own weather. Dust hangs in pale bands, lamps burn amber, and every page seems to breathe when turned. The scribe says writing is less like carving and more like weaving: you do not force language into shape, you guide tension through it until it finds a curve that can hold. Some lines resist and snap back; others bend at once and rest as if they had always meant to fall that way. By evening, one clean version remains, carrying the memory of every pull, pause, and correction that came before it.`;

type LineMode = "idle" | "dragging" | "falling" | "settled" | "domino_wait";

interface CharSpan {
  char: string;
  x: number;
  y: number;
  w: number;
}

interface LineChain {
  index: number;
  chars: CharSpan[];
  px: number[];
  py: number[];
  opx: number[];
  opy: number[];
  rest: number[];
  mode: LineMode;
  tailPinned: boolean;
  tailPinX: number;
  tailPinY: number;
  dominoAt: number;
  stillFrames: number;
}

const PARCHMENT = "#f2e8d8";
const PARCHMENT_DEEP = "#e5d4bc";
const INK = "#0a0a0a";
const INK_MUTED = "rgba(10,10,10,0.9)";

const DAMP = 0.965;
const GRAVITY = 0.33;
const BOTTOM_MARGIN = 52;
const SETTLE_ZONE = 0.4;
const PILE_MAX_WIDTH = 760;
const PILE_MIN_WIDTH = 180;
const LINE_PILE_BAND_GAP = 20;
const ARCH_SAG = 26;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let dpr = 1;
let W = 0;
let H = 0;
let chains: LineChain[] = [];
let pointerDown = false;
let activeLine = -1;
let lastX = 0;
let lastY = 0;

function resetLineToIdle(line: LineChain) {
  line.mode = "idle";
  line.tailPinned = false;
  line.stillFrames = 0;
  line.dominoAt = 0;
  line.px = line.chars.map((c) => c.x);
  line.py = line.chars.map((c) => c.y);
  line.opx = [...line.px];
  line.opy = [...line.py];
}

function makeChain(index: number, chars: CharSpan[]): LineChain {
  const px = chars.map((c) => c.x);
  const py = chars.map((c) => c.y);
  const rest: number[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    rest.push(Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]));
  }
  return {
    index,
    chars,
    px,
    py,
    opx: [...px],
    opy: [...py],
    rest,
    mode: "idle",
    tailPinned: false,
    tailPinX: W / 2,
    tailPinY: H - BOTTOM_MARGIN,
    dominoAt: 0,
    stillFrames: 0,
  };
}

function layoutParagraph() {
  const maxW = Math.min(640, Math.max(300, W - 72));
  const prepared = prepareWithSegments(PARAGRAPH, FONT);
  const { lines } = layoutWithLines(prepared, maxW, LINE_HEIGHT);

  ctx.font = FONT;
  const top = (H - lines.length * LINE_HEIGHT) / 2;
  const nextChains: LineChain[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const y = top + li * LINE_HEIGHT + LINE_HEIGHT / 2;
    const left = (W - line.width) / 2;

    const chars: CharSpan[] = [];
    let prefix = "";
    for (const ch of line.text) {
      const w0 = ctx.measureText(prefix).width;
      prefix += ch;
      const w1 = ctx.measureText(prefix).width;
      const cw = Math.max(0.15, w1 - w0);
      chars.push({ char: ch, x: left + w0 + cw / 2, y, w: cw });
    }

    nextChains.push(makeChain(li, chars));
  }

  chains = nextChains;
  activeLine = -1;
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (chains.length === 0 || chains.every((c) => c.mode === "idle")) {
    layoutParagraph();
    return;
  }

  const nx = W / 2;
  const ny = H - BOTTOM_MARGIN;
  for (const c of chains) {
    if (c.tailPinned || c.mode === "settled") {
      const dx = nx - c.tailPinX;
      const dy = ny - c.tailPinY;
      c.tailPinX = nx;
      c.tailPinY = ny;
      for (let i = 0; i < c.px.length; i++) {
        c.px[i] += dx;
        c.py[i] += dy;
        c.opx[i] += dx;
        c.opy[i] += dy;
      }
    }
  }
}

function hitLineLastChar(mx: number, my: number): number {
  // Prefer lower lines first so overlap still picks visually lower text.
  for (let li = chains.length - 1; li >= 0; li--) {
    const line = chains[li];
    if (line.chars.length === 0) continue;
    const i = line.chars.length - 1;
    const cx = line.mode === "idle" ? line.chars[i].x : line.px[i];
    const cy = line.mode === "idle" ? line.chars[i].y : line.py[i];
    const half = Math.max(line.chars[i].w / 2, 4) + 8;
    const top = cy - LINE_HEIGHT / 2 - 8;
    const bot = cy + LINE_HEIGHT / 2 + 8;
    if (mx >= cx - half && mx <= cx + half && my >= top && my <= bot) return li;
  }
  return -1;
}

function applyConstraint(line: LineChain, i: number, j: number, target: number, pinI: boolean, pinJ: boolean) {
  let dx = line.px[j] - line.px[i];
  let dy = line.py[j] - line.py[i];
  const dist = Math.hypot(dx, dy) || 1e-6;
  const diff = ((dist - target) / dist) * 0.5;
  dx *= diff;
  dy *= diff;
  if (!pinI) {
    line.px[i] += dx;
    line.py[i] += dy;
  }
  if (!pinJ) {
    line.px[j] -= dx;
    line.py[j] -= dy;
  }
}

function settleWidth(): number {
  return Math.max(PILE_MIN_WIDTH, Math.min(PILE_MAX_WIDTH, W * 0.8));
}

function lineFloorBase(lineIndex: number): number {
  // Separate each line's resting pile vertically so they don't all share one baseline.
  const fromBottom = chains.length - 1 - lineIndex;
  return H - BOTTOM_MARGIN - fromBottom * LINE_PILE_BAND_GAP;
}

function applySettledArch(line: LineChain) {
  const n = line.px.length;
  if (n < 2) return;

  const naturalSpan = line.rest.reduce((s, v) => s + v, 0);
  const span = Math.max(120, Math.min(settleWidth(), naturalSpan * 0.78));

  let left = line.tailPinX - span;
  let right = line.tailPinX;
  if (left < 30) {
    right += 30 - left;
    left = 30;
  }
  if (right > W - 30) {
    const shift = right - (W - 30);
    left -= shift;
    right -= shift;
  }

  const baseY = lineFloorBase(line.index) - 8;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const tx = left + (right - left) * t;
    const ty = baseY + ARCH_SAG * (1 - (2 * t - 1) * (2 * t - 1));
    line.px[i] += (tx - line.px[i]) * 0.18;
    line.py[i] += (ty - line.py[i]) * 0.22;
    line.opx[i] = line.px[i];
    line.opy[i] = line.py[i];
  }
}

function updateLine(line: LineChain, now: number) {
  if (line.mode === "idle") return;

  if (line.mode === "domino_wait") {
    if (now < line.dominoAt) return;
    line.mode = "falling";
    line.tailPinned = false;
    line.stillFrames = 0;
    for (let i = 0; i < line.px.length; i++) {
      line.opy[i] = line.py[i] - (1.5 + (i % 3) * 0.35);
    }
  }

  const n = line.px.length;
  if (n === 0) return;

  const dragging = line.mode === "dragging";
  const pinHead = dragging;
  const pinTailMouse = dragging;
  const pinTailBottom = line.tailPinned && (line.mode === "falling" || line.mode === "settled");

  for (let i = 0; i < n; i++) {
    if (pinHead && i === 0) continue;
    if (pinTailMouse && i === n - 1) continue;
    if (pinTailBottom && i === n - 1) continue;

    const vx = (line.px[i] - line.opx[i]) * DAMP;
    const vy = (line.py[i] - line.opy[i]) * DAMP;
    line.opx[i] = line.px[i];
    line.opy[i] = line.py[i];

    line.px[i] += vx;
    line.py[i] += vy + (line.mode === "falling" || line.mode === "settled" ? GRAVITY : GRAVITY * 0.06);
  }

  if (pinHead) {
    line.px[0] = line.chars[0].x;
    line.py[0] = line.chars[0].y;
  }
  if (pinTailMouse) {
    line.px[n - 1] = lastX;
    line.py[n - 1] = lastY;
  }
  if (pinTailBottom) {
    line.px[n - 1] = line.tailPinX;
    line.py[n - 1] = line.tailPinY;
  }

  const iters = n > 350 ? 14 : n > 180 ? 18 : 24;
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n - 1; i++) {
      const pI = pinHead && i === 0;
      const pJ = (pinTailMouse || pinTailBottom) && i + 1 === n - 1;
      applyConstraint(line, i, i + 1, line.rest[i], pI, pJ);
    }
    if (pinHead) {
      line.px[0] = line.chars[0].x;
      line.py[0] = line.chars[0].y;
    }
    if (pinTailMouse) {
      line.px[n - 1] = lastX;
      line.py[n - 1] = lastY;
    }
    if (pinTailBottom) {
      line.px[n - 1] = line.tailPinX;
      line.py[n - 1] = line.tailPinY;
    }
  }

  const floorY = lineFloorBase(line.index);

  let motionMax = 0;
  for (let i = 0; i < n; i++) {
    if (!(pinTailMouse && i === n - 1) && !(pinTailBottom && i === n - 1)) {
      if (line.mode !== "dragging" && line.py[i] > floorY) line.py[i] = floorY;
    }
    motionMax = Math.max(motionMax, Math.hypot(line.px[i] - line.opx[i], line.py[i] - line.opy[i]));
  }

  if (line.mode === "falling") {
    if (motionMax < 0.085) line.stillFrames += 1;
    else line.stillFrames = 0;
    if (line.stillFrames > 16) line.mode = "settled";
  }

  if (line.mode === "settled") {
    applySettledArch(line);
  }
}

function drawParchment() {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, PARCHMENT);
  g.addColorStop(0.45, "#f0e4d2");
  g.addColorStop(1, PARCHMENT_DEEP);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.65);
  v.addColorStop(0, "rgba(139, 90, 43, 0)");
  v.addColorStop(1, "rgba(101, 67, 33, 0.12)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(90, 60, 35, 0.18)";
  ctx.lineWidth = 1;
  const m = 28;
  ctx.strokeRect(m + 0.5, m + 0.5, W - 2 * m - 1, H - 2 * m - 1);
}

function draw() {
  drawParchment();
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  for (const line of chains) {
    if (line.mode === "idle") {
      ctx.fillStyle = INK;
      for (const c of line.chars) ctx.fillText(c.char, c.x, c.y);
    } else {
      ctx.fillStyle = INK_MUTED;
      for (let i = 0; i < line.chars.length; i++) {
        ctx.fillText(line.chars[i].char, line.px[i], line.py[i]);
      }
    }
  }

  ctx.strokeStyle = "rgba(70,48,28,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, H - BOTTOM_MARGIN + LINE_HEIGHT / 2);
  ctx.lineTo(W - 40, H - BOTTOM_MARGIN + LINE_HEIGHT / 2);
  ctx.stroke();
}

function triggerDomino(referenceLine: number, now: number) {
  for (let i = 0; i < referenceLine; i++) {
    const line = chains[i];
    const last = line.chars[line.chars.length - 1];
    line.mode = "domino_wait";
    line.tailPinned = true;
    line.tailPinX = last ? last.x : W / 2;
    line.tailPinY = H - BOTTOM_MARGIN;
    line.dominoAt = now + i * 120;
    line.stillFrames = 0;
  }
}

function onDown(x: number, y: number) {
  pointerDown = true;
  lastX = x;
  lastY = y;

  const lineIdx = hitLineLastChar(x, y);
  if (lineIdx < 0) return;

  const line = chains[lineIdx];
  if (line.mode === "idle") {
    line.px = line.chars.map((c) => c.x);
    line.py = line.chars.map((c) => c.y);
    line.opx = [...line.px];
    line.opy = [...line.py];
  }

  line.mode = "dragging";
  line.tailPinned = false;
  line.stillFrames = 0;
  activeLine = lineIdx;

  // Trigger domino on the 4th line from the bottom.
  const fourthFromBottom = chains.length - 4;
  if (lineIdx === fourthFromBottom && fourthFromBottom >= 0) {
    triggerDomino(lineIdx, performance.now());
  }
}

function onMove(x: number, y: number) {
  lastX = x;
  lastY = y;
}

function onUp(_x: number, y: number) {
  pointerDown = false;
  if (activeLine < 0) return;

  const line = chains[activeLine];
  if (y > H * (1 - SETTLE_ZONE)) {
    const lastIdx = line.px.length - 1;
    line.mode = "falling";
    line.tailPinned = true;
    line.tailPinX = Math.max(40, Math.min(W - 40, line.px[lastIdx]));
    line.tailPinY = H - BOTTOM_MARGIN;
    line.stillFrames = 0;
  } else {
    resetLineToIdle(line);
  }

  activeLine = -1;
}

canvas.addEventListener("mousedown", (e) => onDown(e.clientX, e.clientY));
canvas.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
canvas.addEventListener("mouseup", (e) => onUp(e.clientX, e.clientY));
canvas.addEventListener("mouseleave", (e) => {
  if (pointerDown) onUp(e.clientX, e.clientY);
});

canvas.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    const t = e.touches[0];
    onDown(t.clientX, t.clientY);
  },
  { passive: false }
);
canvas.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
    const t = e.touches[0];
    onMove(t.clientX, t.clientY);
  },
  { passive: false }
);
canvas.addEventListener("touchend", (e) => {
  const t = e.changedTouches[0];
  onUp(t.clientX, t.clientY);
});

canvas.addEventListener("dblclick", () => {
  layoutParagraph();
  pointerDown = false;
  activeLine = -1;
});

function loop(now: number) {
  for (const line of chains) updateLine(line, now);
  draw();
  requestAnimationFrame(loop);
}

async function boot() {
  await document.fonts.ready;
  resize();
  window.addEventListener("resize", () => {
    resize();
    draw();
  });
  draw();
  requestAnimationFrame(loop);
}

boot();
