'use strict';

/* ============================================================
   Panel YouTube — app.js
   Motor de datos: YouTube Data API v3 (sin backend, todo local)
   ------------------------------------------------------------
   Almacenamiento local (localStorage):
   - ytPanel.apikey      : clave de API del usuario
   - ytPanel.channels    : lista de canales [{id, handle, title, thumb}]
   - ytPanel.maxVideos   : videos máximos por canal
   - ytPanel.history     : snapshots por visita {date, points{id:{s,v,vd}}}
   ============================================================ */

const KEYS = {
  apikey: 'ytPanel.apikey',
  channels: 'ytPanel.channels',
  maxVideos: 'ytPanel.maxVideos',
  history: 'ytPanel.history',
  lastData: 'ytPanel.lastData',
  snapshots: 'ytPanel.snapshots',
  alertCfg: 'ytPanel.alertCfg',
  alertLog: 'ytPanel.alertLog',
  alertDismissed: 'ytPanel.alertDismissed',
};

/* ---------- Utilidades ---------- */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const store = {
  get(k, fallback = null) {
    try {
      const raw = localStorage.getItem(k);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* lleno */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* noop */ }
  },
};

const fmtFull = new Intl.NumberFormat('es');

function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toLocaleString('es', { maximumFractionDigits: 2 }) + ' M';
  if (n >= 1_000) return (n / 1_000).toLocaleString('es', { maximumFractionDigits: 1 }) + ' K';
  return String(n);
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateLong(iso) {
  return new Date(iso).toLocaleDateString('es', { year: 'numeric', month: 'long', day: 'numeric' });
}

function timeAgo(iso) {
  const sec = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (sec < 0) return 'ahora';
  const units = [
    [31536000, 'año'], [2592000, 'mes'], [604800, 'semana'],
    [86400, 'día'], [3600, 'hora'], [60, 'minuto'],
  ];
  for (const [u, label] of units) {
    if (sec >= u) {
      const v = Math.floor(sec / u);
      return `hace ${v} ${label}${v > 1 ? 's' : ''}`;
    }
  }
  return 'ahora';
}

/* Duración ISO 8601 -> "12:34" o "1:02:03" */
function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const [, H, M, S] = m;
  const p = (n) => String(Number(n) || 0).padStart(2, '0');
  if (H) return `${H}:${p(M)}:${p(S)}`;
  return `${Number(M) || 0}:${p(S)}`;
}

/* ---------- Escape de HTML ---------- */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
function escAttr(s) {
  return String(s ?? '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

/* ---------- Configuración ---------- */
let apiKey = store.get(KEYS.apikey, '');
let channels = store.get(KEYS.channels, []);
let maxVideos = store.get(KEYS.maxVideos, 10);

const ALERT_DEFAULTS = { enabled: true, minViews: 1000, minScore: 75 };
let alertCfg = Object.assign({}, ALERT_DEFAULTS, store.get(KEYS.alertCfg, {}));
let alertLog = store.get(KEYS.alertLog, []) || [];
let alertDismissed = store.get(KEYS.alertDismissed, []) || [];

function persistChannels() { store.set(KEYS.channels, channels); }

/* ---------- Estado de la UI ---------- */
const state = {
  tab: 'dashboard',
  data: new Map(), // channelId -> {data, videos[]}
  loading: false,
  charts: {},
};

/* ============================================================
   Cliente de la API de YouTube
   ============================================================ */
const YT = {
  BASE: 'https://www.googleapis.com/youtube/v3',
  CACHE_TTL: 5 * 60 * 1000,
  memo: new Map(),

  async call(endpoint, params = {}) {
    const qs = new URLSearchParams({ key: apiKey, ...params });
    const url = `${this.BASE}/${endpoint}?${qs}`;
    const cached = this.memo.get(url);
    if (cached && Date.now() - cached.t < this.CACHE_TTL) return cached.data;

    let res;
    try {
      res = await fetch(url);
    } catch {
      throw { message: 'Sin conexión a internet. Revisa tu señal.' };
    }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* noop */ }
      throw this._httpError(res.status, body);
    }
    const data = await res.json();
    this.memo.set(url, { t: Date.now(), data });
    return data;
  },

  _httpError(status, body) {
    const reason = body?.error?.errors?.[0]?.reason;
    let message = 'Error de la API de YouTube.';
    if (status === 403 && reason === 'quotaExceeded') {
      message = 'Cuota de API agotada. El panel volverá a intentar en unos minutos.';
    } else if (status === 403 && reason === 'apiKeyForbidden') {
      message = 'Tu API key es inválida o está restringida. Revisa la configuración.';
    } else if (status === 401) {
      message = 'API key inválida. Revisa la configuración.';
    } else {
      message = body?.error?.message || `Error HTTP ${status}`;
    }
    return { kind: 'api', message, status };
  },

  /* Resuelve un canal desde URL / @handle / ID */
  async resolveChannel(input) {
    const s = String(input).trim();
    if (!s) throw { message: 'Escribe una URL, @handle o ID.' };

    let handle = null;
    let channelId = null;

    const urlMatch = s.match(/youtube\.com\/(?:channel\/|@|c\/|user\/|handle\/)([^\\/\s?]+)/i);
    if (urlMatch) {
      const slug = urlMatch[1];
      if (/^UC[\w-]{20,}$/.test(slug)) channelId = slug;
      else handle = slug.startsWith('@') ? slug : '@' + slug;
    } else if (s.startsWith('@')) {
      handle = s;
    } else if (/^UC[\w-]{20,}$/.test(s)) {
      channelId = s;
    } else {
      handle = '@' + s;
    }

    if (channelId) {
      const arr = await this.channelByIds(channelId);
      if (!arr.length) throw { message: 'No se encontró un canal con ese ID.' };
      return arr[0];
    }

    const data = await this.call('channels', {
      part: 'snippet,contentDetails,statistics',
      forHandle: handle,
    });
    const item = data.items && data.items[0];
    if (!item) throw { message: `No se encontró el canal ${handle}.` };
    return this._shapeChannel(item);
  },

  async channelByIds(ids) {
    const idArr = Array.isArray(ids) ? ids : [ids];
    const data = await this.call('channels', {
      part: 'snippet,contentDetails,statistics',
      id: idArr.join(','),
    });
    return (data.items || []).map((it) => this._shapeChannel(it));
  },

  _shapeChannel(item) {
    return {
      id: item.id,
      name: item.snippet.title,
      handle: item.snippet.customUrl || '',
      thumb: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
      published: item.snippet.publishedAt || '',
      country: item.snippet.country || '',
      subs: Number(item.statistics?.subscriberCount || 0),
      views: Number(item.statistics?.viewCount || 0),
      videos: Number(item.statistics?.videoCount || 0),
      hiddenSubs: item.statistics?.hiddenSubscriberCount === true,
      uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads || '',
      desc: item.snippet.description || '',
      url: `https://www.youtube.com/channel/${item.id}`,
    };
  },

  /* Últimos videos de un canal (playlist de subidas) */
  async videoList(channel, max) {
    const pid = channel.uploadsPlaylist;
    if (!pid) return [];
    const data = await this.call('playlistItems', {
      part: 'contentDetails',
      playlistId: pid,
      maxResults: Math.min(max, 50),
    });
    const ids = (data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
    if (!ids.length) return [];

    const vdata = await this.call('videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.join(','),
    });
    return (vdata.items || []).map((v) => this._shapeVideo(v, channel));
  },

  _shapeVideo(v, channel) {
    return {
      id: v.id,
      title: v.snippet.title,
      desc: v.snippet.description || '',
      thumb: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.default?.url || '',
      published: v.snippet.publishedAt,
      duration: parseDuration(v.contentDetails?.duration),
      categoryId: v.snippet.categoryId || '',
      views: Number(v.statistics?.viewCount || 0),
      likes: Number(v.statistics?.likeCount || 0),
      comments: Number(v.statistics?.commentCount || 0),
    };
  },
};

/* ---------- Categorías de YouTube ---------- */
const VIDEO_CATEGORIES = {
  1: 'Cine y animación', 2: 'Autos y vehículos', 10: 'Música',
  15: 'Mascotas y animales', 17: 'Deportes', 18: 'Cortometrajes',
  19: 'Viajes y eventos', 20: 'Gaming', 21: 'Videoblogging',
  22: 'Personas y blogs', 23: 'Comedia', 24: 'Entretenimiento',
  25: 'Noticias y política', 26: 'Cómo hacer y estilo', 27: 'Educación',
  28: 'Ciencia y tecnología', 29: 'ONG y activismo', 30: 'Películas',
  31: 'Anime y animación', 32: 'Acción y aventura', 33: 'Clásicos',
  34: 'Comedia', 35: 'Documental', 36: 'Drama', 37: 'Familia',
  38: 'Extranjeros', 39: 'Terror', 40: 'Ciencia ficción y fantasía',
  41: 'Thriller', 42: 'Cortos (Shorts)', 43: 'Tráilers',
};
function categoryName(id) {
  return VIDEO_CATEGORIES[id] || 'Categoría ' + id;
}

/* ============================================================
   Ranking de mejores videos (pódium 🥇🥈🥉 + lista)
   ============================================================ */
