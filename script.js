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
  const EASE      = 0.15;   // how quickly rendered time chases the scroll target (0..1)
  const MIN_DELTA = 0.02;   // don't bother seeking for sub-frame differences (s)
  let targetTime  = 0;      // where the scroll says the video should be
  let renderTime  = 0;      // eased time we actually seek to (trails targetTime)
  let running     = false;  // is the rAF loop currently scheduled?

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
    const stageRect   = scrollStage.getBoundingClientRect();
    const stageTop    = -stageRect.top;
    const stageHeight = scrollStage.offsetHeight - window.innerHeight;

    let progress = stageHeight > 0 ? stageTop / stageHeight : 0;
    progress = Math.max(0, Math.min(1, progress));

    // UI chrome tracks the raw scroll position (no easing needed).
    updateChrome(progress, stageTop);

    let settled = true;
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

        // Seek-gating: only issue a seek when the decoder isn't already seeking
        // and the move is worth a frame. Skipping frames mid-seek is the core
        // fix for the mobile "sticky"/thrashing jank.
        if (!video.seeking && isFinite(renderTime) &&
            Math.abs(video.currentTime - renderTime) > MIN_DELTA) {
          video.currentTime = renderTime;
          // Keep the blurred backdrop in sync, but only while it's visible
          // (hidden on mobile → offsetParent null → skipped to save battery).
          if (videoBlur && videoBlur.offsetParent !== null &&
              !videoBlur.seeking && videoBlur.seekable && videoBlur.seekable.length) {
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

    // Keep looping while the video is still catching up to the scroll target;
    // otherwise suspend (a new scroll/resize will restart us) to save battery.
    if (settled) {
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

  // Any input that can move the page (or change its metrics) wakes the loop.
  // Reading the position happens inside the loop, so sparse iOS momentum
  // scroll events still produce smooth updates.
  ['scroll', 'wheel', 'touchmove', 'resize', 'orientationchange'].forEach((evt) => {
    window.addEventListener(evt, ensureLoop, { passive: true });
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
