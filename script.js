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

  const TOTAL_CHAPTERS = chapters.length;  // 4
  let videoDuration = 0;
  let videoReady    = false;   // true once we can scrub the video
  let isReady       = false;   // true once preloader is dismissed
  let currentChapter = -1;
  let seekWarned    = false;   // one-time warning if video isn't seekable

  // ---- Scrub-engine state (continuous rAF loop) ----
  const EASE         = 0.15;   // how quickly rendered time chases the scroll target (0..1)
  const MIN_DELTA    = 0.05;   // "caught up" tolerance ≈ 1 frame @25fps (s)
  const SEEK_INTERVAL = 40;    // min ms between seeks (~25/s) — throttle, not a seeking-gate
  let targetTime  = 0;      // where the scroll says the video should be
  let renderTime  = 0;      // eased time we actually seek to (trails targetTime)
  let running     = false;  // is the rAF loop currently scheduled?
  let lastSeekAt  = 0;      // timestamp (ms) of the last seek, for throttling
  let stageScrollRange = 0; // cached scrollStage.offsetHeight - innerHeight (refreshed on resize)

  // ========================================
  //  PRELOADER — fake progress until video
  //  metadata is ready, then dismiss
  // ========================================
  let fakeProgress = 0;
  const fakeInterval = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 8;
      fakeProgress = Math.min(fakeProgress, 90);
      fillBar.style.width = fakeProgress + '%';
      pctLabel.textContent = Math.round(fakeProgress) + ' %';
    }
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

  // Safety net — only matters if the video genuinely stalls.
  setTimeout(() => {
    videoDuration = video.duration || 30;
    if (videoDuration && isFinite(videoDuration)) videoReady = true;
    dismissPreloader();
    console.log('[Cinematic] Safety net fired. Duration:', videoDuration, 'Ready:', videoReady);
  }, 1800);

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
  ['scroll', 'wheel', 'touchmove'].forEach((evt) => {
    window.addEventListener(evt, ensureLoop, { passive: true });
  });
  // Layout changes: re-measure the range, then run.
  ['resize', 'orientationchange'].forEach((evt) => {
    window.addEventListener(evt, () => { measure(); ensureLoop(); }, { passive: true });
  });

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
  //  PAUSE VIDEO — we control time manually
  // ========================================
  video.pause();
  video.addEventListener('play', () => video.pause());
  if (videoBlur) {
    videoBlur.pause();
    videoBlur.addEventListener('play', () => videoBlur.pause());
  }

})();
