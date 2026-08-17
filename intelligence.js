'use strict';

/* ============================================================
   YouTube Content Intelligence — intelligence.js
   Motor de recopilación, normalización, cálculo de métricas avanzadas,
   exportación a Excel (17 hojas), JSON jerárquico y Prompt para IA.
   ============================================================ */

(function () {
  /* ---------- 1. DATA COLLECTOR ---------- */
  const IntelligenceDataCollector = {
    async collectChannelData(channelId, periodDays = 'all') {
      if (!apiKey) {
        throw new Error('No hay clave de API configurada. Revisa la sección de Ajustes.');
      }

      // 1. Obtener detalles completos del canal
      let channel = null;
      const cachedBag = state.data.get(channelId);
      if (cachedBag && cachedBag.data) {
        channel = { ...cachedBag.data };
      } else {
        const chans = await YT.channelByIds(channelId);
        if (!chans.length) throw new Error('No se pudo encontrar el canal en YouTube.');
        channel = chans[0];
      }

      // Enriquecer datos del canal con branding / topics si es posible
      try {
        const extraChanData = await YT.call('channels', {
          part: 'snippet,contentDetails,statistics,brandingSettings,topicDetails',
          id: channelId,
        });
        if (extraChanData.items && extraChanData.items[0]) {
          const item = extraChanData.items[0];
          channel.branding = item.brandingSettings || {};
          channel.topicDetails = item.topicDetails || {};
          channel.keywords = item.brandingSettings?.channel?.keywords || '';
        }
      } catch (e) {
        console.warn('No se pudieron obtener datos branding/topic del canal:', e);
      }

      // 2. Obtener lista completa de videos del canal
      const videos = await this.fetchAllVideos(channel);

      // 3. Filtrar videos por período si aplica
      const filteredVideos = this.filterVideosByPeriod(videos, periodDays);

      // 4. Obtener historial local guardado
      const historySnapshots = getHistory();
      const videoSnapshots = store.get(KEYS.snapshots, []) || [];
      const channelGoals = goals[channelId] || null;

      return {
        channel,
        videos: filteredVideos,
        allVideosCount: videos.length,
        periodDays,
        historySnapshots,
        videoSnapshots,
        channelGoals,
      };
    },

    async fetchAllVideos(channel) {
      const pid = channel.uploadsPlaylist;
      if (!pid) return [];

      let allVideoIds = [];
      let nextPageToken = '';
      let pageCount = 0;
      const maxPages = 10; // Hasta 500 videos para cuidar cuota y velocidad

      while (pageCount < maxPages) {
        pageCount++;
        const params = {
          part: 'contentDetails',
          playlistId: pid,
          maxResults: 50,
        };
        if (nextPageToken) params.pageToken = nextPageToken;

        let data;
        try {
          data = await YT.call('playlistItems', params);
        } catch (e) {
          console.warn('Error al paginar playlistItems:', e);
          break;
        }

        const ids = (data.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
        if (!ids.length) break;

        allVideoIds = allVideoIds.concat(ids);
        nextPageToken = data.nextPageToken;
        if (!nextPageToken) break;
      }

      if (!allVideoIds.length) return [];

      // Obtener detalles de videos en bloques de 50
      const detailedVideos = [];
      for (let i = 0; i < allVideoIds.length; i += 50) {
        const chunk = allVideoIds.slice(i, i + 50);
        try {
          const vdata = await YT.call('videos', {
            part: 'snippet,statistics,contentDetails,status,topicDetails',
            id: chunk.join(','),
          });
          const items = (vdata.items || []).map((v) => this.shapeFullVideo(v, channel));
          detailedVideos.push(...items);
        } catch (e) {
          console.warn('Error al obtener chunk de videos:', e);
        }
      }

      return detailedVideos;
    },

    shapeFullVideo(v, channel) {
      const durSec = durSeconds(parseDuration(v.contentDetails?.duration));
      const isShortCat = String(v.snippet?.categoryId) === '42';
      const isShortDuration = durSec > 0 && durSec <= 60;
      const isShort = isShortCat || isShortDuration;
      const isLive = v.snippet?.liveBroadcastContent === 'live' || v.contentDetails?.duration === 'P0D';

      let contentType = 'long_form';
      if (isLive) contentType = 'live';
      else if (isShort) contentType = 'short';

      return {
        id: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.snippet?.title || '',
        description: v.snippet?.description || '',
        publishedAt: v.snippet?.publishedAt || '',
        updatedAt: v.snippet?.publishedAt || '',
        channelId: channel.id,
        channelTitle: channel.name,
        categoryId: v.snippet?.categoryId || '',
        categoryName: categoryName(v.snippet?.categoryId || ''),
        tags: v.snippet?.tags || [],
        defaultLanguage: v.snippet?.defaultLanguage || v.snippet?.defaultAudioLanguage || 'N/A',
        liveBroadcastContent: v.snippet?.liveBroadcastContent || 'none',
        privacyStatus: v.status?.privacyStatus || 'public',
        durationIso: v.contentDetails?.duration || '',
        durationFormatted: parseDuration(v.contentDetails?.duration) || '0:00',
        durationSeconds: durSec,
        contentType,
        isShort,
        isLive,
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        favorites: Number(v.statistics?.favoriteCount || 0),
        thumbnails: v.snippet?.thumbnails || {},
        topicCategories: v.topicDetails?.topicCategories || [],
      };
    },

    filterVideosByPeriod(videos, periodDays) {
      if (!periodDays || periodDays === 'all') return videos;
      const days = parseInt(periodDays, 10);
      if (isNaN(days) || days <= 0) return videos;
      const cutoff = Date.now() - days * 86400000;
      return videos.filter((v) => {
        const time = new Date(v.publishedAt).getTime();
        return !isNaN(time) && time >= cutoff;
      });
    },
  };

  /* ---------- 2. TITLE ANALYZER ---------- */
  const IntelligenceTitleAnalyzer = {
    analyze(title = '') {
      const clean = String(title).trim();
      const chars = clean.length;
      const words = clean ? clean.split(/\s+/).filter(Boolean) : [];
      const wordCount = words.length;

      // Emojis regex
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;
      const emojisFound = clean.match(emojiRegex) || [];
      const emojiCount = emojisFound.length;

      // Hashtags
      const hashtagRegex = /#[\w\u0590-\u05ff]+/gi;
      const hashtagsFound = clean.match(hashtagRegex) || [];
      const hashtagCount = hashtagsFound.length;

      // Mayúsculas
      const lettersOnly = clean.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, '');
      const uppercaseOnly = clean.replace(/[^A-ZÁÉÍÓÚÑ]/g, '');
      const uppercaseRatio = lettersOnly.length > 0 ? uppercaseOnly.length / lettersOnly.length : 0;
      const isAllUppercase = lettersOnly.length > 3 && uppercaseRatio >= 0.85;

      // Números
      const numbersFound = clean.match(/\b\d+\b/g) || [];
      const hasNumber = numbersFound.length > 0;

      // Preguntas y exclamaciones
      const hasQuestion = /[?¿]/.test(clean);
      const hasExclamation = /[!¡]/.test(clean);

      // Primera y última palabra
      const firstWord = words[0] || '';
      const lastWord = words[words.length - 1] || '';

      // Extracción de patrones estructurales
      const detectedPatterns = [];
      const lower = clean.toLowerCase();

      if (hasQuestion || /^(cómo|como|qué|que|por qué|porque|cuándo|cuando|cuál|cual|quién|quien|how|what|why|when|which|who)\b/i.test(clean)) {
        detectedPatterns.push('Pregunta');
      }
      if (/^(cómo|como|how to)\b/i.test(clean)) {
        detectedPatterns.push('Tutorial / Cómo');
      }
      if (hasNumber && /^\d+\s|top\s*\d+|\b\d+\s*(consejos|tips|trucos|secretos|formas|pasos|razones|errores|cosas|hacks|reasons|steps|ways|rules)/i.test(lower)) {
        detectedPatterns.push('Lista / Numerado');
      }
      if (/\b(error|errores|peligro|cuidado|alerta|advertencia|nunca|evita|warning|danger|stop|never|mistake)\b/i.test(lower)) {
        detectedPatterns.push('Advertencia / Error');
      }
      if (/\b(vs|versus|contra|frente a|o|better|mejores|comparativa)\b/i.test(lower)) {
        detectedPatterns.push('Comparación');
      }
      if (/\b(secreto|oculto|nadie sabe|la verdad|revelado|secret|hidden|truth|revealed)\b/i.test(lower)) {
        detectedPatterns.push('Curiosidad / Misterio');
      }
      if (/\b(increíble|impactante|no creerás|sorprendente|shocking|unbelievable)\b/i.test(lower)) {
        detectedPatterns.push('Sorpresa');
      }
      if (/\b(mi historia|cómo logré|mi experiencia|story|experience|storytime)\b/i.test(lower)) {
        detectedPatterns.push('Historia / Testimonio');
      }

      if (!detectedPatterns.length) {
        detectedPatterns.push('Afirmación / Declarativo');
      }

      return {
        title: clean,
        charCount: chars,
        wordCount,
        emojiCount,
        emojis: emojisFound.join(' '),
        hashtagCount,
        hashtags: hashtagsFound.join(' '),
        uppercaseRatio: Math.round(uppercaseRatio * 100) / 100,
        isAllUppercase,
        hasNumber,
        numbersFound: numbersFound.join(', '),
        hasQuestion,
        hasExclamation,
        firstWord,
        lastWord,
        detectedPatterns: detectedPatterns.join(', '),
        primaryPattern: detectedPatterns[0] || 'Declarativo',
      };
    },
  };

  /* ---------- 3. DATA NORMALIZER ---------- */
  const IntelligenceNormalizer = {
    normalize(raw) {
      const { channel, videos, historySnapshots, videoSnapshots, periodDays, allVideosCount, channelGoals } = raw;

      // 1. Normalizar videos con análisis de título y miniaturas
      const normalizedVideos = videos.map((v) => {
        const titleAnalysis = IntelligenceTitleAnalyzer.analyze(v.title);
        const thumbs = v.thumbnails || {};
        const bestThumb = thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';

        return {
          ...v,
          titleAnalysis,
          bestThumbnailUrl: bestThumb,
          thumbnailResolutions: Object.keys(thumbs).join(', '),
        };
      });

      // 2. Normalizar series temporales a partir de videos
      const timeSeries = this.buildTimeSeries(normalizedVideos, historySnapshots, channel.id);

      // 3. Normalizar evolución por video individual desde snapshots
      const videoHistory = this.buildVideoHistory(normalizedVideos, videoSnapshots);

      return {
        metadata: {
          exportGeneratedAt: new Date().toISOString(),
          channelId: channel.id,
          channelTitle: channel.name,
          channelHandle: channel.handle || '',
          analyzedPeriod: periodDays === 'all' ? 'Todo el histórico' : `Últimos ${periodDays} días`,
          videosAnalyzed: normalizedVideos.length,
          totalChannelVideos: channel.videos || allVideosCount,
          applicationVersion: 'v33',
          apiDataSource: 'YouTube Data API v3 (Public Data API)',
        },
        channel,
        videos: normalizedVideos,
        timeSeries,
        videoHistory,
        channelGoals,
      };
    },

    buildTimeSeries(videos, historySnapshots, channelId) {
      // Agrupación por Día, Semana, Mes y Año según fecha de publicación de los videos
      const dailyMap = {};
      const weeklyMap = {};
      const monthlyMap = {};
      const yearlyMap = {};

      for (const v of videos) {
        if (!v.publishedAt) continue;
        const d = new Date(v.publishedAt);
        if (isNaN(d.getTime())) continue;

        const dayKey = d.toISOString().slice(0, 10);
        const monthKey = d.toISOString().slice(0, 7);
        const yearKey = String(d.getFullYear());

        // Semana ISO
        const weekKey = `${d.getFullYear()}-W${String(this.getWeekNumber(d)).padStart(2, '0')}`;

        this.accumulatePeriod(dailyMap, dayKey, v);
        this.accumulatePeriod(weeklyMap, weekKey, v);
        this.accumulatePeriod(monthlyMap, monthKey, v);
        this.accumulatePeriod(yearlyMap, yearKey, v);
      }

      // Complementar Daily con los snapshots históricos si existen
      const channelSnapshots = (historySnapshots || []).map((h) => {
        const pt = h.points?.[channelId];
        return {
          date: h.date?.slice(0, 10) || '',
          totalSubs: pt?.s ?? null,
          totalViews: pt?.v ?? null,
          totalVideos: pt?.vd ?? null,
        };
      }).filter((s) => s.date);

      return {
        daily: Object.values(dailyMap).sort((a, b) => b.period.localeCompare(a.period)),
        weekly: Object.values(weeklyMap).sort((a, b) => b.period.localeCompare(a.period)),
        monthly: Object.values(monthlyMap).sort((a, b) => b.period.localeCompare(a.period)),
        yearly: Object.values(yearlyMap).sort((a, b) => b.period.localeCompare(a.period)),
        channelSnapshots,
      };
    },

    accumulatePeriod(map, key, v) {
      if (!map[key]) {
        map[key] = {
          period: key,
          videoCount: 0,
          views: 0,
          likes: 0,
          comments: 0,
          shortsCount: 0,
          longFormCount: 0,
          liveCount: 0,
          // Métricas que requieren YouTube Analytics API
          watchTimeMinutes: 'N/A',
          impressions: 'N/A',
          ctr: 'N/A',
          subscribersGained: 'N/A',
        };
      }
      map[key].videoCount++;
      map[key].views += v.views || 0;
      map[key].likes += v.likes || 0;
      map[key].comments += v.comments || 0;
      if (v.contentType === 'short') map[key].shortsCount++;
      else if (v.contentType === 'live') map[key].liveCount++;
      else map[key].longFormCount++;
    },

    getWeekNumber(d) {
      const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    },

    buildVideoHistory(videos, videoSnapshots) {
      const historyRows = [];
      const videoMap = new Map(videos.map((v) => [v.id, v]));

      for (const snap of (videoSnapshots || [])) {
        const snapDate = new Date(snap.t).toISOString();
        for (const [vid, entry] of Object.entries(snap.videos || {})) {
          const vObj = videoMap.get(vid);
          if (vObj) {
            historyRows.push({
              videoId: vid,
              title: vObj.title,
              recordedAt: snapDate,
              viewsRecorded: entry.v,
              likes: vObj.likes,
              comments: vObj.comments,
              watchTime: 'N/A',
              impressions: 'N/A',
              ctr: 'N/A',
              subscribersGained: 'N/A',
            });
          }
        }
      }
      return historyRows;
    },
  };

  /* ---------- 4. DATA VALIDATOR ---------- */
  const IntelligenceValidator = {
    validate(normalizedData) {
      const warnings = [];
      const missingFields = [];
      const duplicatedRecords = [];
      const seenIds = new Set();

      const { videos, channel } = normalizedData;

      if (!videos || !videos.length) {
        warnings.push('El canal no contiene videos en el período seleccionado.');
      }

      videos.forEach((v, idx) => {
        // Validar duplicados
        if (seenIds.has(v.id)) {
          duplicatedRecords.push(`Video duplicado detectado ID: ${v.id} («${v.title}»)`);
        }
        seenIds.add(v.id);

        // Validar métricas
        if (v.views < 0) warnings.push(`Video ${v.id} tiene vistas negativas (${v.views}).`);
        if (v.likes < 0) warnings.push(`Video ${v.id} tiene likes negativos (${v.likes}).`);
        if (v.comments < 0) warnings.push(`Video ${v.id} tiene comentarios negativos (${v.comments}).`);
        if (v.likes > v.views && v.views > 10) {
          warnings.push(`Video ${v.id} tiene más likes (${v.likes}) que vistas (${v.views}). Posible anomalía de API.`);
        }

        // Validar fechas
        const pubTime = new Date(v.publishedAt).getTime();
        if (isNaN(pubTime)) {
          missingFields.push(`Video ${v.id} tiene fecha de publicación inválida: ${v.publishedAt}`);
        } else if (pubTime > Date.now() + 86400000) {
          warnings.push(`Video ${v.id} tiene fecha futura de publicación.`);
        }
      });

      const unavailableMetrics = [
        { metric: 'Watch Time (Tiempo de reproducción)', reason: 'Requiere OAuth y YouTube Analytics API (no disponible con API Key pública)' },
        { metric: 'Average View Duration (Duración media)', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Average Percentage Viewed (Retención %)', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Impressions & CTR (Impresiones y Clics)', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Subscribers Gained / Lost por Video', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Traffic Sources (Fuentes de tráfico)', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Audience Demographics & Geography', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Device & Operating System Breakdown', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Returning / New / Unique Viewers', reason: 'Requiere OAuth y YouTube Analytics API' },
        { metric: 'Revenue, RPM, CPM', reason: 'Requiere canal monetizado y YouTube Analytics API' },
      ];

      return {
        isValid: warnings.length === 0 && duplicatedRecords.length === 0,
        status: warnings.length === 0 ? 'PERFECT' : 'PASS_WITH_WARNINGS',
        warnings,
        missingFields,
        duplicatedRecords,
        unavailableMetrics,
        apiLimitations: 'Esta aplicación utiliza YouTube Data API v3 con clave de API pública. Los campos marcados como N/A requieren autenticación OAuth 2.0 y YouTube Analytics API.',
      };
    },
  };

  /* ---------- 5. METRICS CALCULATOR ---------- */
  const IntelligenceMetricsCalc = {
    calculate(normalizedData) {
      const { channel, videos, metadata } = normalizedData;
      const n = videos.length;

      const totalViews = videos.reduce((acc, v) => acc + (v.views || 0), 0);
      const totalLikes = videos.reduce((acc, v) => acc + (v.likes || 0), 0);
      const totalComments = videos.reduce((acc, v) => acc + (v.comments || 0), 0);

      const avgViews = n > 0 ? totalViews / n : 0;
      const avgLikes = n > 0 ? totalLikes / n : 0;
      const avgComments = n > 0 ? totalComments / n : 0;

      // Mediana de vistas
      const sortedViews = [...videos].map((v) => v.views).sort((a, b) => a - b);
      const medianViews = n > 0 ? quantile(sortedViews, 0.5) : 0;

      // Cálculo por video
      const enrichedVideos = videos.map((v) => {
        const views = v.views || 0;
        const likes = v.likes || 0;
        const comments = v.comments || 0;
        const pubTime = new Date(v.publishedAt).getTime();
        const daysSincePub = Math.max((Date.now() - pubTime) / 86400000, 0.1);

        const engagementRate = views > 0 ? ((likes + comments) / views) * 100 : 0;
        const likesPer1k = views > 0 ? (likes / views) * 1000 : 0;
        const commentsPer1k = views > 0 ? (comments / views) * 1000 : 0;
        const viewsPerDay = views / daysSincePub;
        const perfVsAvg = avgViews > 0 ? views / avgViews : 0;
        const perfVsMedian = medianViews > 0 ? views / medianViews : 0;

        // Viral score
        const bag = { data: channel, videos };
        const viralScore = computeViralScore(v, bag);

        return {
          ...v,
          calculated: {
            engagementRate: Math.round(engagementRate * 100) / 100,
            likesPer1k: Math.round(likesPer1k * 10) / 10,
            commentsPer1k: Math.round(commentsPer1k * 10) / 10,
            viewsPerDay: Math.round(viewsPerDay * 10) / 10,
            daysSincePublished: Math.round(daysSincePub * 10) / 10,
            perfVsChannelAvg: Math.round(perfVsAvg * 100) / 100,
            perfVsChannelMedian: Math.round(perfVsMedian * 100) / 100,
            viralScore: viralScore.total,
          },
        };
      });

      // Rankings
      const topByViews = [...enrichedVideos].sort((a, b) => b.views - a.views).slice(0, 10);
      const topByLikes = [...enrichedVideos].sort((a, b) => b.likes - a.likes).slice(0, 10);
      const topByComments = [...enrichedVideos].sort((a, b) => b.comments - a.comments).slice(0, 10);
      const topByEngagement = [...enrichedVideos].filter((v) => v.views >= Math.min(avgViews * 0.2, 50))
        .sort((a, b) => b.calculated.engagementRate - a.calculated.engagementRate).slice(0, 10);
      const topByViralScore = [...enrichedVideos].sort((a, b) => b.calculated.viralScore - a.calculated.viralScore).slice(0, 10);
      const topByVelocity = [...enrichedVideos].sort((a, b) => b.calculated.viewsPerDay - a.calculated.viewsPerDay).slice(0, 10);

      // Bottom Performers (considerando antigüedad > 7 días para no castigar videos recién subidos)
      const bottomPerformers = enrichedVideos
        .filter((v) => v.calculated.daysSincePublished >= 7 && v.views < avgViews * 0.5)
        .sort((a, b) => a.views - b.views)
        .slice(0, 10);

      // Desglose Shorts vs Videos Largos
      const shorts = enrichedVideos.filter((v) => v.contentType === 'short');
      const longVideos = enrichedVideos.filter((v) => v.contentType === 'long_form');

      const shortsAvgViews = shorts.length ? shorts.reduce((a, b) => a + b.views, 0) / shorts.length : 0;
      const longAvgViews = longVideos.length ? longVideos.reduce((a, b) => a + b.views, 0) / longVideos.length : 0;
      const shortsAvgEng = shorts.length ? shorts.reduce((a, b) => a + b.calculated.engagementRate, 0) / shorts.length : 0;
      const longAvgEng = longVideos.length ? longVideos.reduce((a, b) => a + b.calculated.engagementRate, 0) / longVideos.length : 0;

      // Palabras clave más exitosas
      const topTitles = topByViralScore.map((v) => v.title);
      const winningKeywords = patternKeywords(topTitles);

      return {
        enrichedVideos,
        channelSummary: {
          totalViewsAnalyzed: totalViews,
          totalLikesAnalyzed: totalLikes,
          totalCommentsAnalyzed: totalComments,
          avgViewsPerVideo: Math.round(avgViews),
          medianViewsPerVideo: Math.round(medianViews),
          avgLikesPerVideo: Math.round(avgLikes),
          avgCommentsPerVideo: Math.round(avgComments),
          avgEngagementRate: totalViews > 0 ? Math.round(((totalLikes + totalComments) / totalViews) * 10000) / 100 : 0,
          viewsPerSubscriber: channel.subs > 0 ? Math.round((channel.views / channel.subs) * 100) / 100 : 0,
        },
        formatComparison: {
          shortsCount: shorts.length,
          longFormCount: longVideos.length,
          shortsAvgViews: Math.round(shortsAvgViews),
          longAvgViews: Math.round(longAvgViews),
          shortsAvgEngagement: Math.round(shortsAvgEng * 100) / 100,
          longAvgEngagement: Math.round(longAvgEng * 100) / 100,
        },
        winningKeywords,
        rankings: {
          topByViews,
          topByLikes,
          topByComments,
          topByEngagement,
          topByViralScore,
          topByVelocity,
          bottomPerformers,
        },
        formulas: {
          engagementRate: '(likes + comments) / views * 100',
          likesPer1k: '(likes / views) * 1000',
          commentsPer1k: '(comments / views) * 1000',
          viewsPerDay: 'views / days_since_published',
          perfVsChannelAvg: 'views / channel_average_views',
          perfVsChannelMedian: 'views / channel_median_views',
          viralScore: 'Rendimiento(50) + Interacción(30) + Impulso(20) normalizado frente al promedio del canal',
        },
      };
    },
  };

  /* ---------- 6. EXCEL EXPORTER (17 HOJAS CON SHEETJS) ---------- */
  const IntelligenceExcelExporter = {
    export(dataPackage) {
      if (typeof XLSX === 'undefined') {
        throw new Error('La librería SheetJS (XLSX) no está cargada.');
      }

      const wb = XLSX.utils.book_new();
      const { metadata, channel, timeSeries, videoHistory } = dataPackage.normalizedData;
      const { quality } = dataPackage;
      const { enrichedVideos, channelSummary, formatComparison, rankings, formulas } = dataPackage.metricsData;

      // 1. Channel Overview
      const overviewRows = [
        ['MÉTRICA / CAMPO', 'VALOR', 'DESCRIPCIÓN / FUENTE'],
        ['ID del Canal', channel.id, 'Identificador único oficial'],
        ['Nombre del Canal', channel.name, 'Título público del canal'],
        ['Handle / URL personalizada', channel.handle || 'N/A', 'Handle @'],
        ['Suscriptores totales', channel.subs, 'YouTube Data API statistics'],
        ['Vistas totales acumuladas', channel.views, 'YouTube Data API statistics'],
        ['Videos públicos totales', channel.videos, 'YouTube Data API statistics'],
        ['Fecha de creación', channel.published, 'Fecha de registro en YouTube'],
        ['País', channel.country || 'N/A', 'País configurado'],
        ['Videos analizados en esta muestra', metadata.videosAnalyzed, 'Total de videos procesados'],
        ['Período analizado', metadata.analyzedPeriod, 'Rango de fechas seleccionado'],
        ['Vistas promedio por video', channelSummary.avgViewsPerVideo, 'Promedio de la muestra analizada'],
        ['Mediana de vistas por video', channelSummary.medianViewsPerVideo, 'Mediana de la muestra analizada'],
        ['Engagement Rate promedio', `${channelSummary.avgEngagementRate}%`, '(Likes + Comentarios) / Vistas'],
        ['Vistas por Suscriptor', channelSummary.viewsPerSubscriber, 'Vistas totales / Suscriptores'],
        ['Shorts analizados', formatComparison.shortsCount, 'Videos <= 60s o categoría Shorts'],
        ['Videos largos analizados', formatComparison.longFormCount, 'Videos tradicionales > 60s'],
        ['Vistas promedio en Shorts', formatComparison.shortsAvgViews, 'Promedio de vistas en formato Short'],
        ['Vistas promedio en Videos Largos', formatComparison.longAvgViews, 'Promedio de vistas en formato Largo'],
        ['Engagement promedio Shorts', `${formatComparison.shortsAvgEngagement}%`, 'Interacción en Shorts'],
        ['Engagement promedio Videos Largos', `${formatComparison.longAvgEngagement}%`, 'Interacción en Videos Largos'],
        ['Fecha de exportación', metadata.exportGeneratedAt, 'Timestamp ISO'],
        ['Fuente de API', metadata.apiDataSource, 'YouTube Data API v3'],
      ];
      this.addSheet(wb, 'Channel Overview', overviewRows);

      // 2. Videos
      const videosHeader = [
        'Video ID', 'Título', 'URL', 'Tipo de Contenido', 'Duración', 'Segundos', 'Fecha Publicación',
        'Vistas', 'Likes', 'Comentarios', 'Engagement Rate %', 'Likes por 1k', 'Comentarios por 1k',
        'Vistas / Día', 'Vs Promedio Canal', 'Vs Mediana Canal', 'Viral Score (0-100)', 'Categoría',
        'Idioma', 'Privacidad', 'Tags',
      ];
      const videoRows = [videosHeader, ...enrichedVideos.map((v) => [
        v.id, v.title, v.url, v.contentType, v.durationFormatted, v.durationSeconds, v.publishedAt,
        v.views, v.likes, v.comments, v.calculated.engagementRate, v.calculated.likesPer1k, v.calculated.commentsPer1k,
        v.calculated.viewsPerDay, v.calculated.perfVsChannelAvg, v.calculated.perfVsChannelMedian, v.calculated.viralScore,
        v.categoryName, v.defaultLanguage, v.privacyStatus, (v.tags || []).join(', '),
      ])];
      this.addSheet(wb, 'Videos', videoRows);

      // 3. Daily Metrics
      const dailyHeader = ['Fecha / Día', 'Videos Publicados', 'Vistas Sumadas', 'Likes Sumados', 'Comentarios Sumados', 'Shorts', 'Largos', 'Watch Time', 'Impresiones', 'CTR', 'Suscriptores Ganados'];
      const dailyRows = [dailyHeader, ...(timeSeries.daily || []).map((d) => [
        d.period, d.videoCount, d.views, d.likes, d.comments, d.shortsCount, d.longFormCount, d.watchTimeMinutes, d.impressions, d.ctr, d.subscribersGained,
      ])];
      this.addSheet(wb, 'Daily Metrics', dailyRows);

      // 4. Weekly Metrics
      const weeklyHeader = ['Semana (ISO)', 'Videos Publicados', 'Vistas Sumadas', 'Likes Sumados', 'Comentarios Sumados', 'Shorts', 'Largos', 'Watch Time', 'Impresiones', 'CTR'];
      const weeklyRows = [weeklyHeader, ...(timeSeries.weekly || []).map((w) => [
        w.period, w.videoCount, w.views, w.likes, w.comments, w.shortsCount, w.longFormCount, w.watchTimeMinutes, w.impressions, w.ctr,
      ])];
      this.addSheet(wb, 'Weekly Metrics', weeklyRows);

      // 5. Monthly Metrics
      const monthlyHeader = ['Mes (YYYY-MM)', 'Videos Publicados', 'Vistas Sumadas', 'Likes Sumados', 'Comentarios Sumados', 'Shorts', 'Largos', 'Watch Time', 'Impresiones', 'CTR'];
      const monthlyRows = [monthlyHeader, ...(timeSeries.monthly || []).map((m) => [
        m.period, m.videoCount, m.views, m.likes, m.comments, m.shortsCount, m.longFormCount, m.watchTimeMinutes, m.impressions, m.ctr,
      ])];
      this.addSheet(wb, 'Monthly Metrics', monthlyRows);

      // 6. Yearly Metrics
      const yearlyHeader = ['Año', 'Videos Publicados', 'Vistas Sumadas', 'Likes Sumados', 'Comentarios Sumados', 'Shorts', 'Largos'];
      const yearlyRows = [yearlyHeader, ...(timeSeries.yearly || []).map((y) => [
        y.period, y.videoCount, y.views, y.likes, y.comments, y.shortsCount, y.longFormCount,
      ])];
      this.addSheet(wb, 'Yearly Metrics', yearlyRows);

      // 7. Video History (Snapshots)
      const histHeader = ['Video ID', 'Título', 'Fecha Grabación Snapshot', 'Vistas Registradas', 'Likes', 'Comentarios', 'Watch Time', 'CTR'];
      const histRows = [histHeader, ...(videoHistory.length ? videoHistory.map((h) => [
        h.videoId, h.title, h.recordedAt, h.viewsRecorded, h.likes, h.comments, h.watchTime, h.ctr,
      ]) : [['Sin historial temporal local', 'Abre el panel en distintos días para acumular evolución por video', '', '', '', '', '', '']])];
      this.addSheet(wb, 'Video History', histRows);

      // 8. Traffic Sources (Documentado API Limit)
      const trafficRows = [
        ['Fuente de Tráfico', 'Porcentaje', 'Vistas Estimadas', 'Disponibilidad'],
        ['Búsqueda de YouTube', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Videos sugeridos', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Funciones de navegación / Feed de inicio', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Feed de Shorts', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Externo (Google, WhatsApp, etc.)', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Páginas del canal', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Notificaciones', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
      ];
      this.addSheet(wb, 'Traffic Sources', trafficRows);

      // 9. Audience (Documentado API Limit)
      const audienceRows = [
        ['Métrica de Audiencia', 'Valor', 'Estado', 'Nota Técnica'],
        ['Espectadores nuevos vs recurrentes', 'N/A', 'No disponible en Data API v3', 'Requiere YouTube Analytics API'],
        ['Espectadores únicos', 'N/A', 'No disponible en Data API v3', 'Requiere YouTube Analytics API'],
        ['Suscriptores que activaron campana', 'N/A', 'No disponible en Data API v3', 'Requiere YouTube Analytics API'],
        ['Género (Masculino / Femenino)', 'N/A', 'No disponible en Data API v3', 'Requiere YouTube Analytics API'],
        ['Distribución por Edad (18-24, 25-34, etc.)', 'N/A', 'No disponible en Data API v3', 'Requiere YouTube Analytics API'],
      ];
      this.addSheet(wb, 'Audience', audienceRows);

      // 10. Geography (Documentado API Limit)
      const geoRows = [
        ['País / Región', 'Código ISO', 'Vistas %', 'Disponibilidad'],
        [channel.country ? `País principal del canal: ${channel.country}` : 'País del canal no especificado', channel.country || 'N/A', '100% (Origen canal)', 'Disponible en snippet'],
        ['Desglose geográfico de audiencia', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
      ];
      this.addSheet(wb, 'Geography', geoRows);

      // 11. Devices (Documentado API Limit)
      const devRows = [
        ['Tipo de Dispositivo / SO', 'Vistas %', 'Watch Time %', 'Disponibilidad'],
        ['Teléfono móvil', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Computadora / Ordenador', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['TV / Smart TV / Consola', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
        ['Tablet', 'N/A', 'N/A', 'Requiere YouTube Analytics API + OAuth 2.0'],
      ];
      this.addSheet(wb, 'Devices', devRows);

      // 12. Title Analysis
      const titleHeader = [
        'Video ID', 'Título', 'Caracteres', 'Palabras', 'Emojis (Cantidad)', 'Emojis Detectados',
        'Hashtags (Cantidad)', 'Hashtags Detectados', 'Ratio Mayúsculas', 'Todo en Mayúsculas',
        'Contiene Número', 'Tiene Pregunta', 'Tiene Exclamación', 'Primera Palabra', 'Última Palabra',
        'Patrón Principal', 'Todos los Patrones Detectados', 'Vistas', 'Engagement %',
      ];
      const titleRows = [titleHeader, ...enrichedVideos.map((v) => {
        const ta = v.titleAnalysis;
        return [
          v.id, v.title, ta.charCount, ta.wordCount, ta.emojiCount, ta.emojis,
          ta.hashtagCount, ta.hashtags, ta.uppercaseRatio, ta.isAllUppercase ? 'SÍ' : 'NO',
          ta.hasNumber ? 'SÍ' : 'NO', ta.hasQuestion ? 'SÍ' : 'NO', ta.hasExclamation ? 'SÍ' : 'NO',
          ta.firstWord, ta.lastWord, ta.primaryPattern, ta.detectedPatterns, v.views, v.calculated.engagementRate,
        ];
      })];
      this.addSheet(wb, 'Title Analysis', titleRows);

      // 13. Thumbnails
      const thumbHeader = ['Video ID', 'Título', 'Mejor URL Miniatura', 'Resoluciones Disponibles', 'Default (120x90)', 'Medium (320x180)', 'High (480x360)', 'Standard (640x480)', 'MaxRes (1280x720)'];
      const thumbRows = [thumbHeader, ...enrichedVideos.map((v) => {
        const t = v.thumbnails || {};
        return [
          v.id, v.title, v.bestThumbnailUrl, v.thumbnailResolutions,
          t.default?.url || 'N/A', t.medium?.url || 'N/A', t.high?.url || 'N/A', t.standard?.url || 'N/A', t.maxres?.url || 'N/A',
        ];
      })];
      this.addSheet(wb, 'Thumbnails', thumbRows);

      // 14. Calculated Metrics
      const calcHeader = [
        'Video ID', 'Título', 'Vistas', 'Likes', 'Comentarios', 'Engagement Rate %',
        'Likes / 1k Views', 'Comentarios / 1k Views', 'Vistas / Día', 'Días Publicado',
        'Ratio vs Promedio Canal', 'Ratio vs Mediana Canal', 'Viral Score (0-100)',
      ];
      const calcRows = [calcHeader, ...enrichedVideos.map((v) => [
        v.id, v.title, v.views, v.likes, v.comments, v.calculated.engagementRate,
        v.calculated.likesPer1k, v.calculated.commentsPer1k, v.calculated.viewsPerDay,
        v.calculated.daysSincePublished, v.calculated.perfVsChannelAvg, v.calculated.perfVsChannelMedian,
        v.calculated.viralScore,
      ])];
      this.addSheet(wb, 'Calculated Metrics', calcRows);

      // 15. Top Performers
      const topHeader = ['Ranking Pos', 'Criterio', 'Video ID', 'Título', 'Vistas', 'Likes', 'Comentarios', 'Engagement %', 'Viral Score', 'Vistas/Día'];
      const topRows = [topHeader];
      rankings.topByViralScore.forEach((v, i) => {
        topRows.push([i + 1, 'Top Viral Score', v.id, v.title, v.views, v.likes, v.comments, v.calculated.engagementRate, v.calculated.viralScore, v.calculated.viewsPerDay]);
      });
      rankings.topByViews.slice(0, 5).forEach((v, i) => {
        topRows.push([i + 1, 'Top Vistas Totales', v.id, v.title, v.views, v.likes, v.comments, v.calculated.engagementRate, v.calculated.viralScore, v.calculated.viewsPerDay]);
      });
      rankings.topByEngagement.slice(0, 5).forEach((v, i) => {
        topRows.push([i + 1, 'Top Engagement Rate', v.id, v.title, v.views, v.likes, v.comments, v.calculated.engagementRate, v.calculated.viralScore, v.calculated.viewsPerDay]);
      });
      this.addSheet(wb, 'Top Performers', topRows);

      // 16. Bottom Performers
      const bottomHeader = ['Posición', 'Video ID', 'Título', 'Vistas', 'Promedio Canal', 'Déficit % vs Promedio', 'Días Publicado', 'Engagement %', 'Motivo Identificado'];
      const bottomRows = [bottomHeader];
      rankings.bottomPerformers.forEach((v, i) => {
        const defPct = Math.round((1 - v.calculated.perfVsChannelAvg) * 100);
        bottomRows.push([
          i + 1, v.id, v.title, v.views, channelSummary.avgViewsPerVideo, `-${defPct}%`,
          v.calculated.daysSincePublished, v.calculated.engagementRate,
          v.views === 0 ? 'Sin tracción inicial' : 'Rendimiento bajo frente a la media del canal',
        ]);
      });
      if (rankings.bottomPerformers.length === 0) {
        bottomRows.push(['-', '-', 'No se detectaron videos con rendimiento atípicamente bajo (>7 días de publicados)', '-', '-', '-', '-', '-', '-']);
      }
      this.addSheet(wb, 'Bottom Performers', bottomRows);

      // 17. Data Dictionary
      const dictRows = [
        ['CAMPO / MÉTRICA', 'DESCRIPCIÓN', 'ORIGEN / FUENTE', 'UNIDAD', 'FÓRMULA / REGLA', 'DISPONIBILIDAD'],
        ['id / videoId', 'Identificador alfanumérico único de YouTube', 'YouTube Data API', 'String', 'Oficial de YouTube', 'Disponible'],
        ['title', 'Título público del video', 'YouTube Data API', 'Texto', 'Oficial de YouTube', 'Disponible'],
        ['views', 'Cantidad total de reproducciones acumuladas', 'YouTube Data API', 'Entero', 'Oficial de YouTube', 'Disponible'],
        ['likes', 'Cantidad de Me Gusta recibidos', 'YouTube Data API', 'Entero', 'Oficial de YouTube', 'Disponible'],
        ['comments', 'Cantidad de comentarios públicos', 'YouTube Data API', 'Entero', 'Oficial de YouTube', 'Disponible'],
        ['duration', 'Duración del contenido en formato MM:SS o HH:MM:SS', 'YouTube Data API', 'Tiempo', 'Convertido desde ISO 8601 (PT#M#S)', 'Disponible'],
        ['contentType', 'Segmentación de formato (short, long_form, live)', 'Calculado determinista', 'Categoría', 'short: categoría 42 o duración <= 60s; long_form: >60s; live: emisión en vivo', 'Disponible'],
        ['engagementRate', 'Tasa de interacción por vista', 'Métrica Calculada', 'Porcentaje (%)', formulas.engagementRate, 'Disponible'],
        ['likesPer1k', 'Me gusta por cada mil reproducciones', 'Métrica Calculada', 'Tasa x 1,000', formulas.likesPer1k, 'Disponible'],
        ['commentsPer1k', 'Comentarios por cada mil reproducciones', 'Métrica Calculada', 'Tasa x 1,000', formulas.commentsPer1k, 'Disponible'],
        ['viewsPerDay', 'Velocidad de visualizaciones por día desde publicación', 'Métrica Calculada', 'Vistas/Día', formulas.viewsPerDay, 'Disponible'],
        ['perfVsChannelAvg', 'Rendimiento relativo frente a la media del canal', 'Métrica Calculada', 'Ratio multiplicador', formulas.perfVsChannelAvg, 'Disponible'],
        ['perfVsChannelMedian', 'Rendimiento relativo frente a la mediana del canal', 'Métrica Calculada', 'Ratio multiplicador', formulas.perfVsChannelMedian, 'Disponible'],
        ['viralScore', 'Puntaje de impacto y tracción (0 a 100)', 'Métrica Calculada', 'Puntaje 0-100', formulas.viralScore, 'Disponible'],
        ['titleAnalysis.primaryPattern', 'Patrón lingüístico detectado en el título', 'Algoritmo Determinista', 'Categoría', 'Análisis regex de preguntas, números, advertencias, tutoriales, etc.', 'Disponible'],
        ['Watch Time / CTR / Retención', 'Tiempo de reproducción e impresiones', 'YouTube Analytics API', 'Minutos / %', 'Requiere OAuth 2.0 y YouTube Analytics API', 'No disponible en Data API pública'],
        ['Traffic Sources / Demographics', 'Fuentes de tráfico y demografía', 'YouTube Analytics API', 'Porcentajes', 'Requiere OAuth 2.0 y YouTube Analytics API', 'No disponible en Data API pública'],
      ];
      this.addSheet(wb, 'Data Dictionary', dictRows);

      // Generar binario
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    },

    addSheet(wb, sheetName, rows) {
      const ws = XLSX.utils.aoa_to_sheet(rows);

      // Auto ajustar anchos de columna básicos
      const colWidths = [];
      for (const r of rows) {
        r.forEach((cell, ci) => {
          const len = String(cell ?? '').length;
          colWidths[ci] = Math.max(colWidths[ci] || 10, Math.min(len + 3, 50));
        });
      }
      ws['!cols'] = colWidths.map((w) => ({ wch: w }));

      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    },
  };

  /* ---------- 7. JSON EXPORTER (ESPECIALIZADO PARA IA) ---------- */
  const IntelligenceJSONExporter = {
    export(dataPackage) {
      const { normalizedData, quality, metricsData } = dataPackage;
      const { metadata, channel, timeSeries, videoHistory, channelGoals } = normalizedData;
      const { enrichedVideos, channelSummary, formatComparison, winningKeywords, rankings, formulas } = metricsData;

      // Estructura limpia y jerárquica para consumo directo de LLMs
      const jsonStructure = {
        metadata: {
          ...metadata,
          exportType: 'YouTube Channel Content Intelligence Dataset',
          targetAI: 'ChatGPT, Claude, Gemini, NotebookLM',
        },
        channel: {
          id: channel.id,
          name: channel.name,
          handle: channel.handle,
          description: channel.desc,
          country: channel.country,
          publishedAt: channel.published,
          subscribersCount: channel.subs,
          totalViewsCount: channel.views,
          totalPublicVideos: channel.videos,
          channelKeywords: channel.keywords || '',
        },
        channel_metrics_summary: {
          ...channelSummary,
          formatComparison,
          winningKeywords,
        },
        data_dictionary: formulas,
        data_quality: quality,
        rankings: {
          topViralVideos: rankings.topByViralScore.map(this.compactVideoForAI),
          topViewedVideos: rankings.topByViews.map(this.compactVideoForAI),
          topEngagedVideos: rankings.topByEngagement.map(this.compactVideoForAI),
          bottomPerformers: rankings.bottomPerformers.map(this.compactVideoForAI),
        },
        time_series: {
          daily: timeSeries.daily,
          weekly: timeSeries.weekly,
          monthly: timeSeries.monthly,
          yearly: timeSeries.yearly,
        },
        videos: enrichedVideos.map((v) => ({
          id: v.id,
          title: v.title,
          url: v.url,
          contentType: v.contentType,
          duration: v.durationFormatted,
          durationSeconds: v.durationSeconds,
          publishedAt: v.publishedAt,
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          category: v.categoryName,
          tags: v.tags,
          titleAnalysis: v.titleAnalysis,
          calculatedMetrics: v.calculated,
          thumbnails: {
            bestUrl: v.bestThumbnailUrl,
            availableResolutions: v.thumbnailResolutions,
          },
        })),
        video_history_snapshots: videoHistory,
      };

      const jsonString = JSON.stringify(jsonStructure, null, 2);
      return new Blob([jsonString], { type: 'application/json' });
    },

    compactVideoForAI(v) {
      return {
        id: v.id,
        title: v.title,
        contentType: v.contentType,
        duration: v.durationFormatted,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        engagementRate: `${v.calculated.engagementRate}%`,
        viewsPerDay: v.calculated.viewsPerDay,
        viralScore: v.calculated.viralScore,
        performanceVsAverage: `${Math.round(v.calculated.perfVsChannelAvg * 100)}%`,
        pattern: v.titleAnalysis?.primaryPattern || 'Declarativo',
      };
    },
  };

  /* ---------- 8. AI PROMPT GENERATOR ---------- */
  const IntelligencePromptGenerator = {
    generate(dataPackage) {
      const { normalizedData, metricsData } = dataPackage;
      const { metadata, channel } = normalizedData;
      const { channelSummary, formatComparison, winningKeywords, rankings } = metricsData;

      const top5Videos = rankings.topByViralScore.slice(0, 5).map((v, i) =>
        `  ${i + 1}. "${v.title}" (${v.contentType === 'short' ? 'Short' : 'Largo'}, ${v.durationFormatted}) | Vistas: ${fmtCount(v.views)} | Likes: ${fmtCount(v.likes)} | Comentarios: ${fmtCount(v.comments)} | Engagement: ${v.calculated.engagementRate}% | Score: ${v.calculated.viralScore}/100`
      ).join('\n');

      const bottom3Videos = rankings.bottomPerformers.slice(0, 3).map((v, i) =>
        `  ${i + 1}. "${v.title}" (${v.contentType === 'short' ? 'Short' : 'Largo'}, ${v.durationFormatted}) | Vistas: ${fmtCount(v.views)} | Publicado hace: ${v.calculated.daysSincePublished} días`
      ).join('\n');

      const keywordsText = winningKeywords.length ? winningKeywords.join(', ') : 'Contenido diverso';

      const promptText = `
# INSTRUCCIÓN PARA ANÁLISIS DE INTELIGENCIA DE CONTENIDO EN YOUTUBE

Actúa como un estratega senior de contenido y científico de datos experto en el algoritmo de YouTube.

He adjuntado el dataset completo en formato Excel (.xlsx) y JSON (.json) con el rendimiento histórico real de mi canal de YouTube.

---

## 📊 CONTEXTO DEL CANAL
- **Nombre del Canal:** ${channel.name} (${channel.handle || channel.id})
- **Suscriptores:** ${fmtFull.format(channel.subs)}
- **Vistas Totales Acumuladas:** ${fmtFull.format(channel.views)}
- **Videos Analizados en este Dataset:** ${metadata.videosAnalyzed} videos (${metadata.analyzedPeriod})
- **Promedio de Vistas por Video:** ${fmtFull.format(channelSummary.avgViewsPerVideo)} vistas
- **Mediana de Vistas por Video:** ${fmtFull.format(channelSummary.medianViewsPerVideo)} vistas
- **Tasa de Engagement Promedio:** ${channelSummary.avgEngagementRate}%
- **Desglose Formatos:** ${formatComparison.shortsCount} Shorts (Promedio: ${fmtCount(formatComparison.shortsAvgViews)} vistas) vs ${formatComparison.longFormCount} Videos Largos (Promedio: ${fmtCount(formatComparison.longAvgViews)} vistas)
- **Palabras Clave Ganadoras en Mejores Videos:** ${keywordsText}

### TOP 5 VIDEOS CON MEJOR RENDIMIENTO REAL:
${top5Videos}

### VIDEOS CON MENOR RENDIMIENTO:
${bottom3Videos || '  (No se detectaron videos atípicamente bajos con más de 7 días de antigüedad)'}

---

## 🎯 OBJETIVO DEL ANÁLISIS

Analiza exclusivamente los datos cuantitativos y cualitativos proporcionados en los archivos adjuntos y responde con rigor analítico a los siguientes 20 puntos:

1. **Rendimiento General:** Diagnóstico del estado actual del canal basado en promedios y medianas.
2. **Top Performers:** Qué factores objetivos diferencian a los videos con puntaje más alto.
3. **Bottom Performers:** Qué factores tienen en común los videos con menor rendimiento.
4. **Temáticas Ganadoras:** Qué tópicos y palabras clave atraen consistentemente más vistas e interacción.
5. **Comparativa de Formatos (Shorts vs Videos Largos):** Cuál genera más tracción, cuál tiene mejor engagement y cómo debería distribuirse el esfuerzo de producción.
6. **Duración Óptima:** Qué rango exacto de duración maximiza las visualizaciones y la interacción según los datos reales.
7. **Análisis de Títulos:** Qué longitud (caracteres/palabras), patrones lingüísticos (preguntas, números, listas, tutoriales) y uso de mayúsculas o emojis generan mejores resultados.
8. **Patrones de Engagement:** Qué tipo de contenido activa más comentarios por cada mil visitas y por qué.
9. **Velocidad de Crecimiento (Views/Día):** Qué videos despegan rápido versus cuáles actúan como contenido "evergreen" de crecimiento constante.
10. **Conversión y Retención:** Patrones inferidos de la interacción y duración.
11. **Oportunidades Ocultas:** Temas o formatos poco explorados que tuvieron un rendimiento por encima del promedio.
12. **Qué Dejar de Hacer:** Prácticas, títulos o duraciones que se correlacionan con bajo rendimiento.
13. **Fuerza de la Evidencia:** Para cada conclusión, indica si la evidencia en los datos es FUERTE, MEDIA o DÉBIL.
14. **No Confundir Correlación con Causalidad:** Explica con criterio cuándo un factor puede ser casualidad.
15. **Limitaciones:** Aclara qué aspectos no pueden asegurarse debido a que métricas de retención o CTR son estimadas por las limitaciones públicas de la API.

---

## 📌 ESTRUCTURA DE RESPUESTA FINAL REQUERIDA

Al final de tu análisis, entrega obligatoriamente las siguientes secciones estructuradas:

### 1. 🏆 TOP CONTENT PATTERNS (Patrones Ganadores Comprobados)
Resume los 3 a 5 patrones más sólidos que se repiten en los videos exitosos del canal.

### 2. 🟢 WHAT TO DO MORE (Qué Repetir y Escalar)
Lista de 3 a 5 acciones concretas de producción y titulación.

### 3. 🔴 WHAT TO AVOID (Qué Reducir o Eliminar)
Lista de 3 cosas que no están funcionando según los datos.

### 4. 💡 5 NEW VIDEO IDEAS (Basadas Exclusivamente en los Datos Reales)
Genera exactamente **5 ideas de videos** diseñadas a partir de los patrones encontrados. Para CADA idea utiliza esta plantilla exacta:

- **Idea #[N]:** [Título propuesto atractivo optimizado con los patrones ganadores]
- **Concepto:** [Descripción del contenido en 2 líneas]
- **Hook (Gancho inicial primeros 5 seg):** [Qué decir o mostrar en los primeros segundos]
- **Formato:** [Short / Video Largo]
- **Duración Recomendada:** [ej. 45 seg / 8-10 min]
- **Razón Estratégica:** [Por qué funcionará según la data analizada]
- **Patrón del Canal en que se Basa:** [Citar el video o métrica específica del dataset que respalda la idea]

---
*IMPORTANTE: No inventes información externa ni uses consejos genéricos. Todo tu análisis debe estar anclado a los datos reales de ${channel.name}.*
`.trim();

      return new Blob([promptText], { type: 'text/plain;charset=utf-8' });
    },
  };

  /* ---------- 9. USER INTERFACE CONTROLLER ---------- */
  const IntelligenceUI = {
    init() {
      this.bindEvents();
      this.populateChannels();
    },

    bindEvents() {
      // Tab click hook
      const intelTab = document.getElementById('tab-intelligence');
      if (intelTab) {
        intelTab.addEventListener('click', () => {
          this.populateChannels();
          this.updateSelectedChannelView();
        });
      }

      // Channel selector change
      const chanSelect = document.getElementById('intel-channel-select');
      if (chanSelect) {
        chanSelect.addEventListener('change', () => {
          this.updateSelectedChannelView();
        });
      }

      // Period selector change
      const periodSelect = document.getElementById('intel-period-select');
      if (periodSelect) {
        periodSelect.addEventListener('change', () => {
          this.updateSelectedChannelView();
        });
      }

      // Main export button
      const exportBtn = document.getElementById('btn-intel-export');
      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          this.runExport();
        });
      }
    },

    populateChannels() {
      const select = document.getElementById('intel-channel-select');
      if (!select) return;

      const prev = select.value;
      select.innerHTML = '';

      if (!channels || !channels.length) {
        select.innerHTML = '<option value="">No hay canales registrados</option>';
        return;
      }

      channels.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name || c.handle || c.id;
        select.appendChild(opt);
      });

      if (prev && channels.some((c) => c.id === prev)) {
        select.value = prev;
      } else {
        select.value = channels[0].id;
      }
    },

    updateSelectedChannelView() {
      const select = document.getElementById('intel-channel-select');
      const infoBox = document.getElementById('intel-channel-info');
      const summaryBox = document.getElementById('intel-data-summary');
      const resultsBox = document.getElementById('intel-results');

      if (resultsBox) resultsBox.classList.add('hidden');

      if (!select || !select.value) {
        if (infoBox) infoBox.innerHTML = '<p class="muted">Selecciona un canal para ver sus datos.</p>';
        return;
      }

      const channelId = select.value;
      const bag = state.data.get(channelId);
      const ch = channels.find((c) => c.id === channelId);

      const name = bag?.data?.name || ch?.name || 'Canal';
      const handle = bag?.data?.handle || ch?.handle || channelId;
      const thumb = bag?.data?.thumb || ch?.thumb || '';
      const subs = bag?.data?.subs ? fmtFull.format(bag.data.subs) : '—';
      const views = bag?.data?.views ? fmtFull.format(bag.data.views) : '—';
      const totalVideos = bag?.data?.videos ? fmtFull.format(bag.data.videos) : '—';
      const loadedVideos = (bag?.videos || []).length;
      const lastSync = $('#lbl-updated')?.textContent?.replace('Actualizado: ', '') || 'Hoy';

      if (infoBox) {
        infoBox.classList.remove('hidden');
        infoBox.innerHTML = `
          <div class="intel-chan-card">
            <img class="intel-chan-thumb" src="${escAttr(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <div class="intel-chan-details">
              <div class="intel-chan-name">${esc(name)}</div>
              <div class="intel-chan-handle">${esc(handle)} · ID: ${esc(channelId)}</div>
              <div class="intel-chan-stats">
                <span class="intel-stat-pill">👥 ${subs} subs</span>
                <span class="intel-stat-pill">👁 ${views} vistas</span>
                <span class="intel-stat-pill">🎬 ${totalVideos} videos públicos</span>
              </div>
              <div class="intel-chan-meta">
                <span>🔄 Sincronización: <b>${esc(lastSync)}</b></span>
                <span>📦 En memoria: <b>${loadedVideos} videos</b></span>
              </div>
            </div>
          </div>`;
      }

      if (summaryBox) {
        summaryBox.classList.remove('hidden');
        summaryBox.innerHTML = `
          <div class="intel-summary-grid">
            <div class="intel-summary-item">
              <div class="intel-summary-label">Videos Disponibles</div>
              <div class="intel-summary-value">${loadedVideos || totalVideos}</div>
            </div>
            <div class="intel-summary-item">
              <div class="intel-summary-label">Formatos Detectables</div>
              <div class="intel-summary-value">Shorts + Largos</div>
            </div>
            <div class="intel-summary-item">
              <div class="intel-summary-label">Métricas Calculadas</div>
              <div class="intel-summary-value">15+ Ratios</div>
            </div>
            <div class="intel-summary-item">
              <div class="intel-summary-label">Hojas de Excel</div>
              <div class="intel-summary-value">17 Hojas</div>
            </div>
          </div>
          <div class="intel-api-note">
            ℹ️ <strong>Nota de Calidad de Datos:</strong> Se extraerán todos los datos disponibles mediante YouTube Data API v3 (títulos, duraciones, vistas, likes, comentarios, categorías, tags, thumbnails y evolución). Las métricas privadas que requieren OAuth (Watch time exacto, CTR, Retención) se documentarán con la etiqueta <code>N/A</code> y se complementarán con estimaciones de engagement y velocidad.
          </div>`;
      }
    },

    async runExport() {
      const select = document.getElementById('intel-channel-select');
      const periodSelect = document.getElementById('intel-period-select');
      const progressBox = document.getElementById('intel-progress');
      const resultsBox = document.getElementById('intel-results');
      const exportBtn = document.getElementById('btn-intel-export');

      if (!select || !select.value) {
        showToast('Selecciona un canal para exportar.', 'error');
        return;
      }

      const channelId = select.value;
      const periodDays = periodSelect ? periodSelect.value : 'all';

      exportBtn.disabled = true;
      resultsBox.classList.add('hidden');
      progressBox.classList.remove('hidden');

      const steps = [
        { id: 'step-prep', label: 'Preparando datos y configuración...' },
        { id: 'step-videos', label: 'Obteniendo videos y metadata completa...' },
        { id: 'step-metrics', label: 'Obteniendo estadísticas e interacción...' },
        { id: 'step-history', label: 'Procesando series temporales e histórico...' },
        { id: 'step-calc', label: 'Calculando métricas derivadas y análisis de títulos...' },
        { id: 'step-excel', label: 'Generando libro Excel (17 hojas)...' },
        { id: 'step-json', label: 'Estructurando JSON jerárquico para IA...' },
        { id: 'step-prompt', label: 'Generando prompt especializado para IA...' },
      ];

      this.renderProgressSteps(steps);

      try {
        // Step 1: Prep
        this.setStepActive('step-prep');
        await this.delay(200);
        this.setStepDone('step-prep');

        // Step 2 & 3: Videos & Metrics
        this.setStepActive('step-videos');
        const rawData = await IntelligenceDataCollector.collectChannelData(channelId, periodDays);
        this.setStepDone('step-videos');

        this.setStepActive('step-metrics');
        await this.delay(250);
        this.setStepDone('step-metrics');

        // Step 4: History & Normalization
        this.setStepActive('step-history');
        const normalizedData = IntelligenceNormalizer.normalize(rawData);
        const quality = IntelligenceValidator.validate(normalizedData);
        await this.delay(250);
        this.setStepDone('step-history');

        // Step 5: Calculation
        this.setStepActive('step-calc');
        const metricsData = IntelligenceMetricsCalc.calculate(normalizedData);
        const dataPackage = { normalizedData, quality, metricsData };
        await this.delay(250);
        this.setStepDone('step-calc');

        // Step 6: Excel Export
        this.setStepActive('step-excel');
        const excelBlob = IntelligenceExcelExporter.export(dataPackage);
        await this.delay(200);
        this.setStepDone('step-excel');

        // Step 7: JSON Export
        this.setStepActive('step-json');
        const jsonBlob = IntelligenceJSONExporter.export(dataPackage);
        await this.delay(150);
        this.setStepDone('step-json');

        // Step 8: Prompt Export
        this.setStepActive('step-prompt');
        const promptBlob = IntelligencePromptGenerator.generate(dataPackage);
        await this.delay(150);
        this.setStepDone('step-prompt');

        // Render downloads
        this.renderResults(normalizedData.channel, excelBlob, jsonBlob, promptBlob);
        showToast('¡Exportación completada exitosamente!', 'success');
      } catch (err) {
        console.error('Error durante la exportación de Intelligence:', err);
        progressBox.insertAdjacentHTML('beforeend', `<div class="intel-error-msg">❌ Error en la exportación: ${esc(err.message || String(err))}</div>`);
        showToast('Error al generar la exportación.', 'error');
      } finally {
        exportBtn.disabled = false;
      }
    },

    renderProgressSteps(steps) {
      const box = document.getElementById('intel-progress');
      if (!box) return;

      box.innerHTML = `
        <div class="intel-progress-steps">
          ${steps.map((s) => `
            <div class="intel-step" id="${s.id}">
              <span class="intel-step-icon">⏳</span>
              <span class="intel-step-label">${esc(s.label)}</span>
            </div>`).join('')}
        </div>`;
    },

    setStepActive(id) {
      const el = document.getElementById(id);
      if (el) {
        el.className = 'intel-step active';
        el.querySelector('.intel-step-icon').textContent = '⚙️';
      }
    },

    setStepDone(id) {
      const el = document.getElementById(id);
      if (el) {
        el.className = 'intel-step done';
        el.querySelector('.intel-step-icon').textContent = '✓';
      }
    },

    renderResults(channel, excelBlob, jsonBlob, promptBlob) {
      const resultsBox = document.getElementById('intel-results');
      if (!resultsBox) return;

      const dateStr = new Date().toISOString().slice(0, 10);
      const safeName = (channel.name || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '_');

      const excelName = `youtube_ai_analysis_${safeName}_${dateStr}.xlsx`;
      const jsonName = `youtube_ai_analysis_${safeName}_${dateStr}.json`;
      const promptName = `youtube_ai_analysis_prompt_${safeName}_${dateStr}.txt`;

      const excelUrl = URL.createObjectURL(excelBlob);
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const promptUrl = URL.createObjectURL(promptBlob);

      const excelSize = this.formatBytes(excelBlob.size);
      const jsonSize = this.formatBytes(jsonBlob.size);
      const promptSize = this.formatBytes(promptBlob.size);

      resultsBox.classList.remove('hidden');
      resultsBox.innerHTML = `
        <div class="intel-results-header">
          <span class="intel-success-icon">🎉</span>
          <span>Archivos generados y listos para descargar</span>
        </div>
        <div class="intel-results-files">
          <div class="intel-file-card">
            <div class="intel-file-info">
              <span class="intel-file-icon">📊</span>
              <div>
                <div class="intel-file-name" title="${escAttr(excelName)}">${esc(excelName)}</div>
                <div class="intel-file-size">Excel estructurado (17 hojas) · ${excelSize}</div>
              </div>
            </div>
            <a class="btn btn-primary intel-download-btn" href="${excelUrl}" download="${escAttr(excelName)}">Descargar Excel</a>
          </div>

          <div class="intel-file-card">
            <div class="intel-file-info">
              <span class="intel-file-icon">📄</span>
              <div>
                <div class="intel-file-name" title="${escAttr(jsonName)}">${esc(jsonName)}</div>
                <div class="intel-file-size">JSON optimizado para LLMs · ${jsonSize}</div>
              </div>
            </div>
            <a class="btn btn-ghost intel-download-btn" href="${jsonUrl}" download="${escAttr(jsonName)}">Descargar JSON</a>
          </div>

          <div class="intel-file-card">
            <div class="intel-file-info">
              <span class="intel-file-icon">🧠</span>
              <div>
                <div class="intel-file-name" title="${escAttr(promptName)}">${esc(promptName)}</div>
                <div class="intel-file-size">Prompt con contexto y 5 ideas · ${promptSize}</div>
              </div>
            </div>
            <a class="btn btn-ghost intel-download-btn" href="${promptUrl}" download="${escAttr(promptName)}">Descargar Prompt IA</a>
          </div>
        </div>`;
    },

    formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(2) + ' MB';
    },

    delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };

  /* ---------- INICIALIZACIÓN ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    try {
      IntelligenceUI.init();
    } catch (e) {
      console.error('Error al inicializar IntelligenceUI:', e);
    }
  });

  // Exportar al scope global si se requiere
  window.IntelligenceModule = {
    DataCollector: IntelligenceDataCollector,
    TitleAnalyzer: IntelligenceTitleAnalyzer,
    Normalizer: IntelligenceNormalizer,
    Validator: IntelligenceValidator,
    MetricsCalc: IntelligenceMetricsCalc,
    ExcelExporter: IntelligenceExcelExporter,
    JSONExporter: IntelligenceJSONExporter,
    PromptGenerator: IntelligencePromptGenerator,
    UI: IntelligenceUI,
  };
})();
