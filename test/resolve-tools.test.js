/* node test/resolve-tools.test.js — the STUDIO's edit bay: DaVinci Resolve (sidecar/tools/builtin/resolve.js).
   Offline + deterministic: ffprobe and the Python bridge are a scripted fake spawn; a real temp workspace on disk.
   Verifies: exact NTSC rationals, real in/out points, gaps, connected clips offset in their parent's SOURCE time,
   markers on the clip that owns the moment, asset stream flags from the probe, <media-rep> URLs, attribute escaping,
   the plan errors a model will actually hit, the workspace jail, and that resolve_status / resolve_control never
   claim a live Resolve the bridge did not reach. (Live proof against real media + an independent OpenTimelineIO
   parse was done by hand; Resolve itself is not on the gate machine.) */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const R = require('../sidecar/tools/builtin/resolve.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const ROOT = path.join(os.tmpdir(), 'starnet-resolve-test-' + process.pid);
A.rejects = async (fn, msg) => { let threw = false; try { await fn(); } catch (e) { threw = true; } A.ok(threw, msg); };

// scripted spawn: handler(cmd, args) -> { code, stdout, stderr } | { error }
function fakeSpawn(handler, calls) {
  return (cmd, args, opts) => {
    if (calls) calls.push({ cmd, args, opts });
    const ch = new EventEmitter();
    ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => {}; ch.unref = () => {};
    setImmediate(() => {
      const r = handler(cmd, args || []) || { code: 0 };
      if (r.error) { ch.emit('error', new Error(r.error)); return; }
      if (r.stdout) ch.stdout.emit('data', r.stdout);
      if (r.stderr) ch.stderr.emit('data', r.stderr);
      ch.emit('close', r.code == null ? 0 : r.code);
    });
    return ch;
  };
}
const probeJson = (dur, v, a) => JSON.stringify({ format: { duration: String(dur) },
  streams: [].concat(v ? [{ codec_type: 'video', width: 1920, height: 1080 }] : [], a ? [{ codec_type: 'audio', channels: 2, sample_rate: '48000' }] : []) });

(async () => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}

  /* ---- A. time ---- */
  const ntsc = R.rateOf(29.97);
  A.eq([ntsc.num, ntsc.den], [1001, 30000], '29.97 is the exact 1001/30000 rational');
  A.eq(R.ftime(1, ntsc), '1001/30000s', 'one NTSC frame');
  A.eq(R.ftime(45, ntsc), '45045/30000s', 'NTSC times stay literal multiples of frameDuration');
  A.eq(R.ftime(48, R.rateOf(24)), '2s', 'whole seconds collapse');
  A.eq(R.ftime(0, ntsc), '0s', 'zero is 0s');
  for (const f of [24, 25, 30, 50, 60, 120]) A.eq(R.rateOf(f).fps, f, f + ' fps resolves to itself (no trailing-zero mangling)');
  A.eq(R.rateOf('23.976').den, 24000, '23.976 accepted as a string');
  A.throws(() => R.rateOf(31), 'an unsupported rate is refused');

  /* ---- B. the builder ---- */
  const U = p => 'file:///media/' + encodeURIComponent(p);
  const media = { 'a.mp4': { duration: 10, hasVideo: true, hasAudio: true }, 'b.mov': { duration: 6, hasVideo: true, hasAudio: false }, 'm.wav': { duration: 20, hasVideo: false, hasAudio: true } };
  const built = R.buildFcpxml({ name: 'Cut & "Test"', fps: 24, clips: [
    { path: 'a.mp4', url: U('a.mp4'), in: 1.5, out: 6 },
    { path: 'b.mov', url: U('b.mov'), in: 0, out: 3 },
    { path: 'a.mp4', url: U('a.mp4'), in: 7, out: 9, at: 8 },
    { path: 'b.mov', url: U('b.mov'), in: 1, out: 3, lane: 1, at: 2 },
    { path: 'm.wav', url: U('m.wav'), in: 0, out: 12, lane: -1, at: 0 }
  ], markers: [{ at: 1, name: 'Hook' }, { at: 8.5, name: 'Payoff', note: 'land <it>' }] }, media);
  const x = built.xml;
  A.ok(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">/.test(x), 'FCPXML 1.10 header + doctype');
  A.ok(x.includes('<project name="Cut &amp; &quot;Test&quot;">'), 'names are attribute-escaped');
  A.ok(x.includes('<asset-clip ref="r2" name="a" offset="0s" start="36/24s" duration="108/24s">'), 'real in-point + length (1.5s..6s)');
  A.ok(x.includes('<asset-clip ref="r3" name="b" offset="108/24s" start="0s" duration="3s"/>'), 'second clip butts against the first');
  A.ok(x.includes('<gap name="Gap" offset="180/24s" start="0s" duration="12/24s"/>'), '`at` opens a gap (7.5s..8s)');
  A.ok(x.includes('<asset-clip ref="r2" name="a" offset="8s" start="7s" duration="2s">'), 'third clip lands at 8s, cut from 7s');
  A.ok(x.includes('<asset-clip ref="r3" name="b" lane="1" offset="84/24s" start="1s" duration="2s"/>'), 'connected clip offset is in the PARENT\'s source time (1.5 + 2)');
  A.ok(x.includes('<asset-clip ref="r4" name="m" lane="-1" offset="36/24s" start="0s" duration="12s"/>'), 'music under the timeline on lane -1');
  A.ok(x.includes('<marker start="60/24s" duration="1/24s" value="Hook"/>'), 'marker at timeline 1s sits on clip 1 at source 2.5s');
  A.ok(x.includes('<marker start="180/24s" duration="1/24s" value="Payoff" note="land &lt;it&gt;"/>'), 'marker lands on the clip that owns 8.5s');
  A.ok(x.includes('id="r3" name="b" start="0s" duration="6s" hasVideo="1" hasAudio="0"'), 'a silent source is flagged hasAudio=0 from the probe');
  A.ok(x.includes('id="r4" name="m" start="0s" duration="20s" hasVideo="0" hasAudio="1" audioSources="1"'), 'an audio-only source has no video + no format');
  A.ok(x.includes('<media-rep kind="original-media" src="file:///media/a.mp4"/>'), 'paths ride <media-rep>, not a legacy asset src');
  A.eq(built.stats.seconds, 10, 'sequence length = end of the main storyline');
  A.eq([built.stats.spine, built.stats.gaps, built.stats.connected, built.stats.markers, built.stats.assets], [3, 1, 2, 2, 3], 'stats');

  const one = (c, extra) => () => R.buildFcpxml(Object.assign({ fps: 24, clips: c }, extra || {}), {});
  A.throws(one([]), 'an empty cut is refused');
  A.throws(one([{ path: 'a.mp4', url: 'u', in: 2, out: 2 }]), 'out must be after in');
  A.throws(one([{ path: 'a.mp4', url: 'u', out: 3, lane: 1 }]), 'a connected clip without `at` is refused');
  A.throws(one([{ path: 'a.mp4', url: 'u', out: 3 }, { path: 'a.mp4', url: 'u', out: 3, at: 1 }]), 'overlapping main-track clips are refused');
  A.throws(one([{ path: 'a.mp4', url: 'u', out: 3 }], { markers: [{ name: 'x' }] }), 'a marker without `at` is refused');
  const unprobed = R.buildFcpxml({ fps: 24, clips: [{ path: 'x.mp4', url: 'u', out: 4 }] }, {});
  A.ok(/hasVideo="1" hasAudio="0"/.test(unprobed.xml) && /duration="4s"/.test(unprobed.xml), 'unprobed media: flags from the extension, asset at least as long as the cut');
  const past = R.buildFcpxml({ fps: 24, clips: [{ path: 'a.mp4', url: 'u', out: 2 }, { path: 'm.wav', url: 'u', out: 5, lane: -1, at: 4 }] }, media);
  A.ok(/<gap name="Gap" offset="2s" start="0s" duration="7s"><asset-clip ref="r3" name="m" lane="-1" offset="2s"/.test(past.xml), 'a connected clip past the storyline end rides a filler gap');

  /* ---- C. resolve_timeline_file (fs + probe wiring) ---- */
  const ws = path.join(ROOT, 'agent');
  await fsp.mkdir(path.join(ws, 'clips'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'clips', 'a.mp4'), 'x');
  await fsp.writeFile(path.join(ws, 'clips', 'm.wav'), 'x');
  const calls = [];
  const spawnA = fakeSpawn((cmd, args) => {
    if (cmd === 'ffprobe') return /m\.wav$/.test(args[args.length - 1]) ? { stdout: probeJson(20, false, true) } : { stdout: probeJson(10, true, true) };
    return { error: 'ENOENT' };
  }, calls);
  const T = R.makeResolveTools({ fsp, pathMod: path, root: ROOT, spawn: spawnA, envFor: () => ({}) });
  const tool = n => T.tools.find(t => t.name === n);
  const emitted = [];
  const ctx = { agentId: 'agent', emit: (k, d) => emitted.push({ k, d }) };
  const out = await tool('resolve_timeline_file').run({ name: 'My Cut', fps: 29.97, clips: [{ path: 'clips/a.mp4', in: 0, out: 11 }, { path: 'clips/m.wav', out: 5, lane: -1, at: 0 }], markers: [{ at: 1, name: 'M' }] }, ctx);
  const file = await fsp.readFile(path.join(ws, 'edits', 'My_Cut.fcpxml'), 'utf8');
  A.ok(/frameDuration="1001\/30000s"/.test(file), 'file written into the jailed workspace at edits/<name>.fcpxml');
  A.ok(file.includes('src="file:///') && file.includes('/clips/a.mp4"'), 'workspace media is linked by absolute file URL');
  A.ok(/out 11s is past the media end \(10\.00s\)/.test(out.content), 'an out-point past the real media end is reported, not hidden');
  A.eq(emitted.map(e => e.d.kind + ':' + e.d.title), ['file:edits/My_Cut.fcpxml'], 'the file lands in chat as a deliverable');
  A.ok(calls.every(c => c.opts && c.opts.shell === false), 'every child runs WITHOUT a shell');
  await A.rejects(() => tool('resolve_timeline_file').run({ name: 'x', clips: [{ path: '../escape.mp4', out: 2 }] }, ctx), 'a ../ path cannot leave the workspace');
  await A.rejects(() => tool('resolve_timeline_file').run({ name: 'x', clips: [{ path: path.join(os.tmpdir(), 'abs.mp4'), out: 2 }] }, ctx), 'an absolute path needs the station path-trust guard');
  await A.rejects(() => tool('resolve_timeline_file').run({ name: 'x', clips: [{ path: 'clips/missing.mp4', out: 2 }] }, ctx), 'missing media is refused, not linked blind');

  /* ---- D. resolve_status / resolve_control never claim a live Resolve they did not reach ---- */
  const noPy = R.makeResolveTools({ fsp, pathMod: path, root: ROOT, spawn: fakeSpawn(() => ({ error: 'ENOENT' })), envFor: () => ({}), platform: 'linux' });
  const s1 = await noPy.tools.find(t => t.name === 'resolve_status').run({}, ctx);
  A.ok(/Live control: NO — no Python 3 found/.test(s1.content), 'no Python: status says NO and why');
  { const K = R._internals; const st = noPy.tools.find(t => t.name === 'resolve_status');
    A.ok(st.timeoutMs > 3 * K.PY_PICK_TIMEOUT_MS + K.STATUS_PROBE_MS, 'resolve_status backstop (' + st.timeoutMs + 'ms) covers 3 launcher probes + the bridge probe (75s worst case; it was 60s)'); }
  const M = R.makeResolveTools({ fsp, pathMod: path, root: ROOT, envFor: () => ({}), platform: 'linux', spawn: () => null })._internals.OUT_MARK;
  const bridgeSays = (o) => fakeSpawn((cmd, args) => (args.indexOf('import sys;print(sys.version_info[0])') >= 0 ? { stdout: '3\n' } : { stdout: 'noise\n' + M + JSON.stringify(o) + '\n' }));
  const free = R.makeResolveTools({ fsp, pathMod: path, root: ROOT, envFor: () => ({}), platform: 'linux', spawn: bridgeSays({ ok: false, reachable: false, module_imported: true, error: 'Resolve did not answer. It must be running, be Resolve STUDIO' }) });
  const s2 = await free.tools.find(t => t.name === 'resolve_status').run({}, ctx);
  A.ok(/Live control: NO — Resolve did not answer/.test(s2.content) && /resolve_timeline_file/.test(s2.content), 'free Resolve: NO + the interchange route');
  await A.rejects(() => free.tools.find(t => t.name === 'resolve_control').run({ action: 'add_marker', at: 1, name: 'x' }, ctx), 'control refuses when the bridge is not reachable');
  const live = R.makeResolveTools({ fsp, pathMod: path, root: ROOT, envFor: () => ({}), platform: 'linux', spawn: bridgeSays({ ok: true, reachable: true, python: '3.11.0', product: 'DaVinci Resolve Studio', version: '20.1', project: 'Promo', timelines: ['T1'], current_timeline: { name: 'T1', fps: '24', start_frame: 86400, end_frame: 86640, video_tracks: 2, audio_tracks: 1, markers: 0 } }) });
  const s3 = await live.tools.find(t => t.name === 'resolve_status').run({}, ctx);
  A.ok(/Live control: YES — DaVinci Resolve Studio 20\.1/.test(s3.content) && /Project: Promo/.test(s3.content) && /T1 @ 24 fps/.test(s3.content), 'a reachable Studio is reported with its project + timeline');
  const c = await live.tools.find(t => t.name === 'resolve_control').run({ action: 'render', name: 'final/cut' }, ctx);
  A.ok(/Resolve render OK/.test(c.content), 'render goes through the bridge');
  await A.rejects(() => live.tools.find(t => t.name === 'resolve_control').run({ action: 'rm_rf' }, ctx), 'unknown actions are refused before any process starts');
  await A.rejects(() => live.tools.find(t => t.name === 'resolve_control').run({ action: 'render', name: 'x', target_dir: '../../etc' }, ctx), 'the render target cannot leave the workspace');
  A.ok(!/os\.system|subprocess|eval\(|exec\(/.test(R.makeResolveTools({ fsp, pathMod: path, root: ROOT, spawn: () => null })._internals.BRIDGE_PY.replace('spec.loader.exec_module', '')), 'the bridge runs no shell and evals nothing');

  /* ---- E. capability wiring ---- */
  const grants = (CAP_REGISTRY.studio || []).reduce((m, g) => (m[g.tool] = g, m), {});
  A.ok(grants.resolve_timeline_file && grants.resolve_timeline_file.requiresConsent === true, 'the STUDIO grants resolve_timeline_file (consent: it writes)');
  A.ok(grants.resolve_status && grants.resolve_status.requiresConsent === false, 'resolve_status is a free read');
  A.ok(grants.resolve_control && grants.resolve_control.scope === 'execute' && grants.resolve_control.requiresConsent === true, 'resolve_control is execute + consent-gated');
  for (const t of T.tools) A.eq(t.capability, 'studio', t.name + ' declares the studio capability');

  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('resolve-tools.test');
})().catch(e => { console.error(e); process.exit(1); });
