// スクロールの端（一番上・一番下）まで来たことを見た目で知らせる。
// 端でさらに引っぱると、端を軸に中身が少し伸び、端に色のグラデーションが出る。指を離すと元に戻る。
// （ブラウザ標準の同じ効果は切ってあるので、二重にはならない）

const MAX_STRETCH = 0.07;   // 最大でどれだけ伸びるか（7%）
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * scroller: スクロールする要素
 * opts.stretchEl: 伸び縮みさせる要素（省略時は scroller 自身）
 * opts.host: グラデーションを置く要素（position が static 以外であること）
 * opts.edges(): グラデーションを出す位置 { top, bottom }（host の上端・下端からの距離 px）
 */
export function attachOverscroll(scroller, opts = {}) {
  const stretchEl = opts.stretchEl || scroller;
  const host = opts.host || scroller.parentElement;
  const glow = { top: document.createElement('div'), bottom: document.createElement('div') };
  glow.top.className = 'edge-glow top';
  glow.bottom.className = 'edge-glow bottom';
  host.append(glow.top, glow.bottom);

  let g = null;   // { mode: 'top' | 'bottom' | null, anchor, lastY, x0, y0 }

  const show = (mode, amount) => {
    const e = opts.edges ? opts.edges() : { top: 0, bottom: 0 };
    const el = glow[mode];
    el.style[mode] = `${e[mode]}px`;
    el.style.opacity = String(amount);
    if (reduceMotion.matches) return;
    // 伸ばす軸：上端なら「いま見えている一番上」、下端なら「中身の一番下」
    const originY = stretchEl === scroller
      ? (mode === 'top' ? '0%' : '100%')
      : (mode === 'top' ? `${scroller.scrollTop}px` : `${scroller.scrollTop + scroller.clientHeight}px`);
    stretchEl.style.transformOrigin = `50% ${originY}`;
    stretchEl.style.transform = `scaleY(${1 + MAX_STRETCH * amount})`;
  };
  const release = () => {
    stretchEl.classList.add('ov-release');
    stretchEl.style.transform = '';
    for (const el of [glow.top, glow.bottom]) { el.classList.add('ov-release'); el.style.opacity = '0'; }
    setTimeout(() => {
      stretchEl.classList.remove('ov-release');
      stretchEl.style.transformOrigin = '';
      glow.top.classList.remove('ov-release');
      glow.bottom.classList.remove('ov-release');
    }, 260);
  };

  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    const t = e.touches[0];
    g = { mode: null, anchor: 0, lastY: t.clientY, x0: t.clientX, y0: t.clientY };
  }, { passive: true });

  scroller.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const step = t.clientY - g.lastY;
    g.lastY = t.clientY;
    if (!g.mode) {
      // 横の動き（コードの横スクロールなど）は対象外
      if (Math.abs(t.clientX - g.x0) > Math.abs(t.clientY - g.y0)) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (step > 0 && scroller.scrollTop <= 0) { g.mode = 'top'; g.anchor = t.clientY - step; }
      else if (step < 0 && max > 0 && scroller.scrollTop >= max - 1) { g.mode = 'bottom'; g.anchor = t.clientY - step; }
      else return;
      stretchEl.classList.remove('ov-release');
    }
    const pulled = g.mode === 'top' ? t.clientY - g.anchor : g.anchor - t.clientY;
    if (pulled <= 0) { g.mode = null; release(); return; }
    show(g.mode, 1 - Math.exp(-pulled / 170));   // 引くほど伸びるが、だんだん伸びにくくなる
  }, { passive: true });

  const end = () => {
    if (g && g.mode) release();
    g = null;
  };
  scroller.addEventListener('touchend', end, { passive: true });
  scroller.addEventListener('touchcancel', end, { passive: true });
}
