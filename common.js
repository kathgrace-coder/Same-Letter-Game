/* shared helpers */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
async function post(url, data) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch { return { ok: false, error: 'Cannot reach the game server. Check your connection.' }; }
}
let clockOffset = 0; // serverTime - clientTime
const serverNow = () => Date.now() + clockOffset;
function syncClock(v) { clockOffset = v.serverNow - Date.now(); }

function listen(url, onState, onDead) {
  let es, closed = false;
  window.addEventListener('beforeunload', () => { closed = true; });
  (function open() {
    es = new EventSource(url);
    es.onmessage = e => { const v = JSON.parse(e.data); syncClock(v); onState(v); setConn(true); };
    es.onerror = async () => {
      if (closed) return;
      setConn(false);
      if (es.readyState !== 2) return; // browser is retrying by itself
      es.close();
      // Only give up if the server says the game/player no longer exists; otherwise retry.
      let gone = false;
      try { const r = await fetch(url.replace('/api/events', '/api/check')); gone = r.status === 403 || r.status === 404; } catch {}
      if (gone) { onDead && onDead(); } else setTimeout(() => !closed && open(), 2000);
    };
  })();
  return () => { closed = true; es.close(); };
}
function setConn(ok) {
  let el = $('#conn');
  if (!el) { el = document.createElement('div'); el.id = 'conn'; el.style.cssText = 'position:fixed;bottom:10px;left:10px;background:#e23d4b;color:#fff;font-weight:800;padding:6px 12px;border-radius:99px;font-size:13px;z-index:9'; el.textContent = 'Reconnecting…'; document.body.appendChild(el); }
  el.style.display = ok ? 'none' : 'block';
}

/* countdown bar; returns stop fn */
let timerRaf = 0;
function runTimer(endsAt, seconds, bar, label) {
  cancelAnimationFrame(timerRaf);
  const total = seconds * 1000;
  (function tick() {
    const left = Math.max(0, endsAt - serverNow());
    const f = left / total;
    bar.firstElementChild.style.transform = `scaleX(${f})`;
    bar.classList.toggle('warn', f < .5 && f >= .25);
    bar.classList.toggle('low', f < .25);
    if (label) label.textContent = Math.ceil(left / 1000);
    if (left > 0) timerRaf = requestAnimationFrame(tick);
  })();
}
const stopTimer = () => cancelAnimationFrame(timerRaf);
const fmt = ms => (ms / 1000).toFixed(2) + 's';
const board = (lb, meId, max = 10) => `<ol class="list">${lb.slice(0, max).map(p => `<li class="${p.id === meId ? 'me' : ''}"><span class="n">${p.rank}</span><span class="grow">${esc(p.name)}</span><span>${p.score}</span></li>`).join('') || '<li class="muted">No players yet</li>'}</ol>`;
const podium = lb => {
  const t = lb.slice(0, 3);
  if (!t.length) return '';
  const order = [t[1], t[0], t[2]].filter(Boolean);
  return `<div class="podium">${order.map(p => `<div class="pod p${p.rank}"><b>${esc(p.name)}</b>${p.score} pts<div style="font-size:32px">${['🥇', '🥈', '🥉'][p.rank - 1]}</div></div>`).join('')}</div>`;
};
