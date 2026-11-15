// Matrix-style falling characters behind the page (decorative; off for reduced-motion users).
(function () {
  let cvs = null, raf = 0, running = false;
  window.startRain = function (opacity) {
    if (running || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    cvs = document.createElement('canvas'); cvs.id = 'rain'; cvs.style.opacity = opacity == null ? 0.2 : opacity;
    document.body.prepend(cvs);
    const ctx = cvs.getContext('2d'), size = 16;
    const chars = '01アイウエオカキクケコサシスセソタチツテト<>/\\{}[]$#%&'.split('');
    let cols = 0, drops = [];
    const resize = () => { cvs.width = innerWidth; cvs.height = innerHeight; cols = Math.ceil(cvs.width / size); drops = Array.from({ length: cols }, () => Math.random() * -40); };
    resize(); addEventListener('resize', resize);
    running = true; let last = 0;
    const frame = (t) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (t - last < 65) return; last = t;
      ctx.fillStyle = 'rgba(2,10,5,.13)'; ctx.fillRect(0, 0, cvs.width, cvs.height);
      ctx.fillStyle = '#2bff7a'; ctx.font = size + 'px monospace';
      for (let i = 0; i < cols; i++) {
        ctx.fillText(chars[(Math.random() * chars.length) | 0], i * size, drops[i] * size);
        if (drops[i] * size > cvs.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    };
    raf = requestAnimationFrame(frame);
  };
  window.stopRain = function () { running = false; cancelAnimationFrame(raf); if (cvs) cvs.remove(); cvs = null; };
})();
