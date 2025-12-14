// ===== عناصر الواجهة =====
const intro = document.getElementById("intro");
const app = document.getElementById("app");

const btnEnter = document.getElementById("btnEnter");
const btnHome = document.getElementById("btnHome");
const btnLegend = document.getElementById("btnLegend");
const legend = document.getElementById("legend");
const panel = document.getElementById("panel");

const btnAbout = document.getElementById("btnAbout");
const aboutDialog = document.getElementById("aboutDialog");
const btnCloseAbout = document.getElementById("btnCloseAbout");

const btnTour = document.getElementById("btnTour");
const btnRoute = document.getElementById("btnRoute");

// Tour overlay controls
const tourOverlay = document.getElementById("tourOverlay");
const btnCloseTour = document.getElementById("btnCloseTour");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const btnPlay = document.getElementById("btnPlay");

const tourBar = document.getElementById("tourBar");
const tourCounter = document.getElementById("tourCounter");
const tourEra = document.getElementById("tourEra");
const tourName = document.getElementById("tourName");
const tourStory = document.getElementById("tourStory");

// ===== حالة التطبيق =====
let mapInitialized = false;
let map;

let geoLayer;
let routeLine;

let buildingsData = [];
let markerIndex = new Map();
let highlighted = null;

// Filters
let currentQuery = "";
let currentEra = "all";
let currentSort = "name";
let yearMin = null;
let yearMax = null;
let yearMaxSelected = null;

// Tour
let tourList = [];
let tourIndex = 0;
let tourTimer = null;
let tourPlaying = false;

// Audio narrator (optional)
let narrator = new Audio();
narrator.preload = "metadata";

// ===== مساعدات =====
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function debounce(fn, delay = 160) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function getFeatureKey(feature) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  return String(p.id || p.slug || p.name || `${coords[0] || ""},${coords[1] || ""}`);
}

function getYear(feature) {
  const y = Number(feature?.properties?.year);
  return Number.isFinite(y) ? y : null;
}

function getEra(feature) {
  const e = String(feature?.properties?.era || "").trim();
  return e || "غير محدد";
}

function getStatus(feature) {
  const s = String(feature?.properties?.status || "").trim();
  return s || "غير محدد";
}

function getStyle(feature) {
  const s = String(feature?.properties?.style || "").trim();
  return s || "غير محدد";
}

function parseUrlSelection() {
  const url = new URL(window.location.href);
  const qid = url.searchParams.get("id");
  const hid = (window.location.hash || "").replace("#", "").trim();
  return qid || hid || null;
}

function setUrlSelection(id) {
  if (!id) return;
  const url = new URL(window.location.href);
  url.searchParams.set("id", id);
  window.history.replaceState({}, "", url.toString());
}

function latlngFromFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return [coords[1], coords[0]];
}

// ===== أزرار الواجهة =====
btnEnter?.addEventListener("click", () => {
  intro.classList.add("is-hidden");
  app.classList.remove("is-hidden");
  initMapOnce();
});

btnHome?.addEventListener("click", () => {
  stopTour();
  hideTourOverlay();
  intro.classList.remove("is-hidden");
  app.classList.add("is-hidden");
});

btnLegend?.addEventListener("click", () => {
  legend?.classList.toggle("is-hidden");
});

btnAbout?.addEventListener("click", () => {
  aboutDialog?.showModal?.();
});
btnCloseAbout?.addEventListener("click", () => aboutDialog?.close?.());

// ===== الخريطة =====
function initMapOnce() {
  if (mapInitialized) return;
  mapInitialized = true;

  map = L.map("map", { zoomControl: true }).setView([31.9038, 35.2034], 14);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  loadGeoJSON();
}

