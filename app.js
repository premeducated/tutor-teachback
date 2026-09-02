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
 * THE QUESTION FLOW, Lucas's ruling of 2026-09-01 evening, which REVERSED his ruling of that
 * afternoon: there is no answer reveal. "Let's just get rid of the showing them the correct
 * answer one. That's just extra steps." Do not put it back. The candidate gets the vignette
 * cold and teaches it, and the page never holds the answer at all (see bank/build_bank.py).
 *
 * THE CLOCK is the other half of that ruling: "make sure that people can't reload and get a
 * different question and that there's no way to cheat on this, like, they can't get extra
 * time." So every question has a fixed window, read-and-work then teach, the page moves on by
 * itself, and the schedule is a set of absolute wall-clock deadlines fixed at the moment they
 * press Start and stored in this browser. A reload comes back to the same questions with the
 * same deadlines still counting. Nothing on this page can ever move a deadline later.
 */
(function () {
  'use strict';

  var CLOUD = 'dyqrlzcbs';
  var PRESET = 'tutor_teachback';
  var ENDPOINT = 'https://api.cloudinary.com/v1_1/' + CLOUD + '/video/upload';
  var CHUNK = 6 * 1024 * 1024;
  var N_QUESTIONS = 2;
  var HILITE = '#FFF08A';

  // 90 seconds is the pace of the exam itself (COMLEX Level 1 gives about 82 seconds an item,
  // Step 1 about 90). Five minutes to teach is Lucas's ruling of 2026-09-01: "let's give them
  // five minutes for the explanation." Two questions come to thirteen minutes. Change these
  // two lines and nothing else, every number on the page follows.
  var WORK_S = 90;
  var TEACH_S = 300;

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  // Shorter clocks for the browser test, and only when the page is served from this machine.
  // A deployed copy ignores the parameter, so it is not a lever a candidate can pull.
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (LOCAL && params.get('t')) {
    var t = params.get('t').split(',').map(Number);
    if (t[0] > 0) WORK_S = t[0];
    if (t[1] > 0) TEACH_S = t[1];
  }
  var Q_MS = (WORK_S + TEACH_S) * 1000;
  var CAP_S = N_QUESTIONS * (WORK_S + TEACH_S);

  var state = {
    applicant: params.get('a') || '',
    name: params.get('n') || '',
    email: params.get('e') || '',
    camStream: null, scrStream: null,
    recs: [], parts: {}, blobs: [],
    startedAt: 0, tick: null, level: null,
    bank: null, questions: [], at: -1, phase: '', heard: false,
    sched: [], reloads: 0, resuming: null,
    away: [], surface: '',
    picks: { l1: false, l2all: false, subs: [] }
  };

  var EXAM = { 'Level 1': 'COMLEX Level 1 / USMLE Step 1', 'Level 2': 'COMLEX Level 2 / USMLE Step 2' };
  function examLabel(level) { return EXAM[level] || level; }

  // ---------------- screens ----------------
  function show(which) {
    ['gate', 'resume', 'again', 'pick', 'practice', 'setup', 'record', 'upload', 'done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== which);
    });
    var step = { gate: 0, resume: 0, again: 5, pick: 1, practice: 2, setup: 3, record: 4, upload: 5, done: 5 }[which];
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
  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function spoken(sec) {
    if (sec % 60 === 0) return (sec / 60) + ' minute' + (sec === 60 ? '' : 's');
    if (sec < 120) return sec + ' seconds';
    return Math.floor(sec / 60) + ' minutes ' + (sec % 60) + ' seconds';
  }

  // ---------------- the bank ----------------
  function bank() {
    if (state.bank) return state.bank;
    try { state.bank = JSON.parse(atob(window.__TB)); } catch (e) { state.bank = null; }
    return state.bank;
  }

  // ---------------- the attempt, remembered in this browser ----------------
  // One record per application id. It is what makes a reload come back to the same
  // questions and the same deadlines instead of a fresh clock.
  var STORE = 'tb:' + state.applicant;
  function loadRecord() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; }
  }
  function saveRecord(r) {
    try { localStorage.setItem(STORE, JSON.stringify(r)); } catch (e) { /* private mode */ }
  }
  function record() {
    return { v: 1, started: state.startedAt, qids: state.questions.map(function (q) { return q.id; }),
             sched: state.sched, picks: state.picks, reloads: state.reloads, done: false,
             name: state.name, email: state.email, away: state.away, seen: Date.now() };
  }

  // ---------------- gate ----------------
  $('tWork').textContent = spoken(WORK_S);
  $('tTeach').textContent = spoken(TEACH_S);
  $('tTotal').textContent = Math.ceil(CAP_S / 60) + ' minutes';
  $('dWork').textContent = spoken(WORK_S);
  $('dTeach').textContent = spoken(TEACH_S);
  $('dTeach2').textContent = spoken(TEACH_S);
  document.querySelector('.bar.demo .clock').textContent = mmss(WORK_S);
  if (state.name) $('n').value = state.name;
  if (state.email) $('e').value = state.email;

  if (!state.applicant) {
    // Without the application id the upload comes back belonging to nobody, and the draw
    // would be reseeded on every reload. The link in the email always carries it.
    flag('gateflag', 'This link is missing your application id, so the page cannot tie your '
      + 'recording to your application. Open the page from the link in the email we sent you.', true);
    $('toPick').disabled = true;
  }

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
    $('subs').innerHTML = subs.map(function (s) {
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
      return flag('pickflag', 'Pick at least one. If you do not want all of Level 2 / Step 2, '
        + 'tick the individual subjects you are comfortable with instead.');
    }
    show('practice');
  });
  // The practice screen is off the clock and unrecorded. Lucas 2026-09-01: "a quick tutorial
  // would help with a fake question they could practice highlighting, bolding, drawing,
  // whatever else they have, and then a screen to confirm their mic and camera are working."
  $('toSetup2').addEventListener('click', function () {
    setPen(false);
    eraseInk();
    toSetup();
  });

  // Laptop only, Lucas 2026-09-01: "let's just make sure that people do this on their laptop."
  // The screen is how he sees what they reference and how fast, so there is no camera-only
  // path any more. A phone or a tablet is told to come back on a laptop with the same link.
  function toSetup() {
    show('setup');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      flag('setupflag', 'This browser cannot record. Use Chrome, Edge, Firefox or Safari on a laptop.', true);
      $('askCam').disabled = true;
    } else if (!navigator.mediaDevices.getDisplayMedia) {
      flag('setupflag', 'This device cannot share a screen, which almost always means a phone or '
        + 'a tablet. The teaching sample has to be done on a laptop or desktop, because your '
        + 'screen is how we see you work. Come back on one. The link in your email stays good '
        + 'and your clock has not started.', true);
      $('askCam').disabled = true;
    }
  }

  // ---------------- choosing the questions ----------------
  // Seeded on the application id, so the draw is stable for one applicant and different
  // between applicants. Plain randomness let somebody reload until they got a question they
  // liked. The stored record above is what stops the same thing across reloads now, and the
  // seed is the second lock under it.
  function seedFrom(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  var rngState = 0;
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
    rngState = seedFrom(state.applicant);
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
      $('askScreen').disabled = false;
      meter(s);
      unflag('setupflag');
    }).catch(function (err) { flag('setupflag', permMessage(err, 'camera and microphone'), true); });
  });

  $('askScreen').addEventListener('click', function () {
    navigator.mediaDevices.getDisplayMedia({
      // displaySurface is a hint to open the picker on the whole-screen pane. Browsers that
      // honour it help, browsers that ignore it are checked after the fact below.
      video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 20 } }, audio: false
    }).then(function (s) {
      var track = s.getVideoTracks()[0];
      var settings = (track && track.getSettings) ? (track.getSettings() || {}) : {};
      state.surface = settings.displaySurface || 'unknown';
      if (settings.displaySurface && settings.displaySurface !== 'monitor') {
        // A single window or tab hides whatever they open beside it, which is the one thing
        // the screen is there to show. Ask again rather than record a blind tape.
        s.getTracks().forEach(function (t) { t.stop(); });
        flag('setupflag', 'You shared ' + (settings.displaySurface === 'browser' ? 'a single tab'
          : 'a single window') + '. Share your entire screen instead, so whatever you open to '
          + 'teach or look something up is in the recording. Press the Screen button again and '
          + 'pick the whole screen.', true);
        return;
      }
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
    if (!state.camStream || !state.scrStream) return;
    $('ready').classList.remove('hidden');
    $('start').disabled = false;
  }

  function meter(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ac = new AC(), src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
      an.fftSize = 512; src.connect(an);
      var buf = new Uint8Array(an.frequencyBinCount), loud = 0;
      $('micStatus').textContent = 'Nothing heard yet.';
      $('micStatus').classList.remove('ok');
      state.level = setInterval(function () {
        an.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        $('lvl').style.width = Math.min(100, (peak / 60) * 100) + '%';
        // Three loud-ish frames in a row is speech, not a click on the desk.
        loud = peak > 10 ? loud + 1 : 0;
        if (loud >= 3 && !state.heard) {
          state.heard = true;
          $('micStatus').textContent = 'Microphone is picking you up.';
          $('micStatus').classList.add('ok');
        }
      }, 90);
    } catch (e) { /* the meter is a nicety, never a blocker */ }
  }

  // ---------------- the schedule ----------------
  // sched[i] = { w: when question i's read-and-work window ends, t: when its teaching window
  // ends }, both absolute milliseconds. Question i+1 starts the instant sched[i].t passes.
  function buildSchedule(from) {
    var out = [];
    for (var i = 0; i < state.questions.length; i++) {
      var w = from + i * Q_MS + WORK_S * 1000;
      out.push({ w: w, t: w + TEACH_S * 1000 });
    }
    return out;
  }
  function position(now) {
    for (var i = 0; i < state.sched.length; i++) {
      if (now < state.sched[i].w) return { at: i, phase: 'work' };
      if (now < state.sched[i].t) return { at: i, phase: 'teach' };
    }
    return { at: state.sched.length, phase: 'over' };
  }
  // Pull everything from question `at` onward earlier by `ms`. The only edits the schedule
  // ever takes are these, so a deadline can move earlier and never later.
  function pullEarlier(at, ms) {
    ms = Math.max(0, ms);      // a click that lands after the deadline passed shifts nothing
    for (var i = at; i < state.sched.length; i++) {
      state.sched[i].w -= ms;
      state.sched[i].t -= ms;
    }
    saveRecord(record());
  }

  // ---------------- rendering a question ----------------
  function render(q, idx) {
    var html = '<div class="qtag">Question ' + (idx + 1) + ' of ' + state.questions.length
      + '  ·  ' + esc(examLabel(q.level)) + '  ·  ' + esc(q.group) + '</div>'
      + '<div class="stem">' + esc(q.stem) + '</div><ol class="opts">';
    q.options.forEach(function (o) { html += '<li>' + esc(o) + '</li>'; });
    html += '</ol>';
    $('qbox').innerHTML = html;
    window.scrollTo(0, 0);
  }

  function paintPhase() {
    var last = state.at + 1 >= state.questions.length;
    var work = state.phase === 'work';
    $('bar').classList.toggle('teach', !work);
    $('ready2').classList.toggle('hidden', !work);
    $('next').classList.toggle('hidden', work);
    $('next').textContent = last ? 'Finish and send' : 'Next question';
    $('phaseNote').classList.toggle('teach', !work);
    if (work) {
      $('phaseNote').textContent = 'Read it and work it. You are recording, so think out loud if '
        + 'you like. Teaching time starts when the clock hits zero, or sooner if you press Start '
        + 'teaching now.';
    } else {
      $('phaseNote').textContent = 'Teach it, out loud, the way you would to a student who got it '
        + 'wrong and does not know why. ' + (last
          ? 'When the clock hits zero the recording ends and sends itself.'
          : 'When the clock hits zero the next question replaces this one.');
    }
  }

  function tick() {
    if (finishing || !state.sched.length) return;
    var now = Date.now();
    var pos = position(now);
    if (pos.phase === 'over') { finish(); return; }
    var changed = false;
    if (pos.at !== state.at) {
      state.at = pos.at;
      render(state.questions[state.at], state.at);
      changed = true;
    }
    if (pos.phase !== state.phase || changed) {
      state.phase = pos.phase;
      paintPhase();
      saveRecord(record());
    }
    var end = pos.phase === 'work' ? state.sched[pos.at].w : state.sched[pos.at].t;
    var left = (end - now) / 1000;
    $('clock').textContent = mmss(Math.ceil(left));
    $('bar').classList.toggle('last', left <= 30);
    $('cap').textContent = (pos.phase === 'work' ? 'to work it, then ' + spoken(TEACH_S) + ' to teach it'
                                                  : 'left to teach it')
      + '  ·  question ' + (pos.at + 1) + ' of ' + state.questions.length;
    var total = Math.floor((now - state.startedAt) / 1000);
    $('phase').textContent = 'Total ' + mmss(total) + ' of ' + mmss(CAP_S);
    if (now - lastStamp > 5000) { lastStamp = now; saveRecord(record()); }
  }
  var lastStamp = 0;

  // Both buttons re-read the wall clock rather than trusting state.phase, because the page
  // paints on a 250 ms tick and a click can land after a deadline passed but before the tick
  // noticed. Trusting the painted phase there would compute a negative shift.
  $('ready2').addEventListener('click', function () {
    var now = Date.now(), pos = position(now);
    if (pos.phase !== 'work' || pos.at !== state.at) { tick(); return; }
    // Giving up the rest of the reading window. The teaching window keeps its full length
    // and starts now, so everything after it moves earlier by exactly what they gave up.
    pullEarlier(pos.at, state.sched[pos.at].w - now);
    tick();
  });
  $('next').addEventListener('click', function () {
    var now = Date.now(), pos = position(now);
    if (pos.phase !== 'teach' || pos.at !== state.at) { tick(); return; }
    pullEarlier(pos.at, state.sched[pos.at].t - now);
    tick();
  });

  // ---------------- leaving the page ----------------
  // Lucas 2026-09-01, on candidates looking things up: "I'm not saying it's not okay to have
  // ChatGPT open or to Google something. I just kinda wanna know what's happening. How often
  // do they need to reference things? Are they able to do it quickly?" So the page does not
  // block anything. It writes down every time they leave it, during which question and which
  // window, and for how long, and that goes up with the recording and into the Slack thread.
  // The screen recording shows WHAT they opened. This is the index into it.
  var awayAt = 0, awayWhy = '';
  function leave(why) {
    if (!state.tick || awayAt) return;
    awayAt = Date.now(); awayWhy = why;
  }
  function back() {
    if (!awayAt) return;
    var now = Date.now(), from = awayAt;
    awayAt = 0;
    if (now - from < 1000) return;      // clicking the address bar blurs the window too
    noteAway(from, now, awayWhy);
  }
  function noteAway(from, to, why) {
    var pos = position(from);
    if (pos.phase === 'over') return;
    state.away.push({ q: pos.at + 1, p: pos.phase === 'work' ? 'w' : 't',
                      f: Math.round((from - state.startedAt) / 1000),
                      t: Math.round((to - state.startedAt) / 1000), y: why });
    if (state.away.length > 60) state.away = state.away.slice(-60);
    saveRecord(record());
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { leave('h'); return; }
    back();
    // A hidden tab gets its timers throttled, so the moment they come back the clock is
    // re-read from the wall rather than waiting for the next throttled tick.
    if (state.tick) tick();
  });
  window.addEventListener('blur', function () { leave('b'); });
  window.addEventListener('focus', function () { back(); });
  // The record is stamped the instant the page goes away, so a reload or a close is measured
  // from the real moment and lands on the right question. The five-second stamp in tick() is
  // the fallback for a crash, where nothing fires.
  window.addEventListener('pagehide', function () { if (state.tick && !finishing) saveRecord(record()); });

  // ---------------- the doc tools ----------------
  function keepSelection(btn, fn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', fn);
  }
  // Both toolbars, the practice one and the real one, are wired the same way. execCommand
  // acts on the live selection, so it does not care which card the selection is in.
  function all(sel) { return [].slice.call(document.querySelectorAll(sel)); }
  all('[data-tool=bold]').forEach(function (b) { keepSelection(b, function () { document.execCommand('bold'); }); });
  all('[data-tool=mark]').forEach(function (b) { keepSelection(b, function () {
    // styleWithCSS matters: without it some browsers emit <font> and the highlight is lost.
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
    document.execCommand('hiliteColor', false, HILITE);
  }); });
  all('[data-tool=clear]').forEach(function (b) { keepSelection(b, function () { document.execCommand('removeFormat'); }); });

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

  function setPen(on) {
    penOn = on;
    ink.classList.toggle('live', penOn);
    all('[data-tool=pen]').forEach(function (b) {
      b.classList.toggle('on', penOn);
      b.textContent = penOn ? 'Drawing, click to stop' : 'Draw on the screen';
    });
  }
  function eraseInk() { strokes = []; cur = null; redraw(); }
  all('[data-tool=pen]').forEach(function (b) { keepSelection(b, function () { setPen(!penOn); }); });
  all('[data-tool=erase]').forEach(function (b) { keepSelection(b, eraseInk); });
  all('.swatch').forEach(function (b) {
    keepSelection(b, function () {
      penColor = b.getAttribute('data-c');
      all('.swatch').forEach(function (o) {
        o.classList.toggle('on', o.getAttribute('data-c') === penColor);
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
    var b = bank() || { questions: [] };
    if (state.resuming) {
      // Same questions, same deadlines, whatever they did to the page in between.
      var byId = {};
      b.questions.forEach(function (q) { byId[q.id] = q; });
      state.questions = state.resuming.qids.map(function (id) { return byId[id]; }).filter(Boolean);
      state.sched = state.resuming.sched;
      state.picks = state.resuming.picks || state.picks;
      state.startedAt = state.resuming.started;
      state.reloads = state.resuming.reloads;
      state.name = state.resuming.name || state.name;
      state.email = state.resuming.email || state.email;
      state.away = state.resuming.away || [];
      if (state.resuming.seen) noteAway(state.resuming.seen, Date.now(), 'c');
      if (state.questions.length !== state.resuming.qids.length) {
        // The bank was rotated under them. Redraw from the seed rather than hand out a fresh
        // clock, and keep their original deadlines.
        state.questions = chooseQuestions();
      }
    } else {
      state.questions = chooseQuestions();
      if (!state.questions.length) { alert('No questions matched what you picked. Go back and pick again.'); return; }
      state.startedAt = Date.now();
      state.sched = buildSchedule(state.startedAt);
      state.reloads = 0;
    }
    saveRecord(record());
    // Read it straight back. A browser that is not keeping site data (a private window, or
    // site data blocked) would hand out a fresh clock on every reload, so it does not get to
    // start at all. Every normal browser window passes this.
    var back = loadRecord();
    if (!back || back.started !== state.startedAt) {
      flag('setupflag', 'This browser is not keeping site data, which usually means a private '
        + 'or incognito window. The clock cannot be trusted without it, so open the link from '
        + 'your email in a normal window and start again.', true);
      return;
    }

    if (!state.scrStream) {
      flag('setupflag', 'The screen is not being shared. Press the Screen button and share your '
        + 'entire screen.', true);
      return;
    }
    if (!state.heard && !confirm('The microphone has not picked anything up yet. Say a sentence '
        + 'and watch the bar under your camera move. Start anyway?')) return;
    var mic = state.camStream.getAudioTracks();
    var screenPlusVoice = new MediaStream(state.scrStream.getVideoTracks().concat(mic));
    startRecorder('screen', screenPlusVoice, 1200000);
    startRecorder('camera', state.camStream, 350000);

    state.at = -1; state.phase = '';
    show('record');
    tick();
    state.tick = setInterval(tick, 250);   // wall clock inside, never a tick count
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
    var r = record(); r.done = 'recorded'; saveRecord(r);
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
    var esc2 = function (v) { return String(v).replace(/([\\=|])/g, '\\$1'); };
    var picks = [];
    if (state.picks.l1) picks.push('Level 1 / Step 1');
    if (state.picks.l2all) picks.push('Level 2 / Step 2, all of it');
    if (state.picks.subs.length) picks.push(state.picks.subs.join(' and '));
    return ['name=' + esc2(state.name), 'email=' + esc2(state.email),
            'applicant=' + esc2(state.applicant || 'none'), 'role=' + role,
            'minutes=' + Math.round((Date.now() - state.startedAt) / 60000),
            'started=' + new Date(state.startedAt).toISOString(),
            'cap=' + CAP_S, 'reloads=' + state.reloads,
            'surface=' + (state.surface || 'unknown'),
            'away=' + state.away.length,
            'awaysec=' + state.away.reduce(function (n, a) { return n + (a.t - a.f); }, 0),
            'awaylog=' + esc2(state.away.map(function (a) {
              return 'q' + a.q + a.p + ' ' + a.f + '-' + a.t + ' ' + a.y;
            }).join(', ').slice(0, 900)),
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
      $('bar2').style.width = pct + '%';
      $('upPct').textContent = pct + '%';
    }
    var chain = Promise.resolve();
    state.blobs.forEach(function (item) {
      chain = chain.then(function () { return uploadOne(item, bytes); });
    });
    chain.then(function () {
      $('bar2').style.width = '100%'; $('upPct').textContent = '100%';
      var r = record(); r.done = 'sent'; saveRecord(r);
      show('done');
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

  // ---------------- coming back to a started attempt ----------------
  function closed(title, note) {
    $('againTitle').textContent = title;
    $('againNote').textContent = note;
    show('again');
  }
  (function resumeIfStarted() {
    if (!state.applicant) return;
    var r = loadRecord();
    if (!r || !r.sched || !r.sched.length) return;
    if (r.done === 'sent') {
      return closed('You already sent your teaching sample.',
        'It reached us and it is attached to your application. It is one take, so there is '
        + 'nothing more to do here. You will hear back either way.');
    }
    if (r.done === 'recorded') {
      return closed('Your recording did not finish sending.',
        'The page was closed while your recording was on its way, and the recording went with '
        + 'it. Reply to the email that sent you here and say what happened.');
    }
    var now = Date.now();
    var last = r.sched[r.sched.length - 1].t;
    if (now >= last) {
      r.done = 'expired'; saveRecord(r);
      return closed('Your time ran out.',
        'You started this at ' + new Date(r.started).toLocaleTimeString() + ' and the page was '
        + 'closed before anything was sent. The clock does not stop for that, so this attempt '
        + 'is over. Reply to the email that sent you here and say what happened.');
    }
    if (r.done === 'expired') {
      // Cannot happen with a sane clock, but a machine whose clock jumped backwards could
      // get here. Treat it as over rather than hand a window back.
      return closed('Your time ran out.',
        'This attempt is over. Reply to the email that sent you here and say what happened.');
    }
    r.reloads = (r.reloads || 0) + 1;
    saveRecord(r);
    state.resuming = r;
    state.reloads = r.reloads;
    state.sched = r.sched;
    // Describe where the clock is right now. It keeps moving while they read this.
    var pos = position(now);
    var end = pos.phase === 'work' ? r.sched[pos.at].w : r.sched[pos.at].t;
    $('resumeNote').textContent = 'You pressed Start at ' + new Date(r.started).toLocaleTimeString()
      + ' and this browser remembers it. You are on question ' + (pos.at + 1) + ' of '
      + r.qids.length + ', ' + (pos.phase === 'work' ? 'still in the reading window' : 'in the teaching window')
      + ', with this much left on it:';
    var rc = setInterval(function () {
      var n2 = Date.now(), p2 = position(n2);
      if (p2.phase === 'over') {
        clearInterval(rc);
        r.done = 'expired'; saveRecord(r);
        return closed('Your time ran out.', 'The clock reached the end while this page was open. '
          + 'Reply to the email that sent you here and say what happened.');
      }
      var e2 = p2.phase === 'work' ? r.sched[p2.at].w : r.sched[p2.at].t;
      $('resumeClock').textContent = mmss(Math.ceil((e2 - n2) / 1000));
    }, 250);
    $('resumeClock').textContent = mmss(Math.ceil((end - now) / 1000));
    $('resumeGo').addEventListener('click', function () {
      clearInterval(rc);
      if (position(Date.now()).phase === 'over') {
        r.done = 'expired'; saveRecord(r);
        return closed('Your time ran out.', 'The clock reached the end before you pressed Continue. '
          + 'Reply to the email that sent you here and say what happened.');
      }
      toSetup();
      flag('setupflag', 'Your clock is still running while you do this. Camera and microphone, '
        + 'then the screen, then Start.');
    });
    show('resume');
  })();
})();
