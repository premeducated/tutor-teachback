/* Premeducated teaching sample recorder.
 *
 * One page, no install, no account. It records the applicant's screen with their voice, and
 * their camera as a second small file, then uploads both straight into Cloudinary with an
 * unsigned preset. There is no server anywhere in this path.
 *
 * WHY TWO FILES INSTEAD OF ONE COMPOSITED FILE, which is the obvious first design:
 * compositing a webcam bubble onto the screen means drawing both into a canvas every frame
 * and recording the canvas. A canvas draw loop is page rendering, and a browser throttles or
 * stops page rendering when the tab is hidden. A tutor teaching WILL open another tab, and
 * the recording would silently freeze on the last drawn frame while the audio kept running.
 * Recording the screen track directly is not tied to the page's rendering loop, so it cannot
 * freeze. Two files that are always right beat one file that is usually right.
 *
 * THE QUESTION FLOW is Lucas's, 2026-09-01: "start with the cold vignette, no answer, allow
 * them to explain but give them a timer and when they're ready they can move on and see the
 * answer, still recording. If they got it wrong I want to capture their reactions." So each
 * question has two phases, the answer is revealed by them and not by a clock, and the second
 * phase has its own timer and its own prompt.
 */
(function () {
  'use strict';

  var CLOUD = 'dyqrlzcbs';
  var PRESET = 'tutor_teachback';
  var ENDPOINT = 'https://api.cloudinary.com/v1_1/' + CLOUD + '/video/upload';
  var CAP_MS = 15 * 60 * 1000;
  var CHUNK = 6 * 1024 * 1024;
  var N_QUESTIONS = 2;
  var HILITE = '#FFF08A';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  var state = {
    applicant: params.get('a') || '',
    name: params.get('n') || '',
    email: params.get('e') || '',
    assigned: (params.get('q') || '').split(',').filter(Boolean),
    camStream: null, scrStream: null,
    recs: [], parts: {}, blobs: [],
    startedAt: 0, phaseAt: 0, tick: null, level: null,
    bank: null, questions: [], at: 0, phase: 'teach',
    picks: { l1: false, l2all: false, subs: [] }
  };

  // ---------------- screens ----------------
  function show(which) {
    ['gate', 'pick', 'setup', 'record', 'upload', 'done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== which);
    });
    var step = { gate: 0, pick: 1, setup: 2, record: 3, upload: 4, done: 4 }[which];
    [].forEach.call($('steps').children, function (d, i) { d.classList.toggle('on', i <= step); });
    window.scrollTo(0, 0);
  }
  function flag(id, msg, bad) {
    var el = $(id); el.textContent = msg;
    el.classList.toggle('bad', !!bad); el.classList.remove('hidden');
  }
  function unflag(id) { $(id).classList.add('hidden'); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------- the bank ----------------
  function bank() {
    if (state.bank) return state.bank;
    try { state.bank = JSON.parse(atob(window.__TB)); } catch (e) { state.bank = null; }
    return state.bank;
  }

  // ---------------- gate ----------------
  if (state.name) $('n').value = state.name;
  if (state.email) $('e').value = state.email;

  $('toPick').addEventListener('click', function () {
    var n = $('n').value.trim(), e = $('e').value.trim();
    if (n.length < 2) return flag('gateflag', 'Please put your full name in.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      return flag('gateflag', 'That email does not look right. Use the one you applied with.');
    }
    state.name = n; state.email = e;
    unflag('gateflag');
    buildPicker();
    show('pick');
  });

  // ---------------- what they tutor ----------------
  function buildPicker() {
    var b = bank();
    if (!b) return;
    var subs = (b.groups['Level 2'] || []);
    $('subs').innerHTML = subs.map(function (s, i) {
      return '<label class="pick"><input type="checkbox" class="sub" value="' + esc(s) + '">'
           + '<span><b>' + esc(s) + '</b></span></label>';
    }).join('');
    [].forEach.call(document.querySelectorAll('#pick input[type=checkbox]'), function (cb) {
      cb.addEventListener('change', syncPicker);
    });
    syncPicker();
  }

  function syncPicker() {
    state.picks.l1 = $('c1').checked;
    state.picks.l2all = $('c2').checked;
    state.picks.subs = [].filter.call(document.querySelectorAll('.sub'), function (c) {
      return c.checked;
    }).map(function (c) { return c.value; });

    // Level 2 as a whole and picking single subjects are the same choice made two ways, so
    // ticking the whole thing takes the subject list off the table rather than leaving a
    // half-filled second control on screen.
    $('subsWrap').classList.toggle('hidden', state.picks.l2all);
    if (state.picks.l2all) {
      [].forEach.call(document.querySelectorAll('.sub'), function (c) { c.checked = false; });
      state.picks.subs = [];
    }
    [].forEach.call(document.querySelectorAll('#pick .pick'), function (l) {
      var cb = l.querySelector('input');
      l.classList.toggle('on', cb && cb.checked);
    });
    var pool = poolFor();
    $('pickSummary').textContent = pool.total
      ? pool.total + ' question' + (pool.total === 1 ? '' : 's') + ' to draw from'
      : '';
    unflag('pickflag');
  }

  function poolFor() {
    var b = bank() || { questions: [] };
    var l1 = state.picks.l1
      ? b.questions.filter(function (q) { return q.level === 'Level 1'; }) : [];
    var l2 = [];
    if (state.picks.l2all) {
      l2 = b.questions.filter(function (q) { return q.level === 'Level 2'; });
    } else if (state.picks.subs.length) {
      l2 = b.questions.filter(function (q) {
        return q.level === 'Level 2' && state.picks.subs.indexOf(q.group) >= 0;
      });
    }
    return { l1: l1, l2: l2, total: l1.length + l2.length };
  }

  $('toSetup').addEventListener('click', function () {
    var pool = poolFor();
    if (!pool.total) {
      return flag('pickflag', 'Pick at least one. If you do not want all of Level 2, tick the '
        + 'individual subjects you are comfortable with instead.');
    }
    show('setup');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      flag('setupflag', 'This browser cannot record. Use Chrome, Edge, Firefox or Safari on a laptop.', true);
      $('askCam').disabled = true;
    } else if (!navigator.mediaDevices.getDisplayMedia) {
      flag('setupflag', 'This device cannot share a screen, which almost always means a phone or '
        + 'a tablet. You can still record your camera and voice, but if you want to draw or show '
        + 'anything, stop and come back on a laptop.');
    }
  });

  // ---------------- choosing the questions ----------------
  // Seeded on the application id, so the draw is stable for one applicant and different
  // between applicants. Plain randomness let somebody reload until they got a question they
  // liked, which is the one form of gaming this page would otherwise invite.
  function seedFrom(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  var rngState = seedFrom(state.applicant || String(Date.now()));
  function rnd() {                       // mulberry32
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    var t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function drawFrom(list, used) {
    var free = list.filter(function (q) { return used.indexOf(q.id) < 0; });
    var from = free.length ? free : list;
    if (!from.length) return null;
    // Order the pool by id first so the same seed always sees the same order, whatever
    // order the bank happens to be in.
    from = from.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return from[Math.floor(rnd() * from.length)];
  }

  function chooseQuestions() {
    var b = bank();
    if (!b) return [];
    // If the invitation named the questions, use those. The bot picks the least used ones so
    // two applicants in a row do not get the same pair.
    if (state.assigned.length) {
      var byId = {};
      b.questions.forEach(function (q) { byId[q.id] = q; });
      var named = state.assigned.map(function (i) { return byId[i]; }).filter(Boolean);
      if (named.length >= N_QUESTIONS) return named.slice(0, N_QUESTIONS);
    }
    rngState = seedFrom(state.applicant || String(Date.now()));
    var pool = poolFor(), out = [], used = [];
    // One from each level when they teach both, which is what the interview instructions
    // have always asked candidates to prepare.
    if (pool.l1.length && pool.l2.length) {
      [pool.l1, pool.l2].forEach(function (list) {
        var q = drawFrom(list, used);
        if (q) { out.push(q); used.push(q.id); }
      });
    }
    var all = pool.l1.concat(pool.l2);
    while (out.length < N_QUESTIONS && all.length) {
      var q = drawFrom(all, used);
      if (!q) break;
      out.push(q); used.push(q.id);
      if (used.length >= all.length) break;
    }
    return out;
  }

  // ---------------- permissions ----------------
  $('askCam').addEventListener('click', function () {
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (s) {
      state.camStream = s;
      $('pvCam').srcObject = s;
      $('askCam').textContent = 'Camera and microphone are on';
      $('askCam').disabled = true;
      $('askScreen').disabled = !navigator.mediaDevices.getDisplayMedia;
      meter(s);
      unflag('setupflag');
      if (!navigator.mediaDevices.getDisplayMedia) readyCheck();
    }).catch(function (err) { flag('setupflag', permMessage(err, 'camera and microphone'), true); });
  });

  $('askScreen').addEventListener('click', function () {
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 20 } }, audio: false
    }).then(function (s) {
      state.scrStream = s;
      $('pvScr').srcObject = s;
      $('askScreen').textContent = 'Screen is being shared';
      $('askScreen').disabled = true;
      s.getVideoTracks()[0].addEventListener('ended', function () {
        if (state.recs.length) finish();
      });
      unflag('setupflag');
      readyCheck();
    }).catch(function (err) { flag('setupflag', permMessage(err, 'screen'), true); });
  });

  function permMessage(err, what) {
    var n = err && err.name;
    if (n === 'NotAllowedError') return 'You turned down the ' + what + ' request, or the browser '
      + 'blocked it. Reload the page and allow it. On a Mac you may also need System Settings, '
      + 'Privacy and Security.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No ' + what + ' was found on this computer.';
    if (n === 'NotReadableError') return 'Another program is holding the ' + what + '. Close Zoom, '
      + 'Teams or any other call and try again.';
    return 'The ' + what + ' could not be started (' + (n || 'unknown') + ').';
  }

  function readyCheck() {
    if (!state.camStream) return;
    $('ready').classList.remove('hidden');
    $('start').disabled = false;
  }

  function meter(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = new AC(), src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
      an.fftSize = 512; src.connect(an);
      var buf = new Uint8Array(an.frequencyBinCount);
      state.level = setInterval(function () {
        an.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        $('lvl').style.width = Math.min(100, (peak / 60) * 100) + '%';
      }, 90);
    } catch (e) { /* the meter is a nicety, never a blocker */ }
  }

  // ---------------- rendering a question ----------------
  function render(q, idx) {
    var html = '<div class="qtag">Question ' + (idx + 1) + ' of ' + state.questions.length
      + '  ·  ' + esc(q.level) + '  ·  ' + esc(q.group) + '</div>'
      + '<div class="stem">' + esc(q.stem) + '</div><ol class="opts">';
    q.options.forEach(function (o) { html += '<li>' + esc(o) + '</li>'; });
    html += '</ol>';
    $('qbox').innerHTML = html;
    state.phase = 'teach';
    state.phaseAt = Date.now();
    $('reveal').classList.remove('hidden');
    $('next').classList.add('hidden');
  }

  function revealAnswer() {
    var q = state.questions[state.at];
    if (!q || state.phase !== 'teach') return;
    // The card is theirs to type in by now, so the answer is grafted onto the DOM rather than
    // re-rendered. Re-rendering would wipe whatever they highlighted or wrote while teaching.
    var lis = $('qbox').querySelectorAll('ol.opts li');
    [].forEach.call(lis, function (li) {
      if (li.textContent.trim().replace(/\s+/g, ' ') === q.answer.trim().replace(/\s+/g, ' ')) {
        li.classList.add('right');
      }
    });
    var box = document.createElement('div');
    box.className = 'reveal';
    box.innerHTML = '<h3>The answer is ' + esc(q.answer) + '</h3>'
      + '<p>' + esc(q.explanation) + '</p>'
      + '<div class="prompt">Keep going, you are still recording. If that is where you landed, '
      + 'say what you would check with the student to be sure they follow it. If it is not, say '
      + 'so out loud and teach it from here. That is the part we are most interested in.</div>';
    $('qbox').appendChild(box);
    state.phase = 'after';
    state.phaseAt = Date.now();
    $('reveal').classList.add('hidden');
    $('next').classList.remove('hidden');
    $('next').textContent = (state.at + 1 < state.questions.length)
      ? 'Next question' : 'Finish and send';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('reveal').addEventListener('click', revealAnswer);
  $('next').addEventListener('click', function () {
    if (state.at + 1 < state.questions.length) {
      state.at += 1;
      render(state.questions[state.at], state.at);
      window.scrollTo(0, 0);
    } else {
      finish();
    }
  });

  // ---------------- the doc tools ----------------
  function keepSelection(btn, fn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', fn);
  }
  keepSelection($('bBold'), function () { document.execCommand('bold'); });
  keepSelection($('bMark'), function () {
    // styleWithCSS matters: without it some browsers emit <font> and the highlight is lost.
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
    document.execCommand('hiliteColor', false, HILITE);
  });
  keepSelection($('bClear'), function () { document.execCommand('removeFormat'); });

  // ---------------- drawing ----------------
  var ink = $('ink'), ctx = ink.getContext('2d');
  var strokes = [], cur = null, penOn = false, penColor = '#D93A3A';

  function sizeInk() {
    ink.width = window.innerWidth;
    ink.height = window.innerHeight;
    redraw();
  }
  function redraw() {
    ctx.clearRect(0, 0, ink.width, ink.height);
    var off = window.scrollY;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
    strokes.concat(cur ? [cur] : []).forEach(function (s) {
      if (s.pts.length < 2) return;
      ctx.strokeStyle = s.c;
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y - off);
      for (var i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y - off);
      ctx.stroke();
    });
  }
  window.addEventListener('resize', sizeInk);
  // Strokes are stored in PAGE coordinates and drawn with the scroll subtracted, so a drawing
  // stays on the thing it was drawn on instead of sliding around when the page moves.
  window.addEventListener('scroll', redraw, { passive: true });
  sizeInk();

  keepSelection($('bPen'), function () {
    penOn = !penOn;
    ink.classList.toggle('live', penOn);
    $('bPen').classList.toggle('on', penOn);
    $('bPen').textContent = penOn ? 'Drawing, click to stop' : 'Draw on the screen';
  });
  keepSelection($('bErase'), function () { strokes = []; cur = null; redraw(); });
  [].forEach.call(document.querySelectorAll('.swatch'), function (b) {
    keepSelection(b, function () {
      penColor = b.getAttribute('data-c');
      [].forEach.call(document.querySelectorAll('.swatch'), function (o) {
        o.classList.toggle('on', o === b);
      });
    });
  });
  ink.addEventListener('pointerdown', function (e) {
    if (!penOn) return;
    ink.setPointerCapture(e.pointerId);
    cur = { c: penColor, pts: [{ x: e.clientX, y: e.clientY + window.scrollY }] };
  });
  ink.addEventListener('pointermove', function (e) {
    if (!cur) return;
    cur.pts.push({ x: e.clientX, y: e.clientY + window.scrollY });
    redraw();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    ink.addEventListener(ev, function () {
      if (cur) { strokes.push(cur); cur = null; redraw(); }
    });
  });

  // ---------------- recording ----------------
  function pickMime(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function startRecorder(key, stream, videoBps) {
    var mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
                         'video/webm', 'video/mp4']);
    var opts = { audioBitsPerSecond: 96000, videoBitsPerSecond: videoBps };
    if (mime) opts.mimeType = mime;
    var rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch (e) { rec = new MediaRecorder(stream); }
    state.parts[key] = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.parts[key].push(ev.data); };
    rec.__key = key;
    rec.__mime = rec.mimeType || mime || 'video/webm';
    rec.start(4000);
    state.recs.push(rec);
    return rec;
  }

  $('start').addEventListener('click', function () {
    state.questions = chooseQuestions();
    if (!state.questions.length) { alert('No questions matched what you picked. Go back and pick again.'); return; }

    var mic = state.camStream.getAudioTracks();
    if (state.scrStream) {
      var screenPlusVoice = new MediaStream(state.scrStream.getVideoTracks().concat(mic));
      startRecorder('screen', screenPlusVoice, 1200000);
      startRecorder('camera', state.camStream, 350000);
    } else {
      startRecorder('camera', state.camStream, 900000);
    }

    state.startedAt = Date.now();
    state.at = 0;
    render(state.questions[0], 0);
    show('record');

    state.tick = setInterval(function () {
      var ms = Date.now() - state.startedAt;          // wall clock, never a tick count, so
      var s = Math.floor(ms / 1000);                  // throttling cannot distort it
      $('clock').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      var left = Math.max(0, CAP_MS - ms);
      $('cap').textContent = left > 60000
        ? 'Recording. ' + Math.ceil(left / 60000) + ' minutes left of the cap.'
        : 'Recording. Under a minute left, start wrapping up.';
      var ps = Math.floor((Date.now() - state.phaseAt) / 1000);
      $('phase').textContent = (state.phase === 'teach' ? 'Teaching this one: ' : 'Since the answer: ')
        + Math.floor(ps / 60) + ':' + ('0' + (ps % 60)).slice(-2);
      if (ms >= CAP_MS) finish();
    }, 500);
  });

  $('stop').addEventListener('click', function () {
    if (Date.now() - state.startedAt < 60000 &&
        !confirm('That is under a minute. Stop and send anyway?')) return;
    finish();
  });

  window.addEventListener('beforeunload', function (e) {
    if (state.recs.length && !state.blobs.length) { e.preventDefault(); e.returnValue = ''; }
  });

  var finishing = false;
  function finish() {
    if (finishing) return;
    finishing = true;
    clearInterval(state.tick);
    clearInterval(state.level);
    var pending = state.recs.length;
    if (!pending) return;
    state.recs.forEach(function (rec) {
      rec.onstop = function () {
        var parts = state.parts[rec.__key] || [];
        if (parts.length) {
          state.blobs.push({ role: rec.__key, blob: new Blob(parts, { type: rec.__mime }) });
        }
        if (--pending === 0) {
          [state.camStream, state.scrStream].forEach(function (s) {
            if (s) s.getTracks().forEach(function (t) { t.stop(); });
          });
          show('upload');
          sendAll();
        }
      };
      try { rec.stop(); } catch (e) { if (--pending === 0) { show('upload'); sendAll(); } }
    });
  }

  // ---------------- upload ----------------
  function contextString(role) {
    var esc2 = function (v) { return String(v).replace(/([=|])/g, '\\$1'); };
    var picks = [];
    if (state.picks.l1) picks.push('Level 1');
    if (state.picks.l2all) picks.push('Level 2 all');
    if (state.picks.subs.length) picks.push(state.picks.subs.join(' and '));
    return ['name=' + esc2(state.name), 'email=' + esc2(state.email),
            'applicant=' + esc2(state.applicant || 'none'), 'role=' + role,
            'minutes=' + Math.round((Date.now() - state.startedAt) / 60000),
            'teaches=' + esc2(picks.join(', ') || 'not stated'),
            'questions=' + esc2(state.questions.map(function (q) { return q.id; }).join(' '))
           ].join('|');
  }

  function putChunk(blob, role, start, end, total, uniq) {
    var fd = new FormData();
    fd.append('file', blob.slice(start, end), role + '.webm');
    fd.append('upload_preset', PRESET);
    // No tags field here on purpose. An unsigned upload cannot add its own tags, the preset's
    // tutor-teachback tag is applied server side, and everything that identifies the applicant
    // rides in context, which unsigned uploads DO keep. Verified against the live account.
    fd.append('context', contextString(role));
    return fetch(ENDPOINT, {
      method: 'POST', body: fd,
      headers: { 'X-Unique-Upload-Id': uniq,
                 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + total }
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); });
      return r.json();
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function uploadOne(item, onBytes) {
    var uniq = 'tb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    var size = item.blob.size, start = 0;
    function step() {
      if (start >= size) return Promise.resolve();
      var end = Math.min(start + CHUNK, size), attempt = 0;
      function tryChunk() {
        attempt += 1;
        return putChunk(item.blob, item.role, start, end, size, uniq).then(function () {
          onBytes(end - start); start = end; return step();
        }).catch(function (err) {
          // A dropped chunk is usually a wifi blip, and they have already spent ten minutes.
          if (attempt >= 3) throw err;
          return sleep(1200 * attempt).then(tryChunk);
        });
      }
      return tryChunk();
    }
    return step();
  }

  function sendAll() {
    if (!state.blobs.length) {
      flag('upflag', 'Nothing was recorded. Reload and try again, and if it happens twice, reply '
        + 'to the email you got and say so.', true);
      return;
    }
    var total = state.blobs.reduce(function (n, b) { return n + b.blob.size; }, 0), sent = 0;
    $('upflag').classList.add('hidden');
    $('retry').classList.add('hidden');
    $('upNote').textContent = 'Leave this page open. Closing it now loses the recording. This is '
      + 'about ' + Math.max(1, Math.round(total / 1024 / 1024)) + ' MB.';
    function bytes(n) {
      sent += n;
      var pct = Math.min(99, Math.round((sent / total) * 100));
      $('bar').style.width = pct + '%';
      $('upPct').textContent = pct + '%';
    }
    var chain = Promise.resolve();
    state.blobs.forEach(function (item) {
      chain = chain.then(function () { return uploadOne(item, bytes); });
    });
    chain.then(function () {
      $('bar').style.width = '100%'; $('upPct').textContent = '100%'; show('done');
    }).catch(function (err) {
      flag('upflag', 'The upload did not finish (' + String(err.message || err).slice(0, 160)
        + '). Your recording is still here in the page, so try again. If it will not go, download '
        + 'the file and reply to your application email with it attached.', true);
      $('retry').classList.remove('hidden');
      $('dl').classList.remove('hidden');
    });
  }

  $('retry').addEventListener('click', function () { sendAll(); });
  $('dl').addEventListener('click', function () {
    state.blobs.forEach(function (item) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(item.blob);
      a.download = (state.name.replace(/[^A-Za-z0-9]+/g, '-') || 'teaching-sample') + '-' + item.role + '.webm';
      document.body.appendChild(a); a.click(); a.remove();
    });
  });
})();
