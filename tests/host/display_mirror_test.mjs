// SPDX-License-Identifier: MPL-2.0
// The display page (web/display/) against the firmware's own mirror encoder.
// Compiles tests/host/display_mirror_host.c, which is base/device/mirror.c (MR_SEGW 80, as app/app.h),
// draws a glass and writes the SysEx stream. This feeds that stream, in uneven pieces, to loom_mirror.js
// (the page's decoder) and to the published mirror page's decoder (base/web/mirror/index.html), and both
// must match the glass. Also loads display.html's script against a stub DOM, and checks a chord name.
// No JieLi toolchain. The full loom_host app is not built.
//   node tests/host/display_mirror_test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(join(tmpdir(), "loom-display-"));
let failed = 0;
const ok = (cond, what) => { console.log(`${what.padEnd(72)} ${cond ? "ok" : "FAIL"}`); if (!cond) failed++; };

const cc = process.env.CC || "cc";
execFileSync(cc, ["-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-O2",
  "-DPLAT_HOST", "-DMR_SEGW=80", "-I", join(root, "base/include"), "-I", join(root, "base/device"),
  "-o", join(dir, "display_mirror_host"), join(root, "tests/host/display_mirror_host.c")],
  { stdio: "inherit" });
execFileSync(join(dir, "display_mirror_host"), [dir], { stdio: "inherit" });

const { createLoomMirror, mrRequest, mrUnpack7 } = await import(pathToFileURL(join(root, "web/display/loom_mirror.js")));

for (const op of [0, 1, 2]) {
  const r = mrRequest(op), u = mrUnpack7(r.slice(1, -1));
  ok(r[0] === 0xF0 && r.at(-1) === 0xF7 && u.join() === [0, 0x59, 0x50, 1, 0, 0, op, ~op & 0xFF].join(),
     `request ${op} is cmd 0x50, body ${op}`);
}

function rowsDiffer(a, b) {
  let n = 0, first = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
  return [n, first];
}
function feedPieces(dec, bytes, seed) {
  let s = seed, i = 0;
  while (i < bytes.length) {
    s = (s * 1103515245 + 12345) >>> 0;
    const n = 1 + (s >>> 16) % 500;
    dec.feed(bytes.subarray(i, i + n));
    i += n;
  }
}
const stream = readFileSync(join(dir, "stream.syx"));
const bin = readFileSync(join(dir, "screen.bin"));
const want = new Uint16Array(240 * 240);
for (let i = 0; i < want.length; i++) want[i] = bin[2 * i] << 8 | bin[2 * i + 1];

const dec = createLoomMirror();
feedPieces(dec, stream, 1);
const [diff, at] = rowsDiffer(dec.screen, want);
ok(dec.stats.bad === 0 && dec.stats.gaps === 0, `encoder stream: ${dec.stats.bad} bad, ${dec.stats.gaps} gaps`);
ok(diff === 0, `page decoder matches the glass (${stream.length} B)` + (diff ? ` (${diff} px, first ${at % 240},${at / 240 | 0})` : ""));
ok(dec.stats.fills >= 3 && dec.stats.rects >= 2 && dec.stats.inputs >= 1,
   `fills ${dec.stats.fills}, rects ${dec.stats.rects}, panel reports ${dec.stats.inputs}`);

const dec2 = createLoomMirror();
feedPieces(dec2, stream, 9);
const [diff2] = rowsDiffer(dec2.screen, want);
ok(dec2.stats.bad === 0 && diff2 === 0, "the same stream in other piece sizes");

// the published mirror page's decoder, unchanged, on the same stream
const published = readFileSync(join(root, "base/web/mirror/index.html"), "utf8");
const marked = /\/\/ --- decoder: begin[^\n]*\n([\s\S]*?)\/\/ --- decoder: end/.exec(published);
ok(!!marked, "published mirror page still has its decoder");
if (marked) {
  const { createMirror } = new Function(`"use strict";\n${marked[1]}\nreturn { createMirror };`)();
  const old = createMirror();
  feedPieces(old, stream, 3);
  const [d3] = rowsDiffer(old.screen, want);
  ok(old.stats.bad === 0 && old.stats.gaps === 0 && d3 === 0, "published mirror decoder matches the same glass");
}

// display.html parses as a module, and the chord code still names C E G
{
  const html = readFileSync(join(root, "web/display/display.html"), "utf8");
  ok(!html.includes("link_panel") && !html.includes("SX_CMD") && !html.includes('id="stats"'),
     "no Ask panel, no cmd 83, no stats strip");
  ok(html.includes('from "./loom_mirror.js"') && html.includes("function chordName") && html.includes("function quizStart"),
     "page imports the protocol module and still has chords and the quiz");
  const json = JSON.parse(readFileSync(join(root, "web/display/chords.json"), "utf8"));
  ok(json.chords.maj && json.chords.m7 && json.intervals.length === 12, "chords.json parses");
  const script = html.match(/<script type="module">([\s\S]*)<\/script>/)[1];
  writeFileSync(join(dir, "page.mjs"), script);
  execFileSync(process.execPath, ["--check", join(dir, "page.mjs")], { stdio: "inherit" });
  ok(true, "display.html script parses");
  const namesAt = script.indexOf("const NAMES = ");
  const chordAt = script.indexOf("function chordName");
  const chordEnd = script.indexOf("// ---- a chord clicked");
  const levelsAt = script.indexOf("const WHITE_ROOTS = ");
  const levelsEnd = script.indexOf("const quiz = ");
  const api = new Function(`${script.slice(namesAt, chordAt)}\n${script.slice(chordAt, chordEnd)}\n${script.slice(levelsAt, levelsEnd)}\nreturn { chordName, LEVELS };`)();
  const c = api.chordName([60, 64, 67]);
  ok(c && c.name === "Cmaj" && c.type === "maj" && api.chordName([60, 64]) === null && api.LEVELS.length >= 7,
     "C E G is Cmaj, two notes are not a chord, quiz has its levels");
}

rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`FAILED ${failed}`); process.exit(1); }
console.log("ok");
