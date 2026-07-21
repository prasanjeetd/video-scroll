/* ===================================
   CINEMATIC VIDEO-SCROLL — Script
   Trisha & Mainak Wedding
   Drives video playback via scroll,
   manages chapter transitions & anims
   =================================== */

(function () {
  'use strict';

  // ---- DOM refs ----
  const video       = document.getElementById('mainVideo');
  const videoBlur   = document.getElementById('mainVideoBlur'); // blurred backdrop
  const scrollStage = document.getElementById('scrollStage');
  const preloader   = document.getElementById('preloader');
  const fillBar     = document.getElementById('preloaderFill');
  const pctLabel    = document.getElementById('preloaderPct');
  const progressBar = document.getElementById('progressBar');
  const nav         = document.getElementById('nav');
  const dots        = [...document.querySelectorAll('.nav__dot')];
  const chapters    = [...document.querySelectorAll('.chapter')];

  // ---- Source strategy: PHONES get one fixed clip, DESKTOP climbs a ladder ----
  // Phones are decode-limited, so consistency beats sharpness: a single
  // ALL-INTRA clip (every frame a keyframe) means every scroll-seek decodes
  // exactly ONE frame → uniform, granular, no "sometimes fast / sometimes
  // stuck". No mid-session quality swaps (a swap is itself an inconsistency),
  // and no background rung fetches competing for bandwidth (helps music start).
  // Desktop has decode headroom, so it keeps the start-low-climb ladder.
  const isPhone = matchMedia('(pointer: coarse)').matches &&
                  Math.min(screen.width, screen.height) <= 820;

  const RUNGS = [
    { src: 'videos/wedding-540.mp4',  h: 960  },
    { src: 'videos/wedding-720.mp4',  h: 1280 },
    { src: 'videos/wedding-1080.mp4', h: 1920 },
  ];
  let rung = 0;
  let ceiling = 0;   // phones never climb (ceiling stays 0)
  if (isPhone) {
    video.src = 'videos/wedding-mobile.mp4';  // 540p all-intra, fixed
  } else {
    // Ceiling by NEED: never fetch more pixels than the display can show.
    const needH = Math.max(window.innerHeight, screen.height) *
                  (window.devicePixelRatio || 1);
    ceiling = RUNGS.findIndex((r) => r.h >= needH);
    if (ceiling === -1) ceiling = RUNGS.length - 1;
    const savedCeil = parseInt(localStorage.getItem('cine-rung') || '', 10);
    if (!isNaN(savedCeil)) ceiling = Math.min(ceiling, savedCeil);
    video.src = RUNGS[0].src;
  }

  // Loop tuning — snappier & more granular on phones (cheap all-intra seeks
  // allow it); gentler on desktop where HD seeks want a little more headroom.
  const EASE          = isPhone ? 0.20 : 0.15;  // ease toward scroll target
  const MIN_DELTA     = isPhone ? 0.03 : 0.05;  // "caught up" / min move to seek
  const SEEK_INTERVAL = isPhone ? 25   : 40;    // min ms between seeks

  const TOTAL_CHAPTERS = chapters.length;  // 4
  let videoDuration = 0;
  let videoReady    = false;   // true once we can scrub the video
  let isReady       = false;   // true once preloader is dismissed
  let currentChapter = -1;
  let seekWarned    = false;   // one-time warning if video isn't seekable

  // ---- Scrub-engine state (continuous rAF loop) ----
  // EASE / MIN_DELTA / SEEK_INTERVAL are set above (branched by isPhone).
  let targetTime  = 0;      // where the scroll says the video should be
  let renderTime  = 0;      // eased time we actually seek to (trails targetTime)
  let running     = false;  // is the rAF loop currently scheduled?
  let lastSeekAt  = 0;      // timestamp (ms) of the last seek, for throttling
  let stageScrollRange = 0; // cached scrollStage.offsetHeight - innerHeight (refreshed on resize)
  let lastInputAt = 0;      // last user scroll/touch input (idle detection for upgrades)
  let seekIssuedAt = 0;     // when the latest seek was issued (latency telemetry)
  const seekLats  = [];     // rolling window of measured seek latencies (ms)

  // ========================================
  //  PRELOADER — HONEST buffering progress.
  //  Fast networks: first frame arrives in <1s → dismissed immediately.
  //  Slow networks: shows the video's TRUE buffered % (no fake 100%-then-black)
  //  and holds until the first frame, capped by the 12s safety net — after
  //  which the poster keeps the hero looking designed while buffering continues.
  // ========================================
  let fakeProgress = 0;
  const fakeInterval = setInterval(() => {
    let pct;
    if (videoDuration && video.buffered.length) {
      pct = Math.min(99, (video.buffered.end(video.buffered.length - 1) / videoDuration) * 100);
    } else {
      // nothing measurable yet — creep gently, never pretend to finish
      fakeProgress = Math.min(fakeProgress + Math.random() * 5, 30);
      pct = fakeProgress;
    }
    fillBar.style.width = pct + '%';
    pctLabel.textContent = Math.round(pct) + ' %';
  }, 200);

  function dismissPreloader() {
    if (isReady) return; // prevent double-call
    isReady = true;
    clearInterval(fakeInterval);
    fillBar.style.width = '100%';
    pctLabel.textContent = '100 %';
    setTimeout(() => {
      preloader.classList.add('hidden');
      // trigger hero chapter + kick the scrub loop
      activateChapter(0);
      ensureLoop();
      // ambient music (no-op until a user gesture allows sound)
      startMusic();
      // begin fetching the next quality rung once the page is settled
      setTimeout(fetchNextRung, 1000);
    }, 250);
  }

  // ---- Video readiness ----
  // The video is usable for scrubbing as soon as the first frame is decoded
  // (readyState >= 2 / HAVE_CURRENT_DATA). We do NOT wait for canplaythrough
  // (full buffering) — that's why the loader used to hang on the 4s safety net.

  function markReadyAndDismiss() {
    if (video.duration && isFinite(video.duration)) videoDuration = video.duration;
    if (!videoDuration || !isFinite(videoDuration)) videoDuration = 30;
    videoReady = true;
    dismissPreloader();
  }

  video.addEventListener('loadedmetadata', () => {
    videoDuration = video.duration;
    videoReady = true;   // seekable now; keep buffering in the background
    console.log('[Cinematic] Video metadata loaded. Duration:', videoDuration);
  });

  // First frame ready → reveal the page immediately.
  video.addEventListener('loadeddata', markReadyAndDismiss);
  video.addEventListener('canplay', markReadyAndDismiss);

  // CRUCIAL: on fast/cached loads the events above can fire BEFORE this script
  // attaches its listeners. Check the current state right now so we don't fall
  // through to the safety-net timer (that was the ~4.8s stall).
  if (video.readyState >= 2) markReadyAndDismiss();

  // Safety net — on very slow networks the honest progress bar holds the
  // preloader up while real buffering happens; after 12s we reveal the page
  // regardless (the poster covers the hero until the video pops in).
  setTimeout(() => {
    videoDuration = video.duration || 30;
    if (videoDuration && isFinite(videoDuration)) videoReady = true;
    dismissPreloader();
    console.log('[Cinematic] Safety net fired. Duration:', videoDuration, 'Ready:', videoReady);
  }, 12000);

  // ---- Seek-latency telemetry (drives the capability controller) ----
  video.addEventListener('seeked', () => {
    if (seekIssuedAt) {
      seekLats.push(performance.now() - seekIssuedAt);
      if (seekLats.length > 12) seekLats.shift();
    }
  });

  // ========================================
  //  CHAPTER MANAGEMENT
  // ========================================
  function activateChapter(index) {
    if (index === currentChapter) return;
    currentChapter = index;

    chapters.forEach((ch, i) => {
      const isActive = i === index;
      ch.classList.toggle('active', isActive);

      // Animate inner elements
      const anims = ch.querySelectorAll('.anim');
      anims.forEach((el) => {
        if (isActive) {
          // small delay before revealing so opacity:0 transition kicks in
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.classList.add('revealed');
            });
          });
        } else {
          el.classList.remove('revealed');
        }
      });
    });

    // Update nav dots
    dots.forEach((d, i) => d.classList.toggle('active', i === index));
  }

  // ========================================
  //  SCRUB ENGINE — continuous rAF loop
  //  Reads scroll position every frame (robust to iOS momentum, where scroll
  //  events fire in bursts), EASES the video time toward it, and GATES seeks so
  //  we never queue a new seek while the decoder is still busy. This is what
  //  makes scrubbing smooth instead of steppy/janky, especially on mobile.
  // ========================================
  const scrollCue = document.querySelector('.scroll-cue');

  function updateChrome(progress, stageTop) {
    // Active chapter
    const chapterSize = 1 / TOTAL_CHAPTERS;
    let chIdx = Math.min(Math.floor(progress / chapterSize), TOTAL_CHAPTERS - 1);
    activateChapter(chIdx);
    // Nav background
    nav.classList.toggle('scrolled', stageTop > 80);
    // Scroll cue
    if (scrollCue) scrollCue.style.opacity = progress < 0.05 ? '1' : '0';
    // Global progress bar
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const globalProgress = docHeight > 0 ? (window.scrollY / docHeight) : 0;
    progressBar.style.width = (globalProgress * 100) + '%';
  }

  function renderLoop() {
    const stageTop = -scrollStage.getBoundingClientRect().top;

    // Denominator is cached (refreshed on resize) so the mobile URL bar toggling
    // window.innerHeight mid-scroll doesn't nudge the mapping.
    let progress = stageScrollRange > 0 ? stageTop / stageScrollRange : 0;
    progress = Math.max(0, Math.min(1, progress));

    // UI chrome tracks the raw scroll position (no easing needed).
    updateChrome(progress, stageTop);

    let settled  = true;   // eased time has reached the scroll target
    let caughtUp = true;   // the real video frame has reached the eased time
    if (videoReady && videoDuration && isFinite(videoDuration)) {
      // Chrome only allows seeking when the server supports HTTP range requests.
      // Without it, video.seekable is empty ([0,0]) and seeks are ignored.
      const seekable = video.seekable.length &&
                       video.seekable.end(video.seekable.length - 1) > 0;
      if (seekable) {
        targetTime = progress * videoDuration;
        // Ease the rendered time toward the scroll target (weighted, cinematic).
        renderTime += (targetTime - renderTime) * EASE;
        if (Math.abs(targetTime - renderTime) > 0.001) settled = false;

        // Has the ACTUAL video frame reached the eased time yet? On a slow
        // decoder (low-end phone) seeks lag well behind renderTime — we must not
        // let the loop sleep until this is true, or it freezes on a stale frame.
        const delta = Math.abs(video.currentTime - renderTime);
        if (delta > MIN_DELTA) caughtUp = false;

        // Time-throttled seek. NOT gated on video.seeking (that can wedge stuck
        // on a slow decoder and block every future seek). Because renderTime is
        // eased, each throttled seek is a small nearby step the decoder handles.
        const now = performance.now();
        if (delta > MIN_DELTA && isFinite(renderTime) &&
            now - lastSeekAt >= SEEK_INTERVAL) {
          lastSeekAt = now;
          seekIssuedAt = now;   // telemetry: latency measured on 'seeked'
          video.currentTime = renderTime;
          // Keep the blurred backdrop in sync, but only while it's visible
          // (hidden on mobile → offsetParent null → skipped to save battery).
          if (videoBlur && videoBlur.offsetParent !== null &&
              videoBlur.seekable && videoBlur.seekable.length) {
            try { videoBlur.currentTime = renderTime; } catch (e) { /* not ready */ }
          }
        }
      } else if (!seekWarned) {
        seekWarned = true;
        console.warn(
          '[Cinematic] Video is NOT seekable (video.seekable is empty), so ' +
          'scroll cannot scrub it. Your server does not support HTTP range ' +
          'requests. Use a range-capable server (e.g. `node serve.js` in this ' +
          'folder). VS Code "Live Server" and `python -m http.server` do NOT ' +
          'support ranges and will leave the video frozen.'
        );
      }
    }

    // Suspend ONLY when the ease has settled AND the real video frame has caught
    // up. Otherwise keep the loop alive so a slow seek is never abandoned
    // mid-flight (the freeze bug). A scroll/resize restarts it via ensureLoop().
    if (settled && caughtUp) {
      running = false;
    } else {
      requestAnimationFrame(renderLoop);
    }
  }

  function ensureLoop() {
    if (!running) {
      running = true;
      requestAnimationFrame(renderLoop);
    }
  }

  // Cache the scroll range (denominator for progress). Refreshed only on resize,
  // so the mobile URL bar changing innerHeight mid-scroll doesn't shift the map.
  function measure() {
    stageScrollRange = scrollStage.offsetHeight - window.innerHeight;
  }
  measure();

  // Any input that can move the page wakes the loop. Reading the position
  // happens inside the loop, so sparse iOS momentum events still update smoothly.
  // Also stamps lastInputAt so quality upgrades only happen while idle.
  ['scroll', 'wheel', 'touchmove'].forEach((evt) => {
    window.addEventListener(evt, () => {
      lastInputAt = performance.now();
      ensureLoop();
    }, { passive: true });
  });
  // Layout changes: re-measure the range, then run.
  ['resize', 'orientationchange'].forEach((evt) => {
    window.addEventListener(evt, () => { measure(); ensureLoop(); }, { passive: true });
  });

  // ========================================
  //  CAPABILITY CONTROLLER — start low, climb.
  //  Background-fetches the next rung; upgrades ONLY when the user is idle AND
  //  the device has proven decode headroom (measured seek latency). Demotes —
  //  and remembers the limit — if a rung measures too slow. Sharpness never at
  //  the cost of smoothness.
  // ========================================
  let nextBlobURL = null;   // fully-downloaded next rung, ready to swap in
  let prevBlobURL = null;   // previous rung kept around for instant demotion
  let fetching    = false;
  let swapping    = false;

  function p90() {
    if (seekLats.length < 6) return 0; // not enough data yet
    const s = [...seekLats].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.9)];
  }

  function fetchNextRung() {
    if (fetching || nextBlobURL || swapping || rung >= ceiling) return;
    // Never compete with the CURRENT rung still buffering (slow networks):
    // the primary experience always gets the bandwidth first. NOTE: a paused
    // video is never fully buffered by Chrome (it stops after a healthy lead),
    // so the test is "comfortably ahead of the playhead", not "complete".
    // Fast networks pass immediately; slow ones stay blocked — as intended.
    const bufEnd = video.buffered.length ?
      video.buffered.end(video.buffered.length - 1) : 0;
    const aheadOk = bufEnd >= Math.min(videoDuration - 0.5, renderTime + 8);
    if (videoDuration && !aheadOk) return;
    fetching = true;
    fetch(RUNGS[rung + 1].src)
      .then((res) => { if (!res.ok) throw new Error(res.status); return res.blob(); })
      .then((blob) => { nextBlobURL = URL.createObjectURL(blob); })
      .catch(() => { /* network hiccup — a later controller tick retries */ })
      .finally(() => { fetching = false; });
  }

  function swapTo(newRung, url) {
    if (swapping || !url) return;
    swapping = true;
    const t = video.currentTime;
    const oldPrev = prevBlobURL;
    prevBlobURL = video.src.startsWith('blob:') ? video.src : null;
    if (oldPrev && oldPrev !== url && oldPrev !== prevBlobURL) {
      try { URL.revokeObjectURL(oldPrev); } catch (e) { /* already gone */ }
    }
    rung = newRung;
    seekLats.length = 0;      // fresh telemetry for the new rung
    video.src = url;
    if (url === nextBlobURL) nextBlobURL = null;
    video.addEventListener('loadeddata', function onSwapLoaded() {
      video.removeEventListener('loadeddata', onSwapLoaded);
      try { video.currentTime = t; } catch (e) { /* not seekable yet */ }
      primed = false;          // iOS must repaint the new source
      primeVideo();
      swapping = false;
      setTimeout(fetchNextRung, 1500);  // maybe another rung above
    });
  }

  setInterval(() => {
    if (!isReady) return;
    // DEMOTE: this rung is measurably too slow for smooth scrubbing.
    if (rung > 0 && seekLats.length >= 8 && p90() > 40) {
      ceiling = rung - 1;
      localStorage.setItem('cine-rung', String(ceiling));
      swapTo(ceiling, prevBlobURL || RUNGS[ceiling].src);
      return;
    }
    // CLIMB: next rung downloaded + user idle + headroom proven (p90() is 0
    // until the user has actually scrubbed — climbing unwatched is safe; the
    // demotion path corrects any mistake).
    if (rung < ceiling && !nextBlobURL) fetchNextRung();
    if (rung < ceiling && nextBlobURL && !swapping && !running &&
        performance.now() - lastInputAt > 1500 && p90() <= 24) {
      swapTo(rung + 1, nextBlobURL);
    }
  }, 2000);

  // Debug hook — used by tests and for field diagnosis via console
  window.__cine = {
    get rung() { return rung; },
    get ceiling() { return ceiling; },
    get p90() { return p90(); },
    force(r) { if (RUNGS[r]) swapTo(r, RUNGS[r].src); },
  };

  // ========================================
  //  NAV DOT CLICK — scroll to chapter
  // ========================================
  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      const idx = parseInt(dot.dataset.section, 10);
      const stageHeight = scrollStage.offsetHeight - window.innerHeight;
      const chapterSize = 1 / TOTAL_CHAPTERS;
      const targetScroll = scrollStage.offsetTop + stageHeight * chapterSize * idx;
      window.scrollTo({ top: targetScroll, behavior: 'smooth' });
    });
  });

  // ========================================
  //  INTERSECTION OBSERVER — below-fold
  //  elements (details, footer)
  // ========================================
  const ioOptions = { threshold: 0.15 };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        io.unobserve(entry.target);
      }
    });
  }, ioOptions);

  document.querySelectorAll('.anim-scroll').forEach((el) => io.observe(el));

  // ========================================
  //  PRIME & FREEZE — we control time manually.
  //  iOS Safari does not load or PAINT any video frame until playback has
  //  started once (preload is mostly ignored): without this, iPhones show a
  //  black screen while everything else works. So: play muted for one frame,
  //  then freeze. Muted+playsinline autoplay is allowed on iOS; if it's still
  //  rejected (e.g. Low Power Mode), retry on the first touch/click.
  //  Harmless on Chrome/Android/desktop.
  // ========================================
  let primed = false;
  let lastPlayRejection = '-';   // surfaced in the ?debug=1 overlay
  function primeVideo() {
    if (primed) return;
    const tryPrime = (v) => {
      if (!v) return;
      const p = v.play();
      if (p && p.then) {
        p.then(() => {
          primed = true;
          requestAnimationFrame(() => {
            v.pause();
            // micro-seek nudge: forces stubborn devices to actually paint
            try { v.currentTime = Math.max(0, v.currentTime - 0.001); } catch (e) { /* ok */ }
          });
        }).catch((err) => {
          // autoplay rejected (Low Power Mode / battery saver) — every future
          // gesture retries until a frame is painted
          lastPlayRejection = (err && err.name) ? err.name : 'rejected';
        });
      } else {
        v.pause();
        primed = true;
      }
    };
    tryPrime(video);
    // Blur backdrop is desktop-only (display:none on phones) — prime it only
    // where visible so mobiles don't decode a second stream.
    if (videoBlur && videoBlur.offsetParent !== null) tryPrime(videoBlur);
  }
  primeVideo();

  // ========================================
  //  AMBIENT MUSIC — the invite's own soundtrack, looped.
  //  Browsers forbid sound before a user gesture, so playback arms on the
  //  first touch/click/key (on mobile, that's the moment scrolling starts).
  //  The nav speaker toggle persists the visitor's choice.
  // ========================================
  const music    = document.getElementById('bgMusic');
  const soundBtn = document.getElementById('soundToggle');
  let musicWanted  = localStorage.getItem('cine-muted') !== '1';
  let musicPlaying = false;

  // Reflect the INTENDED state, not just whether audio has started. Sound is
  // wanted by default, so the toggle reads "on" from the first paint (it plays
  // at the first touch/scroll — browsers forbid audio before a gesture). Only
  // an explicit tap-to-mute flips it off.
  function updateSoundBtn() {
    if (soundBtn) soundBtn.classList.toggle('on', musicWanted);
  }
  updateSoundBtn();   // set the default "on" icon at load

  function startMusic() {
    if (!music || !musicWanted || musicPlaying) return;
    music.volume = 0;
    const p = music.play();
    if (p && p.then) {
      p.then(() => {
        musicPlaying = true;
        updateSoundBtn();
        // gentle 1.5s fade-in
        const t0 = performance.now();
        (function fade() {
          const k = Math.min(1, (performance.now() - t0) / 1500);
          music.volume = 0.6 * k;
          if (k < 1) requestAnimationFrame(fade);
        })();
      }).catch(() => { /* blocked — the next gesture retries */ });
    }
  }

  if (soundBtn) {
    soundBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Toggle the INTENDED state (works even before audio has started).
      if (musicWanted) {
        musicWanted = false;
        if (music) music.pause();
        musicPlaying = false;
        localStorage.setItem('cine-muted', '1');
      } else {
        musicWanted = true;
        localStorage.setItem('cine-muted', '0');
        startMusic();
      }
      updateSoundBtn();
    });
  }

  // Pause music when the tab is hidden; resume when it returns.
  document.addEventListener('visibilitychange', () => {
    if (!music) return;
    if (document.hidden) {
      if (musicPlaying) music.pause();
    } else if (musicPlaying && musicWanted) {
      music.play().catch(() => {});
    }
  });

  // ---- One gesture path for everything gated on user activation ----
  ['touchstart', 'pointerdown', 'click', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, () => {
      if (!primed) primeVideo();  // retries until a frame is painted
      startMusic();               // no-op once playing or muted by choice
    }, { passive: true });
  });

  // ========================================
  //  FIELD DEBUG — open with ?debug=1 to read the failing stage right off a
  //  misbehaving device (one screenshot = full diagnosis).
  // ========================================
  if (/[?&]debug=1/.test(location.search)) {
    const dbg = document.createElement('div');
    dbg.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:99999;' +
      'background:rgba(0,0,0,.78);color:#7CFC00;font:10px/1.6 monospace;' +
      'padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(dbg);
    setInterval(() => {
      const bufEnd  = video.buffered.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : '0';
      const seekEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1).toFixed(1) : '0';
      const conn = (navigator.connection && navigator.connection.effectiveType) || '?';
      dbg.textContent =
        'src   ' + ((video.currentSrc || '').split('/').pop() || '-').slice(0, 30) +
        '\nrung  ' + rung + '/' + ceiling + '  p90 ' + Math.round(p90()) + 'ms' +
        '\nready ' + video.readyState + '  net ' + video.networkState + '  conn ' + conn +
        '\nbuf   ' + bufEnd + 's  seekable ' + seekEnd + 's  t ' + video.currentTime.toFixed(2) +
        '\nprime ' + primed + '  playErr ' + lastPlayRejection +
        '\nvErr  ' + (video.error ? (video.error.code + ' ' + (video.error.message || '')) : '-') +
        '\nmusic ' + (musicPlaying ? 'on' : 'off');
    }, 500);
  }

})();
