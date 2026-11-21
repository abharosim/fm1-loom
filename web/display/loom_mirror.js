/* SPDX-License-Identifier: MPL-2.0
 * The LOOM-8 screen mirror on the wire (fm1-base device/mirror.c, the protocol the firmware already
 * sends). No DOM. display.html paints what this decodes; a later shared page can swap this module
 * for another firmware's codec.
 *
 * Frames: F0, then 8-to-7 packing (LSB first) of
 *   00 59 cmd len24 body ~sum8(body)
 * then F7.
 *   host -> device  cmd 0x50, body one byte: 0 off, 1 on (also the keep-alive; the unit stops
 *                   after 6 s without one), 2 refresh (on, and the whole screen again)
 *   device -> host  cmd 0x50 hello: version, on, width-1, height-1 (239, 239)
 *                   cmd 0x51 rect: x, y, w, h, seq, then the w*h pixels, row by row, run-length
 *                        coded (below). w is 1..240
 *                   cmd 0x52 fill: x, y, w, h, seq, RGB565 high byte first
 *                   cmd 0x53 input: the panel (buttons, keys, encoders, MASTER, lights). This
 *                        page does not draw the panel; the reports are accepted so they do not
 *                        break the stream
 *                   cmd 0x54 remote answer (this page does not send remote commands)
 * A rect or a fill carries seq (mod 256). A gap means a frame was dropped; the host asks for a
 * refresh. The pixel code, cache empty at the start of each rect (device/mirror.c mr_code_row):
 *   0nnnnnnn        n+1 more pixels of the colour now (1..128)
 *   10iiiiii        the colour now = cache[i]; one pixel
 *   11nnnnnn hi lo  the colour now = hi<<8|lo, stored at cache[(c*40503)>>10 & 63]; n+1 pixels
 */
export const MR_REQ = 0x50, MR_RECT = 0x51, MR_FILL = 0x52, MR_INPUT = 0x53, MR_REMOTE = 0x54;

export function mrPack7(bytes) {
  const out = [];
  let acc = 0, nb = 0;
  for (const b of bytes) {
    acc |= b << nb; nb += 8;
    while (nb >= 7) { out.push(acc & 0x7F); acc >>= 7; nb -= 7; }
  }
  if (nb) out.push(acc & 0x7F);
  return out;
}

export function mrUnpack7(src) {
  const out = [];
  let acc = 0, nb = 0;
  for (const b of src) {
    acc |= (b & 0x7F) << nb; nb += 7;
    if (nb >= 8) { out.push(acc & 0xFF); acc >>= 8; nb -= 8; }
  }
  return out;
}

/* a request to the FM-1: 0 off, 1 on (also the keep-alive), 2 refresh */
export function mrRequest(op) {
  return Uint8Array.from([0xF0, ...mrPack7([0x00, 0x59, MR_REQ, 1, 0, 0, op & 0xFF, ~op & 0xFF]), 0xF7]);
}

const mrHash = (c) => (Math.imul(c, 40503) >>> 10) & 63;

/* on: { rect(x, y, w, h), hello(info), gap(), input(state) }. screen is 240 x 240 RGB565
 * (the number, high byte first). */
export function createLoomMirror(on = {}) {
  const screen = new Uint16Array(240 * 240);
  const stats = { bytes: 0, frames: 0, rects: 0, fills: 0, inputs: 0, bad: 0, gaps: 0 };
  let buf = [], inSx = false, seq = -1;
  function rect(b) {
    const x = b[0], y = b[1], w = b[2], h = b[3], total = w * h, cache = new Uint16Array(64);
    let i = 5, p = 0, cur = 0;
    if (!w || !h || x + w > 240 || y + h > 240) return false;
    const put = (c, n) => {
      if (p + n > total) return false;
      for (let k = 0; k < n; k++, p++) screen[(y + (p / w | 0)) * 240 + x + p % w] = c;
      return true;
    };
    while (i < b.length) {
      const op = b[i++];
      if (op < 0x80) { if (!put(cur, op + 1)) return false; }
      else if (op < 0xC0) { cur = cache[op & 63]; if (!put(cur, 1)) return false; }
      else {
        if (i + 2 > b.length) return false;
        cur = b[i] << 8 | b[i + 1]; i += 2;
        cache[mrHash(cur)] = cur;
        if (!put(cur, (op & 63) + 1)) return false;
      }
    }
    return p === total;
  }
  function frame(raw) {
    const m = mrUnpack7(raw);
    if (m.length < 7 || m[0] !== 0 || m[1] !== 0x59) return;
    const n = m[3] | m[4] << 8 | m[5] << 16;
    let sum = 0;
    for (let i = 6; i < 6 + n; i++) sum += m[i];
    if (n + 7 !== m.length || (~sum & 0xFF) !== m[6 + n]) { stats.bad++; return; }
    const cmd = m[2], b = m.slice(6, 6 + n);
    stats.frames++;
    if (cmd === MR_RECT || cmd === MR_FILL) {
      if (seq >= 0 && b[4] !== seq) { stats.gaps++; on.gap?.(); }
      seq = (b[4] + 1) & 255;
    }
    if (cmd === MR_RECT) {
      if (!rect(b)) { stats.bad++; on.gap?.(); }
      stats.rects++;
      on.rect?.(b[0], b[1], b[2], b[3]);
    } else if (cmd === MR_FILL && n >= 7) {
      const c = b[5] << 8 | b[6], x = b[0], y = b[1], w = b[2], h = b[3];
      for (let j = y; j < Math.min(240, y + h); j++) screen.fill(c, j * 240 + x, j * 240 + Math.min(240, x + w));
      stats.fills++;
      on.rect?.(x, y, w, h);
    } else if (cmd === MR_INPUT && n >= 21) {
      const u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
      const lit = b[15] | b[16] << 8;
      stats.inputs++;
      on.input?.({ buttons: b[0] | b[1] << 8, keys: u32(2), enc: Array.from(b.slice(6, 13), (v) => (v << 24) >> 24),
                   master: b[13] | b[14] << 8, litButtons: lit & 0x7FFF, playRed: !!(lit & 0x8000), litKeys: u32(17),
                   dimButtons: n >= 27 ? b[21] | b[22] << 8 : 0, dimKeys: n >= 27 ? u32(23) : 0 });
    } else if (cmd === MR_REQ && n >= 4) {
      on.hello?.({ version: b[0], on: !!b[1], w: b[2] + 1, h: b[3] + 1 });
    } else if (cmd === MR_REMOTE && n >= 3) {
      on.remote?.({ seq: b[0], op: b[1], ok: !!b[2] });
    }
  }
  function feed(data) {
    for (const v of data) {
      stats.bytes++;
      if (v === 0xF0) { inSx = true; buf = []; }
      else if (!inSx || v >= 0xF8) continue;
      else if (v === 0xF7) { inSx = false; frame(buf); }
      else if (v & 0x80) inSx = false;
      else buf.push(v);
    }
  }
  return { feed, screen, stats, resync() { seq = -1; } };
}
