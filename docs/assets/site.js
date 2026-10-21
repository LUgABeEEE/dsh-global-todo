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
  // A jump — an anchor click, a deep link, a fast wheel — can carry the viewport past a
  // group before the observer sees it intersect, and that content would stay hidden. So a
  // scroll also sweeps whatever is already above the fold; the worst case is "already
  // visible" instead of "invisible".
  function sweep() {
    for (var i = 0; i < groups.length; i += 1) {
      var group = groups[i];
      if (group.classList.contains('is-in')) continue;
      if (group.getBoundingClientRect().top < window.innerHeight * 0.92) reveal(group);
    }
  }
  window.addEventListener('scroll', sweep, { passive: true });
  window.addEventListener('resize', sweep);
  sweep();
}());

/* ---------------------------------------------------------------------------
   Image preview
   Any screenshot on the page opens in an overlay; a backdrop click or Escape
   closes it. The anchors keep their href, so with the script disabled they still
   open the PNG in a tab, and middle-click / ctrl-click keep working because only
   a plain left click is intercepted.
   --------------------------------------------------------------------------- */
;(function () {
  var overlay = document.getElementById('lightbox')
  var image = document.getElementById('lightboxImage')
  var text = document.getElementById('lightboxText')
  var closeBtn = document.getElementById('lightboxClose')
  if (!overlay || !image) return

  var lastFocus = null

  function labelFor(link) {
    var figcaption = link.closest('figure') ? link.closest('figure').querySelector('figcaption') : null
    var aria = link.getAttribute('aria-label') || ''
    var zh = figcaption ? figcaption.querySelector('.zh') : null
    var raw = zh ? zh.textContent : (figcaption ? figcaption.textContent : aria)
    return (raw || aria).replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  function open(link) {
    var src = link.getAttribute('href') || link.currentSrc || link.src
    if (!src) return
    lastFocus = document.activeElement
    image.src = src
    image.alt = labelFor(link)
    text.textContent = image.alt
    overlay.hidden = false
    // Force a frame so the opacity transition runs instead of snapping.
    void overlay.offsetWidth
    overlay.classList.add('is-open')
    document.body.classList.add('lightbox-open')
    closeBtn.focus({ preventScroll: true })
  }

  function close() {
    if (overlay.hidden) return
    overlay.classList.remove('is-open')
    document.body.classList.remove('lightbox-open')
    var finish = function () {
      overlay.hidden = true
      image.removeAttribute('src')
    }
    overlay.addEventListener('transitionend', finish, { once: true })
    setTimeout(finish, 260)
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true })
  }

  document.addEventListener('click', function (event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return

    var link = event.target.closest('a[href$=".png"], a[href*=".png"]')
    if (link) {
      event.preventDefault()
      open(link)
      return
    }
    // The caption of a state card also opens its screenshot: the image alone is a
    // small target on a phone, and the caption is visually part of the same card.
    var card = event.target.closest('.state')
    if (card) {
      var inner = card.querySelector('a[href*=".png"]')
      if (inner) { event.preventDefault(); open(inner) }
      return
    }
    var shot = event.target.closest('.shot img')
    if (shot && shot.closest('.shot')) {
      var figure = shot.closest('.shot')
      var anchor = figure.querySelector('a[href*=".png"]')
      if (anchor) { event.preventDefault(); open(anchor); return }
      // The hero screenshot has no anchor; preview the image itself.
      open({ getAttribute: function () { return shot.currentSrc || shot.src }, closest: function () { return figure }, src: shot.src })
    }
  })

  // Backdrop click closes; a click on the image itself does not, so it can be inspected.
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay || event.target.classList.contains('lightbox-figure') || event.target.classList.contains('lightbox-caption')) close()
  })
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close()
  })
}())

/* ---------------------------------------------------------------------------
   Pointer aura in the hero
   Two CSS variables, written at most once per frame. Disabled entirely on touch
   and under prefers-reduced-motion, so nothing here can make a phone janky.
   --------------------------------------------------------------------------- */
;(function () {
  var hero = document.querySelector('.hero')
  if (!hero) return
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)')
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (!fine.matches || calm.matches) return

  var frame = 0
  var lastX = 0
  var lastY = 0
  hero.addEventListener('pointermove', function (event) {
    lastX = event.clientX
    lastY = event.clientY
    if (frame !== 0) return
    frame = window.requestAnimationFrame(function () {
      frame = 0
      var rect = hero.getBoundingClientRect()
      var x = (lastX - rect.left) / rect.width
      var y = (lastY - rect.top) / rect.height
      hero.style.setProperty('--mx', (x * 100).toFixed(1) + '%')
      hero.style.setProperty('--my', (y * 100).toFixed(1) + '%')
      hero.style.setProperty('--px', ((x - 0.5) * -10).toFixed(2))
      hero.style.setProperty('--py', ((y - 0.5) * -8).toFixed(2))
    })
  }, { passive: true })
  hero.addEventListener('pointerleave', function () {
    hero.style.removeProperty('--px')
    hero.style.removeProperty('--py')
  })
}())
