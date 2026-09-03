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
  var RAW_ENDPOINT = 'https://api.cloudinary.com/v1_1/' + CLOUD + '/raw/upload';
  var CHUNK = 6 * 1024 * 1024;
  // Two questions for each thing they tick. Lucas 2026-09-01 night: "let's make it two
  // questions for each thing they want to tutor if we have that many questions available. eg.
  // if they pick level 1 and level 2 they get 4 questions total, two from level 1 and two from
  // level 2, same timing."
  var PER_PICK = 2;
  var HILITE = '#FFF08A';
  // The AI student. One hosted function holds the answer key and the model key, because this
  // page is static and must never hold either. The browser sends a question id, the stem and
  // choices it is showing, and what the candidate said. Nothing comes back but the student's
  // words. There is no key in this file, and deploy.sh refuses to ship one.
  var STUDENT_URL = 'https://ztmogkvswdrinseajzdw.supabase.co/functions/v1/teachback-student';

  // 90 seconds is the pace of the exam itself (COMLEX Level 1 gives about 82 seconds an item,
  // Step 1 about 90). Eight minutes to teach is Lucas's ruling of 2026-09-01 late night, made
  // for the student: "up to 8 minutes for each question if we get more prompting with the
  // socratic thing." It was five before the student existed. Two questions come to nineteen
  // minutes. Change these two lines and nothing else, every number on the page follows.
  var WORK_S = 90;
  var TEACH_S = 480;

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
  var PICK_S = PER_PICK * (WORK_S + TEACH_S);      // what one tick costs them in seconds
  function capS() { return state.questions.length * (WORK_S + TEACH_S); }

  var state = {
    applicant: params.get('a') || '',
    name: params.get('n') || '',
    email: params.get('e') || '',
    camStream: null, scrStream: null,
    recs: [], seg: null,
    startedAt: 0, tick: null, level: null,
    bank: null, questions: [], at: -1, phase: '', heard: false,
    sched: [], reloads: 0, resuming: null,
    away: [], surface: '', chat: [],
    picks: { l1: false, l2all: false, subs: [], omm: false, bio: false }
  };

  var EXAM = { 'Level 1': 'COMLEX Level 1 / USMLE Step 1', 'Level 2': 'COMLEX Level 2 / USMLE Step 2',
               'OMM': 'OMM, every COMLEX level', 'Biostats': 'Biostats and epidemiology, every exam' };
  function examLabel(level) { return EXAM[level] || level; }

  // ---------------- screens ----------------
  function show(which) {
    ['gate', 'resume', 'again', 'pick', 'practice', 'setup', 'record', 'upload', 'done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== which);
    });
    document.body.classList.toggle('recording', which === 'record');
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
             name: state.name, email: state.email, away: state.away, chat: state.chat,
             seen: Date.now() };
  }

  // ---------------- gate ----------------
  $('tWork').textContent = spoken(WORK_S);
  $('tTeach').textContent = spoken(TEACH_S);
  $('tTotal').textContent = Math.ceil(PICK_S / 60) + ' minutes';
  $('tTotal2').textContent = Math.ceil(2 * PICK_S / 60) + ' minutes';
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
    state.picks.omm = $('c3').checked;
    state.picks.bio = $('c4').checked;
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
    var n = pool.count;
    $('pickSummary').textContent = n
      ? n + ' question' + (n === 1 ? '' : 's') + ', about ' + Math.ceil(n * (WORK_S + TEACH_S) / 60)
        + ' minutes, drawn from ' + pool.total
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
    var omm = state.picks.omm
      ? b.questions.filter(function (q) { return q.level === 'OMM'; }) : [];
    var bio = state.picks.bio
      ? b.questions.filter(function (q) { return q.level === 'Biostats'; }) : [];
    // One list per tick, in the order the questions will come. A tick with fewer questions
    // than PER_PICK gives what it has, which is Lucas's "if we have that many available".
    var lists = [l1, l2, omm, bio].filter(function (l) { return l.length; });
    var count = lists.reduce(function (n, l) { return n + Math.min(PER_PICK, l.length); }, 0);
    return { l1: l1, l2: l2, omm: omm, bio: bio, lists: lists, count: count,
             total: l1.length + l2.length + omm.length + bio.length };
  }

  $('toSetup').addEventListener('click', function () {
    var pool = poolFor();
    if (!pool.total) {
      return flag('pickflag', 'Pick at least one. If you do not want all of Level 2 / Step 2, '
        + 'tick the shelf subjects you are comfortable with instead.');
    }
    show('practice');
  });
  // The practice screen is off the clock and unrecorded. Lucas 2026-09-01: "a quick tutorial
  // would help with a fake question they could practice highlighting, bolding, drawing,
  // whatever else they have, and then a screen to confirm their mic and camera are working."
  $('toSetup2').addEventListener('click', function () {
    setPen(false);
    eraseInk();
    pStudent.stop();
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
    // PER_PICK from each thing they ticked, in a fixed order (Level 1, Level 2, OMM,
    // Biostats), and fewer only when a pool is smaller than that.
    pool.lists.forEach(function (list) {
      for (var i = 0; i < PER_PICK && i < list.length; i++) {
        var q = drawFrom(list, used);
        if (!q) break;
        out.push(q); used.push(q.id);
      }
    });
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
      $('askCam').classList.add('done');
      $('askScreen').disabled = false;
      $('askScreen').classList.remove('ghost');
      stepNote(2);
      meter(s);
      unflag('setupflag');
    }).catch(function (err) { flag('setupflag', permMessage(err, 'camera and microphone'), true); });
  });

  // The screen is captured no wider than 1600 px. Lucas's own run captured his Retina screen
  // at 2880 by 1800, and the encoder spent its whole bitrate on pixels nobody needs: a page of
  // text reads fine at 1600 wide. A browser that cannot scale is asked again without the cap.
  function askDisplay(capped) {
    var video = { displaySurface: 'monitor', frameRate: { ideal: 15, max: 20 } };
    if (capped) { video.width = { max: 1600 }; video.height = { max: 1000 }; }
    return navigator.mediaDevices.getDisplayMedia({ video: video, audio: false }).catch(function (err) {
      if (capped && err && err.name === 'OverconstrainedError') return askDisplay(false);
      throw err;
    });
  }
  $('askScreen').addEventListener('click', function () {
    // displaySurface is a hint to open the picker on the whole-screen pane. Browsers that
    // honour it help, browsers that ignore it are checked after the fact below.
    askDisplay(true).then(function (s) {
      var track = s.getVideoTracks()[0];
      // Text, not motion: the encoder keeps letters sharp and drops frames instead.
      try { if (track) track.contentHint = 'text'; } catch (e) {}
      var settings = (track && track.getSettings) ? (track.getSettings() || {}) : {};
      state.surface = settings.displaySurface || 'unknown';
      if (settings.displaySurface && settings.displaySurface !== 'monitor') {
        // A single window or tab hides whatever they open beside it, which is the one thing
        // the screen is there to show. Ask again rather than record a blind tape.
        s.getTracks().forEach(function (t) { t.stop(); });
        flag('setupflag', 'You shared ' + (settings.displaySurface === 'browser' ? 'a single tab'
          : 'a single window') + '. Share your entire screen instead, so whatever you open to '
          + 'teach or look something up is in the recording. Press Share your whole screen '
          + 'again and pick the whole screen.', true);
        return;
      }
      state.scrStream = s;
      $('pvScr').srcObject = s;
      $('askScreen').textContent = 'Screen is being shared';
      $('askScreen').disabled = true;
      $('askScreen').classList.add('done');
      stepNote(3);
      s.getVideoTracks()[0].addEventListener('ended', function () {
        // They stopped sharing. The attempt ends and whatever is on tape goes up.
        if (state.tick && !finishing) finish();
      });
      unflag('setupflag');
      readyCheck();
    }).catch(function (err) { flag('setupflag', permMessage(err, 'screen'), true); });
  });

  // Which computer this is, because the fix for a blocked screen is a different path on each.
  // A Mac gates screen sharing at the operating system, so the browser never asks the person
  // at all until it is switched on there and reopened. Windows has no such gate for the screen.
  var OS = (function () {
    var p = String(navigator.platform || ''), ua = String(navigator.userAgent || '');
    if (/Mac/.test(p) || /Macintosh/.test(ua)) return 'mac';
    if (/Win/.test(p) || /Windows/.test(ua)) return 'win';
    return 'other';
  })();
  var MAC_SCREEN = 'System Settings, Privacy & Security, Screen Recording (called Screen & System '
    + 'Audio Recording on newer Macs)';
  function stepNote(n) {
    var el = $('stepnote');
    if (n >= 3) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = n === 1
      ? '<b>Step 1 of 2.</b> Press the first button and allow the camera and microphone when the browser asks.'
      : '<b>Step 2 of 2.</b> Press <b>Share your whole screen</b>. The browser opens a picker: choose the '
        + 'whole screen, not a window or a tab.';
  }
  (function osNote() {
    var el = $('osnote');
    if (OS === 'mac') el.innerHTML = 'Your Mac may ask as well as the browser. The first time a browser '
      + 'shares the screen, macOS sends you to ' + MAC_SCREEN + ' to switch the browser on, and the '
      + 'browser then has to be quit and opened again. Do that before you press Start.';
    else if (OS === 'win') el.innerHTML = 'Windows asks nothing extra for the screen. If the camera or '
      + 'microphone never asks, open Settings, Privacy & security, then Camera and Microphone, and '
      + 'allow apps and desktop apps to use them.';
    else return;
    el.classList.remove('hidden');
  })();

  function permMessage(err, what) {
    var n = err && err.name;
    if (n === 'NotAllowedError') {
      var base = 'You cancelled the ' + what + ' request, or the browser blocked it. Press the button '
        + 'again and allow it. If the browser never asks, ';
      if (what === 'screen') {
        if (OS === 'mac') return base + 'your Mac is blocking it: open ' + MAC_SCREEN + ', switch this '
          + 'browser on, quit the browser completely, then open your link again.';
        if (OS === 'win') return base + 'press the button again and choose the whole screen in the '
          + 'window that opens. Windows has no setting to change for this.';
        return base + 'check the site permissions in the browser settings and reload.';
      }
      if (OS === 'mac') return base + 'open System Settings, Privacy & Security, then Camera and '
        + 'Microphone, switch this browser on, and reload.';
      if (OS === 'win') return base + 'open Settings, Privacy & security, then Camera and Microphone, '
        + 'allow apps and desktop apps to use them, and reload.';
      return base + 'check the site permissions in the browser settings and reload.';
    }
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
  // A stem's lab values come as a table: lines that start with "|" are its rows, one per
  // line, the way the bank writes them (bank/restore_tables.py). Everything else is prose.
  // They used to be one run-on line, "Test Patient's Value Reference Range Synovial fluid
  // WBC 96,000/mm³ <200/mm³ ..." (Lucas, 2026-09-02, on his own test run).
  function stemHtml(stem) {
    var html = '', rows = [];
    function flush() {
      if (!rows.length) return;
      // "Test | Patient's Value | Reference Range" is a header row. "Temperature | 37.1°C" is
      // data from the first row, and a row with a number in it is never a header.
      var head = !/\d/.test(rows[0].join(' '));
      html += '<table class="labs">';
      rows.forEach(function (r, i) {
        var tag = head && i === 0 ? 'th' : 'td';
        html += '<tr>' + r.map(function (c) { return '<' + tag + '>' + esc(c) + '</' + tag + '>'; }).join('') + '</tr>';
      });
      html += '</table>';
      rows = [];
    }
    String(stem).split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (line.charAt(0) === '|') {
        rows.push(line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }));
      } else {
        flush();
        html += '<p>' + esc(line) + '</p>';
      }
    });
    flush();
    return html;
  }
  function render(q, idx) {
    var html = '<div class="qtag">Question ' + (idx + 1) + ' of ' + state.questions.length
      + '  ·  ' + esc(examLabel(q.level)) + '  ·  ' + esc(q.group) + '</div>'
      + '<div class="stem">' + stemHtml(q.stem) + '</div><ol class="opts">';
    q.options.forEach(function (o) { html += '<li>' + XO + esc(o) + '</li>'; });
    html += '</ol>';
    $('qbox').innerHTML = html;
    // A new question is a clean page (Lucas, 2026-09-02: "moving on to the next question
    // should clear the drawings"). The notes box goes with it: they were about the last one.
    eraseInk();
    $('scratch').innerHTML = '';
    window.scrollTo(0, 0);
  }

  // The toolbar sticks to the bottom edge of the bar, and the student panel under the
  // toolbar. The bar's height is measured, not assumed, so nothing drifts apart or overlaps
  // when its copy wraps (Lucas, 2026-09-02: page text showed through the gap between them).
  (function () {
    var bar = $('bar');
    function set() {
      if (bar.offsetHeight) document.documentElement.style.setProperty('--barh', bar.offsetHeight + 'px');
    }
    if (window.ResizeObserver) new ResizeObserver(set).observe(bar);
    window.addEventListener('resize', set);
    set();
  })();

  function paintPhase() {
    var last = state.at + 1 >= state.questions.length;
    var work = state.phase === 'work';
    $('bar').classList.toggle('teach', !work);
    $('ready2').classList.toggle('hidden', !work);
    $('next').classList.toggle('hidden', work);
    disarm($('next'));
    $('next').textContent = last ? 'Finish and send' : 'Next question';
    // One button on the bar at a time (Lucas, 2026-09-02: two side by side and a candidate
    // cannot know which one to press). On the last question it is the red one, since it ends
    // the attempt.
    $('next').classList.toggle('stop', last);
    $('next').classList.toggle('ghost', !last);
    $('phaseNote').classList.toggle('teach', !work);
    if (work) {
      $('phaseNote').textContent = 'Read it and work it. Teaching starts when the clock hits zero.';
      student.stop();
    } else {
      $('phaseNote').textContent = 'Teach it out loud. Your student got it wrong. Ask them what they '
        + 'picked and why.';
      student.begin(state.questions[state.at], state.at + 1, state.startedAt);
    }
  }

  function tick() {
    if (finishing || !state.sched.length) return;
    var now = Date.now();
    var pos = position(now);
    if (pos.phase === 'over' || !state.questions[pos.at]) { finish(); return; }
    var changed = false;
    if (pos.at !== state.at) {
      // The question that just ended goes up now, in the background, and the new one starts
      // its own tapes. The recorders overlap for a moment, which is allowed.
      if (state.at >= 0) endSegment(null);
      state.at = pos.at;
      render(state.questions[state.at], state.at);
      startSegment(state.at);
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
    $('phase').textContent = 'Total ' + mmss(total) + ' of ' + mmss(capS());
    paintUpstat();
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
  // A stray press must not end a question or the attempt, but a confirm() dialog is not the
  // guard: it freezes the page's scripts while it is open, so the tick that enforces the clock
  // stops with it and the tape keeps rolling past the deadline (independent review,
  // 2026-09-02). So the button arms itself on the first press and acts on the second within
  // five seconds, and nothing ever blocks. A phase change disarms it.
  function arm(btn, label) {
    if (btn.dataset.armed === '1') { disarm(btn); return true; }
    btn.dataset.armed = '1'; btn.dataset.label = btn.textContent; btn.textContent = label;
    btn.classList.add('armed');
    clearTimeout(btn._armT); btn._armT = setTimeout(function () { disarm(btn); }, 5000);
    return false;
  }
  function disarm(btn) {
    clearTimeout(btn._armT);
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = ''; btn.classList.remove('armed');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
  $('next').addEventListener('click', function () {
    var last = state.at + 1 >= state.questions.length;
    if (!arm($('next'), last ? 'Press again to finish and send' : 'Press again to move on')) return;
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
  // A press you can see (Lucas, 2026-09-02: "there's no confirmation that i've clicked those
  // buttons"). The text tools act on the selection, so with nothing selected they used to do
  // nothing and say nothing. Now a press flashes the button, and a press with nothing selected
  // says what to do, in a hint under the toolbar that never changes the toolbar's height.
  function hint(btn, msg) {
    var bar = btn.closest ? btn.closest('[data-tools]') : null;
    var el = bar && bar.querySelector('[data-hint]');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(el._t); el._t = setTimeout(function () { el.textContent = ''; }, 2600);
  }
  function flash(btn) {
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 350);
  }
  function selectionTool(sel, name, fn) {
    all(sel).forEach(function (b) { keepSelection(b, function () {
      var s = window.getSelection();
      if (!s || s.isCollapsed) { hint(b, 'Select some words first, then press ' + name + '.'); return; }
      fn(); flash(b);
    }); });
  }
  selectionTool('[data-tool=bold]', 'B', function () { document.execCommand('bold'); });
  selectionTool('[data-tool=mark]', 'Highlight', function () {
    // styleWithCSS matters: without it some browsers emit <font> and the highlight is lost.
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
    document.execCommand('hiliteColor', false, HILITE);
  });
  // Strike, Lucas 2026-09-01 night: "i would also like a strikethrough feature for stem text
  // and answer choices." Two ways in: select anything and press Strike, or click the small
  // cross beside an answer choice to cross the whole choice out, the way the exam software
  // does it. The cross is not editable, so typing in the question never eats it.
  selectionTool('[data-tool=strike]', 'Strike', function () { document.execCommand('strikeThrough'); });
  selectionTool('[data-tool=clear]', 'Clear', function () { document.execCommand('removeFormat'); });
  var XO = '<span class="xo" contenteditable="false" title="Cross this choice out">\u2715</span>';
  // There is no Lock in pill any more. It went in on 2026-09-02 afternoon and out that night:
  // "get rid of the lock in... it doesn't matter anyway if they actually pick an answer or
  // not, because we're not grading them." Nothing about their answer rides up with the tapes.
  document.addEventListener('mousedown', function (e) {
    var c = e.target.classList;
    if (c && c.contains('xo')) e.preventDefault();
  });
  document.addEventListener('click', function (e) {
    var x = e.target;
    if (!x.classList || !x.classList.contains('xo')) return;
    e.preventDefault();
    x.parentNode.classList.toggle('struck');
  });

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
      b.textContent = penOn ? 'Stop drawing' : 'Draw anywhere';
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
  // The whiteboard under the question draws without the pen being switched on. Lucas,
  // 2026-09-02: he did not know he could draw anywhere, "maybe give them a little whiteboard
  // underneath the question, so it's a little more obvious that they can draw and they have a
  // dedicated space for it." Same strokes, same canvas, same colours. When the pen IS on the
  // canvas sits over the board and takes the events itself, so nothing draws twice.
  all('[data-board]').forEach(function (board) {
    board.addEventListener('pointerdown', function (e) {
      if (penOn || e.button) return;
      e.preventDefault();
      try { board.setPointerCapture(e.pointerId); } catch (x) {}
      cur = { c: penColor, pts: [{ x: e.clientX, y: e.clientY + window.scrollY }] };
      redraw();
    });
    board.addEventListener('pointermove', function (e) {
      if (!cur || penOn) return;
      cur.pts.push({ x: e.clientX, y: e.clientY + window.scrollY });
      redraw();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      board.addEventListener(ev, function () {
        if (cur && !penOn) { strokes.push(cur); cur = null; redraw(); }
      });
    });
  });

  // ---------------- the student ----------------
  // Lucas 2026-09-01 late night, his go on the browser-voice student. What he is after, in
  // his words: "identify good tutors who ask questions like 'how did you get that answer?'
  // 'tell me about...' etc instead of just lecturing the whole time and video interviews are
  // really just lectures in disguise." So during the teach window a second-year student who
  // has already picked the wrong answer is on the page. The browser transcribes the candidate
  // (Web Speech API: Chrome, Edge and Safari), each stretch of speech goes to the function,
  // and the reply comes back into a bubble and out loud through speechSynthesis. The student
  // stays silent while being lectured: only a question or an instruction aimed at them gets
  // an answer, and the function says which it was, so the bot can count the questions. A text
  // box is the way in when the browser has no speech recognition (Firefox). He rejected fixed
  // prompts, a scripted objection, and typing as the main path.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var TTS = window.speechSynthesis || null;

  // One wiring for both panels, the practice one and the real one, the way the toolbars are.
  // `turns()` returns the array this panel writes into: state.chat for the real student, a
  // throwaway for practice, so nothing from practice ever reaches the transcript.
  function makeStudent(root, turns) {
    var log = root.querySelector('[data-st-log]'), stateEl = root.querySelector('[data-st-state]');
    var note = root.querySelector('[data-st-note]'), typeWrap = root.querySelector('[data-st-type]');
    var input = root.querySelector('[data-st-input]'), send = root.querySelector('[data-st-send]');
    var q = null, num = 0, t0 = 0, on = false, gen = 0;
    var rec = null, wantListen = false, speaking = false, typedOnly = !SR;
    var queue = [], busy = false;
    // Nothing goes to the student until the tutor has been quiet this long. Chrome hands over
    // a "final" stretch at every one-second pause, so on Lucas's own run (2026-09-02) "something
    // I think is important would be the scratching" and "and the high pitched sound" went up
    // two seconds apart as two turns, the student answered the friction rub twice, and it
    // talked over him mid-sentence. His words: "it needs to give a little more time for people
    // that speak slower like me." Fragments now merge until the pause is real.
    var QUIET_MS = 2500;
    var pending = '', lastVoice = 0, quietT = null;

    function setState(s, cls) { stateEl.textContent = s; stateEl.className = 'st-state ' + (cls || ''); }
    function bubble(who, text) {
      var d = document.createElement('div');
      d.className = who === 'you' ? 'st-you' : 'st-them';
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    function mine() { return turns().filter(function (t) { return q && t.q === q.id; }); }
    function push(who, text, extra) {
      var t = { t: Math.round((Date.now() - t0) / 1000), q: q.id, n: num, who: who, text: text };
      if (extra) for (var k in extra) t[k] = extra[k];
      turns().push(t);
      if (state.tick) saveRecord(record());
      return t;
    }
    function call(body) {
      body.a = state.applicant || 'none'; body.q = q.id; body.stem = q.stem; body.options = q.options;
      // The student's knowledge was fixed on its opening turn (knows and gaps, written by the
      // function) and goes back with every call, so what it does not know stays not known
      // however many times it is asked (Lucas, 2026-09-02 night: "clearly, it knows. You just
      // have to keep prompting it"). It lives on the opening turn, so a reload keeps it.
      var op = mine().filter(function (t) { return t.opening; })[0];
      if (op && op.knows) { body.knows = op.knows; body.gaps = op.gaps || []; }
      return fetch(STUDENT_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
                                  body: JSON.stringify(body) })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
    }
    function typedMode(why) {
      typedOnly = true;
      dropRec();
      typeWrap.classList.remove('hidden');
      setState('type below', 'typed');
      if (why) note.textContent = why;
    }

    // ---- hearing the candidate ----
    function startListening() {
      wantListen = true;
      if (typedOnly) { typeWrap.classList.remove('hidden'); if (!busy) setState('type below', 'typed'); return; }
      if (rec || speaking) return;
      try {
        var r = new SR();
        // Interim results are how the page knows the tutor is still talking: every one of
        // them, final or not, pushes the quiet timer back.
        r.continuous = true; r.interimResults = true; r.lang = 'en-US';
        r.onresult = function (ev) {
          lastVoice = Date.now();
          for (var i = ev.resultIndex; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) {
              var text = (ev.results[i][0].transcript || '').trim();
              if (text) pending = (pending ? pending + ' ' : '') + text;
            }
          }
        };
        r.onerror = function (ev) {
          var e = ev && ev.error;
          if (e === 'not-allowed' || e === 'service-not-allowed' || e === 'audio-capture') {
            typedMode('This browser is not letting the page hear you (' + e + '), so type to the '
              + 'student instead. The recording is still running.');
          }
          // no-speech, network and aborted all end the recognizer, and onend starts it again.
        };
        r.onend = function () {
          if (rec === r) rec = null;
          // Chrome stops after a stretch of silence. While the window is open, start again.
          if (wantListen && !speaking && !typedOnly) {
            setTimeout(function () { if (wantListen && !rec && !speaking) startListening(); }, 250);
          }
        };
        rec = r;
        r.start();
        if (!busy) setState('listening', 'live');
      } catch (e) {
        rec = null;
        typedMode('Speech recognition would not start here, so type to the student instead.');
      }
    }
    function dropRec() {
      if (!rec) return;
      var r = rec; rec = null;
      r.onend = null; r.onresult = null; r.onerror = null;
      try { r.abort(); } catch (e) {}
    }
    function stopListening() { wantListen = false; dropRec(); }

    // ---- the student talking ----
    function pickVoice() {
      if (!TTS) return null;
      var vs = TTS.getVoices() || [];
      var en = vs.filter(function (v) { return /^en[-_]/i.test(v.lang); });
      var pref = en.filter(function (v) { return /Samantha|Google US English|Aria|Jenny|Karen|Moira|Zira/i.test(v.name); });
      return pref[0] || en[0] || null;
    }
    var guard = null;
    function speak(text, done) {
      if (!TTS || !window.SpeechSynthesisUtterance) { done(); return; }
      // The microphone would hear the student's own voice through the speakers, so recognition
      // is off while the student talks and back on the moment they stop.
      speaking = true; dropRec();
      setState('speaking', 'talk');
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02; u.pitch = 1.0; u.lang = 'en-US';
      var voice = pickVoice(); if (voice) u.voice = voice;
      var finished = false, g = gen;
      // An utterance from a question that has since ended must not touch the mic state of
      // the one now running (cancel() does not always fire onend, so the guard could outlive it).
      function end() {
        if (finished) return;
        finished = true; clearTimeout(guard); guard = null;
        if (g === gen) speaking = false;
        done();
      }
      u.onend = end; u.onerror = end;
      // Headless browsers and some desktops never fire onend. Never let that hold the mic.
      guard = setTimeout(end, Math.max(3000, text.length * 90));
      try { TTS.cancel(); TTS.speak(u); } catch (e) { end(); }
    }

    // ---- a stretch of the candidate's speech ----
    function quiet() { return typedOnly || !lastVoice || Date.now() - lastVoice >= QUIET_MS; }
    // Runs four times a second while the window is open. A finished stretch waits here until
    // the tutor has been quiet long enough, then goes to the student as one piece.
    function checkQuiet() {
      if (!on) return;
      if (pending && quiet()) { var t = pending; pending = ''; heard(t, false); }
      if (queue.length && !busy && quiet()) pump();
    }
    function heard(text, typed) {
      if (!on) return;
      bubble('you', text);
      var t = push('you', text, { typed: !!typed });
      queue.push({ turn: t, text: text });
      if (typed) pump();
    }
    // The student saying the same thing twice, which Lucas heard on the practice question
    // ("transferrin is basically TIBC", twice over). If the new line is mostly the words of the
    // last one, it stays unsaid.
    function words(t) {
      var seen = {}, out = [];
      String(t).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).forEach(function (w) {
        if (w && !seen[w]) { seen[w] = 1; out.push(w); }
      });
      return out;
    }
    function letters(t) { return (String(t).match(/\b[A-Ea-e](?=[\s?.,!]|$)/g) || []).join('').toUpperCase(); }
    function sameAsLast(text) {
      var prev = mine().filter(function (t) { return t.who === 'student'; }).pop();
      if (!prev) return false;
      var a = words(prev.text), b = words(text), common = 0;
      if (a.length < 4 || b.length < 4) return false;
      // A line that names a different answer letter is a new thought, however similar the rest.
      if (letters(prev.text) !== letters(text)) return false;
      b.forEach(function (w) { if (a.indexOf(w) >= 0) common++; });
      return common / Math.max(a.length, b.length) >= 0.72;
    }
    function pump() {
      if (busy || !queue.length || !on) return;
      busy = true;
      var g = gen;
      // Everything said while the last answer was in flight goes up as one stretch.
      var items = queue.splice(0, queue.length);
      var seg = items.map(function (i) { return i.text; }).join(' ');
      // The function keeps the first 1500 characters, and a tutor who talked for minutes
      // before pausing asked their question at the END of that. Send the tail.
      if (seg.length > 1400) seg = seg.slice(-1400);
      var hist = mine().map(function (t) { return { who: t.who, text: t.text }; });
      hist = hist.slice(0, Math.max(0, hist.length - items.length)).slice(-40);
      var sentAt = Date.now();
      setState('thinking', 'busy');
      call({ seg: seg, history: hist }).then(function (r) {
        if (g !== gen) return;
        // The tutor went on talking while this was in flight, so it answers half a thought.
        // Drop it, put the stretch back, and the whole thought goes up at the next real pause.
        if (!typedOnly && (queue.length || pending || (lastVoice > sentAt && !quiet()))) {
          queue = items.concat(queue);
          return;
        }
        items.forEach(function (i) { i.turn.asked = !!r.asked; i.turn.addressed = !!r.addressed; });
        if (state.tick) saveRecord(record());
        if (r.reply && !sameAsLast(r.reply)) {
          bubble('student', r.reply);
          push('student', r.reply);
          return new Promise(function (res) { speak(r.reply, res); });
        }
      }).catch(function (e) {
        if (g !== gen) return;
        note.textContent = 'The student did not catch that (' + String(e.message || e).slice(0, 60)
          + '). Keep going, the recording is running.';
      }).then(function () {
        if (g !== gen) return;
        busy = false;
        if (typedOnly) setState('type below', 'typed');
        else if (wantListen) { setState('listening', 'live'); startListening(); }
        if (queue.length && quiet()) pump();      // otherwise checkQuiet sends it at the pause
      });
    }

    // ---- the window opening and closing ----
    function begin(question, n, startedAt) {
      if (!question) return;
      if (on && q && q.id === question.id) return;      // same question, already running
      stop();
      gen += 1;
      var g = gen;
      q = question; num = n; t0 = startedAt || Date.now(); on = true;
      pending = ''; lastVoice = 0;
      clearInterval(quietT); quietT = setInterval(checkQuiet, 250);
      log.innerHTML = ''; note.textContent = '';
      root.classList.remove('hidden');
      typeWrap.classList.toggle('hidden', !typedOnly);
      var prior = mine();
      if (prior.length) {
        // Back after a reload in the middle of teaching: the exchange so far comes back and
        // the student does not introduce themselves twice.
        prior.forEach(function (t) { bubble(t.who, t.text); });
        startListening();
        return;
      }
      busy = true;
      setState('joining', 'busy');
      call({ start: true }).then(function (r) {
        if (g !== gen) return;
        bubble('student', r.reply);
        // pick is the wrong letter the student committed to, checked server side, kept in the
        // transcript so whoever reviews the tape can see what the tutor had to work from.
        push('student', r.reply, { opening: true, pick: r.pick || '', knows: r.knows || [], gaps: r.gaps || [] });
        return new Promise(function (res) { speak(r.reply, res); });
      }).catch(function (e) {
        if (g !== gen) return;
        note.textContent = 'The student could not join (' + String(e.message || e).slice(0, 60)
          + '). Teach anyway, the recording is running, and try talking to them in a moment.';
      }).then(function () {
        if (g !== gen) return;
        busy = false;
        startListening();
        if (queue.length) pump();
      });
    }
    function stop() {
      gen += 1;
      // A stretch that was still waiting for its quiet window is theirs all the same: it goes
      // into the transcript, unsent and unjudged, rather than vanishing (independent review).
      if (on && q && pending) { bubble('you', pending); push('you', pending, { typed: false, unsent: true }); }
      on = false; q = null; queue = []; busy = false;
      pending = ''; clearInterval(quietT); quietT = null;
      stopListening();
      if (guard) { clearTimeout(guard); guard = null; }
      if (TTS) { try { TTS.cancel(); } catch (e) {} }
      speaking = false;
      root.classList.add('hidden');
    }

    send.addEventListener('click', function () {
      var v = input.value.trim();
      if (!v || !on) return;
      input.value = '';
      heard(v, true);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send.click(); }
    });

    return { begin: begin, stop: stop };
  }

  var practiceTurns = [];
  var pStudent = makeStudent($('pstudent'), function () { return practiceTurns; });
  var student = makeStudent($('student'), function () { return state.chat; });

  // The practice student, on the practice question, so they can try talking to one before
  // anything records. The function holds that question's answer beside the bank's, and it is
  // never scored: its turns go into a throwaway array, not the transcript.
  $('pTalk').addEventListener('click', function () {
    var box = $('pqbox');
    var stem = box.querySelector('.stem').textContent.replace(/\s+/g, ' ').trim();
    var options = [].map.call(box.querySelectorAll('ol.opts li'), function (li) {
      // The cross is inside the choice. Read the choice without it.
      var c = li.cloneNode(true);
      [].forEach.call(c.querySelectorAll('.xo'), function (x) { x.parentNode.removeChild(x); });
      return c.textContent.replace(/\s+/g, ' ').trim();
    });
    practiceTurns.length = 0;
    pStudent.begin({ id: 'practice', stem: stem, options: options }, 0, Date.now());
    $('pTalk').textContent = 'The student is here. Talk to them.';
    $('pTalk').disabled = true;
  });

  // ---------------- recording ----------------
  function pickMime(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // One file per question per camera, not one file for the whole attempt. Lucas's own run on
  // 2026-09-02: six minutes made a 60 MB screen file, so four full questions would pass 400 MB,
  // and this Cloudinary plan refuses any video over 100 MB. And a page closed early used to
  // lose everything. Now each question's tapes go up the moment it ends, in the background,
  // while the next one runs. The biggest possible file is one 9.5 minute question at the
  // screen bitrate below, about 80 MB with the voice track.
  var SCREEN_BPS = 1000000, CAMERA_BPS = 300000;

  function startRecorder(key, stream, videoBps) {
    var mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
                         'video/webm', 'video/mp4']);
    var opts = { audioBitsPerSecond: 96000, videoBitsPerSecond: videoBps };
    if (mime) opts.mimeType = mime;
    var rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch (e) { rec = new MediaRecorder(stream); }
    // The parts live on the recorder, not in a shared slot: the next question's recorder for
    // the same camera starts before this one has flushed its last chunk.
    rec.__parts = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) rec.__parts.push(ev.data); };
    rec.__key = key;
    rec.__mime = rec.mimeType || mime || 'video/webm';
    rec.start(4000);
    state.recs.push(rec);
    return rec;
  }
  function startSegment(at) {
    if (!state.scrStream || !state.camStream || !state.questions[at]) return;
    var mic = state.camStream.getAudioTracks();
    var screenPlusVoice = new MediaStream(state.scrStream.getVideoTracks().concat(mic));
    state.seg = { at: at, qid: state.questions[at].id, t0: Date.now() };
    startRecorder('screen', screenPlusVoice, SCREEN_BPS);
    startRecorder('camera', state.camStream, CAMERA_BPS);
  }
  // Stop the running tapes, hand each one to the sender with the question's transcript, then
  // call done. The next question's recorders may already be running on the same streams.
  var flushing = 0;      // recorders stopped but not yet handed to the sender
  function endSegment(done) {
    var recs = state.recs, seg = state.seg;
    state.recs = []; state.seg = null;
    if (!recs.length || !seg) { if (done) done(); return; }
    var pending = recs.length;
    flushing += pending;
    var minutes = Math.max(1, Math.round((Date.now() - seg.t0) / 60000));
    recs.forEach(function (rec) {
      var collected = false;
      function collect() {
        if (collected) return;
        collected = true;
        flushing -= 1;
        if (rec.__parts.length) {
          enqueue({ role: rec.__key, q: seg.at, qid: seg.qid, minutes: minutes,
                    blob: new Blob(rec.__parts, { type: rec.__mime }) });
        }
        rec.__parts = [];
        if (--pending === 0) {
          enqueue({ role: 'transcript', q: seg.at, qid: seg.qid, minutes: minutes,
                    blob: new Blob([JSON.stringify(transcript(seg.at, seg.qid))], { type: 'application/json' }) });
          if (done) done();
        }
      }
      rec.onstop = collect;
      try { rec.stop(); } catch (e) { collect(); }
    });
  }

  $('start').addEventListener('click', function () {
    var b = bank() || { questions: [] };
    // Everything that can refuse a Start comes before anything is written down, so a refused
    // Start never leaves a running clock behind it for a reload to find (independent review,
    // 2026-09-01 night: the record used to be saved before these two checks).
    if (!state.scrStream) {
      flag('setupflag', 'The screen is not being shared. Press Share your whole screen and pick '
        + 'the entire screen.', true);
      return;
    }
    // One attempt, and Lucas wants them told so before the clock starts: "please make sure you
    // give a pop-up that says, are you sure you're ready? You only have one attempt." A resume
    // is not a new attempt, so it only gets the microphone warning if that one applies.
    var micWarn = state.heard ? '' : 'The microphone has not picked anything up yet. Say a '
      + 'sentence and watch the bar under your camera move.\n\n';
    if (state.resuming) {
      if (micWarn && !confirm(micWarn + 'Start anyway?')) return;
    } else if (!confirm(micWarn + 'You only get one attempt. When you press OK the first question '
        + 'appears and the clock starts. It does not stop, and reloading or closing the page does '
        + 'not give you more time or a different question.\n\nAre you sure you are ready?')) {
      return;
    }
    if (state.resuming) {
      // Same questions, same deadlines, whatever they did to the page in between.
      var byId = {};
      b.questions.forEach(function (q) { byId[q.id] = q; });
      // A question rotated out of the bank since they started is replaced IN ITS SLOT, so the
      // ones that survived stay where the deadlines expect them and the count always matches
      // the schedule. Replacements come from the seeded draw first, then anything live.
      var taken = {}, fresh = null, fi = 0;
      state.resuming.qids.forEach(function (id) { if (byId[id]) taken[id] = true; });
      state.questions = state.resuming.qids.map(function (id) {
        if (byId[id]) return byId[id];
        if (!fresh) fresh = chooseQuestions().concat(b.questions);
        while (fi < fresh.length && taken[fresh[fi].id]) fi++;
        var q = fresh[fi] || null;
        if (q) taken[q.id] = true;
        return q;
      }).filter(Boolean);
      state.sched = state.resuming.sched;
      state.picks = state.resuming.picks || state.picks;
      state.startedAt = state.resuming.started;
      state.reloads = state.resuming.reloads;
      state.name = state.resuming.name || state.name;
      state.email = state.resuming.email || state.email;
      state.away = state.resuming.away || [];
      state.chat = state.resuming.chat || [];
      if (state.resuming.seen) noteAway(state.resuming.seen, Date.now(), 'c');
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

    // The tapes start inside tick(), with the first question, so a resume records under the
    // question the clock is actually on.
    state.at = -1; state.phase = '';
    show('record');
    tick();
    state.tick = setInterval(tick, 250);   // wall clock inside, never a tick count
  });

  window.addEventListener('beforeunload', function (e) {
    var unsent = queue.some(function (i) { return i.role !== 'transcript' && i.status !== 'sent'; });
    if (state.recs.length || flushing > 0 || unsent) { e.preventDefault(); e.returnValue = ''; }
  });

  var finishing = false;
  function finish() {
    if (finishing) return;
    finishing = true;
    clearInterval(state.tick);
    clearInterval(state.level);
    student.stop();
    var r = record(); r.done = 'recorded'; saveRecord(r);
    endSegment(function () {
      [state.camStream, state.scrStream].forEach(function (s) {
        if (s) s.getTracks().forEach(function (t) { t.stop(); });
      });
      $('upstat').classList.add('hidden');
      show('upload');
      sendAll();
    });
  }

  // ---------------- upload ----------------
  function contextString(item) {
    var esc2 = function (v) { return String(v).replace(/([\\=|])/g, '\\$1'); };
    var picks = [];
    if (state.picks.l1) picks.push('Level 1 / Step 1');
    if (state.picks.l2all) picks.push('Level 2 / Step 2, all of it');
    if (state.picks.subs.length) picks.push(state.picks.subs.join(' and '));
    if (state.picks.omm) picks.push('OMM');
    if (state.picks.bio) picks.push('Biostats');
    return ['name=' + esc2(state.name), 'email=' + esc2(state.email),
            'applicant=' + esc2(state.applicant || 'none'), 'role=' + item.role,
            'q=' + (item.q + 1), 'of=' + state.questions.length, 'qid=' + esc2(item.qid),
            'minutes=' + item.minutes,
            'elapsed=' + Math.round((Date.now() - state.startedAt) / 60000),
            'started=' + new Date(state.startedAt).toISOString(),
            'cap=' + capS(), 'reloads=' + state.reloads,
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

  function putChunk(item, start, end, total, uniq) {
    var fd = new FormData();
    fd.append('file', item.blob.slice(start, end), item.role + '-q' + (item.q + 1) + '.webm');
    fd.append('upload_preset', PRESET);
    // No tags field here on purpose. An unsigned upload cannot add its own tags, the preset's
    // tutor-teachback tag is applied server side, and everything that identifies the applicant
    // rides in context, which unsigned uploads DO keep. Verified against the live account.
    fd.append('context', contextString(item));
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

  // What the bot reads to count the candidate's questions to the student, one file per
  // question: every stretch the candidate said on it (with the student's verdict on whether
  // it asked or addressed them) and every reply, with seconds since Start. Practice turns are
  // never in here, only the recorded questions.
  function transcript(at, qid) {
    return { v: 2, applicant: state.applicant || 'none', name: state.name,
             started: new Date(state.startedAt).toISOString(), work_s: WORK_S, teach_s: TEACH_S,
             speech: SR ? 'browser' : 'typed',
             q: at + 1, of: state.questions.length, qid: qid,
             questions: state.questions.map(function (q) { return q.id; }),
             turns: state.chat.filter(function (t) { return t.q === qid; }) };
  }
  function uploadTranscript(item) {
    var fd = new FormData();
    fd.append('file', item.blob, 'transcript-q' + (item.q + 1) + '.json');
    fd.append('upload_preset', PRESET);
    fd.append('context', contextString(item));
    // A few kilobytes. If it has not gone in 30 seconds the tapes are still marked sent: the
    // transcript never gets to hold the page at 99%.
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 30000) : null;
    return fetch(RAW_ENDPOINT, { method: 'POST', body: fd, signal: ctl ? ctl.signal : undefined }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); });
      return r.json();
    }).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  function uploadOne(item, onBytes) {
    var uniq = 'tb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    var size = item.blob.size, start = 0;
    function step() {
      if (start >= size) return Promise.resolve();
      var end = Math.min(start + CHUNK, size), attempt = 0;
      function tryChunk() {
        attempt += 1;
        return putChunk(item, start, end, size, uniq).then(function () {
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

  // The sender. Every finished question puts three items here (screen, camera, transcript) and
  // they go up one at a time in the background while the next question runs. A chunk that
  // fails three times marks its item failed and the sender moves on, and the finish screen
  // retries whatever failed. A transcript that will not go never holds anything up: the tape
  // is the thing, the transcript is the index into it.
  var queue = [], sending = null, lastSent = { at: 0, q: 0 };
  function enqueue(item) {
    item.status = 'wait'; item.sent = 0; item.size = item.blob.size;
    queue.push(item);
    pumpUploads();
  }
  function pumpUploads() {
    if (sending) return;
    var item = null;
    for (var i = 0; i < queue.length && !item; i++) if (queue[i].status === 'wait') item = queue[i];
    if (!item) { paintUpstat(); return; }
    sending = item; item.status = 'sending'; item.sent = 0;
    var p = item.role === 'transcript' ? uploadTranscript(item)
                                       : uploadOne(item, function (n) { item.sent += n; paintUpstat(); });
    p.then(function () {
      item.status = 'sent'; item.sent = item.size; item.blob = null;
      if (item.role === 'screen') lastSent = { at: Date.now(), q: item.q + 1 };
    }, function (err) {
      item.status = 'failed'; item.error = String((err && err.message) || err).slice(0, 160);
      try { console.warn(item.role + ' q' + (item.q + 1) + ' did not upload: ' + item.error); } catch (e) {}
    }).then(function () { sending = null; paintUpstat(); pumpUploads(); });
  }
  // The small pill at the bottom right while the clock runs. It never touches the layout.
  function paintUpstat() {
    var el = $('upstat');
    if (finishing || !state.tick) { el.classList.add('hidden'); return; }
    var failed = queue.filter(function (i) { return i.status === 'failed' && i.role !== 'transcript'; });
    if (sending && sending.role !== 'transcript') {
      var pct = sending.size ? Math.min(99, Math.round(sending.sent / sending.size * 100)) : 0;
      el.textContent = 'Sending question ' + (sending.q + 1) + '  ·  ' + pct + '%';
      el.className = 'upstat';
    } else if (failed.length) {
      el.textContent = 'Question ' + (failed[0].q + 1) + ' has not sent yet. It retries at the end.';
      el.className = 'upstat bad';
    } else if (lastSent.at && Date.now() - lastSent.at < 6000) {
      el.textContent = 'Question ' + lastSent.q + ' sent';
      el.className = 'upstat ok';
    } else { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
  }
  // Read by the browser test, live and local: which files went and which did not. Nothing in
  // it a candidate could use.
  window.__tbQueue = function () {
    return queue.map(function (i) { return { role: i.role, q: i.q + 1, status: i.status }; });
  };

  function mb(n) { return Math.max(1, Math.round(n / 1024 / 1024)); }
  function sendAll() {
    var tapes = queue.filter(function (i) { return i.role !== 'transcript'; });
    if (!tapes.length) {
      flag('upflag', 'Nothing was recorded. Reload and try again, and if it happens twice, reply '
        + 'to the email you got and say so.', true);
      return;
    }
    queue.forEach(function (i) { if (i.status === 'failed') i.status = 'wait'; });
    $('upflag').classList.add('hidden');
    $('retry').classList.add('hidden');
    $('dl').classList.add('hidden');
    var left = queue.reduce(function (n, i) { return n + (i.status === 'sent' ? 0 : i.size); }, 0);
    $('upNote').textContent = 'Leave this page open until it says done.'
      + (left ? ' About ' + mb(left) + ' MB to go.' : '');
    pumpUploads();
    var watch = setInterval(function () {
      var total = 0, sent = 0;
      queue.forEach(function (i) { total += i.size; sent += i.sent; });
      var pct = total ? Math.min(99, Math.round((sent / total) * 100)) : 0;
      $('bar2').style.width = pct + '%';
      $('upPct').textContent = pct + '%';
      if (sending || queue.some(function (i) { return i.status === 'wait'; })) return;
      clearInterval(watch);
      var failed = queue.filter(function (i) { return i.status === 'failed' && i.role !== 'transcript'; });
      if (failed.length) {
        flag('upflag', 'Question ' + failed.map(function (i) { return i.q + 1; }).join(' and ')
          + ' did not finish sending (' + failed[0].error + '). Try again. If it will not go, '
          + 'download the files and reply to your application email with them attached.', true);
        $('retry').classList.remove('hidden');
        $('dl').classList.remove('hidden');
        return;
      }
      $('bar2').style.width = '100%'; $('upPct').textContent = '100%';
      var r = record(); r.done = 'sent'; saveRecord(r);
      show('done');
    }, 250);
  }

  $('retry').addEventListener('click', function () { sendAll(); });
  $('dl').addEventListener('click', function () {
    queue.forEach(function (item) {
      if (item.status === 'sent' || !item.blob || item.role === 'transcript') return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(item.blob);
      a.download = (state.name.replace(/[^A-Za-z0-9]+/g, '-') || 'teaching-sample')
        + '-q' + (item.q + 1) + '-' + item.role + '.webm';
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
      return closed('Part of your recording did not finish sending.',
        'The page was closed while your last question was on its way. The questions that '
        + 'finished sending reached us. Reply to the email that sent you here and say what happened.');
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
