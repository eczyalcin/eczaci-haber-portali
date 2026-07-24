(function () {
  'use strict';

  var DATA_URL = './data/news.json';
  var CATEGORIES_URL = './config/categories.json';

  var ALL_TAB = { id: 'tumu', label: 'Tüm Haberler', description: 'Tüm kaynaklardan gelen haber ve duyurular' };
  var SOURCES_TAB = { id: 'kaynaklar', label: 'Kaynaklar', description: 'Taranan kaynakların listesi ve güncel durumu' };

  var state = {
    categories: [],
    items: [],
    sources: [],
    generatedAt: null,
    activeTab: ALL_TAB.id,
    query: '',
  };

  var tabsEl = document.getElementById('tabs');
  var contentEl = document.getElementById('content');
  var lastUpdatedEl = document.getElementById('lastUpdated');
  var searchInput = document.getElementById('searchInput');
  var refreshBtn = document.getElementById('refreshBtn');
  var sourcesLink = document.getElementById('sourcesLink');

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function formatRelativeTime(iso) {
    if (!iso) return '';
    var then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    var diffMs = Date.now() - then;
    var minutes = Math.round(diffMs / 60000);
    if (minutes < 1) return 'az önce';
    if (minutes < 60) return minutes + ' dk önce';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' saat önce';
    var days = Math.round(hours / 24);
    if (days < 7) return days + ' gün önce';
    return new Date(then).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return 'Henüz veri yok';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Henüz veri yok';
    return d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function categoryLabel(id) {
    var cat = state.categories.find(function (c) { return c.id === id; });
    return cat ? cat.label : id;
  }

  async function load() {
    contentEl.innerHTML = '<div class="loading-state">Yükleniyor…</div>';
    try {
      // GitHub Pages'in CDN katmanı (Fastly) "cache: no-store" isteğine
      // rağmen eski bir kopyayı sunabiliyor; her seferinde benzersiz bir
      // sorgu parametresiyle isteği zorunlu cache-miss yapıyoruz.
      var cacheBuster = 'v=' + Date.now();
      var [newsRes, catRes] = await Promise.all([
        fetch(DATA_URL + '?' + cacheBuster, { cache: 'no-store' }),
        fetch(CATEGORIES_URL + '?' + cacheBuster, { cache: 'no-store' }),
      ]);
      var news = await newsRes.json();
      var categories = await catRes.json();

      state.categories = categories;
      state.items = news.items || [];
      state.sources = news.sources || [];
      state.generatedAt = news.generatedAt || null;

      renderTabs();
      renderMeta();
      renderContent();
    } catch (err) {
      contentEl.innerHTML =
        '<div class="empty-state">Veriler yüklenemedi. Lütfen sayfayı yenileyin.<br><small>' +
        escapeHtml(err && err.message ? err.message : String(err)) +
        '</small></div>';
    }
  }

  function renderMeta() {
    lastUpdatedEl.textContent = state.generatedAt
      ? 'Son güncelleme: ' + formatDateTime(state.generatedAt)
      : 'Henüz tarama yapılmadı';
  }

  function renderTabs() {
    var allTabs = [ALL_TAB].concat(state.categories).concat([SOURCES_TAB]);
    tabsEl.innerHTML = '';
    allTabs.forEach(function (tab) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn' + (tab.id === state.activeTab ? ' active' : '');
      btn.textContent = tab.label;
      btn.addEventListener('click', function () {
        state.activeTab = tab.id;
        renderTabs();
        renderContent();
      });
      tabsEl.appendChild(btn);
    });
  }

  function currentItems() {
    var items = state.items;
    if (state.activeTab !== ALL_TAB.id) {
      items = items.filter(function (it) { return it.category === state.activeTab; });
    }
    var q = state.query.trim().toLocaleLowerCase('tr');
    if (q) {
      items = items.filter(function (it) {
        return (it.title || '').toLocaleLowerCase('tr').indexOf(q) !== -1;
      });
    }
    return items;
  }

  function renderContent() {
    if (state.activeTab === SOURCES_TAB.id) {
      renderSources();
      return;
    }

    var activeCat = state.categories.find(function (c) { return c.id === state.activeTab; });
    var desc = activeCat ? activeCat.description : ALL_TAB.description;
    var items = currentItems();

    var html = '<p class="category-desc">' + escapeHtml(desc) + '</p>';

    if (items.length === 0) {
      html +=
        '<div class="empty-state">' +
        (state.generatedAt
          ? 'Bu kategoride şu an gösterilecek haber yok.'
          : 'Henüz veri yok, ilk otomatik tarama bekleniyor. Bu portal düzenli aralıklarla kaynakları tarayarak kendini günceller.') +
        '</div>';
      contentEl.innerHTML = html;
      return;
    }

    html += '<div class="news-grid">';
    items.forEach(function (it) {
      var alsoFromHtml = '';
      if (it.alsoFrom && it.alsoFrom.length) {
        var names = it.alsoFrom.map(function (a) { return escapeHtml(a.sourceName); }).join(', ');
        alsoFromHtml = '<div class="also-from">Ayrıca: ' + names + '</div>';
      }
      html +=
        '<article class="news-card">' +
        '<a class="news-title" href="' + escapeHtml(it.link) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(it.title) +
        '</a>' +
        '<div class="news-card-meta">' +
        '<span class="source-badge">' + escapeHtml(it.sourceName || it.source) + '</span>' +
        '<span>' + escapeHtml(formatRelativeTime(it.publishedAt || it.fetchedAt)) + '</span>' +
        '</div>' +
        alsoFromHtml +
        '</article>';
    });
    html += '</div>';

    contentEl.innerHTML = html;
  }

  function renderSources() {
    var statusLabels = {
      ok: 'Aktif',
      empty: 'Veri yok',
      'needs-config': 'Yapılandırma bekliyor',
      error: 'Hata',
    };

    var html = '<p class="category-desc">Bu portal aşağıdaki kaynakları düzenli aralıklarla otomatik olarak tarar. "Yapılandırma bekliyor" durumundaki kaynaklar için RSS/HTML ayarları henüz tamamlanmadı; zaman içinde eklenecektir.</p>';
    html += '<div class="source-list">';

    if (state.sources.length === 0) {
      html += '<div class="empty-state">Henüz kaynak durumu bilgisi yok.</div>';
    } else {
      state.sources.forEach(function (src) {
        var status = src.status || 'error';
        html +=
          '<div class="source-row">' +
          '<div class="source-row-main">' +
          '<a href="' + escapeHtml(src.homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(src.name) + '</a>' +
          '<span class="source-row-sub">' + escapeHtml(categoryLabel(src.category)) + ' · ' + (src.itemCount || 0) + ' haber</span>' +
          '</div>' +
          '<span class="status-pill status-' + escapeHtml(status) + '">' + escapeHtml(statusLabels[status] || status) + '</span>' +
          '</div>';
      });
    }

    html += '</div>';
    contentEl.innerHTML = html;
  }

  searchInput.addEventListener('input', function (e) {
    state.query = e.target.value;
    renderContent();
  });

  refreshBtn.addEventListener('click', load);

  sourcesLink.addEventListener('click', function (e) {
    e.preventDefault();
    state.activeTab = SOURCES_TAB.id;
    renderTabs();
    renderContent();
  });

  load();
})();