function loadGeoJSON() {
  panel.innerHTML = `
    <div class="panel__empty">
      <h2>جاري التحميل…</h2>
      <p>يتم تحميل بيانات المباني.</p>
    </div>
  `;

  fetch("./data/buildings.geojson", { cache: "no-store" })
    .then(r => {
      if (!r.ok) throw new Error("GeoJSON load failed: " + r.status);
      return r.json();
    })
    .then(geojson => {
      buildingsData = geojson?.features || [];

      // years
      const years = buildingsData.map(getYear).filter(v => v !== null);
      yearMin = years.length ? Math.min(...years) : null;
      yearMax = years.length ? Math.max(...years) : null;
      yearMaxSelected = yearMax;

      buildGeoLayer(geojson);
      zoomToAll();

      renderExplorePanel(); // البحث/الفلاتر/القائمة

      // Load selection from URL
      const selected = parseUrlSelection();
      if (selected) {
        const f = buildingsData.find(x => getFeatureKey(x) === selected);
        if (f) selectFeature(f, true);
      }
    })
    .catch(err => {
      console.error(err);
      panel.innerHTML = `
        <div class="panel__empty">
          <h2>مشكلة في البيانات</h2>
          <p>تأكدي أن الملف <code>data/buildings.geojson</code> موجود وصحيح.</p>
          <p class="smallNote">${escapeHtml(err.message || String(err))}</p>
        </div>
      `;
    });
}

function buildGeoLayer(geojson) {
  if (geoLayer) geoLayer.remove();
  markerIndex.clear();
  highlighted = null;

  const baseStyle = {
    radius: 7,
    fillColor: "#c8a86a",
    color: "#ffffff",
    weight: 1.5,
    opacity: 1,
    fillOpacity: 0.9
  };

  geoLayer = L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const st = getStatus(feature);
      if (st.includes("مهدد") || st.includes("خطر")) return L.circleMarker(latlng, { ...baseStyle, fillColor: "#e07a5f" });
      if (st.includes("مرمم") || st.includes("تم ترميم")) return L.circleMarker(latlng, { ...baseStyle, fillColor: "#81b29a" });
      return L.circleMarker(latlng, baseStyle);
    },
    onEachFeature: (feature, layer) => {
      const key = getFeatureKey(feature);
      markerIndex.set(key, layer);
      layer.on("click", () => {
        stopTour();
        hideTourOverlay();
        selectFeature(feature, true);
      });
    }
  }).addTo(map);
}

function zoomToAll() {
  const b = geoLayer?.getBounds?.();
  if (b && b.isValid && b.isValid()) {
    map.fitBounds(b, { padding: [40, 40] });
  }
}

function focusOnFeature(feature, zoom = 19) {
  const ll = latlngFromFeature(feature);
  if (!ll) return;
  map.flyTo(ll, zoom, { animate: true, duration: 1.2 });
}

// ===== اختيار مبنى =====
function selectFeature(feature, updateUrl = false) {
  focusOnFeature(feature, 19);
  renderDetails(feature);
  highlightMarker(feature);
  if (updateUrl) setUrlSelection(getFeatureKey(feature));
}

// ===== هايلايت =====
function highlightMarker(feature) {
  const key = getFeatureKey(feature);
  const layer = markerIndex.get(key);
  if (!layer || !layer.setStyle) return;

  // رجّع السابق طبيعي
  if (highlighted && highlighted.setStyle) {
    highlighted.setStyle({ radius: 7, weight: 1.5, opacity: 1, fillOpacity: 0.9 });
  }

  layer.setStyle({ radius: 10, weight: 2, opacity: 1, fillOpacity: 1 });
  highlighted = layer;
}

// ===== Panel: Explore =====
function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => String(a).localeCompare(String(b), "ar"));
}

