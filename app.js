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
   Historial de evolución (snapshots por día)
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
    renderAll();
    showToast('Datos actualizados', 'success');
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
  renderComparison();
  renderRank();
  renderVideos();
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
      ${videos.length ? videos.map(videoCardHTML).join('') : '<p class="muted">Sin datos de videos.</p>'}`;
    box.appendChild(block);
  }
  const n = state.data.size;
  $('#lbl-videos-info').textContent = `${total} videos · ${n} canal${n > 1 ? 'es' : ''}`;
}

function videoCardHTML(v) {
  const short = String(v.categoryId) === '42';
  return `
    <a class="video-card" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">
      <div class="video-thumb-wrap">
        <img class="video-thumb" src="${escAttr(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        <span class="video-thumb-duration">${esc(v.duration)}</span>
      </div>
      <div class="video-body">
        <div class="video-title">${esc(v.title)}${short ? '<span class="video-shorts-badge">#Shorts</span>' : ''}</div>
        <div class="video-date">${fmtDateTime(v.published)} · ${timeAgo(v.published)}</div>
        <div class="video-stats">
          <span class="video-stat">👁 <b>${fmtCount(v.views)}</b></span>
          <span class="video-stat">👍 <b>${fmtCount(v.likes)}</b></span>
          <span class="video-stat">💬 <b>${fmtCount(v.comments)}</b></span>
          <span class="video-stat">${esc(categoryName(v.categoryId))}</span>
        </div>
        ${v.desc ? `<div class="video-desc">${esc(v.desc)}</div>` : ''}
      </div>
    </a>`;
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

  $('#channel-filter').addEventListener('change', renderSummary);

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
  if (apiKey && channels.length) loadStats();
});