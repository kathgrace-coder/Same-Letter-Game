// helpers shared by the host and player pages
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
  del(k){ try { localStorage.removeItem(k); } catch(e){} }
};
async function api(path, body){
  try {
    const r = await fetch('/api/' + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
    return await r.json();
  } catch(e){ return { error: 'Connection problem — check your internet and try again.' }; }
}
let clockOffset = 0; // serverTime - localTime
const serverNow = () => Date.now() + clockOffset;
function connect(room, token, onState, onKicked){
  const es = new EventSource(`/api/events?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`);
  es.addEventListener('state', e => { const s = JSON.parse(e.data); clockOffset = s.serverNow - Date.now(); onState(s); });
  es.addEventListener('kicked', () => { es.close(); onKicked && onKicked(); });
  return es;
}
const medal = r => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r;
const secs = ms => (ms/1000).toFixed(2) + 's';
const ordinal = n => { const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10]||s[v]||s[0]); };

// Drives the get-ready countdown number + timer bar while a question is on screen.
let _raf;
function runClock(r, els){
  cancelAnimationFrame(_raf);
  function tick(){
    const t = serverNow();
    if (t < r.startsAt) { if (els.count) els.count.textContent = Math.max(1, Math.ceil((r.startsAt - t) / 1000)); }
    else {
      const left = Math.max(0, r.endsAt - t), total = r.endsAt - r.startsAt;
      if (els.bar){ els.bar.style.transform = 'scaleX(' + (left/total) + ')'; els.barWrap.classList.toggle('low', left < 5000); }
      if (els.left) els.left.textContent = Math.ceil(left/1000) + 's';
    }
    _raf = requestAnimationFrame(tick);
  }
  tick();
}
const stopClock = () => cancelAnimationFrame(_raf);