function getFilteredFeatures() {
  const q = currentQuery.trim().toLowerCase();
  let arr = buildingsData.filter(f => {
    const name = String(f?.properties?.name || "").toLowerCase();
    const st = getStatus(f).toLowerCase();
    const sty = getStyle(f).toLowerCase();
    const era = getEra(f);
    const y = getYear(f);

    const passQ = q ? (name.includes(q) || st.includes(q) || sty.includes(q) || String(era).toLowerCase().includes(q)) : true;
    const passEra = (currentEra === "all") ? true : (era === currentEra);
    const passYear = (yearMaxSelected === null || y === null) ? true : (y <= yearMaxSelected);

    return passQ && passEra && passYear;
  });

  // sort
  arr.sort((a, b) => {
    if (currentSort === "year") {
      return (getYear(a) ?? 999999) - (getYear(b) ?? 999999);
    }
    return String(a?.properties?.name || "").localeCompare(String(b?.properties?.name || ""), "ar");
  });

  return arr;
}

function updateLayerVisibility() {
  const allowed = new Set(getFilteredFeatures().map(getFeatureKey));
  markerIndex.forEach((layer, key) => {
    if (!layer?.setStyle) return;
    const show = allowed.has(key);
    layer.setStyle({
      opacity: show ? 1 : 0,
      fillOpacity: show ? 0.9 : 0
    });
  });
}

