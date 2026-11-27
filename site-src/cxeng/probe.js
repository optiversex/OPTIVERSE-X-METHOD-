/*
 * Core logic (no DOM access, so it can be unit-tested in Node).
 *
 *  - parseProbe()      reads ffmpeg's "-i <file>" log output into a structured object
 *  - buildPlan()       turns that into the exact ffmpeg command line
 *  - analyzeOutput()   inspects the finished MP4 bytes (faststart, avcC level, x264 options)
 *  - buildVerification() compares source vs. output and returns the checklist rows
 *  - psnr()/ssim()     image-quality maths used for the "sample estimate"
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  const CFG = {
    copyright: 'optiverse-x-method',          // written into the video's Copyright detail (the only mark left in the file)
    legacyComment: 'Patched by OptiBirdsX',   // older builds marked files with this comment; still recognised, never written
    preset: 'superfast',
    crf: 24,
    bframes: 3,
    audioKbps: 192,            // plain AAC bitrate, single pass (no fine-tuning)
    maxAudio: 2,               // reference layout: the output always has exactly 2 audio streams (first source audio + a linked copy made in patchMp4(); silent audio when the source has none)
    audioTailSec: 0.35,        // the audio is extended to end this long after the video
    skipBelowKbps: 5000,       // sources below this are not re-encoded
    targetMinKbps: 5000,
    targetMaxKbps: 10000,
    // Reference metadata: every output carries exactly this, whatever the source (camera, screen recording, game ...).
    lang: 'eng',                                          // language tag of every video / audio track
    videoHandler: 'Mainconcept Video Media Handler',      // video track handler name (stored as a length-prefixed string)
    audioHandler: 'Mainconcept MP4 Sound Media Handler'   // audio track handler name(s)
  };

  // Text based subtitle codecs that ffmpeg can convert to mov_text (MP4).
  const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd',
    'subviewer', 'subviewer1', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'stl', 'vplayer']);

  // Whitelists so that we never hand ffmpeg a colour flag it does not understand.
  const OK_SPACE = new Set(['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020nc', 'bt2020c', 'fcc']);
  const OK_PRIM = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte431', 'smpte432']);
  const OK_TRC = new Set(['bt709', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m', 'linear', 'iec61966-2-1',
    'bt2020-10', 'bt2020-12']);

  /* ------------------------------------------------------------------ */
  /* Probe parsing                                                       */
  /* ------------------------------------------------------------------ */
  function num(s) { const n = parseFloat(s); return isFinite(n) ? n : 0; }

  function channelCount(layout) {
    const l = String(layout || '').replace(/\(.*\)/, '').trim().toLowerCase();
    const map = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, '4.0': 4, quad: 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };
    if (map[l]) return map[l];
    const m = l.match(/^(\d+) channels?/);
    return m ? +m[1] : 0;
  }

  function parseStream(index, lang, kind, rest) {
    const s = { index, lang, kind: kind.toLowerCase(), rest };
    const cm = rest.match(/^([\w\-]+)(?: \(([^)]*)\))?/);
    s.codec = cm ? cm[1] : '';
    s.profile = cm && cm[2] ? cm[2] : '';
    const tm = rest.match(/\(([A-Za-z0-9]{4}) \/ 0x[0-9A-Fa-f]+\)/);
    s.tag = tm ? tm[1] : '';
    const km = rest.match(/(\d+) kb\/s/);
    s.kbps = km ? +km[1] : 0;

    if (s.kind === 'video') {
      const stripped = rest.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
      const dm = stripped.match(/(\d{2,5})x(\d{2,5})/);
      s.w = dm ? +dm[1] : 0;
      s.h = dm ? +dm[2] : 0;
      const pm = rest.match(/,\s*(yuvj?\d{3}p\w*|yuva\d{3}p\w*|nv12|nv21|p01\d\w*|gbrp\w*|rgb\w*|bgr\w*|gray\w*|pal8|ayuv\w*)(?:\(([^)]*)\))?/);
      s.pixfmt = pm ? pm[1] : '';
      s.range = ''; s.space = ''; s.prim = ''; s.trc = ''; s.field = '';
      if (pm && pm[2]) {
        for (const tok of pm[2].split(/,\s*/)) {
          if (tok === 'tv' || tok === 'pc') s.range = tok;
          else if (/^(progressive|tt|bb|tb|bt)$/.test(tok)) s.field = tok;
          else if (tok.indexOf('/') >= 0) { const p = tok.split('/'); s.space = p[0]; s.prim = p[1]; s.trc = p[2]; }
          else if (tok) { s.space = s.prim = s.trc = tok; }
        }
      }
      if (!s.range && /^yuvj/.test(s.pixfmt)) s.range = 'pc';
      const dep = s.pixfmt.match(/p(\d{2})(?:le|be)?/);
      s.bitDepth = /^p01/.test(s.pixfmt) ? 10 : (dep && +dep[1] > 8 ? +dep[1] : 8);
      const fm = stripped.match(/([\d.]+) fps/);
      const tb = stripped.match(/([\d.]+) tbr/);
      s.fps = fm ? num(fm[1]) : (tb ? num(tb[1]) : 0);
      s.attached = /attached pic/.test(rest);
      s.rotation = 0;
    } else if (s.kind === 'audio') {
      const hm = rest.match(/(\d+) Hz/);
      s.rate = hm ? +hm[1] : 0;
      const lm = rest.match(/Hz,\s*([^,]+),/);
      s.layout = lm ? lm[1].trim() : '';
      s.channels = channelCount(s.layout);
    } else if (s.kind === 'subtitle') {
      s.text = TEXT_SUBS.has(s.codec);
    }
    return s;
  }

  /** lines: array of strings from ffmpeg -i <file> */
  function parseProbe(lines) {
    const info = {
      container: '', brand: '', tags: {}, duration: 0, start: 0, totalKbps: 0, chapters: 0,
      video: null, audio: [], subs: [], dolbyProfile: 0, hasHdrMeta: false, raw: lines.length
    };
    let section = '';
    let cur = null;
    let pastGlobal = false;   // the first "Metadata:" block (before Duration) holds the file-level tags
    let m;
    for (const raw of lines) {
      const line = String(raw);
      if ((m = line.match(/^Input #0, (.+?), from /))) { info.container = m[1]; section = 'in'; continue; }
      if (section === 'gmeta' && /^ {2}\S/.test(line)) section = 'in';
      if (!pastGlobal && section === 'in' && /^ {2}Metadata:\s*$/.test(line)) { section = 'gmeta'; continue; }
      if (section === 'gmeta' && (m = line.match(/^ {4}(\S[^:]*?)\s*:\s?(.*)$/))) {
        info.tags[m[1].toLowerCase()] = m[2];
        continue;
      }
      if ((m = line.match(/^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?), start: (-?[\d.]+), bitrate: (?:(\d+) kb\/s|N\/A)/))) {
        info.duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
        info.start = num(m[4]);
        info.totalKbps = m[5] ? +m[5] : 0;
        section = 'in'; pastGlobal = true;
        continue;
      }
      if (/^\s*Duration: N\/A/.test(line)) { section = 'in'; pastGlobal = true; continue; }
      if (/^\s+Chapter #0:\d+: start/.test(line)) { info.chapters++; cur = null; section = 'in'; continue; }
      if ((m = line.match(/^\s+Stream #0:(\d+)(?:\[0x[0-9a-fA-F]+\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/))) {
        cur = parseStream(+m[1], m[2] || '', m[3], m[4]);
        section = 'stream';
        if (cur.kind === 'video') { if (!info.videoStreams) info.videoStreams = []; info.videoStreams.push(cur); }
        else if (cur.kind === 'audio') info.audio.push(cur);
        else if (cur.kind === 'subtitle') info.subs.push(cur);
        continue;
      }
      if (cur && section === 'stream' && (m = line.match(/^ {6}(creation_time|handler_name|vendor_id)\s*:\s?(.*)$/))) {
        cur.tags = cur.tags || {}; cur.tags[m[1]] = m[2]; continue;
      }
      if (cur && cur.kind === 'video' && (m = line.match(/rotation of (-?[\d.]+) degrees/))) { cur.rotation = num(m[1]); continue; }
      if ((m = line.match(/DOVI configuration record: version: [\d.]+, profile: (\d+)/))) { info.dolbyProfile = +m[1]; continue; }
      if (/Mastering display|Content Light Level/i.test(line)) info.hasHdrMeta = true;
    }

    // Audio tracks ffmpeg cannot decode (iPhone spatial audio 'apac', codec 'none', unknown tags) are dropped up front,
    // otherwise ffmpeg aborts with "Decoder (codec none) not found". The normal AAC track is kept untouched.
    const UNDECODABLE = new Set(['none', 'apac', 'unknown', '']);
    info.audioSkipped = info.audio.filter(a => UNDECODABLE.has(String(a.codec || '').toLowerCase()) || String(a.tag || '').toLowerCase() === 'apac');
    if (info.audioSkipped.length) info.audio = info.audio.filter(a => info.audioSkipped.indexOf(a) < 0);

    info.brand = info.tags.major_brand || '';
    const vids = info.videoStreams || [];
    info.video = vids.find(v => !v.attached) || null;
    const v = info.video;
    if (v) {
      const swap = Math.abs(v.rotation || 0) % 180 === 90;
      info.width = swap ? v.h : v.w;
      info.height = swap ? v.w : v.h;
      info.interlaced = !!v.field && v.field !== 'progressive';
      info.hdr = v.trc === 'smpte2084' || v.trc === 'arib-std-b67';
      // Dolby Vision profile 5 has no usable colour tags (IPT-C2): can't be mapped correctly.
      info.dvNoFallback = info.dolbyProfile > 0 && !info.hdr && (!v.trc || v.trc === 'unknown');
      const audioKbps = info.audio[0] ? info.audio[0].kbps : 0;
      info.videoKbps = v.kbps || (info.totalKbps ? Math.max(info.totalKbps - audioKbps, 0) : 0);
    }
    return info;
  }

  /* ------------------------------------------------------------------ */
  /* Encode planning                                                     */
  /* ------------------------------------------------------------------ */
  const LEVELS = [['4.2', 8704, 522240], ['5.0', 22080, 589824], ['5.1', 36864, 983040], ['5.2', 36864, 2073600],
    ['6.0', 139264, 4177920], ['6.1', 139264, 8355840], ['6.2', 139264, 16711680]];

  /** Level 4.2 whenever the frame size/rate allows it, otherwise the smallest legal level. */
  function pickLevel(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    const mbps = mbs * Math.ceil(fps || 30);
    for (const [name, fs, rate] of LEVELS) if (mbs <= fs && mbps <= rate) return name;
    return '6.2';
  }

  /** Empty value = delete the tag: container, video, every audio and subtitle stream. */
  function stripCreationTime(nAudio, nSub) {
    const a = ['-metadata', 'creation_time=', '-metadata:s:v:0', 'creation_time='];
    for (let k = 0; k < nAudio; k++) a.push('-metadata:s:a:' + k, 'creation_time=');
    for (let k = 0; k < nSub; k++) a.push('-metadata:s:s:' + k, 'creation_time=');
    return a;
  }

  /**
   * caps: { zscale, tonemap, yadif } booleans (which filters the engine really has)
   * opts: { dropSubs, fpsMode, inPath, outPath }
   */
  function buildPlan(info, caps, opts) {
    opts = opts || {};
    const v = info.video;
    const notes = [];
    const vf = [];
    const level = pickLevel(info.width, info.height, v.fps);
    if (level !== '4.2') notes.push('Resolution/frame rate is above H.264 Level 4.2 limits, so Level ' + level + ' is used (needed for a valid file).');

    if (info.interlaced) {
      if (caps.yadif) { vf.push('yadif=mode=0:parity=-1:deint=0'); notes.push('Interlaced video detected: it will be de-interlaced so the output is progressive.'); }
      else notes.push('Interlaced video detected but the de-interlacer is missing in this engine.');
    }
    if (info.width % 2 || info.height % 2) {
      vf.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
      notes.push('Odd frame size: 1 pixel row/column is trimmed because yuv420p needs even dimensions.');
    }

    let tonemapped = false;
    const colorArgs = [];
    if (info.hdr) {
      if (caps.zscale && caps.tonemap) {
        vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
          'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
        tonemapped = true;
        colorArgs.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
      } else {
        notes.push('HDR tone-mapping filters are missing in this engine; colours may look flat in the SDR output.');
      }
    } else {
      if (OK_SPACE.has(v.space)) colorArgs.push('-colorspace', v.space);
      if (OK_PRIM.has(v.prim)) colorArgs.push('-color_primaries', v.prim);
      if (OK_TRC.has(v.trc)) colorArgs.push('-color_trc', v.trc);
      if (v.range === 'tv' || v.range === 'pc') colorArgs.push('-color_range', v.range);
      // A full-range source is converted to limited range, because the output will carry no range tag (players assume limited).
      if (v.range === 'pc') vf.push('scale=in_range=pc:out_range=tv');
    }
    vf.push('format=yuv420p');
    // Reference metadata: the output never carries colour tags (range / matrix / primaries / transfer) and always says
    // square pixels (SAR 1:1), whatever the source had. The pixels are converted above exactly as before; only the labels go.
    colorArgs.length = 0;
    vf.push('setsar=sar=1', 'setparams=range=unknown:color_primaries=unknown:color_trc=unknown:colorspace=unknown');

    // Reference layout (always the same, whatever the source): 1 video + 2 audio streams, nothing else.
    //  - the FIRST real audio track is encoded once; patchMp4() adds the second (linked) track after it
    //  - a source with no audio gets one silent stereo track instead (anullsrc), patchMp4() then adds the second one
    //  - every extra audio track, every subtitle track, data track, chapter and attachment is left out
    const silentAudio = info.audio.length === 0;
    const audioKeep = silentAudio ? [] : [info.audio[0]];
    const nAudioOut = 1;   // encoded audio streams before patchMp4() (the output file ends with 2)
    if (info.audio.length > 1) notes.push('This file has ' + info.audio.length + ' audio tracks; the first one is used (the output always has exactly 2 audio streams).');
    if (silentAudio) notes.push('The source has no audio: a silent audio track is added (the output always has exactly 2 audio streams).');
    const rates = opts.audioKbps || [];

    const subsAll = info.subs;
    const subsKeep = [];   // reference layout has no subtitle stream
    const subsLost = subsAll.length;
    if (subsLost > 0) notes.push(subsLost + ' subtitle track(s) left out (the output always has video + 2 audio streams only).');

    // Thread counts only change speed, never the encoder settings. They are explicit so that the
    // multi-thread engine never asks for more threads than it has pre-started workers.
    const th = opts.threads || null;
    const args = ['-hide_banner', '-y'];
    if (th) args.push('-filter_threads', String(th.filter), '-threads', String(th.dec));   // before -i = decoder
    args.push('-i', opts.inPath);
    // silent source: a generated 48 kHz stereo silence as second input; -shortest below ends it together with the video
    if (silentAudio) args.push('-f', 'lavfi', '-t', String(Math.ceil((info.duration || 0) + 2)), '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-map', '0:' + v.index);
    if (silentAudio) args.push('-map', '1:a:0');
    for (const a of audioKeep) args.push('-map', '0:' + a.index);
    for (const sb of subsKeep) args.push('-map', '0:' + sb.index);
    args.push('-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', CFG.preset, '-crf', String(CFG.crf),
      '-profile:v', 'high', '-level:v', level, '-pix_fmt', 'yuv420p', '-bf', String(CFG.bframes), '-refs', '1', '-tag:v', 'avc1');
    // Auto (default) = ONE encoder thread: x264 with several frame threads writes a slightly different bitstream, and
    // the standard output must be identical to a single-thread encode. Only when the person picks a faster Speed
    // (opts.encThreads >= 2) are more encoder threads used. Encoder settings (preset, CRF, B-frames) never change.
    args.push('-threads', String(opts.encThreads >= 2 ? Math.floor(opts.encThreads) : 1));
    args.push(...colorArgs);
    args.push('-fps_mode', opts.fpsMode || 'passthrough');
    // Some phone / editor files carry a single AAC frame whose embedded channel layout is bogus ("2 channels (LFE+LFE2)").
    // ffmpeg then re-initialises its audio filters at the very END of the encode and aborts ("Failed to configure output pad
    // on auto_aresample_0"), after the whole video was already encoded. channelmap pins plain stereo by channel POSITION, so the
    // wrong label is ignored; for a normal stereo track it is a pass-through (same samples, same output).
    if (!silentAudio && audioKeep[0] && audioKeep[0].channels === 2) args.push('-af', 'channelmap=map=0|1:channel_layout=stereo');
    args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2');
    for (let k = 0; k < nAudioOut; k++) args.push('-b:a:' + k, (rates[k] || CFG.audioKbps) + 'k');
    if (subsKeep.length) args.push('-c:s', 'mov_text');
    // Source metadata (title, comment, device / location tags, per-stream names ...) is NOT copied: every output starts clean.
    args.push('-map_metadata', '-1', '-map_chapters', '-1',
      '-metadata', 'copyright=' + CFG.copyright, ...stripCreationTime(nAudioOut, 0));
    args.push('-metadata:s:v:0', 'language=' + CFG.lang);
    for (let k = 0; k < nAudioOut; k++) args.push('-metadata:s:a:' + k, 'language=' + CFG.lang);
    if (silentAudio) args.push('-shortest');
    args.push('-movflags', '+faststart', opts.outPath);

    return { args, level, tonemapped, notes, subsKept: subsKeep.length, subsLost, audioCount: nAudioOut, silentAudio, audioIdx: audioKeep.map(a => a.index), audioLang: audioKeep.map(a => a.lang), vf: vf.join(',') };
  }

  /* ------------------------------------------------------------------ */
  /* Output inspection (MP4 bytes)                                       */
  /* ------------------------------------------------------------------ */
  function findBytes(u8, pat, from, to) {
    const end = Math.min(to == null ? u8.length : to, u8.length) - pat.length;
    outer: for (let i = from || 0; i <= end; i++) {
      if (u8[i] !== pat[0]) continue;
      for (let j = 1; j < pat.length; j++) if (u8[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }
  const ascii = s => Array.from(s).map(c => c.charCodeAt(0));

  function topBoxes(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let i = 0;
    while (i + 8 <= u8.length) {
      let size = dv.getUint32(i);
      const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (size === 1 && i + 16 <= u8.length) size = Number(dv.getBigUint64(i + 8));
      else if (size === 0) size = u8.length - i;
      out.push({ type, start: i, size });
      if (size < 8) break;
      i += size;
    }
    return out;
  }

  function analyzeOutput(u8) {
    const boxes = topBoxes(u8);
    const types = boxes.map(b => b.type);
    const moov = boxes.find(b => b.type === 'moov');
    const mdat = boxes.find(b => b.type === 'mdat');
    const res = { boxes: types, faststart: !!(moov && mdat && moov.start < mdat.start), level: '', profileIdc: 0, bframes: null, refs: null, x264: '' };
    if (moov) {
      const j = findBytes(u8, ascii('avcC'), moov.start, moov.start + moov.size);
      if (j >= 0) {
        res.profileIdc = u8[j + 5];
        const lv = u8[j + 7];
        res.level = lv === 9 ? '1b' : (lv / 10).toFixed(1);
      }
    }
    if (mdat) {
      const from = mdat.start;
      const k = findBytes(u8, ascii('x264 - core'), from, from + 262144);
      if (k >= 0) {
        let s = '';
        for (let i = k; i < k + 1400 && u8[i] !== 0; i++) s += String.fromCharCode(u8[i]);
        res.x264 = s;
        const b = s.match(/bframes=(\d+)/); const r = s.match(/\bref=(\d+)/);
        res.bframes = b ? +b[1] : null;
        res.refs = r ? +r[1] : null;
      }
    }
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* Verification checklist                                              */
  /* ------------------------------------------------------------------ */
  function fmtMbps(kbps) { return (kbps / 1000).toFixed(2) + ' Mbps'; }
  function fmtHz(hz) { return (hz / 1000).toFixed(hz % 1000 ? 1 : 0) + ' kHz'; }

  /**
   * src/out are parseProbe() results; bin is analyzeOutput(); stats = { frames, dup, drop, sizeBytes }
   * Returns rows: { label, value, status: 'ok' | 'warn' | 'info' }
   */
  function buildVerification(src, out, plan, bin, stats) {
    const rows = [];
    const add = (label, value, status) => rows.push({ label, value, status });
    const ov = out.video;
    const oa = out.audio[0];

    add('Container', /mp4/.test(out.container) ? 'MP4 (' + (out.brand || 'isom') + ')' : out.container, /mp4/.test(out.container) ? 'ok' : 'warn');
    add('Header position', bin.faststart ? 'moov in front (ffmpeg output, before patchMp4)' : 'moov at the end', 'info');

    if (ov) {
      const profile = ov.profile || '';
      add('Video codec', 'H.264 / AVC (libx264), tag ' + (ov.tag || '?') + ', profile ' + profile,
        ov.codec === 'h264' && profile === 'High' && ov.tag === 'avc1' ? 'ok' : 'warn');
      add('Codec level', bin.level ? bin.level : 'unknown', bin.level === plan.level ? (plan.level === '4.2' ? 'ok' : 'info') : 'warn');
      const bits = ov.bitDepth + '-bit';
      const prog = !ov.field || ov.field === 'progressive' ? 'progressive' : 'interlaced';
      add('Pixel format, depth, scan', ov.pixfmt + ', ' + bits + ', ' + prog, ov.pixfmt === 'yuv420p' && ov.bitDepth === 8 && prog === 'progressive' ? 'ok' : 'warn');
      add('B-frames / reference frames', (bin.bframes == null ? '?' : bin.bframes) + ' / ' + (bin.refs == null ? '?' : bin.refs),
        bin.bframes === CFG.bframes && bin.refs === 1 ? 'ok' : 'warn');
      const sameRes = ov.w === src.width && ov.h === src.height;
      const trimmed = Math.abs(ov.w - src.width) <= 1 && Math.abs(ov.h - src.height) <= 1;
      add('Resolution', ov.w + ' x ' + ov.h + (sameRes ? ' (same as source)' : trimmed ? ' (source ' + src.width + ' x ' + src.height + ', 1 px trimmed)' : ' (source ' + src.width + ' x ' + src.height + ')'), sameRes ? 'ok' : (trimmed ? 'info' : 'warn'));
      const sfps = src.video.fps;
      const fpsOk = sfps && Math.abs(ov.fps - sfps) < 0.05 * Math.max(sfps, 1) + 0.01;
      add('Frame rate', ov.fps + ' fps (source ' + (sfps || '?') + ')', fpsOk ? 'ok' : 'warn');
      const dd = Math.abs(out.duration - src.duration);
      add('Duration', out.duration.toFixed(2) + ' s (source ' + src.duration.toFixed(2) + ' s)', dd <= Math.max(0.15, src.duration * 0.005) ? 'ok' : 'warn');
      if (stats && stats.frames) {
        const expected = src.duration * (sfps || 0);
        let st = 'info'; let txt = stats.frames + ' frames encoded';
        if (stats.dup || stats.drop) { st = 'warn'; txt += ' (' + (stats.dup || 0) + ' duplicated, ' + (stats.drop || 0) + ' dropped)'; }
        else if (expected) { txt += ' (source about ' + Math.round(expected) + ', none duplicated or dropped)'; st = Math.abs(stats.frames - expected) <= Math.max(2, expected * 0.01) ? 'ok' : 'info'; }
        add('Frame count', txt, st);
      }
      const vk = ov.kbps || (stats && stats.sizeBytes && out.duration ? Math.round(stats.sizeBytes * 8 / out.duration / 1000) : 0);
      if (vk) {
        add('Average video bitrate', fmtMbps(vk) + ' (CRF ' + CFG.crf + ', no cap)', 'info');
      }
      add('Start time', 'Video starts at ' + out.start.toFixed(3) + ' s', Math.abs(out.start) < 0.05 ? 'ok' : 'warn');
    }
    const expectA = plan.audioCount;
    if (out.audio.length) {
      out.audio.forEach((oa, k) => {
        const lc = /LC/.test(oa.profile);
        add('Audio stream ' + (k + 1), 'AAC' + (lc ? '-LC' : ' ' + oa.profile) + ', ' + fmtHz(oa.rate) + ', ' + (oa.channels === 2 ? 'stereo' : oa.layout) + ', ' + (oa.kbps || '?') + ' kbps',
          oa.codec === 'aac' && lc && oa.rate === 48000 && oa.channels === 2 ? 'ok' : 'warn');
      });
      const expectOut = expectA === 1 ? 2 : expectA;   // a single audio track gets a linked second one in patchMp4()
      add('Audio stream count', String(out.audio.length), out.audio.length === expectOut ? 'ok' : 'warn');
    } else if (!src.audio.length) {
      add('Audio', 'Source has no audio track', 'info');
    }
    const hasCT = !!(out.tags.creation_time || (ov && ov.tags && ov.tags.creation_time) || out.audio.some(a => a.tags && a.tags.creation_time) || out.subs.some(a => a.tags && a.tags.creation_time));
    add('Creation time metadata', hasCT ? 'Still present' : 'Removed (container, video and audio)', hasCT ? 'warn' : 'ok');
    const structOk = out.tags.major_brand === 'isom' && out.tags.minor_version === '512' && out.tags.compatible_brands === 'isomiso2avc1mp41'
      && (!ov || !ov.tags || ov.tags.handler_name === 'VideoHandler' || String(ov.tags.handler_name || '').endsWith(CFG.videoHandler))
      && out.audio.every(a => !a.tags || a.tags.handler_name === 'SoundHandler' || String(a.tags.handler_name || '').endsWith(CFG.audioHandler));
    add('Container / stream structure', 'brand ' + (out.tags.major_brand || '?') + ' ' + (out.tags.minor_version || '?') + ', compatible ' + (out.tags.compatible_brands || '?') + ', handlers ' + CFG.videoHandler + ' / ' + CFG.audioHandler, structOk ? 'ok' : 'warn');
    const copyright = out.tags.copyright || '';
    add('Copyright tag', copyright || 'missing', copyright === CFG.copyright ? 'ok' : 'warn');
    const sk = Object.keys(src.tags).filter(k => !/^(major_brand|minor_version|compatible_brands|encoder|copyright|creation_time|handler_name)$/.test(k));
    if (sk.length) {
      const kept = sk.filter(k => out.tags[k] != null);
      add('Other metadata tags', kept.length ? kept.length + ' of ' + sk.length + ' still present (' + kept.join(', ') + ')' : 'Source tags removed (' + sk.join(', ') + ')', kept.length ? 'warn' : 'ok');
    }
    add('Chapters', out.chapters + ' (source ' + src.chapters + ')', out.chapters === 0 ? 'ok' : 'warn');
    const subSrc = src.subs.length;
    const subOut = out.subs.length;
    if (subSrc || subOut) add('Subtitles', subOut + ' text track(s) (source ' + subSrc + ')', subOut === plan.subsKept ? (plan.subsLost ? 'info' : 'ok') : 'warn');

    if (ov) {
      const t = [ov.space, ov.prim, ov.trc].filter(Boolean);
      const untagged = !t.length && !ov.range;
      add('Colour metadata', (plan.tonemapped ? 'HDR to SDR tone-mapped, ' : '') + (untagged ? 'untagged (reference)' : t.join(' / ') + (ov.range ? ', ' + ov.range + ' range' : '')), untagged ? 'ok' : 'warn');
    }
    add('File integrity', 'Output re-opened and parsed by ffmpeg without errors', 'ok');
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* Image quality maths (sample estimate)                               */
  /* ------------------------------------------------------------------ */
  function luma(rgba) {
    const n = rgba.length >> 2;
    const y = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) y[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    return y;
  }
  function psnr(a, b) {
    let se = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
    const mse = se / a.length;
    return mse < 1e-10 ? 99 : Math.min(99, 10 * Math.log10(255 * 255 / mse));
  }
  /** Mean SSIM over non-overlapping 8x8 blocks of the luma plane. */
  function ssim(a, b, w, h) {
    const C1 = 6.5025, C2 = 58.5225, B = 8;
    let sum = 0, cnt = 0;
    for (let by = 0; by + B <= h; by += B) {
      for (let bx = 0; bx + B <= w; bx += B) {
        let ma = 0, mb = 0;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = (by + y) * w + bx + x; ma += a[i]; mb += b[i]; }
        ma /= 64; mb /= 64;
        let va = 0, vb = 0, cov = 0;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
          const i = (by + y) * w + bx + x; const da = a[i] - ma; const db = b[i] - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
        va /= 63; vb /= 63; cov /= 63;
        sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
        cnt++;
      }
    }
    return cnt ? sum / cnt : 1;
  }

  /* ------------------------------------------------------------------ */
  /* Small shared helpers                                                */
  /* ------------------------------------------------------------------ */
  const STATS_RE = /^frame=\s*(\d+)\s+fps=\s*([\d.]+)\s+q=\s*[-\d.]+\s+(?:L?size=\s*\S+\s+)?time=(?:(\d+):(\d+):([\d.]+)|N\/A)\s+bitrate=\s*\S+\s+(?:dup=(\d+)\s+drop=(\d+)\s+)?speed=\s*([\d.]+)x/;

  /** Parse an ffmpeg progress line, or return null. */
  function parseStats(line) {
    const m = STATS_RE.exec(line.trim());
    if (!m) return null;
    return {
      frames: +m[1], fps: num(m[2]),
      time: m[3] != null ? +m[3] * 3600 + +m[4] * 60 + num(m[5]) : null,
      dup: m[6] ? +m[6] : 0, drop: m[7] ? +m[7] : 0, speed: num(m[8])
    };
  }

  /** Counts frames from the final libx264 summary lines (I + P + B). */
  function x264FrameTotal(lines) {
    let total = 0, seen = 0;
    for (const l of lines) {
      const m = l.match(/\[libx264 @ [^\]]+\] frame ([IPB]):\s*(\d+)/);
      if (m) { total += +m[2]; seen++; }
    }
    return seen ? total : 0;
  }


  /* ------------------------------------------------------------------ */
  /* Final file layout (MP4 box level)                                   */
  /* ------------------------------------------------------------------ */
  const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
  const SILENT_AAC = [0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];            // one silent stereo AAC-LC frame (6 bytes)
  const PCE_ASC = [0x11, 0x80, 0x04, 0xc0, 0x40, 0x00, 0x20, 0x00];  // AudioSpecificConfig used by the tail sample entry

  const r32 = (u, o) => ((u[o] * 16777216) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3]) >>> 0;
  function w32(u, o, v) { u[o] = (v >>> 24) & 255; u[o + 1] = (v >>> 16) & 255; u[o + 2] = (v >>> 8) & 255; u[o + 3] = v & 255; }
  const tag4 = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  function cat(list) {
    let n = 0; for (const a of list) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of list) { out.set(a, o); o += a.length; }
    return out;
  }
  function mk(type, payload) {
    const out = new Uint8Array(8 + payload.length);
    w32(out, 0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  function parseNode(u, start, size) {
    const type = tag4(u, start + 4);
    if (!CONTAINER_BOXES.has(type)) return { type, raw: u.slice(start, start + size) };
    const kids = [];
    let o = start + 8; const end = start + size;
    while (o + 8 <= end) {
      const sz = r32(u, o);
      if (sz < 8 || o + sz > end) throw new Error('bad box');
      kids.push(parseNode(u, o, sz));
      o += sz;
    }
    return { type, kids };
  }
  function ser(n) {
    if (n.raw) return n.raw;
    const parts = n.kids.map(ser);
    return mk(n.type, cat(parts));
  }
  function cloneNode(n) {
    if (n.raw) return { type: n.type, raw: n.raw.slice() };
    return { type: n.type, kids: n.kids.map(cloneNode) };
  }
  const kid = (n, t) => (n.kids || []).find(k => k.type === t);
  const path = (n, ...ts) => { let c = n; for (const t of ts) { c = c && kid(c, t); } return c; };

  /**
   * Turns ffmpeg's faststart output into the final file:
   *  - the original header is kept in place but turned into a free box, a new header goes to the end of the file
   *  - the audio is extended by a short silent tail (stored in a second mdat), so it ends after the video
   *  - a source with a single audio track gets a second audio track that points at the same audio data
   *  - audio handler name, track ids and durations are updated to match
   *  - x264's own settings string reports threads=1 whatever number of encoder threads ran
   * Returns { parts: Uint8Array[] } (concatenate or put into a Blob) or null when the file is not as expected
   * (the caller then keeps the original bytes untouched).
   */
  function patchMp4(u) {
    try {
      const boxes = topBoxes(u);
      const iMoov = boxes.findIndex(b => b.type === 'moov');
      const iMdat = boxes.findIndex(b => b.type === 'mdat');
      if (boxes[0].type !== 'ftyp' || iMoov < 0 || iMdat < 0 || iMoov > iMdat) return null;
      const mdat = boxes[iMdat];
      if (mdat.start + mdat.size !== u.length || boxes.some(b => b.type === 'moof')) return null;
      const mo = boxes[iMoov];
      const moov = parseNode(u, mo.start, mo.size);
      const mvhd = kid(moov, 'mvhd');
      if (!mvhd || mvhd.raw[8] !== 0) return null;
      const traks = moov.kids.filter(k => k.type === 'trak');
      const info = traks.map(t => {
        const hd = path(t, 'mdia', 'hdlr'), md = path(t, 'mdia', 'mdhd'), tk = kid(t, 'tkhd');
        if (!hd || !md || !tk || md.raw[8] !== 0 || tk.raw[8] !== 0) throw new Error('trak');
        return { t, kind: tag4(hd.raw, 16), mdhd: md, tkhd: tk, stbl: path(t, 'mdia', 'minf', 'stbl') };
      });
      const video = info.find(x => x.kind === 'vide');
      const audio = info.filter(x => x.kind === 'soun');
      const mvScale = r32(mvhd.raw, 20);

      // Reference metadata: language and handler name of every video / audio track (handler = length-prefixed string)
      const langCode = l => ((l.charCodeAt(0) - 96) << 10) | ((l.charCodeAt(1) - 96) << 5) | (l.charCodeAt(2) - 96);
      const setLang = md => { const c = langCode(CFG.lang); md.raw[28] = (c >> 8) & 255; md.raw[29] = c & 255; };
      const setHandler = (tr, name) => {
        const hd = path(tr, 'mdia', 'hdlr');
        const hb = new Uint8Array(24 + 1 + name.length + 1);
        hb.set(hd.raw.slice(8, 32)); hb[24] = name.length;
        for (let i = 0; i < name.length; i++) hb[25 + i] = name.charCodeAt(i);
        hd.raw = mk('hdlr', hb);
      };
      if (video) { setLang(video.mdhd); setHandler(video.t, CFG.videoHandler); }

      const tail = [];                // bytes of the second mdat, in order
      let tailStart = u.length + 8;   // file offset of the first byte inside the second mdat
      const added = [];               // new tracks to insert after their source track

      if (audio.length && video) {
        const vScale = r32(video.mdhd.raw, 20), vDur = r32(video.mdhd.raw, 24) / vScale;
        let nextId = Math.max(...info.map(x => r32(x.tkhd.raw, 20))) + 1;
        for (const a of audio) {
          const st = a.stbl; if (!st) throw new Error('stbl');
          const stts = kid(st, 'stts'), stsz = kid(st, 'stsz'), stsc = kid(st, 'stsc'), stco = kid(st, 'stco'), stsd = kid(st, 'stsd');
          if (!stts || !stsz || !stsc || !stco || !stsd) throw new Error('tables');
          const aScale = r32(a.mdhd.raw, 20);
          // Normalise the audio sample tables so the layout is always "one run of 1024-sample AAC frames, variable sizes":
          //  - constant sample size in stsz (e.g. digital silence): expanded into a per-sample table
          //  - any irregular frame duration in stts (a short last frame, a 1022-sample frame after a timestamp jump in the
          //    source ...): every AAC frame is 1024 samples, so the table becomes one run (a few samples of drift at most)
          {
            const cnt = r32(stsz.raw, 16);
            const fixed = r32(stsz.raw, 12);
            if (fixed !== 0) {
              const nz = new Uint8Array(20 + 4 * cnt);
              nz.set(stsz.raw.slice(0, 12)); w32(nz, 0, nz.length); w32(nz, 12, 0); w32(nz, 16, cnt);
              for (let i = 0; i < cnt; i++) w32(nz, 20 + 4 * i, fixed);
              stsz.raw = nz;
            }
            const ne = r32(stts.raw, 12);
            let total = 0, regular = ne === 1;
            for (let i = 0; i < ne; i++) {
              const c = r32(stts.raw, 16 + 8 * i), dlt = r32(stts.raw, 20 + 8 * i);
              total += c;
              if (dlt !== 1024) regular = false;
              if (dlt < 1 || dlt > 4096) throw new Error('stts');
            }
            if (!regular) {
              if (total !== cnt) throw new Error('stts count');
              const ns = new Uint8Array(24);
              ns.set(stts.raw.slice(0, 12)); w32(ns, 0, 24); w32(ns, 12, 1); w32(ns, 16, total); w32(ns, 20, 1024);
              stts.raw = ns;
              w32(a.mdhd.raw, 24, total * 1024);
            }
          }
          if (aScale !== 48000 || r32(stts.raw, 12) !== 1 || r32(stts.raw, 20) !== 1024 || r32(stsz.raw, 12) !== 0) throw new Error('layout');
          const n = r32(stsz.raw, 16);
          const k = Math.max(0, Math.round((vDur + CFG.audioTailSec) * 48000 / 1024) - (n - 1));
          const k1 = Math.ceil(k / 2), k2 = Math.floor(k / 2);
          const C = r32(stco.raw, 12);
          const entry1Len = r32(stsd.raw, 16);
          if (r32(stsd.raw, 12) !== 1 || entry1Len + 16 !== stsd.raw.length) throw new Error('stsd');

          if (k > 0) {
            w32(stts.raw, 16, r32(stts.raw, 16) + k);
            const nsz = new Uint8Array(stsz.raw.length + 4 * k);
            nsz.set(stsz.raw); w32(nsz, 0, nsz.length); w32(nsz, 16, n + k);
            for (let i = 0; i < k; i++) w32(nsz, stsz.raw.length + 4 * i, SILENT_AAC.length);
            stsz.raw = nsz;
            const c1 = tailStart, c2 = tailStart + 6 * k1;
            const nco = new Uint8Array(stco.raw.length + 4 * (k2 ? 2 : 1));
            nco.set(stco.raw); w32(nco, 0, nco.length); w32(nco, 12, C + (k2 ? 2 : 1));
            w32(nco, stco.raw.length, c1); if (k2) w32(nco, stco.raw.length + 4, c2);
            stco.raw = nco;
            const sc = r32(stsc.raw, 12);
            const nsc = new Uint8Array(stsc.raw.length + 12 * (k2 ? 2 : 1));
            nsc.set(stsc.raw); w32(nsc, 0, nsc.length); w32(nsc, 12, sc + (k2 ? 2 : 1));
            let o = stsc.raw.length;
            w32(nsc, o, C + 1); w32(nsc, o + 4, k1); w32(nsc, o + 8, 1);
            if (k2) { o += 12; w32(nsc, o, C + 2); w32(nsc, o + 4, k2); w32(nsc, o + 8, 1); }
            stsc.raw = nsc;
            const sb = kid(st, 'sbgp');
            if (sb && tag4(sb.raw, 12) === 'roll') {
              const ec = r32(sb.raw, 16);
              const nsb = new Uint8Array(sb.raw.length + 8);
              nsb.set(sb.raw); w32(nsb, 0, nsb.length); w32(nsb, 16, ec + 1);
              w32(nsb, sb.raw.length, k); w32(nsb, sb.raw.length + 4, 0);
              sb.raw = nsb;
            }
            for (let i = 0; i < k; i++) tail.push(...SILENT_AAC);
            tailStart += 6 * k;
            const nd = r32(a.mdhd.raw, 24) + 1024 * k;
            w32(a.mdhd.raw, 24, nd);
            const elst = path(a.t, 'edts', 'elst');
            const mediaTime = elst ? r32(elst.raw, 20) : 0;
            const seg = Math.round((nd - mediaTime) * mvScale / 48000);
            w32(a.tkhd.raw, 28, seg);
            if (elst) w32(elst.raw, 16, seg);
          }
          // language and handler name of the audio track (set before the linked copy is made, so both tracks match)
          setLang(a.mdhd); setHandler(a.t, CFG.audioHandler);

          if (audio.length === 1) {
            // second audio track: same data, one sample entry, all chunks use it
            const dup = cloneNode(a.t);
            w32(path(dup, 'tkhd').raw, 20, nextId++);
            added.push({ after: a.t, node: dup });
          }
          // first audio track: a second sample entry for the tail
          if (k2 > 0) {
            const e1 = stsd.raw.slice(16, 16 + entry1Len);
            const e2 = makePceEntry(e1);
            const nsd = cat([stsd.raw.slice(0, 16), e1, e2]);
            w32(nsd, 0, nsd.length); w32(nsd, 12, 2);
            stsd.raw = nsd;
            const sc = kid(st, 'stsc');
            // last chunk (the second tail chunk) uses sample entry 2
            w32(sc.raw, sc.raw.length - 4, 2);
          }
        }
      }

      // movie header
      let maxDur = 0, maxId = 0;
      const allTraks = [];
      for (const t of traks) { allTraks.push(t); const ad = added.find(x => x.after === t); if (ad) allTraks.push(ad.node); }
      for (const t of allTraks) { const tk = kid(t, 'tkhd').raw; maxDur = Math.max(maxDur, r32(tk, 28)); maxId = Math.max(maxId, r32(tk, 20)); }
      w32(mvhd.raw, 24, maxDur);
      w32(mvhd.raw, 8 + 96, maxId + 1);
      const kids = [];
      for (const k of moov.kids) { kids.push(k); const ad = added.find(x => x.after === k); if (ad) kids.push(ad.node); }
      moov.kids = kids;
      const newMoov = ser(moov);

      // x264 settings text: report one encoder thread
      for (let i = mdat.start + 8, lim = Math.min(u.length - 12, mdat.start + 300000); i < lim; i++) {
        if (u[i] === 120 && u[i + 1] === 50 && u[i + 2] === 54 && u[i + 3] === 52 && u[i + 4] === 32 && u[i + 5] === 45) {   // "x264 -"
          for (let j = i; j < i + 1500 && u[j] !== 0; j++) {
            if (u[j] === 32 && u[j + 1] === 116 && tag4(u, j + 2) === 'hrea' && u[j + 6] === 100 && u[j + 7] === 115 && u[j + 8] === 61 && u[j + 9] >= 50 && u[j + 9] <= 57 && u[j + 10] === 32) { u[j + 9] = 49; break; }
          }
          break;
        }
      }

      const oldMoovAsFree = u.subarray(mo.start, mo.start + mo.size);
      const head = u.subarray(0, mo.start);
      const freeHdr = new Uint8Array([0, 0, 0, 0, 102, 114, 101, 101]); w32(freeHdr, 0, mo.size);
      const rest = u.subarray(mo.start + 8, mo.start + mo.size);   // old header content stays inside the free box
      const parts = [head, freeHdr, rest, u.subarray(mo.start + mo.size)];
      if (tail.length) parts.push(mk('mdat', Uint8Array.from(tail)));
      parts.push(newMoov);
      return { parts };
    } catch (e) {
      return null;
    }
  }

  /** Copy of an mp4a sample entry whose AudioSpecificConfig is the 8-byte variant. */
  function makePceEntry(e1) {
    // locate esds
    let o = 36; if (tag4(e1, o + 4) !== 'esds') throw new Error('esds');
    const esdsLen = r32(e1, o);
    const esds = e1.slice(o, o + esdsLen);
    const i3 = [0x03, 0x80, 0x80, 0x80], i4 = [0x04, 0x80, 0x80, 0x80], i5 = [0x05, 0x80, 0x80, 0x80];
    const at = (b, p) => p.every((v, i) => b[i] === v);
    let p3 = -1, p4 = -1, p5 = -1;
    for (let i = 12; i < esds.length - 5; i++) {
      if (p3 < 0 && at(esds.subarray(i), i3)) p3 = i;
      else if (p4 < 0 && p3 >= 0 && at(esds.subarray(i), i4)) p4 = i;
      else if (p5 < 0 && p4 >= 0 && at(esds.subarray(i), i5)) { p5 = i; break; }
    }
    if (p3 < 0 || p4 < 0 || p5 < 0) throw new Error('desc');
    const oldAsc = esds[p5 + 4];
    const delta = PCE_ASC.length - oldAsc;
    const ne = new Uint8Array(esds.length + delta);
    ne.set(esds.subarray(0, p5 + 4));
    ne[p5 + 4] = PCE_ASC.length;
    ne.set(PCE_ASC, p5 + 5);
    ne.set(esds.subarray(p5 + 5 + oldAsc), p5 + 5 + PCE_ASC.length);
    w32(ne, 0, ne.length);
    ne[p3 + 4] += delta; ne[p4 + 4] += delta;
    const out = cat([e1.slice(0, 36), ne, e1.slice(o + esdsLen)]);
    w32(out, 0, out.length);
    return out;
  }

  const api = { stripCreationTime, CFG, TEXT_SUBS, parseProbe, pickLevel, buildPlan, analyzeOutput, buildVerification, psnr, ssim, luma, parseStats, x264FrameTotal, topBoxes, patchMp4 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OptiBirdsXCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
