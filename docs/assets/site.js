  (function () {
    var root = document.documentElement;
    var btn = document.getElementById('langToggle');
    if (!btn) return;
    var stored = null;
    try { stored = window.localStorage.getItem('gt-lang'); } catch (e) { stored = null; }
    if (stored === 'zh' || stored === 'en') root.setAttribute('data-lang', stored);
    var sync = function () {
      var zh = root.getAttribute('data-lang') !== 'en';
      btn.setAttribute('title', zh ? 'Switch to English' : '切换到中文');
    };
    sync();
    btn.addEventListener('click', function () {
      var zh = root.getAttribute('data-lang') !== 'en';
      var next = zh ? 'en' : 'zh';
      root.setAttribute('data-lang', next);
      root.setAttribute('lang', next === 'zh' ? 'zh-Hans' : 'en');
      try { window.localStorage.setItem('gt-lang', next); } catch (e) { /* private mode */ }
      sync();
    });
  }());


/* ---------------------------------------------------------------------------
   Page behaviour: scroll progress, header state, reveal-on-scroll.
   No framework, no build, and nothing here is required for the page to be
   readable — every effect degrades to "static page" when it cannot run.
   --------------------------------------------------------------------------- */
(function () {
  var root = document.documentElement;
  var reduce = false;
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    reduce = false;
  }

  // Scroll progress + header state, both driven from one rAF-throttled handler.
  var bar = document.getElementById('scrollProgress');
  var header = document.querySelector('.site-header');
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var y = window.scrollY || doc.scrollTop || 0;
      if (bar) bar.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + '%';
      if (header) header.classList.toggle('is-scrolled', y > 8);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  // Reveal groups: stagger the children so a row arrives left to right.
  var groups = document.querySelectorAll('.reveal-group');
  var reveal = function (group) {
    var kids = group.children;
    for (var i = 0; i < kids.length; i += 1) {
      kids[i].style.setProperty('--reveal-delay', Math.min(i * 70, 350) + 'ms');
    }
    group.classList.add('is-in');
  };

  if (reduce || !('IntersectionObserver' in window)) {
    // No motion, or no observer: show everything immediately.
    for (var g = 0; g < groups.length; g += 1) groups[g].classList.add('is-in');
    return;
  }

  root.setAttribute('data-reveal-ready', '');
  var observer = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].isIntersecting) {
        reveal(entries[i].target);
        observer.unobserve(entries[i].target);
      }
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  for (var index = 0; index < groups.length; index += 1) observer.observe(groups[index]);
}());