function renderExplorePanel() {
  const eras = uniqueSorted(buildingsData.map(getEra));

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
      <h2 style="margin:0;">استكشف</h2>
      <button id="btnZoomAll" class="btn btn--ghost btn--sm">عرض الكل</button>
    </div>

    <div class="controls">
      <input id="searchBox" class="input" type="text" placeholder="ابحث (اسم/عصر/طراز/حالة)…" />

      <div class="controls__row">
        <select id="eraSel" class="select">
          <option value="all">كل العصور</option>
          ${eras.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("")}
        </select>
        <select id="sortSel" class="select">
          <option value="name">فرز: الاسم</option>
          <option value="year">فرز: السنة</option>
        </select>
      </div>

      ${yearMin !== null && yearMax !== null ? `
        <div class="rangeWrap">
          <span class="pill">حتى سنة</span>
          <input id="yearRange" type="range" min="${yearMin}" max="${yearMax}" value="${yearMaxSelected ?? yearMax}" step="1" />
          <span id="yearVal" class="pill">${yearMaxSelected ?? yearMax}</span>
        </div>
      ` : `<div class="smallNote">لا يوجد حقل سنة صالح في البيانات.</div>`}
    </div>

    <div class="smallNote" style="margin:10px 0 8px;">
      نصيحة للسائح: اضغط “الجولة” لتجربة متحفية تلقائية.
    </div>

    <div id="listBox" style="display:flex; flex-direction:column; gap:8px;"></div>
  `;

  const searchBox = document.getElementById("searchBox");
  const eraSel = document.getElementById("eraSel");
  const sortSel = document.getElementById("sortSel");
  const yearRange = document.getElementById("yearRange");
  const yearVal = document.getElementById("yearVal");
  const listBox = document.getElementById("listBox");

  const draw = () => {
    const list = getFilteredFeatures();
    updateLayerVisibility();

    if (!list.length) {
      listBox.innerHTML = `<div class="smallNote">لا يوجد نتائج.</div>`;
      return;
    }

    listBox.innerHTML = list.map(f => {
      const p = f?.properties || {};
      const name = p.name || "مبنى بدون اسم";
      const y = p.year || "—";
      const era = getEra(f);
      const st = getStatus(f);
      const key = getFeatureKey(f);
      return `
        <button class="bItem" data-key="${escapeHtml(key)}"
          style="text-align:right; cursor:pointer; padding:10px 12px;
                 border:1px solid #333; border-radius:12px; background: rgba(255,255,255,.04);
                 color:#fff; font-family:inherit;">
          <div style="font-weight:900;">${escapeHtml(name)}</div>
          <div style="opacity:.78; font-size:12px; margin-top:3px; display:flex; gap:8px; flex-wrap:wrap;">
            <span>سنة: ${escapeHtml(String(y))}</span>
            <span>عصر: ${escapeHtml(String(era))}</span>
            <span>حالة: ${escapeHtml(String(st))}</span>
          </div>
        </button>
      `;
    }).join("");

    listBox.querySelectorAll(".bItem").forEach(btn => {
      btn.addEventListener("click", () => {
        stopTour(); hideTourOverlay();
        const key = btn.getAttribute("data-key");
        const f = buildingsData.find(x => getFeatureKey(x) === key);
        if (f) selectFeature(f, true);
      });
    });
  };

  draw();

  searchBox.addEventListener("input", debounce((e) => {
    currentQuery = e.target.value || "";
    draw();
  }, 140));

  eraSel.addEventListener("change", (e) => {
    currentEra = e.target.value;
    draw();
  });

  sortSel.addEventListener("change", (e) => {
    currentSort = e.target.value;
    draw();
  });

  if (yearRange) {
    yearRange.addEventListener("input", (e) => {
      yearMaxSelected = Number(e.target.value);
      if (yearVal) yearVal.textContent = String(yearMaxSelected);
      draw();
    });
  }

  document.getElementById("btnZoomAll")?.addEventListener("click", () => {
    stopTour(); hideTourOverlay();
    zoomToAll();
  });
}

// ===== Details (متحف داخل اللوحة) =====
function renderDetails(feature) {
  const p = feature?.properties || {};
  const key = getFeatureKey(feature);

  const title = p.name || "مبنى";
  const year = p.year || "-";
  const era = getEra(feature);
  const style = p.style || "-";
  const status = p.status || "-";
  const story = p.story || "لا يوجد وصف بعد.";

  const imgMain = p.image || "./assets/placeholder.jpg";
  const link = p.link || "";

  // Gallery: array of strings
  const gallery = Array.isArray(p.gallery) ? p.gallery : [];
  const gallerySafe = gallery.length ? gallery : ["./assets/placeholder.jpg"];

  // Before/After
  const ba = p.beforeAfter || null;
  const beforeImg = ba?.before || "";
  const afterImg = ba?.after || "";

  // Audio
  const audio = p.audio || "";

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
      <h2 class="cardTitle">${escapeHtml(title)}</h2>
      <button id="backToExplore" class="btn btn--ghost btn--sm">← رجوع</button>
    </div>

    <img class="cardImg" src="${escapeHtml(imgMain)}" alt="${escapeHtml(title)}" />

    <div class="metaRow">
      <span class="pill">سنة: ${escapeHtml(String(year))}</span>
      <span class="pill">عصر: ${escapeHtml(String(era))}</span>
      <span class="pill">طراز: ${escapeHtml(String(style))}</span>
      <span class="pill">حالة: ${escapeHtml(String(status))}</span>
    </div>

    <p class="cardText">${escapeHtml(String(story))}</p>

    ${audio ? `
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <button id="btnPlayAudio" class="btn btn--primary btn--sm">🔊 استمع للقصة</button>
        <button id="btnStopAudio" class="btn btn--ghost btn--sm">⏹ إيقاف</button>
      </div>
      <p class="smallNote">* الصوت بدون موسيقى، مرشد هادئ.</p>
    ` : `
      <p class="smallNote" style="margin-top:12px;">لا يوجد ملف صوتي لهذا المبنى بعد. (أضيفي <code>audio</code> داخل GeoJSON)</p>
    `}

    ${link ? `
      <a href="${escapeHtml(link)}" target="_blank" rel="noopener"
        class="btn btn--primary btn--sm" style="display:inline-block; margin-top:10px; text-decoration:none;">
        مصدر / المزيد
      </a>
    ` : ``}

    <!-- Before/After -->
    ${beforeImg && afterImg ? `
      <div class="ba">
        <div class="ba__wrap">
          <img src="${escapeHtml(beforeImg)}" alt="قبل" />
          <img id="afterImg" class="ba__after" src="${escapeHtml(afterImg)}" alt="بعد" />
          <div class="ba__label before">قبل</div>
          <div class="ba__label after">بعد</div>
        </div>
        <div class="ba__range">
          <input id="baRange" type="range" min="0" max="100" value="50" />
        </div>
      </div>
    ` : `
      <p class="smallNote" style="margin-top:12px;">ميزة “قبل/بعد” غير مفعّلة هنا. (أضيفي <code>beforeAfter.before</code> و <code>beforeAfter.after</code>)</p>
    `}

    <!-- Gallery -->
    <div class="gallery">
      <div class="gallery__main">
        <img id="gMain" src="${escapeHtml(gallerySafe[0])}" alt="Gallery" />
      </div>

      <div class="gallery__nav">
        <button id="gPrev" class="btn btn--ghost btn--sm">◀</button>
        <div class="smallNote" style="align-self:center;">معرض الصور</div>
        <button id="gNext" class="btn btn--ghost btn--sm">▶</button>
      </div>

      <div class="gallery__thumbs" id="gThumbs">
        ${gallerySafe.map((src, i) => `
          <img data-i="${i}" class="${i===0 ? "active" : ""}" src="${escapeHtml(src)}" alt="thumb" />
        `).join("")}
      </div>
    </div>

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
      <button id="btnCopyLink" class="btn btn--ghost btn--sm">نسخ رابط المبنى</button>
      <button id="btnStartTourFromHere" class="btn btn--ghost btn--sm">ابدأ الجولة من هنا</button>
    </div>

    <p class="smallNote" style="margin-top:10px;">ID: <code>${escapeHtml(key)}</code></p>
  `;

  // Back
  document.getElementById("backToExplore")?.addEventListener("click", () => {
    renderExplorePanel();
  });

  // Copy link
  document.getElementById("btnCopyLink")?.addEventListener("click", async () => {
    try {
      setUrlSelection(key);
      await navigator.clipboard.writeText(window.location.href);
      alert("تم نسخ رابط المبنى ✅");
    } catch {
      alert("لم أستطع النسخ. انسخي الرابط من شريط العنوان.");
    }
  });

  // Start tour from this
  document.getElementById("btnStartTourFromHere")?.addEventListener("click", () => {
    openTourOverlay();
    buildTourList();
    const idx = tourList.findIndex(x => getFeatureKey(x) === key);
    tourIndex = idx >= 0 ? idx : 0;
    showTourItem(tourIndex, true);
  });

  // Before/After slider
  const baRange = document.getElementById("baRange");
  const afterEl = document.getElementById("afterImg");
  if (baRange && afterEl) {
    const apply = () => {
      const v = Number(baRange.value); // 0..100
      // clip-path inset(top right bottom left) — left = v%
      afterEl.style.clipPath = `inset(0 0 0 ${v}%)`;
    };
    baRange.addEventListener("input", apply);
    apply();
  }

  // Gallery logic
  let gi = 0;
  const gMain = document.getElementById("gMain");
  const gThumbs = document.getElementById("gThumbs");
  function setGallery(i) {
    gi = (i + gallerySafe.length) % gallerySafe.length;
    if (gMain) gMain.src = gallerySafe[gi];
    gThumbs?.querySelectorAll("img").forEach(img => img.classList.remove("active"));
    gThumbs?.querySelector(`img[data-i="${gi}"]`)?.classList.add("active");
  }
  document.getElementById("gPrev")?.addEventListener("click", () => setGallery(gi - 1));
  document.getElementById("gNext")?.addEventListener("click", () => setGallery(gi + 1));
  gThumbs?.querySelectorAll("img").forEach(img => {
    img.addEventListener("click", () => setGallery(Number(img.getAttribute("data-i"))));
  });

  // Audio
  const btnPlayAudio = document.getElementById("btnPlayAudio");
  const btnStopAudio = document.getElementById("btnStopAudio");
  if (audio && btnPlayAudio && btnStopAudio) {
    btnPlayAudio.addEventListener("click", () => {
      try{
        narrator.pause();
        narrator.currentTime = 0;
        narrator.src = audio;
        narrator.play();
      }catch(e){
        alert("تعذر تشغيل الصوت. تأكدي من وجود الملف داخل مجلد audio/");
      }
    });
    btnStopAudio.addEventListener("click", () => {
      narrator.pause();
      narrator.currentTime = 0;
    });
  }
}

