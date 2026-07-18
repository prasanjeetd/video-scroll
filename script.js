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
  let ticking       = false;
  let seekWarned    = false;   // one-time warning if video isn't seekable

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
      // trigger hero chapter
      activateChapter(0);
    }, 500);
  }

  // ---- Video readiness events ----

  video.addEventListener('loadedmetadata', () => {
    videoDuration = video.duration;
    videoReady = true;
    console.log('[Cinematic] Video metadata loaded. Duration:', videoDuration);
  });

  video.addEventListener('canplaythrough', () => {
    if (!videoReady) {
      videoDuration = video.duration || 30;
      videoReady = true;
    }
    dismissPreloader();
  });

  // Fallback: if canplaythrough doesn't fire quickly
  video.addEventListener('loadeddata', () => {
    if (video.readyState >= 2) {
      videoDuration = video.duration || 30;
      videoReady = true;
      setTimeout(() => {
        dismissPreloader();
      }, 800);
    }
  });

  // Safety net — dismiss after 4s no matter what
  setTimeout(() => {
    videoDuration = video.duration || 30;
    if (videoDuration && isFinite(videoDuration)) {
      videoReady = true;
    }
    dismissPreloader();
    console.log('[Cinematic] Safety net fired. Duration:', videoDuration, 'Ready:', videoReady);
  }, 4000);

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
  //  SCROLL HANDLER
  //  Maps scrollY → video.currentTime
  //  and determines active chapter
  // ========================================
  function onScroll() {
    // IMPORTANT: Always reset ticking first so future scroll events are not blocked
    ticking = false;

    const stageRect  = scrollStage.getBoundingClientRect();
    const stageTop   = -stageRect.top;  // how far we've scrolled into the stage
    const stageHeight = scrollStage.offsetHeight - window.innerHeight;

    if (stageHeight <= 0) return;

    // Normalised progress 0 → 1 across the scroll stage
    let progress = stageTop / stageHeight;
    progress = Math.max(0, Math.min(1, progress));

    // --- Scrub video (only if video is ready AND actually seekable) ---
    if (videoReady && videoDuration && isFinite(videoDuration)) {
      // Chrome only allows seeking when the server supports HTTP range
      // requests. If it doesn't, video.seekable is empty ([0,0]) and every
      // currentTime write is silently ignored — the video appears frozen.
      const seekable = video.seekable.length &&
                       video.seekable.end(video.seekable.length - 1) > 0;
      if (seekable) {
        const targetTime = progress * videoDuration;
        if (isFinite(targetTime) && Math.abs(video.currentTime - targetTime) > 0.05) {
          video.currentTime = targetTime;
          // Keep the blurred backdrop scrubbed in sync — but only when it's
          // actually visible. On mobile it's display:none (offsetParent null),
          // so we skip it to save battery/decoding. Heavily blurred, so a frame
          // of drift is invisible anyway.
          if (videoBlur && videoBlur.offsetParent !== null &&
              videoBlur.seekable && videoBlur.seekable.length) {
            try { videoBlur.currentTime = targetTime; } catch (e) { /* not ready */ }
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

    // --- Determine active chapter (ALWAYS runs, independent of video) ---
    const chapterSize = 1 / TOTAL_CHAPTERS;
    let chIdx = Math.floor(progress / chapterSize);
    chIdx = Math.min(chIdx, TOTAL_CHAPTERS - 1);
    activateChapter(chIdx);

    // --- Nav background ---
    nav.classList.toggle('scrolled', stageTop > 80);

    // --- Hide scroll cue after a bit of scroll ---
    const scrollCue = document.querySelector('.scroll-cue');
    if (scrollCue) {
      scrollCue.style.opacity = progress < 0.05 ? '1' : '0';
    }

    // --- Progress bar ---
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const globalProgress = docHeight > 0 ? (window.scrollY / docHeight) : 0;
    progressBar.style.width = (globalProgress * 100) + '%';
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScroll);
    }
  }, { passive: true });

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