function rankedVideos() {
  const period = Number($('#rank-period').value);
  const type = $('#rank-type').value;
  const cutoff = period > 0 ? Date.now() - period * 86400000 : 0;
  const list = [];
  for (const [, bag] of state.data) {
    for (const v of (bag.videos || [])) {
      const isShort = String(v.categoryId) === '42';
      if (type === 'short' && !isShort) continue;
      if (type === 'long' && isShort) continue;
      if (cutoff && new Date(v.published).getTime() < cutoff) continue;
      list.push({
        v,
        bag,
        isShort,
        score: computeViralScore(v, bag).total,
      });
    }
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

function renderRanking() {
  const podium = $('#rank-podium');
  const rest = $('#rank-videos');
  const label = $('#lbl-ranking');
  if (!state.data.size) { podium.innerHTML = ''; rest.innerHTML = ''; return; }
  const list = rankedVideos();
  label.textContent = `${list.length} video${list.length === 1 ? '' : 's'} en tu selección`;

  if (!list.length) {
    podium.innerHTML = '';
    rest.innerHTML = '<div class="empty-state"><div class="empty-icon">🏆</div><p>No hay videos que coincidan con estos filtros.</p></div>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const top = list.slice(0, 3);
  podium.innerHTML = `<div class="podium-grid">${top.map((it, i) => `
    <div class="podium-item p${i + 1}">
      <div class="podium-medal">${medals[i]}</div>
      <a class="podium-thumb" href="https://www.youtube.com/watch?v=${encodeURIComponent(it.v.id)}" target="_blank" rel="noopener">
        <img src="${escAttr(it.v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        ${it.isShort ? '<span class="video-thumb-duration">#Shorts</span>' : ''}
      </a>
      <div class="podium-title">${esc(it.v.title)}</div>
      <div class="podium-meta">${esc(it.bag.data.name)} · ${fmtCount(it.v.views)} vistas</div>
      <button class="score-mini lv-${scoreLevel(it.score).cls}" data-score-video="${escAttr(it.v.id)}" title="Ver el Viral Score">
        <span class="sm-icon">${scoreLevel(it.score).icon}</span><span class="sm-num">${it.score}</span><span class="sm-label">Viral</span>
      </button>
    </div>`).join('')}</div>`;

  rest.innerHTML = list.slice(3).map((it, i) => `
    <div class="rv-item">
      <div class="rv-pos">${i + 4}</div>
      <a class="rv-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(it.v.id)}" target="_blank" rel="noopener">
        <img class="rv-thumb" src="${escAttr(it.v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        <div class="rv-body">
          <div class="rv-title">${esc(it.v.title)}</div>
          <div class="rv-meta">${esc(it.bag.data.name)} · ${fmtCount(it.v.views)} vistas</div>
        </div>
      </a>
      <button class="score-mini lv-${scoreLevel(it.score).cls}" data-score-video="${escAttr(it.v.id)}" title="Ver el Viral Score">
        <span class="sm-icon">${scoreLevel(it.score).icon}</span><span class="sm-num">${it.score}</span><span class="sm-label">Viral</span>
      </button>
    </div>`).join('');
}

/* ============================================================
   Historial / evolución
   ============================================================ */
function buildPoints() {
  const points = {};
  const fallback = store.get(KEYS.lastData, {});
  for (const c of channels) {
    const bag = state.data.get(c.id);
    if (bag) {
      points[c.id] = { s: bag.data.subs, v: bag.data.views, vd: bag.data.videos };
    } else if (fallback[c.id]) {
      points[c.id] = fallback[c.id];
    }
  }
  return points;
}

/* Persiste los últimos stats para poder registrar puntos aunque la API falle luego */
function persistLastData() {
  if (!state.data.size) return;
  const last = {};
  for (const [cid, bag] of state.data) {
    last[cid] = { s: bag.data.subs, v: bag.data.views, vd: bag.data.videos };
  }
  store.set(KEYS.lastData, last);
}

/* Auto: guarda un punto por día (se fusiona si ya existe hoy) */
function recordSnapshot() {
  if (!channels.length || !state.data.size) return;
  const today = new Date().toISOString().slice(0, 10);
  const hist = store.get(KEYS.history, []);
  const points = buildPoints();
  const existing = hist.find((h) => h.date === today);
  if (existing) Object.assign(existing.points, points);
  else hist.push({ date: today, points });
  hist.sort((a, b) => a.date.localeCompare(b.date));
  backfillHistory(hist);
  store.set(KEYS.history, hist.slice(-180));
}

/* Snapshot de vistas por video: guarda la última vista de cada video para
   medir el crecimiento entre cargas y detectar videos en aceleración. */
function recordVideoSnapshots() {
  const time = Date.now();
  const snaps = store.get(KEYS.snapshots, []);
  const entry = { t: time, videos: {} };
  for (const [, bag] of state.data) {
    for (const v of (bag.videos || [])) {
      entry.videos[v.id] = { c: bag.data.id, v: v.views };
    }
  }
  if (!Object.keys(entry.videos).length) return;
  const last = snaps[snaps.length - 1];
  if (last && Math.abs(time - last.t) < 10 * 60 * 1000) last.videos = { ...last.videos, ...entry.videos };
  else snaps.push(entry);
  store.set(KEYS.snapshots, snaps.slice(-90));
}

/* Punto manual: guarda uno nuevo aunque ya exista uno hoy (ver evolución sin esperar) */
function recordManualPoint() {
  const points = buildPoints();
  if (!Object.keys(points).length) {
    showToast('Primero agrega canales y carga los datos (pulsa ↻).', 'error');
    return;
  }
  const hist = store.get(KEYS.history, []);
  hist.push({ date: new Date().toISOString(), points, manual: true });
  hist.sort((a, b) => a.date.localeCompare(b.date));
  backfillHistory(hist);
  store.set(KEYS.history, hist.slice(-180));
  renderHistory();
  showToast('Punto guardado. Revisa el gráfico ahora.', 'success');
}

/* Propaga el primer valor de cada canal hacia atrás en el tiempo para
   que todas las curvas sean visibles desde el inicio. */
function backfillHistory(hist) {
  if (!hist.length || !channels.length) return;
  const first = {};
  for (const c of channels) first[c.id] = null;

  // Primer valor real de cada canal (el más antiguo que exista)
  for (const h of hist) {
    for (const cid of Object.keys(first)) {
      const p = h.points[cid];
      if (p && typeof p.s === 'number' && first[cid] === null) {
        first[cid] = { s: p.s, v: p.v, vd: p.vd };
      }
    }
  }
  // Rellena los vacíos de cada punto con ese primer valor
  for (const h of hist) {
    for (const cid of Object.keys(first)) {
      const p = h.points[cid];
      if (!p || typeof p.s !== 'number') {
        if (first[cid]) h.points[cid] = { ...first[cid] };
      }
    }
  }
}

/* ============================================================
   Carga principal
   ============================================================ */
async function loadStats() {
  if (!apiKey || !channels.length || state.loading) return;
  state.loading = true;
  setRefresh(true);
  try {
    const details = await YT.channelByIds(channels.map((c) => c.id).join(','));
    state.data.clear();
    for (const d of details) {
      state.data.set(d.id, { data: d, videos: [] });
      const ch = channels.find((c) => c.id === d.id);
      if (ch && ch.name !== d.name) { ch.name = d.name; ch.thumb = d.thumb; }
    }
    channels = channels.filter((c) => state.data.has(c.id));
    persistChannels();

    const perChannel = Math.min(maxVideos, 50);
    await Promise.all([...state.data.entries()].map(async ([id, bag]) => {
      try { bag.videos = await YT.videoList(bag.data, perChannel); }
      catch (e) { console.warn('videoList', id, e); bag.videos = []; }
    }));

    persistLastData();
    recordSnapshot();
    recordVideoSnapshots();
    renderAll();
    const alerts = detectAlerts();
    showToast(alerts ? `Datos actualizados · ${alerts} alerta${alerts === 1 ? '' : 's'} nueva${alerts === 1 ? '' : 's'}` : 'Datos actualizados', 'success');
  } catch (e) {
    showToast(e?.message || 'No se pudieron cargar los datos.', 'error');
  } finally {
    state.loading = false;
    setRefresh(false);
  }
}

/* ============================================================
   Render de vistas
   ============================================================ */
function renderAll() {
  renderFilterOptions();
  renderSummary();
  renderWhatsWorking();
  renderComparison();
  renderChannelRanks();
  renderPersonalAlerts();
  renderRank();
  renderVideos();
  renderRanking();
  renderMomentum();
  renderPatterns();
  renderHistory();
  $('#lbl-updated').textContent =
    `Actualizado: ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
}

/* Puebla el desplegable de filtro por canal conservando la selección */
function renderFilterOptions() {
  const sel = $('#channel-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="all">Todos los canales</option>';
  for (const [cid, bag] of state.data) {
    const opt = document.createElement('option');
    opt.value = cid;
    opt.textContent = bag.data.name;
    sel.appendChild(opt);
  }
  sel.value = state.data.has(prev) ? prev : 'all';
}

/* --- Tarjetas resumen --- */
function renderSummary() {
  const grid = $('#summary-cards');
  if (!state.data.size) { grid.innerHTML = ''; return; }
  grid.innerHTML = '';

  const sel = $('#channel-filter');
  const filter = sel.value;
  const bagList = filter === 'all'
    ? [...state.data.values()]
    : (state.data.has(filter) ? [state.data.get(filter)] : []);

  for (const bag of bagList) {
    const d = bag.data;
    grid.insertAdjacentHTML('beforeend', channelCardHTML(d, bag.videos));
  }
}

/* Tarjeta enriquecida de un canal */
function channelCardHTML(d, videos) {
  const avgViewsPerVideo = d.videos > 0 ? Math.round(d.views / d.videos) : 0;
  const subsPct = d.views > 0 ? ((d.subs / d.views) * 100).toFixed(2) : '0';
  let avgLikes = null;
  if (videos && videos.length) {
    const sum = videos.reduce((a, v) => a + v.likes, 0);
    avgLikes = Math.round(sum / videos.length);
  }
  const meta = [
    d.published ? `📅 Desde ${fmtDateLong(d.published)}` : '',
    d.country ? `🌍 ${esc(d.country)}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <article class="card">
      <div class="channel-top">
        <img class="avatar" src="${escAttr(d.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        <div>
          <div class="channel-name">${esc(d.name)}${d.url ? ` <a class="card-link" href="${escAttr(d.url)}" target="_blank" rel="noopener" title="Abrir canal en YouTube">↗</a>` : ''}</div>
          <div class="channel-handle">${esc(d.handle || d.id)}</div>
        </div>
      </div>
      ${meta ? `<div class="channel-meta">${meta}</div>` : ''}
      <div class="stat-row">
        <div class="stat"><div class="stat-label">Suscriptores</div>
          <div class="stat-value success">${fmtFull.format(d.subs)}</div></div>
        <div class="stat"><div class="stat-label">Vistas</div>
          <div class="stat-value primary">${fmtFull.format(d.views)}</div></div>
        <div class="stat"><div class="stat-label">Videos</div>
          <div class="stat-value accent">${fmtFull.format(d.videos)}</div></div>
      </div>
      <div class="stat-row row2">
        <div class="stat"><div class="stat-label">Vistas / video</div>
          <div class="stat-value">${fmtFull.format(avgViewsPerVideo)}</div></div>
        <div class="stat"><div class="stat-label">Subs / vistas</div>
          <div class="stat-value">${subsPct}%</div></div>
        <div class="stat"><div class="stat-label">Likes prom. (${(videos||[]).length})</div>
          <div class="stat-value">${avgLikes === null ? '—' : fmtCount(avgLikes)}</div></div>
      </div>
      ${d.desc ? `<p class="card-desc">${esc(d.desc)}</p>` : ''}
    </article>`;
}

/* --- Comparación con Chart.js --- */
const chartColors = ['#ff4b5c', '#38bdf8', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c'];

function renderComparison() {
  const canvas = $('#chart-comparison');
  if (typeof Chart === 'undefined' || !state.data.size) return;
  const chans = [...state.data.values()];
  const labels = chans.map((c) => c.data.name);
  const subs = chans.map((c) => c.data.subs);
  const palette = chans.map((_, i) => chartColors[i % chartColors.length]);

  destroyChart('comparison');
  state.charts.comparison = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Suscriptores',
        data: subs,
        backgroundColor: palette.map((c) => c + 'cc'),
        borderColor: palette,
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: barOptions(),
  });
}

/* ============================================================
   ⚔️ Comparación entre tus canales: tabla con rendimiento a
   30 días (vistas, growth real del historial, videos y promedio).
   ============================================================ */
function channelRanks() {
  const cutoff = Date.now() - 30 * 86400000;
  const hist = store.get(KEYS.history, []);
  const ref = (cid) => {
    const pts = hist
      .map((h) => ({ t: new Date(h.date).getTime(), v: h.points?.[cid]?.v }))
      .filter((p) => Number.isFinite(p.t) && typeof p.v === 'number')
      .sort((a, b) => a.t - b.t);
    if (pts.length < 2) return null;
    const now = Date.now();
    const older = pts.filter((p) => p.t <= now - 7 * 86400000);
    const a = older.length ? older[older.length - 1] : pts[0];
    const b = pts[pts.length - 1];
    if (b.t - a.t < 7 * 86400000) return null;
    if (!a.v) return null;
    return ((b.v - a.v) / a.v) * 100;
  };
  const rows = [];
  for (const [, bag] of state.data) {
    const d = bag.data;
    const recent = (bag.videos || []).filter((v) => new Date(v.published).getTime() >= cutoff);
    const views30 = recent.reduce((a, v) => a + (Number(v.views) || 0), 0);
    const videos30 = recent.length;
    rows.push({
      id: d.id,
      name: d.name,
      thumb: d.thumb,
      views30: Math.round(views30),
      videos30,
      avg30: videos30 ? Math.round(views30 / videos30) : 0,
      short: recent.filter((v) => String(v.categoryId) === '42').length,
      growth: ref(d.id),
    });
  }
  rows.sort((a, b) => b.views30 - a.views30);
  return rows;
}

function growthHTML(g) {
  if (g === null) return '<span class="cmp-na">—</span>';
  const sign = g > 0 ? '+' : '';
  const cls = g > 5 ? 'up' : g < -3 ? 'down' : 'flat';
  return `<span class="cmp-growth ${cls}">${sign}${g.toFixed(1)}%</span>`;
}

function renderChannelRanks() {
  const box = $('#channel-compare');
  if (!box) return;
  if (!state.data.size) { box.innerHTML = ''; return; }
  const rows = channelRanks();
  const html = rows.map((r) => `
    <tr>
      <td>
        <div class="cc-name">
          <img class="avatar" src="${escAttr(r.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <span>${esc(r.name)}</span>
        </div>
      </td>
      <td class="cc-num">${fmtCount(r.views30)}</td>
      <td class="cc-num">${r.videos30}</td>
      <td class="cc-num">${fmtCount(r.avg30)}</td>
      <td class="cc-num cc-shorts">${r.short} #Shorts</td>
      <td class="cc-growth-cell">${growthHTML(r.growth)}</td>
    </tr>`).join('');
  box.className = rows.length ? 'cmp-table-wrap' : 'cmp-table-wrap empty';
  box.innerHTML = `
    <table class="cmp-table">
      <thead>
        <tr>
          <th>Canal</th>
          <th class="cc-num">Views 30d</th>
          <th class="cc-num">Videos</th>
          <th class="cc-num">Promedio</th>
          <th class="cc-num">Shorts</th>
          <th>Growth</th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
    ${!rows.length ? '<p class="muted small">Publica y vuelve a cargar para ver el rendimiento a 30 días.</p>' : ''}`;
}

function barOptions() {
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `Suscriptores: ${fmtFull.format(c.raw)}` } },
    },
    scales: {
      x: {
        ticks: { color: '#98a1b5', callback: (v) => fmtCount(v) },
        grid: { color: 'rgba(255,255,255,0.06)' },
        border: { color: '#262c3d' },
      },
      y: {
        ticks: { color: '#eef1f7', font: { size: 12 } },
        grid: { display: false },
        border: { color: '#262c3d' },
      },
    },
  };
}

/* --- Ranking por suscriptores --- */
function renderRank() {
  const box = $('#rank-list');
  if (!state.data.size) { box.innerHTML = ''; return; }
  const items = [...state.data.values()].map((c) => c.data);
  items.sort((a, b) => b.subs - a.subs);
  const max = items[0]?.subs || 1;
  const medals = ['gold', 'silver', 'bronze'];
  box.innerHTML = `
    <div class="view-head"><h1 class="small">Ranking por suscriptores</h1></div>
    ${items.map((d, i) => `
      <div class="rank-item">
        <div class="rank-pos ${medals[i] || ''}">${i + 1}</div>
        <div class="rank-main">
          <div class="rank-name">${esc(d.name)}</div>
          <div class="rank-track">
            <div class="rank-fill" style="width:${Math.max((d.subs / max) * 100, 2)}%"></div>
          </div>
        </div>
        <div class="rank-value">${fmtFull.format(d.subs)}</div>
      </div>`).join('')}`;
}

/* --- Videos --- */
function renderVideos() {
  updateHourChart();
  renderHourRank();
  const box = $('#videos-list');
  if (!state.data.size) { box.innerHTML = ''; return; }
  let total = 0;
  box.innerHTML = '';
  for (const [cid, bag] of state.data) {
    const d = bag.data;
    const videos = bag.videos || [];
    total += videos.length;
    const block = document.createElement('div');
    block.className = 'channel-block';
    block.innerHTML = `
      <div class="channel-block-head">
        <img class="avatar" src="${d.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        <h3>${esc(d.name)}</h3>
      </div>
      ${videos.length ? videos.map((v) => videoCardHTML(v, bag)).join('') : '<p class="muted">Sin datos de videos.</p>'}`;
    box.appendChild(block);
  }
  const n = state.data.size;
  $('#lbl-videos-info').textContent = `${total} videos · ${n} canal${n > 1 ? 'es' : ''}`;
}

function videoCardHTML(v, bag) {
  const short = String(v.categoryId) === '42';
  const score = computeViralScore(v, bag);
  const lv = scoreLevel(score.total);
  return `
    <div class="video-card">
      <a class="video-card-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">
        <div class="video-thumb-wrap">
          <img class="video-thumb" src="${escAttr(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <span class="video-thumb-duration">${esc(v.duration)}</span>
        </div>
        <div class="video-body">
          <div class="video-title">${esc(v.title)}${short ? '<span class="video-shorts-badge">#Shorts</span>' : ''}</div>
          <div class="video-date">${fmtDateTime(v.published)} · ${timeAgo(v.published)}</div>
          <div class="video-hour">🕐 Publicado a las ${esc(fmtTime(v.published))}</div>
          <div class="video-stats">
            <span class="video-stat">👁 <b>${fmtCount(v.views)}</b></span>
            <span class="video-stat">👍 <b>${fmtCount(v.likes)}</b></span>
            <span class="video-stat">💬 <b>${fmtCount(v.comments)}</b></span>
            <span class="video-stat">${esc(categoryName(v.categoryId))}</span>
          </div>
          ${v.desc ? `<div class="video-desc">${esc(v.desc)}</div>` : ''}
        </div>
      </a>
      <button class="score-mini lv-${lv.cls}" data-score-video="${escAttr(v.id)}" title="Ver el Viral Score">
        <span class="sm-icon">${lv.icon}</span><span class="sm-num">${score.total}</span><span class="sm-label">Viral</span>
      </button>
    </div>`;
}

/* Explicación del Viral Score de un video (se abre en un modal) */
function scoreVideoHTML(v, bag) {
  const score = computeViralScore(v, bag);
  const lv = scoreLevel(score.total);
  const engPct = v.views > 0 ? ((v.likes + v.comments) / v.views) * 100 : 0;
  const rows = (p) => `
      <div class="pb-row">
        <div class="pb-head"><span>${p.label}</span><b>${p.points}/${p.max}</b></div>
        <div class="pb-track"><div class="pb-fill" style="width:${Math.round(p.frac * 100)}%"></div></div>
        <p class="pb-detail">${p.detail}</p>
      </div>`;
  return `
    <div class="sbar-head">
      <div class="sbar-big ${lv.cls}">${lv.icon}</div>
      <div>
        <div class="sbar-title">${esc(v.title)}</div>
        <div class="sbar-meta">${esc(bag.data.name)}</div>
      </div>
    </div>
    <div class="sbar-score">
      <span class="sbar-num">${score.total}</span>
      <span class="sbar-label">Viral Score · ${lv.label}</span>
    </div>
    <p class="sbar-how">Se calcula como el promedio ponderado de rendimiento (50), interacción (30) e impulso (20) contra el promedio de tu canal.</p>
    <div class="sbar-rows">${score.parts.map(rows).join('')}</div>
    <div class="sbar-raw">
      <span>👁 <b>${fmtCount(v.views)}</b> vistas</span>
      <span>💬 <b>${engPct.toFixed(1)}%</b> interacción (likes + comentarios)</span>
    </div>`;
}

/* ---------- Modal del Viral Score ---------- */
function openScoreModal(videoId) {
  for (const [, bag] of state.data) {
    const v = (bag.videos || []).find((x) => x.id === videoId);
    if (!v) continue;
    $('#score-body').innerHTML = scoreVideoHTML(v, bag);
    $('#score-modal').classList.remove('hidden');
    $('#score-modal').setAttribute('aria-hidden', 'false');
    return;
  }
  showToast('No se encontró el video en los datos cargados.', 'error');
}

function closeScoreModal() {
  $('#score-modal').classList.add('hidden');
  $('#score-modal').setAttribute('aria-hidden', 'true');
}

/* ============================================================
   🔔 Alertas: avisan una vez por video/umbral cuando se cruza
   un mínimo de vistas o cierto Viral Score, en cada carga.
   ============================================================ */
function persistAlert() { store.set(KEYS.alertLog, alertLog); }

function detectAlerts() {
  const dismissed = new Set(alertDismissed);
  alertLog = alertLog.filter((a) =>
    a.type === 'views'
      ? (alertCfg.minViews > 0 && a.value >= alertCfg.minViews)
      : (alertCfg.minScore > 0 && a.value >= alertCfg.minScore)
  );
  const seen = new Set(alertLog.map((a) => a.key));
  const pending = [];
  if (alertCfg.enabled) {
    for (const [, bag] of state.data) {
      const d = bag.data;
      for (const v of (bag.videos || [])) {
        const views = Number(v.views) || 0;
        if (alertCfg.minViews > 0 && views >= alertCfg.minViews && !dismissed.has(`${v.id}:views`)) {
          pending.push({ key: `${v.id}:views`, videoId: v.id, channel: d.name, title: v.title,
            type: 'views', value: views, score: computeViralScore(v, bag).total, at: Date.now() });
        }
        if (alertCfg.minScore > 0) {
          const score = computeViralScore(v, bag).total;
          if (score >= alertCfg.minScore && !dismissed.has(`${v.id}:score`)) {
            pending.push({ key: `${v.id}:score`, videoId: v.id, channel: d.name, title: v.title,
              type: 'score', value: score, score, at: Date.now() });
          }
        }
      }
    }
  }
  const fresh = pending.filter((a) => !seen.has(a.key)).length;
  alertLog = alertLog
    .concat(pending.filter((a) => !seen.has(a.key)))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  persistAlert();
  renderAlertBadge();
  return fresh;
}

function renderAlertBadge() {
  const b = $('#alerts-badge');
  if (!b) return;
  const n = alertLog.length;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', n === 0);
}

function alertItemHTML(a) {
  const score = scoreLevel(a.score || 0);
  const chip = a.type === 'views'
    ? `<span class="al-chip al-views">🔥 Más de <b>${fmtCount(a.value)}</b> vistas</span>`
    : `<span class="al-chip al-score">💥 Viral Score <b>${a.value}</b></span>`;
  const date = new Date(a.at).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `
    <div class="alert-item">
      <div class="alert-body">
        <div class="al-top">${chip}<span class="al-date">${esc(date)}</span></div>
        <a class="alert-title" href="https://www.youtube.com/watch?v=${encodeURIComponent(a.videoId)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div class="alert-meta">${esc(a.channel)}</div>
        <button class="score-mini lv-${score.cls}" data-score-video="${escAttr(a.videoId)}" title="Ver el Viral Score">
          <span class="sm-icon">${score.icon}</span><span class="sm-num">${a.score || 0}</span><span class="sm-label">Viral</span>
        </button>
      </div>
      <button class="alert-dismiss" data-dismiss="${escAttr(a.key)}" aria-label="Descartar esta alerta" title="Descartar">✕</button>
    </div>`;
}

function renderAlerts() {
  const list = $('#alerts-list');
  if (!list) return;
  const empty = $('#alerts-empty');
  const foot = $('#alerts-foot');
  if (!alertLog.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    foot.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  foot.classList.remove('hidden');
  list.innerHTML = alertLog.map(alertItemHTML).join('');
}

function openAlerts() {
  renderAlerts();
  $('#alerts-modal').classList.remove('hidden');
  $('#alerts-modal').setAttribute('aria-hidden', 'false');
}

function closeAlerts() {
  $('#alerts-modal').classList.add('hidden');
  $('#alerts-modal').setAttribute('aria-hidden', 'true');
}

function dismissAlert(key) {
  alertLog = alertLog.filter((a) => a.key !== key);
  alertDismissed = alertDismissed.filter((k) => k !== key).concat(key);
  store.set(KEYS.alertDismissed, alertDismissed);
  persistAlert();
  renderAlerts();
  renderAlertBadge();
}

function clearAlerts() {
  alertDismissed = alertDismissed.concat(alertLog.map((a) => a.key));
  alertLog = [];
  store.set(KEYS.alertDismissed, alertDismissed);
  persistAlert();
  renderAlerts();
  renderAlertBadge();
  showToast('Todas las alertas fueron descartadas.', 'success');
}

function updateAlertCfg() {
  alertCfg = {
    enabled: $('#switch-alerts').checked,
    minViews: Math.max(0, parseInt($('#input-minviews').value, 10) || 0),
    minScore: Math.min(100, Math.max(0, parseInt($('#input-minscore').value, 10) || 0)),
  };
  store.set(KEYS.alertCfg, alertCfg);
  renderAlertBadge();
  detectAlerts();
}

/* ============================================================
   🧠 Alertas personales: hallazgos automáticos del panel según
   tu propio rendimiento (sin umbrales ni configuración).
   ============================================================ */
function personalAlerts() {
  const out = [];
  const now = Date.now();
  const hist = store.get(KEYS.history, []);

  const add = ({ icon, cls, text, video = null }) => {
    out.push({ icon, cls, text, video });
  };

  // Crecimiento semanal real (historial vs hace ~7 días)
  const best = {}; // cid -> { v, age }
  for (const h of hist) {
    const t = new Date(h.date).getTime();
    if (!Number.isFinite(t)) continue;
    for (const [cid, pts] of Object.entries(h.points || {})) {
      if (typeof pts?.v !== 'number') continue;
      const age = now - t;
      best[cid] = best[cid] || { v: pts.v, age };
      // nos quedamos con el punto más cercano a hace 7 días (ni más viejo ni más nuevo)
      if (age >= 7 * 86400000 && (age < best[cid].age || best[cid].age < 7 * 86400000)) {
        best[cid] = { v: pts.v, age };
      }
    }
  }

  for (const [, bag] of state.data) {
    const d = bag.data;
    const videos = bag.videos || [];
    if (!videos.length) continue;

    // Récord / bajo promedio: compara cada video reciente contra el promedio del canal
    const avgViews = d.videos > 0 ? d.views / d.videos : 0;
    const recent = videos.filter((v) => now - new Date(v.published).getTime() < 14 * 86400000);
    let bestOver = null, bestUnder = null;
    for (const v of recent) {
      const ratio = avgViews > 0 ? (Number(v.views) || 0) / avgViews : 0;
      if (ratio < 0.7 && (!bestUnder || ratio < bestUnder.ratio)) (bestUnder = { v, ratio });
      if (ratio > 1.2 && (!bestOver || ratio > bestOver.ratio)) (bestOver = { v, ratio });
    }
    if (bestOver && bestOver.ratio >= 1.5 && bestOver.ratio < 2) {
      add({ icon: '🟢', cls: 'up', video: bestOver.v.id,
        text: `${d.name}: «${truncTitle(bestOver.v.title, 40)}» está ${bestOver.ratio.toFixed(1)}X sobre tu promedio.` });
    }
    if (bestUnder && bestUnder.ratio <= 0.6) {
      add({ icon: '🔴', cls: 'down', video: bestUnder.v.id,
        text: `${d.name}: «${truncTitle(bestUnder.v.title, 40)}» está ${((1 - bestUnder.ratio) * 100).toFixed(0)}% debajo del promedio.` });
    }

    // Récord de vistas dentro del canal
    if (bestOver && bestOver.ratio >= 2) {
      add({ icon: '🔥', cls: 'hot', text: `${d.name}: nuevo récord de views para «${truncTitle(bestOver.v.title, 40)}» (${fmtCount(bestOver.v.views)} views).` });
    }

    // Canal sin publicar
    const sorted = videos
      .map((v) => new Date(v.published).getTime())
      .sort((a, b) => b - a);
    const last = sorted[0] || now;
    const daysGap = Math.floor((now - last) / 86400000);
    if (daysGap >= 5) {
      add({ icon: '⚠️', cls: 'idle',
        text: `${d.name} lleva ${daysGap} días sin publicar (último video hace ${daysGap} días).` });
    }

    // Crecimiento semanal
    const ref = best[d.id];
    if (ref && d.views > 0) {
      const growth = ((d.views - ref.v) / ref.v) * 100;
      if (Math.abs(ref.age - 7 * 86400000) < 4 * 86400000 && Math.abs(growth) >= 3) {
        const cls = growth > 0 ? 'up' : 'down';
        add({ icon: '📈', cls, text: `${d.name}: crecimiento semanal ${growth > 0 ? '+' : ''}${growth.toFixed(0)}%.` });
      }
    }
  }
  return out;
}

function renderPersonalAlerts() {
  const box = $('#alerts-personal');
  const empty = $('#alerts-personal-empty');
  if (!box) return;
  if (!state.data.size) { box.innerHTML = ''; return; }
  const alerts = personalAlerts();
  if (!alerts.length) {
    box.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  box.innerHTML = alerts.map((a) => `
    <div class="pers-alert ${a.cls}">
      <span class="pers-icon">${a.icon}</span>
      <span class="pers-text">${esc(a.text)}</span>
      ${a.video ? `<a class="pers-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(a.video)}" target="_blank" rel="noopener">Ver →</a>` : ''}
    </div>`).join('');
}

/* ============================================================
   💡 Ideas: genera títulos y ángulos derivados de los videos
   con mejor Viral Score (tema, formato, duración, interacción).
   ============================================================ */
function truncTitle(t, n = 34) {
  t = String(t || '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function ideaTheme(set) {
  if (set.kws.length) return set.kws[0];
  if (set.cat && set.cat !== '42') return categoryName(set.cat);
  return 'tu contenido';
}

function buildIdeaSet() {
  const filter = $('#channel-filter').value;
  const bagList = filter === 'all'
    ? [...state.data.values()]
    : (state.data.has(filter) ? [state.data.get(filter)] : []);
  const all = [];
  for (const bag of bagList) {
    for (const v of (bag.videos || [])) all.push({ v, bag });
  }
  if (all.length < 3) return null;

  const scored = all
    .map((x) => ({ ...x, score: computeViralScore(x.v, x.bag).total }))
    .sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);
  const kws = patternKeywords(top.map((x) => x.v.title));
  const mainKw = kws[0] ? kws[0].toLowerCase() : '';
  const kwCount = mainKw
    ? top.filter((x) => String(x.v.title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(mainKw)).length
    : top.length;
  const cat = mostCommonCat(top.map((x) => x.v.categoryId));
  const shorts = top.filter((x) => String(x.v.categoryId) === '42').length;
  const topN = top.length;
  const durs = top.map((x) => durSeconds(x.v.duration)).filter(Boolean).sort((a, b) => a - b);
  const durLo = durs.length ? quantile(durs, 0.25) : 0;
  const durHi = durs.length ? quantile(durs, 0.75) : 0;
  const engs = top
    .map((x) => (x.v.views ? (x.v.likes + x.v.comments) / x.v.views : 0))
    .filter((e) => e > 0);
  const medEng = engs.length ? quantile(engs, 0.5) : 0;
  return {
    top, kws, kwCount, cat, shorts, topN,
    isShort: shorts >= topN / 2,
    formatLabel: shorts >= topN / 2 ? 'Shorts' : 'videos largos',
    durLo, durHi, medEng, best: top[0],
  };
}

function ideaCards(set) {
  const theme = ideaTheme(set);
  const bestTitle = set.best && set.best.v.title ? truncTitle(set.best.v.title) : '';
  const durLabel = fmtDurRange(set.durLo, set.durHi);
  return [
    {
      tag: '🎯 Remix',
      title: bestTitle ? `Remix de tu video «${bestTitle}» con nuevo gancho al inicio` : `Remix de tu mejor video con un nuevo gancho al inicio`,
      why: `Tus #1 por Viral Score. Mismo tema, otro ángulo.`,
    },
    {
      tag: '🔁 Secuela',
      title: `Parte 2: ${theme} (lo que faltó decir)`,
      why: `Continúa la conversación que tus ${set.kwCount} videos exitosos ya empezaron.`,
    },
    {
      tag: '🪝 Gancho',
      title: `¿Sabías esto sobre ${theme}?`,
      why: `Abre con el dato que ya te funciona: ${set.kwCount} de tus ${set.topN} mejores videos giran en torno a «${theme}».`,
    },
    {
      tag: '❌ Error',
      title: `El error #1 con ${theme} (y cómo evitarlo)`,
      why: `El formato «error» funciona bien en ${set.formatLabel}; tu cara al tema ya es «${theme}».`,
    },
    {
      tag: '📋 Lista',
      title: `3 señales de que ${theme} te está funcionando`,
      why: `Lista corta y directa, ideal para ${set.formatLabel}.`,
    },
    {
      tag: '❓ Pregunta',
      title: `¿${theme} es para todos? Tu experiencia honesta`,
      why: `Preguntas abiertas disparan comentarios (tu interacción media: ${set.medEng ? pct(set.medEng) : 'aún sin datos'}).`,
    },
    {
      tag: '⚖️ Antes vs después',
      title: `${theme}: antes vs después`,
      why: `Contraste que retiene; combina con tu duración típica de ${durLabel}.`,
    },
    {
      tag: '🔥 Mito',
      title: `5 mitos sobre ${theme} que debes dejar de creer`,
      why: `Nuevo ángulo del mismo tema ganador: ${set.kwCount} de tus mejores videos ya suman sobre «${theme}».`,
    },
    {
      tag: '🎬 Detrás de cámaras',
      title: `Así grabé mi mejor video sobre ${theme} que despegó`,
      why: `Humaniza el canal y refuerza el tema que más te funciona.`,
    },
    {
      tag: '🧵 Historia',
      title: `Lo que aprendí tras publicar sobre ${theme}`,
      why: `Cierra el ciclo de tu tema ganador en formato historia.`,
    },
  ];
}

function ideasHTML(set) {
  const theme = ideaTheme(set);
  const durLabel = fmtDurRange(set.durLo, set.durHi);
  return `
    <div class="idea-summary">
      <div class="idea-summary-title">🧠 Tus ${set.kwCount} videos exitosos giran en torno a <b>«${esc(theme)}»</b></div>
      <div class="idea-chips">
        <span class="idea-chip">${set.isShort ? '🎬 Shorts' : '🎥 Videos largos'}</span>
        <span class="idea-chip">⏱️ ${durLabel}</span>
        ${set.medEng ? `<span class="idea-chip">💬 ${pct(set.medEng)} interacción</span>` : ''}
      </div>
      <p class="muted small">Estas 10 ideas reutilizan tu tema ganador, formato y duración reales. Cópialo y ajústalo a tu estilo.</p>
    </div>
    <div class="idea-grid">
      ${ideaCards(set).map((c) => `
        <div class="idea-card">
          <div class="idea-tag">${c.tag}</div>
          <div class="idea-title">${esc(c.title)}</div>
          <div class="idea-why">${esc(c.why)}</div>
          <button class="btn btn-ghost btn-copy" data-copy="${escAttr(c.title)}">📋 Copiar</button>
        </div>`).join('')}
    </div>`;
}

function renderIdeas() {
  const box = $('#ideas-result');
  const msg = $('#ideas-msg');
  box.innerHTML = '';
  msg.textContent = '';
  const set = buildIdeaSet();
  if (!set) {
    msg.className = 'msg error';
    msg.textContent = 'Necesitas al menos 3 videos con datos cargados para generar ideas. Pulsa ↻ y vuelve a intentarlo.';
    return;
  }
  box.innerHTML = ideasHTML(set);
}

function copyIdea(text, btn) {
  const done = () => {
    btn.textContent = '✅ Copiado';
    setTimeout(() => { btn.textContent = '📋 Copiar'; }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => showToast('No se pudo copiar.', 'error'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { showToast('No se pudo copiar.', 'error'); }
    ta.remove();
  }
}

/* ============================================================
   "Lo que está funcionando": compara videos recientes contra
   el promedio del canal y muestra la mejor señal de cada tipo
   ============================================================ */

/* ============================================================
   "Lo que está funcionando": compara videos recientes contra
   el promedio del canal y muestra la mejor señal de cada tipo
   ============================================================ */
function durSeconds(str) {
  if (!str) return 0;
  const p = str.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return Number(p[0]) || 0;
}
function fmtDurSec(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
function mostCommonCat(arr) {
  const m = {};
  for (const x of arr) if (x) m[x] = (m[x] || 0) + 1;
  let best = '', n = 0;
  for (const k in m) if (m[k] > n) { n = m[k]; best = k; }
  return best;
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* ---------- Viral Score 0-100 ----------
   Rendimiento (50) + Interacción (30) + Impulso (20) */
function computeViralScore(v, bag) {
  const d = bag.data;
  const recent = bag.videos || [];
  const n = recent.length;
  const sum = (f) => recent.reduce((a, x) => a + (f(x) || 0), 0);
  const avgViews = d.videos > 0 ? d.views / d.videos : (n ? sum((x) => x.views) / n : 0);
  const avgEng = n ? sum((x) => (x.views ? (x.likes + x.comments) / x.views : 0)) / n : 0;
  const daysChannel = Math.max((Date.now() - new Date(d.published)) / 86400000, 1);
  const avgDaily = d.views / daysChannel;

  const days = Math.max((Date.now() - new Date(v.published)) / 86400000, 1);
  const views = Number(v.views) || 0;
  const engRate = views > 0 ? (Number(v.likes || 0) + Number(v.comments || 0)) / views : 0;
  const daily = views / days;

  const parts = [
    {
      key: 'views', label: 'Rendimiento', max: 50,
      frac: avgViews > 0 ? clamp01((views / avgViews) / 2.5) : 0,
      detail: avgViews > 0
        ? `${fmtCount(views)} vistas vs ${fmtCount(Math.round(avgViews))} promedio por video (${(views / avgViews).toFixed(2)}X)`
        : `${fmtCount(views)} vistas sin promedio de referencia aún`,
    },
    {
      key: 'eng', label: 'Interacción', max: 30,
      frac: avgEng > 0 ? clamp01((engRate / avgEng) / 1.2) : (engRate > 0 ? 0.4 : 0),
      detail: avgEng > 0
        ? `${pct(engRate)} (likes+comentarios)/vistas vs ${pct(avgEng)} de tu promedio`
        : `${pct(engRate)} de interacción (likes + comentarios)`,
    },
    {
      key: 'vel', label: 'Impulso', max: 20,
      frac: avgDaily > 0 ? clamp01((daily / avgDaily) / 1.2) : 0,
      detail: avgDaily > 0
        ? `~${fmtCount(Math.round(daily))} vistas/día vs ${fmtCount(Math.round(avgDaily))} del promedio del canal`
        : '—',
    },
  ];

  let total = 0;
  parts.forEach((p) => { p.points = Math.round(p.frac * p.max); total += p.points; });
  return { total, parts };
}

function scoreLevel(total) {
  if (total >= 85) return { cls: 'hot', icon: '🔥', label: 'En llamas' };
  if (total >= 70) return { cls: 'good', icon: '🟢', label: 'Buen ritmo' };
  return { cls: 'low', icon: '🔴', label: 'En desarrollo' };
}

function analyzeWhatsWorking(d, videos) {
  const n = videos.length;
  if (!n) return null;
  const sum = (f) => videos.reduce((a, v) => a + (f(v) || 0), 0);
  const avgViews = d.videos > 0 ? d.views / d.videos : sum((v) => v.views) / n;
  const avgEng = sum((v) => (v.views ? (v.likes + v.comments) / v.views : 0)) / n;
  const avgCmt = sum((v) => (v.views ? v.comments / v.views : 0)) / n;
  const avgLike = sum((v) => (v.views ? v.likes / v.views : 0)) / n;
  const avgDur = sum((v) => durSeconds(v.duration)) / n;
  const daysChannel = Math.max((Date.now() - new Date(d.published)) / 86400000, 1);
  const avgDaily = d.views / daysChannel;
  const dominantCat = mostCommonCat(videos.map((v) => v.categoryId));

  const cards = videos.map((v) => {
    const days = Math.max((Date.now() - new Date(v.published)) / 86400000, 1);
    const viewsRatio = avgViews > 0 ? v.views / avgViews : 0;
    const daily = v.views / days;
    const dailyRatio = avgDaily > 0 ? daily / avgDaily : 0;
    const cmt = v.views ? v.comments / v.views : 0;
    const like = v.views ? v.likes / v.views : 0;
    const eng = v.views ? (v.likes + v.comments) / v.views : 0;
    const interRatio = avgCmt > 0 ? cmt / avgCmt : (avgEng > 0 ? eng / avgEng : 0);

    const signals = [];
    if (avgCmt > 0 && cmt >= avgCmt * 1.15) signals.push(`💬 ${pct(cmt)} de comentarios vs ${pct(avgCmt)} de promedio`);
    if (avgLike > 0 && like >= avgLike * 1.15) signals.push(`👍 ${pct(like)} de likes vs ${pct(avgLike)} de promedio`);
    if (avgEng > 0 && eng >= avgEng * 1.1) signals.push(`🔥 Mayor interacción (${pct(eng)} vs ${pct(avgEng)} promedio)`);
    const dur = durSeconds(v.duration);
    if (avgDur > 0 && dur > 0) signals.push(`⏱ Duración ${fmtDurSec(dur)} vs promedio ${fmtDurSec(avgDur)}`);
    if (v.categoryId && v.categoryId !== dominantCat) signals.push(`📂 Categoría: ${categoryName(v.categoryId)}`);

    return { v, viewsRatio, daily, dailyRatio, cmt, like, eng, interRatio, signals, short: String(v.categoryId) === '42' };
  });

  return { avgViews, avgEng, avgCmt, avgDur, avgDaily, cards };
}

/* ============================================================
   Momentum: detecta videos que están acelerando entre cargas
   ============================================================ */
function momentumList() {
  const snaps = store.get(KEYS.snapshots, []);
  if (snaps.length < 2) return [];
  const out = [];
  for (const [, bag] of state.data) {
    for (const v of (bag.videos || [])) {
      const series = snaps
        .map((s) => ({ t: s.t, views: s.videos[v.id]?.v }))
        .filter((p) => typeof p.views === 'number')
        .sort((a, b) => a.t - b.t);
      if (series.length < 2) continue;
      const a = series[0];
      const b = series[series.length - 1];
      const dt = Math.max((b.t - a.t) / 86400000, 0.1);
      const dv = b.views - a.views;
      if (dv <= 0) continue;
      const rate = dv / dt; // vistas/día en este lapso
      const days = Math.max((Date.now() - new Date(v.published)) / 86400000, 1);
      const base = v.views / days; // ritmo medio del propio video desde publicación
      const ratio = base > 0 ? rate / base : 0;
      out.push({ v, bag, rate, base, ratio, series });
    }
  }
  return out.filter((m) => m.ratio >= 2).sort((a, b) => b.ratio - a.ratio).slice(0, 6);
}

function momentumHTML(m) {
  const v = m.v;
  const score = computeViralScore(v, m.bag).total;
  const lvCls = scoreLevel(score).cls;
  const pts = m.series;
  const min = Math.min(...pts.map((p) => p.views));
  const max = Math.max(...pts.map((p) => p.views));
  const range = (max - min) || 1;
  const W = 120, H = 40;
  const last = pts.length - 1;
  const poly = pts.map((p, i) => {
    const x = (i / last) * W;
    const y = H - 4 - ((p.views - min) / range) * (H - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const pct = Math.round((m.ratio - 1) * 100);
  const lv = m.ratio >= 4 ? 'mho' : 'mhi';
  return `
    <div class="mom-item ${lv}">
      <div class="mom-main">
        <a class="mom-title" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a>
        <div class="mom-meta">${esc(m.bag.data.name)} · ${fmtCount(v.views)} vistas</div>
        <button class="score-mini lv-${lvCls}" data-score-video="${escAttr(v.id)}" title="Ver el Viral Score">
          <span class="sm-icon">${scoreLevel(score).icon}</span><span class="sm-num">${score}</span><span class="sm-label">Viral</span>
        </button>
      </div>
      <div class="mom-right">
        <div class="mom-badge">🚨 MOMENTUM DETECTADO</div>
        <div class="mom-pct">+${pct}% <span>vs tu promedio</span></div>
        <svg class="mom-spark" viewBox="0 0 ${W} ${H}" width="100%" height="44" preserveAspectRatio="none">
          <polyline points="${poly}" />
        </svg>
      </div>
    </div>`;
}

function renderMomentum() {
  const box = $('#momentum-list');
  if (!box) return;
  if (!state.data.size) { box.innerHTML = ''; return; }
  const list = momentumList();
  const empty = $('#momentum-empty');
  if (!list.length) {
    box.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  box.innerHTML = list.map(momentumHTML).join('');
}

/* ============================================================
   🧬 Patrones: qué comparten los videos con mejor Viral Score
   ============================================================ */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const PAT_STOPWORDS = new Set((
  'de la el en es a los las con que un una del para por su mas sin o y al este esta '
  + 'ese como pero no asi si ya mis mi tu tus todo toda todos todas hoy hoyy aqui ha '
  + 'vs shorts short video videos canal mins mundo'
).trim().split(/\s+/));

function patternKeywords(titles) {
  const counts = {};
  for (const t of titles) {
    String(t || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .forEach((w) => {
        if (w.length > 3 && !PAT_STOPWORDS.has(w) && !/^\d+$/.test(w)) counts[w] = (counts[w] || 0) + 1;
      });
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 2)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
}

function fmtDurRange(lo, hi) {
  const f = (s) => (s < 60 ? `${Math.round(s)} seg` : fmtDurSec(s));
  return hi <= lo + 1 ? f(lo) : `${f(lo)} – ${f(hi)}`;
}

function fmtHourOfDay(x) {
  const hh = x % 24;
  const period = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 || 12;
  return `${h12}:00 ${period}`;
}

function fmtHourWindow(h) {
  return `${fmtHourOfDay(h)} – ${fmtHourOfDay(h + 2)}`;
}

function computePatterns(bag) {
  const videos = (bag.videos || [])
    .map((v) => ({ v, score: computeViralScore(v, bag).total }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.v);
  const n = videos.length;
  if (n < 3) return null;

  const durs = videos.map((v) => durSeconds(v.duration)).sort((a, b) => a - b);
  const durLo = quantile(durs, 0.25);
  const durHi = quantile(durs, 0.75);

  const bins = {};
  for (const v of videos) {
    const b = Math.floor(new Date(v.published).getHours() / 2) * 2;
    bins[b] = (bins[b] || 0) + 1;
  }
  const bestBin = Number(Object.keys(bins).sort((a, b) => bins[b] - bins[a] || Number(a) - Number(b))[0]);

  const kws = patternKeywords(videos.map((v) => v.title));

  const engs = videos
    .map((v) => (v.views ? (Number(v.likes) + Number(v.comments)) / v.views : 0))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);

  const shortsCount = videos.filter((v) => String(v.categoryId) === '42').length;

  return {
    n,
    durLo, durHi,
    bestBin, binCount: bins[bestBin],
    kws,
    engs,
    shortsCount, shortShare: shortsCount / n,
    medDur: quantile(durs, 0.5),
  };
}

function patRow(icon, label, value, sub) {
  return `
    <div class="pat-row">
      <div class="pat-icon">${icon}</div>
      <div class="pat-body">
        <div class="pat-label">${esc(label)}</div>
        <div class="pat-value">${esc(value)}</div>
        ${sub ? `<div class="pat-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
}

function patRowsHTML(p) {
  const format = p.shortShare >= 0.6 ? 'Shorts'
    : p.shortShare <= 0.4 ? 'Videos largos'
    : 'Mixto entre Shorts y largos';
  const rows = [
    patRow('⏱️', 'Duración', fmtDurRange(p.durLo, p.durHi),
      `Rango típico entre los ${p.n} mejores por Viral Score`),
    patRow('🕐', 'Publicación', p.binCount >= 2 ? fmtHourWindow(p.bestBin) : 'Variado',
      p.binCount >= 2
        ? `Ventana de 2 h que se repite en ${p.binCount} de ${p.n} videos`
        : 'Sin una hora clara: cada video se publicó a horas distintas'),
    patRow('🧠', 'Tema', p.kws.length ? p.kws.map((k) => `#${k}`).join(' ') : 'Variado',
      p.kws.length
        ? 'Palabras más repetidas en los títulos de tus mejores videos'
        : 'Los títulos no comparten palabras clave claras (publica y vuelve a cargar)'),
    patRow('🎬', 'Formato', format,
      `${p.shortsCount} de ${p.n} son Shorts`),
    patRow('💬', 'Interacción', p.engs.length ? pct(quantile(p.engs, 0.5)) : 'Sin señales aún',
      p.engs.length
        ? 'Mediana de (likes + comentarios) / vistas'
        : 'Aún no hay suficientes likes o comentarios medibles'),
  ];
  return rows.join('');
}

function renderPatterns() {
  const box = $('#patterns');
  if (!box) return;
  if (!state.data.size) { box.innerHTML = ''; return; }
  const filter = $('#channel-filter').value;
  const bagList = filter === 'all'
    ? [...state.data.values()]
    : (state.data.has(filter) ? [state.data.get(filter)] : []);
  box.innerHTML = '';
  let any = false;
  for (const bag of bagList) {
    const p = computePatterns(bag);
    if (!p) continue;
    any = true;
    const d = bag.data;
    box.insertAdjacentHTML('beforeend', `
      <div class="pat-channel">
        <div class="pat-channel-head">
          <img class="avatar" src="${escAttr(d.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <h3>${esc(d.name)}</h3>
        </div>
        <div class="pat-grid">${patRowsHTML(p)}</div>
      </div>`);
  }
  const empty = $('#patterns-empty');
  if (empty) empty.classList.toggle('hidden', any);
}

function wwCardFor(analysis, used, { type, emoji, metric, threshold, numFn, rest, subFn }) {
  const best = analysis.cards
    .filter((c) => !used.has(c.v.id) && c[metric] >= threshold)
    .sort((a, b) => b[metric] - a[metric])[0] || null;
  if (!best) return null;
  used.add(best.v.id);
  const why = best.signals.length
    ? `<span>¿Por qué?</span>` + best.signals.slice(0, 3).map((s) => `<span class="ww-chip">${s}</span>`).join('')
    : `<span>¿Por qué?</span><span class="ww-chip">Llegó a más público que tu promedio</span>`;
  return `
    <a class="ww-card ${type}" href="https://www.youtube.com/watch?v=${encodeURIComponent(best.v.id)}" target="_blank" rel="noopener">
      <div class="ww-metric"><span class="ww-emoji">${emoji}</span><b>${numFn(best)}</b><span>${esc(rest)}</span></div>
      <div class="ww-title">${esc(best.v.title)}${best.short ? '<span class="video-shorts-badge">#Shorts</span>' : ''}</div>
      <div class="ww-why">${why}</div>
      <div class="ww-sub">${esc(subFn(best))}</div>
    </a>`;
}

function renderWhatsWorking() {
  const box = $('#ww-cards');
  if (!state.data.size) { box.innerHTML = ''; return; }
  const filter = $('#channel-filter').value;
  const bagList = filter === 'all'
    ? [...state.data.values()]
    : (state.data.has(filter) ? [state.data.get(filter)] : []);
  box.innerHTML = '';
  for (const bag of bagList) {
    const d = bag.data;
    const analysis = analyzeWhatsWorking(d, bag.videos || []);
    if (!analysis) continue;
    const used = new Set();
    const html = [
      wwCardFor(analysis, used, {
        type: 'views', emoji: '🔥', metric: 'viewsRatio', threshold: 1.15,
        numFn: (c) => `${c.viewsRatio.toFixed(1)}X`,
        rest: 'mejor que tu promedio',
        subFn: () => `Rendimiento vs ${fmtCount(Math.round(analysis.avgViews))} vistas por video de promedio`,
      }),
      wwCardFor(analysis, used, {
        type: 'momentum', emoji: '⚡', metric: 'dailyRatio', threshold: 1.15,
        numFn: (c) => `${c.dailyRatio.toFixed(1)}X`,
        rest: 'el ritmo diario de tu canal',
        subFn: (c) => `Suma ~${fmtCount(Math.round(c.daily))} vistas/día vs ${fmtCount(Math.round(analysis.avgDaily))} del promedio`,
      }),
      wwCardFor(analysis, used, {
        type: 'interaction', emoji: '💬', metric: 'interRatio', threshold: 1.15,
        numFn: (c) => `${c.interRatio.toFixed(1)}X`,
        rest: 'más activa tu comunidad',
        subFn: (c) => analysis.avgCmt > 0
          ? `${pct(c.cmt)} de comentarios vs ${pct(analysis.avgCmt)} de promedio`
          : `${pct(c.eng)} de interacción vs ${pct(analysis.avgEng)} de promedio`,
      }),
    ].filter(Boolean).join('');

    box.insertAdjacentHTML('beforeend', `
      <div class="ww-channel">
        <div class="ww-channel-head">
          <img class="avatar" src="${escAttr(d.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <h3>${esc(d.name)}</h3>
        </div>
        <div class="ww-grid">${html || '<p class="ww-empty">Aún no hay señales claras sobre tu promedio. Publica más videos y vuelve a cargar.</p>'}</div>
      </div>`);
  }
}

/* Histograma: cuántos videos publica cada canal a cada hora del día */
function updateHourChart() {
  const canvas = $('#chart-hour-dist');
  if (typeof Chart === 'undefined' || !state.data.size) return;

  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

  // Por canal: contar en cuáles horas se publicó cada video
  const datasets = [];
  let ci = 0;
  for (const [cid, bag] of state.data) {
    const d = bag.data;
    const videos = bag.videos || [];
    if (!videos.length) continue;
    const counts = new Array(24).fill(0);
    for (const v of videos) {
      const h = new Date(v.published).getHours();
      counts[h]++;
    }
    const color = chartColors[ci++ % chartColors.length];
    datasets.push({
      label: d.name,
      data: counts,
      backgroundColor: color + 'b3',
      borderColor: color,
      borderWidth: 1,
      borderRadius: 4,
    });
  }

  if (!datasets.length) return;
  destroyChart('hourDist');
  state.charts.hourDist = new Chart(canvas, {
    type: 'bar',
    data: { labels: hourLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#eef1f7', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${c.raw} video${c.raw === 1 ? '' : 's'}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#98a1b5', font: { size: 9 }, maxTicksLimit: 12 },
          grid: { display: false },
          border: { color: '#262c3d' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#98a1b5', precision: 0 },
          grid: { color: 'rgba(255,255,255,0.06)' },
          border: { color: '#262c3d' },
        },
      },
    },
  });
}

/* Mejor horario de publicación: calcula la calidad de cada hora
   con los propios videos (views relativas al promedio + interacción),
   sin recurrir a estadísticas generales de internet. */
function hourRanking() {
  const filter = $('#channel-filter').value;
  const bagList = filter === 'all'
    ? [...state.data.values()]
    : (state.data.has(filter) ? [state.data.get(filter)] : []);
  const byHour = {};
  let videosSum = 0;
  let engSum = 0;
  let engN = 0;
  for (const bag of bagList) {
    const d = bag.data;
    const videos = bag.videos || [];
    if (!videos.length) continue;
    const sum = (f) => videos.reduce((a, v) => a + (f(v) || 0), 0);
    const avgViews = d.videos > 0 ? d.views / d.videos : sum((v) => v.views) / videos.length;
    for (const v of videos) {
      const h = new Date(v.published).getHours();
      const ratio = avgViews > 0 ? (Number(v.views) || 0) / avgViews : 0;
      const eng = (Number(v.views) || 0) > 0
        ? (Number(v.likes || 0) + Number(v.comments || 0)) / (Number(v.views) || 0)
        : 0;
      (byHour[h] ??= { ratios: [], eng: [], n: 0 });
      byHour[h].ratios.push(ratio);
      byHour[h].eng.push(eng);
      byHour[h].n++;
      videosSum++;
      engSum += eng;
      if (eng > 0) engN++;
    }
  }
  const avgEng = engSum > 0 ? engSum / videosSum : 0;
  const rows = Object.entries(byHour)
    .map(([h, o]) => {
      const s = o.ratios.slice().sort((a, b) => a - b);
      const medRatio = quantile(s, 0.5);
      const medEng = o.eng.slice().sort((a, b) => a - b);
      const eng = o.eng.reduce((a, b) => a + b, 0) / o.n;
      const perf = clamp01(medRatio / 1.8) * 70;
      const inter = avgEng > 0 ? clamp01(eng / (avgEng * 1.2)) * 30 : 0;
      let score = perf + inter;
      score = score * (o.n / (o.n + 2)) + 50 * (2 / (o.n + 2)); // castiga muestras mínimas
      return { h: Number(h), n: o.n, mean: medRatio, eng, score: Math.round(score) };
    })
    .sort((a, b) => b.score - a.score || b.n - a.n)
    .slice(0, 8);
  return { rows, total: videosSum, avgEng };
}

function hourLevel(score) {
  if (score >= 75) return { icon: '🔥', label: 'Excelente', cls: 'great' };
  if (score >= 60) return { icon: '🟢', label: 'Bueno', cls: 'good' };
  if (score >= 45) return { icon: '🟡', label: 'Normal', cls: 'mid' };
  return { icon: '🔴', label: 'Evitar', cls: 'bad' };
}

function renderHourRank() {
  const box = $('#hour-rank');
  if (!box || !state.data.size) return;
  const { rows, total, avgEng } = hourRanking();
  if (!rows.length) {
    box.innerHTML = '<p class="muted small">Publica videos y vuelve a cargar datos (↻) para calcular tu mejor horario.</p>';
    return;
  }
  const best = rows[0];
  const bl = hourLevel(best.score);
  box.innerHTML = `
    <div class="hour-best ${bl.cls}">
      <div class="hour-best-time">${fmtHourOfDay(best.h)}</div>
      <div class="hour-best-chip ${bl.cls}">${bl.icon} ${bl.label}</div>
      <p class="hour-best-sub">Mejor momento según tus ${total} videos propios${avgEng ? ` · ${pct(avgEng)} de interacción media` : ''}.</p>
    </div>
    <div class="hour-list">
      ${rows.map((r) => {
        const lv = hourLevel(r.score);
        return `
          <div class="hour-row">
            <span class="hour-time">${fmtHourOfDay(r.h)}</span>
            <span class="hour-meter"><i style="width:${Math.min(100, r.score)}%"></i></span>
            <span class="hour-level ${lv.cls}">${lv.icon} ${lv.label}</span>
            <span class="hour-extra">${r.n} vid.${avgEng ? ` · ${pct(r.eng)}` : ''}</span>
          </div>`;
      }).join('')}
    </div>`;
}

/* --- Historial / evolución --- */
function renderHistory() {
  const hist = store.get(KEYS.history, []);
  const empty = $('#history-empty');
  const msg = $('#empty-msg');
  const sub = $('#empty-sub');
  const canChart = hist.length >= 2 && typeof Chart !== 'undefined';

  // Mensajes según cuántos puntos hay (nunca destruye el botón)
  if (hist.length === 0) {
    msg.textContent = 'Aún no hay puntos de evolución. Se registra uno diario cada vez que abres el panel.';
    sub.textContent = '¿Quieres verlo ya? Descarga los datos (pulsa ↻ arriba) y guarda un punto con el botón.';
  } else if (hist.length === 1) {
    const last = hist[hist.length - 1];
    const totS = channels.reduce((a, c) => a + (last.points[c.id]?.s ?? 0), 0);
    msg.textContent = `Ya tienes 1 punto registrado${last.manual ? ' (punto manual)' : ` (${fmtDateLong(last.date.split('T')[0])})`}.`;
    sub.textContent = `Los gráficos necesitan al menos 2 puntos. Vuelve otro día y aparece automáticamente, o guarda otro punto ahora. Suscriptores actuales en ${channels.length} canal${channels.length > 1 ? 'es' : ''}: ${fmtFull.format(totS)}`;
  }
  $('#btn-record-history').style.display = canChart ? 'none' : '';
  empty.classList.toggle('hidden', canChart);

  if (!canChart) return;

  const labels = hist.map((h) => fmtDateShort(h.date));
  const mkSet = (field) => {
    const set = [];
    let i = 0;
    for (const c of channels) {
      const color = chartColors[i++ % chartColors.length];
      set.push({
        label: c.name,
        data: hist.map((h) => h.points[c.id]?.[field] ?? null),
        borderColor: color,
        backgroundColor: color + '22',
        fill: false,
        tension: 0.35,
        pointRadius: 2,
        spanGaps: true,
      });
    }
    return set;
  };

  destroyChart('subs');
  state.charts.subs = new Chart($('#chart-subs'), {
    type: 'line',
    data: { labels, datasets: mkSet('s') },
    options: lineOptions(),
  });
  destroyChart('views');
  state.charts.views = new Chart($('#chart-views'), {
    type: 'line',
    data: { labels, datasets: mkSet('v') },
    options: lineOptions(),
  });
}

function lineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#eef1f7', font: { size: 11 } } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtFull.format(c.parsed.y ?? 0)}` } },
    },
    scales: {
      x: {
        ticks: { color: '#98a1b5', font: { size: 10 }, maxTicksLimit: 8 },
        grid: { color: 'rgba(255,255,255,0.05)' },
        border: { color: '#262c3d' },
      },
      y: {
        ticks: { color: '#98a1b5', callback: (v) => fmtCount(v) },
        grid: { color: 'rgba(255,255,255,0.05)' },
        border: { color: '#262c3d' },
      },
    },
  };
}

function fmtDateShort(date) {
  // Los puntos manuales llevan fecha ISO completa (con hora)
  if (date.includes('T')) {
    const d = new Date(date);
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  const parts = date.split('-');
  return `${parseInt(parts[2], 10)}/${parseInt(parts[1], 10)}`;
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

/* ============================================================
   Ajustes
   ============================================================ */
function setupSettings() {
  $('#input-apikey').value = apiKey;
  $('#input-maxvideos').value = maxVideos;
  $('#lbl-maxvideos').textContent = `${maxVideos} videos`;
  $('#switch-alerts').checked = alertCfg.enabled;
  $('#input-minviews').value = alertCfg.minViews || 0;
  $('#input-minscore').value = alertCfg.minScore || 0;
  renderChannelList();
}

function renderChannelList() {
  const box = $('#channel-list');
  if (!channels.length) {
    box.innerHTML = '<p class="muted">Aún no agregas canales.</p>';
    return;
  }
  box.innerHTML = '';
  for (const c of channels) {
    const el = document.createElement('div');
    el.className = 'ch-item';
    el.innerHTML = `
      <img class="avatar" src="${escAttr(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="ch-name">${esc(c.name)}<span class="ch-handle">${esc(c.handle || c.id)}</span></div>
      <button class="remove-btn" data-id="${escAttr(c.id)}">Quitar</button>`;
    box.appendChild(el);
  }
  $$('.remove-btn').forEach((b) =>
    b.addEventListener('click', () => removeChannel(b.dataset.id))
  );
}

function removeChannel(id) {
  channels = channels.filter((c) => c.id !== id);
  state.data.delete(id);
  persistChannels();
  renderChannelList();
  refreshScreens();
  if (apiKey && channels.length) loadStats();
  else renderAll();
}

/* ============================================================
   Navegación
   ============================================================ */
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (name === 'history') renderHistory();
  if (name === 'ranking') renderRanking();
  if (name === 'settings') setupSettings();
}

/* ============================================================
   Pantallas
   ============================================================ */
function refreshScreens() {
  const noKey = !apiKey;
  const noChans = !channels.length;
  $('#screen-setup').classList.toggle('hidden', !noKey);
  $('#screen-nodata').classList.toggle('hidden', noKey || !noChans);
  $('#screen-main').classList.toggle('hidden', noKey || noChans);
  $('#tabbar').classList.toggle('hidden', noKey || noChans);
}

/* Abre la pestaña de Ajustes aunque aún no haya key ni canales */
function openSettings() {
  $('#screen-setup').classList.add('hidden');
  $('#screen-nodata').classList.add('hidden');
  $('#screen-main').classList.remove('hidden');
  $('#tabbar').classList.remove('hidden');
  switchTab('settings');
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function showToast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function setRefresh(on) {
  $('#btn-refresh').classList.toggle('spinning', on);
}

/* ============================================================
   Eventos
   ============================================================ */
function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btn-home').addEventListener('click', () => switchTab('dashboard'));
  $('#btn-refresh').addEventListener('click', loadStats);
  $$('[data-action]').forEach((b) => b.addEventListener('click', openSettings));
  $('#btn-settings').addEventListener('click', openSettings);

  $('#btn-alerts').addEventListener('click', openAlerts);
  $('#btn-ideas').addEventListener('click', renderIdeas);
  $('#ideas-result').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-copy');
    if (btn) copyIdea(btn.dataset.copy, btn);
  });
  $('#btn-clear-alerts').addEventListener('click', clearAlerts);
  $('#alerts-close').addEventListener('click', closeAlerts);
  $('#alerts-backdrop').addEventListener('click', closeAlerts);
  $('#alerts-list').addEventListener('click', (e) => {
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) { dismissAlert(dismiss.dataset.dismiss); return; }
    const mini = e.target.closest('.score-mini');
    if (mini) openScoreModal(mini.dataset.scoreVideo);
  });
  $('#switch-alerts').addEventListener('change', updateAlertCfg);
  ['#input-minviews', '#input-minscore'].forEach((sel) =>
    $(sel).addEventListener('change', updateAlertCfg));

  $('#channel-filter').addEventListener('change', () => { renderSummary(); renderWhatsWorking(); });

  $('#btn-save-key').addEventListener('click', saveKey);
  $('#btn-test-key').addEventListener('click', testKey);
  $('#btn-add-channel').addEventListener('click', addChannel);
  $('#input-channel').addEventListener('keydown', (e) => { if (e.key === 'Enter') addChannel(); });

  $('#input-maxvideos').addEventListener('input', (e) => {
    maxVideos = Number(e.target.value);
    store.set(KEYS.maxVideos, maxVideos);
    $('#lbl-maxvideos').textContent = `${maxVideos} videos`;
  });

  $('#btn-record-history').addEventListener('click', recordManualPoint);
  $('#btn-snapshot-history').addEventListener('click', recordManualPoint);

  ['#videos-list', '#rank-podium', '#rank-videos', '#momentum-list'].forEach((sel) => {
    $(sel).addEventListener('click', (e) => {
      const btn = e.target.closest('.score-mini');
      if (btn) openScoreModal(btn.dataset.scoreVideo);
    });
  });
  $('#rank-period').addEventListener('change', renderRanking);
  $('#rank-type').addEventListener('change', renderRanking);
  $('#score-close').addEventListener('click', closeScoreModal);
  $('#score-backdrop').addEventListener('click', closeScoreModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#score-modal').classList.contains('hidden')) closeScoreModal();
    if (e.key === 'Escape' && !$('#alerts-modal').classList.contains('hidden')) closeAlerts();
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('¿Borrar todos los datos guardados (API key, canales e historial)?')) return;
    Object.values(KEYS).forEach((k) => store.del(k));
    location.reload();
  });
}

function saveKey() {
  const v = $('#input-apikey').value.trim();
  if (!v) { showToast('Escribe una API key.', 'error'); return; }
  apiKey = v;
  store.set(KEYS.apikey, v);
  refreshScreens();
  setupSettings();
  showToast('Clave guardada. Cargando datos…', 'success');
  loadStats();
}

/* Prueba de conexión con la API (no guarda la key automáticamente) */
async function testKey() {
  const v = $('#input-apikey').value.trim();
  if (!v) { showToast('Primero escribe una clave.', 'error'); return; }
  const btn = $('#btn-test-key');
  btn.disabled = true;
  btn.textContent = 'Probando…';
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=1&key=${encodeURIComponent(v)}`
    );
    if (res.ok) showToast('La clave funciona correctamente.', 'success');
    else {
      const body = await res.json().catch(() => null);
      const e = YT._httpError(res.status, body);
      showToast(e.message, 'error');
    }
  } catch {
    showToast('Sin conexión a internet.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Probar conexión';
  }
}

async function addChannel() {
  const input = $('#input-channel');
  const msg = $('#add-channel-msg');
  const value = input.value.trim();
  if (!value) { showToast('Escribe la URL o @handle del canal.', 'error'); return; }
  msg.className = 'msg';
  msg.textContent = 'Buscando canal…';
  input.disabled = true;
  try {
    const ch = await YT.resolveChannel(value);
    if (channels.some((c) => c.id === ch.id)) {
      msg.className = 'msg error';
      msg.textContent = 'Ese canal ya está en tu lista.';
      return;
    }
    channels.push({ id: ch.id, name: ch.name, handle: ch.handle, thumb: ch.thumb });
    persistChannels();
    input.value = '';
    msg.className = 'msg success';
    msg.textContent = `Se agregó ${ch.name}.`;
    renderChannelList();
    refreshScreens();
    await loadStats();
    recordManualPoint();
  } catch (e) {
    msg.className = 'msg error';
    msg.textContent = e.message;
  } finally {
    input.disabled = false;
  }
}

/* ============================================================
   Init
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  setupSettings();
  refreshScreens();
  renderAlertBadge();
  if (apiKey && channels.length) loadStats();
});