// ===== TOUR (مشغل متحفي) =====
btnTour?.addEventListener("click", () => {
  if (tourOverlay.classList.contains("is-hidden")) {
    openTourOverlay();
    buildTourList();
    tourIndex = 0;
    showTourItem(tourIndex, true);
  } else {
    // toggle play
    if (tourPlaying) stopTour();
    else startTour();
  }
});

btnCloseTour?.addEventListener("click", () => {
  stopTour();
  hideTourOverlay();
});

btnPrev?.addEventListener("click", () => {
  stopTour();
  showTourItem(tourIndex - 1, true);
});

btnNext?.addEventListener("click", () => {
  stopTour();
  showTourItem(tourIndex + 1, true);
});

btnPlay?.addEventListener("click", () => {
  if (tourPlaying) stopTour();
  else startTour();
});

function openTourOverlay() {
  tourOverlay.classList.remove("is-hidden");
  btnTour.textContent = "إيقاف الجولة";
}

function hideTourOverlay() {
  tourOverlay.classList.add("is-hidden");
  btnTour.textContent = "الجولة";
}

function buildTourList() {
  tourList = getFilteredFeatures();
  if (!tourList.length) tourList = buildingsData.slice();
}

function showTourItem(index, focus = false) {
  if (!tourList.length) return;

  tourIndex = (index + tourList.length) % tourList.length;
  const f = tourList[tourIndex];
  const p = f?.properties || {};

  const name = p.name || "مبنى";
  const era = getEra(f);
  const story = p.story || "لا يوجد وصف بعد.";
  const progress = Math.round(((tourIndex + 1) / tourList.length) * 100);

  tourCounter.textContent = `محطة ${tourIndex + 1} من ${tourList.length}`;
  tourEra.textContent = `العصر: ${era}`;
  tourName.textContent = name;
  tourStory.textContent = story;
  tourBar.style.width = `${progress}%`;

  if (focus) {
    selectFeature(f, true);
  }

  // Auto play audio if exists (اختياري)
  const audio = p.audio || "";
  if (audio) {
    try{
      narrator.pause();
      narrator.currentTime = 0;
      narrator.src = audio;
      narrator.play().catch(()=>{});
    }catch{}
  }
}

function startTour() {
  if (!tourList.length) buildTourList();
  tourPlaying = true;
  btnPlay.textContent = "إيقاف";
  btnTour.textContent = "إيقاف الجولة";

  // move every 4 seconds
  tourTimer = setInterval(() => {
    showTourItem(tourIndex + 1, true);
  }, 4000);
}

function stopTour() {
  tourPlaying = false;
  btnPlay.textContent = "تشغيل";
  if (tourTimer) clearInterval(tourTimer);
  tourTimer = null;
}

// ===== WALKING ROUTE =====
btnRoute?.addEventListener("click", () => {
  // toggle route
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
    btnRoute.textContent = "المسار";
    return;
  }

  // build route from filtered list in order (by year or name)
  const list = getFilteredFeatures();
  const coords = list.map(latlngFromFeature).filter(Boolean);

  if (coords.length < 2) {
    alert("لا يوجد نقاط كافية لرسم مسار.");
    return;
  }

  routeLine = L.polyline(coords, {
    color: "#6aaed6",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
  btnRoute.textContent = "إخفاء المسار";
});
