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
 */
(function () {
  'use strict';

  var CLOUD = 'dyqrlzcbs';
  var PRESET = 'tutor_teachback';
  var ENDPOINT = 'https://api.cloudinary.com/v1_1/' + CLOUD + '/video/upload';
  var CAP_MS = 12 * 60 * 1000;          // hard stop
  var CHUNK = 6 * 1024 * 1024;          // Cloudinary wants 5MB or more per chunk except the last
  var N_QUESTIONS = 2;

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  var state = {
    applicant: params.get('a') || '',
    name: params.get('n') || '',
    email: params.get('e') || '',
    camStream: null, scrStream: null,
    recs: [], parts: {}, blobs: [],
    startedAt: 0, tick: null, level: null,
    questions: [], shown: 0
  };

  // ---------------- screens ----------------
  function show(which) {
    ['gate', 'setup', 'record', 'upload', 'done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== which);
    });
    var step = { gate: 0, setup: 1, record: 2, upload: 3, done: 3 }[which];
    [].forEach.call($('steps').children, function (d, i) { d.classList.toggle('on', i <= step); });
    window.scrollTo(0, 0);
  }
  function flag(id, msg, bad) {
    var el = $(id);
    el.textContent = msg;
    el.classList.toggle('bad', !!bad);
    el.classList.remove('hidden');
  }
  function unflag(id) { $(id).classList.add('hidden'); }

  // ---------------- gate ----------------
  if (state.name) $('n').value = state.name;
  if (state.email) $('e').value = state.email;

  $('toSetup').addEventListener('click', function () {
    var n = $('n').value.trim(), e = $('e').value.trim();
    if (n.length < 2) return flag('gateflag', 'Please put your full name in.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return flag('gateflag', 'That email does not look right. Use the one you applied with.');
    state.name = n; state.email = e;
    unflag('gateflag');
    show('setup');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      flag('setupflag', 'This browser cannot record. Use Chrome, Edge, Firefox or Safari on a laptop.', true);
      $('askCam').disabled = true;
    } else if (!navigator.mediaDevices.getDisplayMedia) {
      flag('setupflag', 'This device cannot share a screen, which almost always means a phone or a '
        + 'tablet. You can still record your camera and voice, but if you want to draw or show '
        + 'anything, stop and come back on a laptop.');
    }
  });

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
    }).catch(function (err) {
      flag('setupflag', permMessage(err, 'camera and microphone'), true);
    });
  });

  $('askScreen').addEventListener('click', function () {
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 20 } }, audio: false
    }).then(function (s) {
      state.scrStream = s;
      $('pvScr').srcObject = s;
      $('askScreen').textContent = 'Screen is being shared';
      $('askScreen').disabled = true;
      // If they hit the browser's own "Stop sharing" button mid-recording, close it out
      // cleanly rather than writing a file whose second half is a black rectangle.
      s.getVideoTracks()[0].addEventListener('ended', function () {
        if (state.recs.length) finish();
      });
      unflag('setupflag');
      readyCheck();
    }).catch(function (err) {
      flag('setupflag', permMessage(err, 'screen'), true);
    });
  });

  function permMessage(err, what) {
    var n = err && err.name;
    if (n === 'NotAllowedError') return 'You turned down the ' + what + ' request, or the browser blocked it. '
      + 'Reload the page and allow it. On a Mac you may also need System Settings, Privacy and Security.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No ' + what + ' was found on this computer.';
    if (n === 'NotReadableError') return 'Another program is holding the ' + what + '. Close Zoom, Teams or '
      + 'any other call and try again.';
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

  // ---------------- questions ----------------
  function bank() {
    try { return JSON.parse(atob(window.__TB)); } catch (e) { return []; }
  }
  function pick() {
    var all = bank().slice(), out = [];
    for (var i = 0; i < N_QUESTIONS && all.length; i++) {
      out.push(all.splice(Math.floor(Math.random() * all.length), 1)[0]);
    }
    return out;
  }
  function render(q, idx) {
    var html = '<div class="tag">Question ' + (idx + 1) + ' of ' + state.questions.length
      + '  ·  ' + esc(q.exam) + '</div><div class="stem">' + esc(q.stem) + '</div><ol class="opts">';
    q.options.forEach(function (o) { html += '<li>' + esc(o) + '</li>'; });
    html += '</ol><div class="ans">The correct answer is <b>' + esc(q.answer) + '</b>. '
      + 'Teach it. Assume the student picked something else and does not know why they were wrong.</div>';
    $('qbox').innerHTML = html;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

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
    catch (e) { rec = new MediaRecorder(stream); }   // last resort: whatever the browser will give
    state.parts[key] = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.parts[key].push(ev.data); };
    rec.__key = key;
    rec.__mime = rec.mimeType || mime || 'video/webm';
    // A timeslice means a crash or a killed tab still leaves usable parts in memory, and it
    // keeps one enormous buffer from being built up in a single blob.
    rec.start(4000);
    state.recs.push(rec);
    return rec;
  }

  $('start').addEventListener('click', function () {
    state.questions = pick();
    if (!state.questions.length) { alert('The question bank did not load. Reload the page.'); return; }

    var mic = state.camStream.getAudioTracks();
    if (state.scrStream) {
      // The screen file is the one that matters, so the voice goes on it.
      var screenPlusVoice = new MediaStream(state.scrStream.getVideoTracks().concat(mic));
      startRecorder('screen', screenPlusVoice, 1200000);
      startRecorder('camera', state.camStream, 350000);
    } else {
      startRecorder('camera', state.camStream, 900000);
    }

    state.startedAt = Date.now();
    state.shown = 0;
    render(state.questions[0], 0);
    $('next').textContent = state.questions.length > 1 ? 'Second question' : 'Done with this one';
    $('next').disabled = state.questions.length < 2;
    show('record');

    state.tick = setInterval(function () {
      var ms = Date.now() - state.startedAt;              // wall clock, never a tick count,
      var s = Math.floor(ms / 1000);                      // so throttling cannot distort it
      $('clock').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      var left = Math.max(0, CAP_MS - ms);
      $('cap').textContent = left > 60000
        ? 'Recording. ' + Math.ceil(left / 60000) + ' minutes left of the cap.'
        : 'Recording. Under a minute left, start wrapping up.';
      if (ms >= CAP_MS) finish();
    }, 500);
  });

  $('next').addEventListener('click', function () {
    if (state.shown + 1 < state.questions.length) {
      state.shown += 1;
      render(state.questions[state.shown], state.shown);
      if (state.shown + 1 >= state.questions.length) {
        $('next').disabled = true;
        $('next').textContent = 'That is both of them';
      }
    }
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
    // Cloudinary context is key=value pairs joined by |, and | and = have to be escaped.
    var esc2 = function (v) { return String(v).replace(/([=|])/g, '\\$1'); };
    return ['name=' + esc2(state.name), 'email=' + esc2(state.email),
            'applicant=' + esc2(state.applicant || 'none'), 'role=' + role,
            'minutes=' + Math.round((Date.now() - state.startedAt) / 60000),
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
      headers: { 'X-Unique-Upload-Id': uniq, 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + total }
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); });
      return r.json();
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function uploadOne(item, done, total, onBytes) {
    var uniq = 'tb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    var size = item.blob.size, start = 0;
    function step() {
      if (start >= size) return Promise.resolve();
      var end = Math.min(start + CHUNK, size);
      var attempt = 0;
      function tryChunk() {
        attempt += 1;
        return putChunk(item.blob, item.role, start, end, size, uniq).then(function () {
          onBytes(end - start);
          start = end;
          return step();
        }).catch(function (err) {
          // A dropped chunk is usually a wifi blip, and the applicant has already spent ten
          // minutes. Three tries with a backoff before we hand it back to them.
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
      flag('upflag', 'Nothing was recorded. Reload and try again, and if it happens twice, '
        + 'reply to the email you got and say so.', true);
      return;
    }
    var total = state.blobs.reduce(function (n, b) { return n + b.blob.size; }, 0);
    var sent = 0;
    $('upflag').classList.add('hidden');
    $('retry').classList.add('hidden');
    $('upNote').textContent = 'Leave this page open. Closing it now loses the recording. '
      + 'This is about ' + Math.max(1, Math.round(total / 1024 / 1024)) + ' MB.';

    function bytes(n) {
      sent += n;
      var pct = Math.min(99, Math.round((sent / total) * 100));
      $('bar').style.width = pct + '%';
      $('upPct').textContent = pct + '%';
    }

    var chain = Promise.resolve();
    state.blobs.forEach(function (item) {
      chain = chain.then(function () { return uploadOne(item, sent, total, bytes); });
    });
    chain.then(function () {
      $('bar').style.width = '100%';
      $('upPct').textContent = '100%';
      show('done');
    }).catch(function (err) {
      flag('upflag', 'The upload did not finish (' + String(err.message || err).slice(0, 160)
        + '). Your recording is still here in the page, so try again. If it will not go, '
        + 'download the file and reply to your application email with it attached.', true);
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
