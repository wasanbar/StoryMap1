// ===== عناصر الواجهة =====
const intro = document.getElementById("intro");
const app = document.getElementById("app");
const btnEnter = document.getElementById("btnEnter");
const btnHome = document.getElementById("btnHome");
const btnLegend = document.getElementById("btnLegend");
const legend = document.getElementById("legend");
const panel = document.getElementById("panel");

// About dialog
const btnAbout = document.getElementById("btnAbout");
const aboutDialog = document.getElementById("aboutDialog");
const btnCloseAbout = document.getElementById("btnCloseAbout");

// Tour
const btnTour = document.getElementById("btnTour");

let mapInitialized = false;
let map;

// Layers
let geoLayer;                 // طبقة GeoJSON
let clusterLayer;             // MarkerClusterGroup (اختياري)

// Data + indexes
let buildingsData = [];       // نخزن features هنا
let markerIndex = new Map();  // key -> layer (للتحديد/الهايلايت)
let highlighted;              // آخر نقطة تم إبرازها

// UI state
let currentQuery = "";
let currentStatus = "all";
let currentStyle = "all";
let currentSort = "name";
let yearMaxSelected = null;   // slider max (<=)
let yearMin = null;
let yearMax = null;

let tourTimer = null;
let tourIndex = 0;

// ===== أدوات مساعدة =====
function debounce(fn, delay = 180) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ===== مفتاح موحّد لكل feature =====
function getFeatureKey(feature) {
  const p = feature?.properties || {};
  // prefer stable unique id, else name+coords
  const coords = feature?.geometry?.coordinates || [];
  return String(
    p.id ||
    p.slug ||
    p.name ||
    `${coords[0] || ""},${coords[1] || ""}`
  );
}

function getYear(feature) {
  const y = feature?.properties?.year;
  const n = Number(y);
  return Number.isFinite(n) ? n : null;
}

function getStatus(feature) {
  return String(feature?.properties?.status || "").trim() || "غير محدد";
}

function getStyle(feature) {
  return String(feature?.properties?.style || "").trim() || "غير محدد";
}

function parseUrlSelection() {
  // supports: ?id=... or #id=...
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

// ===== أزرار الواجهة =====
btnEnter?.addEventListener("click", () => {
  intro.classList.add("is-hidden");
  app.classList.remove("is-hidden");
  initMapOnce();
});

btnHome?.addEventListener("click", () => {
  app.classList.add("is-hidden");
  intro.classList.remove("is-hidden");
  stopTour();
});

btnLegend?.addEventListener("click", () => {
  legend?.classList.toggle("is-hidden");
});

// About dialog wiring
btnAbout?.addEventListener("click", () => {
  if (aboutDialog?.showModal) aboutDialog.showModal();
});
btnCloseAbout?.addEventListener("click", () => aboutDialog?.close());
aboutDialog?.addEventListener("click", (e) => {
  // click outside content closes
  const rect = aboutDialog.getBoundingClientRect();
  const inside =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top && e.clientY <= rect.bottom;
  // dialog click fires anywhere; we only close if user clicked backdrop area.
  if (!inside) aboutDialog.close();
});

// Tour
btnTour?.addEventListener("click", () => {
  if (tourTimer) stopTour();
  else startTour();
});

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

// ===== تحميل GeoJSON =====
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
      buildingsData = (geojson && geojson.features) ? geojson.features : [];

      // compute years range
      const years = buildingsData.map(getYear).filter(v => v !== null);
      yearMin = years.length ? Math.min(...years) : null;
      yearMax = years.length ? Math.max(...years) : null;
      yearMaxSelected = yearMax;

      rebuildLayers(geojson);

      // زوم عام
      zoomToAll();

      // ابنِ القائمة + البحث/الفلاتر
      renderBuildingsList();

      // إذا في id بالـ URL افتحيه
      const selectedId = parseUrlSelection();
      if (selectedId) {
        const f = buildingsData.find(x => getFeatureKey(x) === selectedId);
        if (f) {
          focusOnFeature(f, { zoom: 19, animate: true });
          renderDetails(f);
          highlightMarker(f);
        }
      }
    })
    .catch(err => {
      console.error(err);
      panel.innerHTML = `
        <div class="panel__empty">
          <h2>مشكلة في البيانات</h2>
          <p>تأكدي أن الملف <code>data/buildings.geojson</code> موجود وصحيح.</p>
          <p class="smallNote">تفاصيل: ${escapeHtml(err.message || String(err))}</p>
        </div>
      `;
    });
}

function rebuildLayers(geojson) {
  // remove old
  if (geoLayer) geoLayer.remove();
  if (clusterLayer) clusterLayer.remove();
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

  const highlightStyle = {
    radius: 10,
    fillColor: "#ffd27a",
    color: "#000000",
    weight: 2,
    opacity: 1,
    fillOpacity: 1
  };

  const makeLayer = () =>
    L.geoJSON(geojson, {
      // نقاط فقط في ملفك الحالي، لو لاحقاً صار Polygon بنغيّر بسهولة
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleForFeature(feature, baseStyle)),
      onEachFeature: (feature, layer) => {
        const key = getFeatureKey(feature);
        markerIndex.set(key, layer);

        layer.on("click", () => {
          stopTour(); // أي تفاعل يدوي يوقف الجولة
          focusOnFeature(feature, { zoom: 19, animate: true });
          renderDetails(feature);
          highlightMarker(feature, baseStyle, highlightStyle);
          setUrlSelection(key);
        });
      }
    });

  geoLayer = makeLayer();

  // Cluster only if library exists and count is "big"
  const useCluster = (typeof L.markerClusterGroup === "function") && buildingsData.length >= 30;

  if (useCluster) {
    clusterLayer = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 18
    });
    clusterLayer.addLayer(geoLayer);
    clusterLayer.addTo(map);
  } else {
    geoLayer.addTo(map);
  }
}

function styleForFeature(feature, baseStyle) {
  // لون حسب الحالة (اختياري) — متوافق مع أسطورتك
  const status = (feature?.properties?.status || "").toLowerCase();
  if (status.includes("مهدد") || status.includes("خطر")) {
    return { ...baseStyle, fillColor: "#e07a5f" };
  }
  if (status.includes("مرمم") || status.includes("تم ترميم")) {
    return { ...baseStyle, fillColor: "#81b29a" };
  }
  return baseStyle;
}

function zoomToAll() {
  const layer = clusterLayer || geoLayer;
  if (!layer) return;

  const b = layer.getBounds?.();
  if (b && b.isValid && b.isValid()) {
    map.fitBounds(b, { padding: [40, 40] });
  }
}

// ===== فلترة/فرز =====
function getFilteredFeatures() {
  const q = currentQuery.trim().toLowerCase();

  let arr = buildingsData.filter(f => {
    const name = String(f?.properties?.name || "").toLowerCase();
    const status = getStatus(f);
    const style = getStyle(f);
    const y = getYear(f);

    const passQuery = q ? (name.includes(q) || String(status).toLowerCase().includes(q) || String(style).toLowerCase().includes(q)) : true;
    const passStatus = (currentStatus === "all") ? true : (status === currentStatus);
    const passStyle = (currentStyle === "all") ? true : (style === currentStyle);
    const passYear = (yearMaxSelected === null || y === null) ? true : (y <= yearMaxSelected);

    return passQuery && passStatus && passStyle && passYear;
  });

  // Sort
  arr.sort((a, b) => {
    if (currentSort === "year") {
      const ya = getYear(a) ?? 999999;
      const yb = getYear(b) ?? 999999;
      return ya - yb;
    }
    // default name
    const na = String(a?.properties?.name || "");
    const nb = String(b?.properties?.name || "");
    return na.localeCompare(nb, "ar");
  });

  return arr;
}

function updateLayerVisibility() {
  const allowed = new Set(getFilteredFeatures().map(getFeatureKey));

  markerIndex.forEach((layer, key) => {
    if (!layer) return;
    const shouldShow = allowed.has(key);

    // circleMarker supports setStyle; we can toggle by opacity
    if (layer.setStyle) {
      layer.setStyle({
        opacity: shouldShow ? 1 : 0,
        fillOpacity: shouldShow ? 0.9 : 0
      });
    }
  });

  // if highlighted is now hidden, clear it
  if (highlighted && highlighted.options && highlighted.options.opacity === 0) {
    highlighted = null;
  }
}

// ===== قائمة المباني + بحث + فلاتر =====
function renderBuildingsList() {
  // options
  const statuses = Array.from(new Set(buildingsData.map(getStatus))).sort((a,b)=>a.localeCompare(b,"ar"));
  const styles = Array.from(new Set(buildingsData.map(getStyle))).sort((a,b)=>a.localeCompare(b,"ar"));

  panel.innerHTML = `
    <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom:10px;">
      <h2 style="margin:0;">المباني</h2>
      <div class="smallNote">${buildingsData.length} عنصر</div>
    </div>

    <div class="controls">
      <input id="searchBox" class="input" type="text" placeholder="ابحث (اسم/طراز/حالة)…" />

      <div class="controls__row">
        <select id="statusSel" class="select">
          <option value="all">كل الحالات</option>
          ${statuses.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>

        <select id="styleSel" class="select">
          <option value="all">كل الطرز</option>
          ${styles.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
      </div>

      <div class="controls__row">
        <select id="sortSel" class="select">
          <option value="name">فرز: الاسم</option>
          <option value="year">فرز: السنة</option>
        </select>

        <button id="btnZoomAll" class="btn btn--ghost btn--sm" style="width:100%;">عرض الكل</button>
      </div>

      ${yearMin !== null && yearMax !== null ? `
        <div class="rangeWrap">
          <span class="pill">حتى سنة</span>
          <input id="yearRange" type="range" min="${yearMin}" max="${yearMax}" value="${yearMaxSelected ?? yearMax}" step="1" />
          <span id="yearVal" class="pill">${yearMaxSelected ?? yearMax}</span>
        </div>
      ` : `<div class="smallNote">لا يوجد حقل سنة صالح في البيانات.</div>`}
    </div>

    <div class="kpi">
      <span class="pill">بحث: <span id="kQuery">-</span></span>
      <span class="pill">تصفية: <span id="kFilter">-</span></span>
    </div>

    <div id="listBox" style="display:flex; flex-direction:column; gap:8px;"></div>
  `;

  const searchBox = document.getElementById("searchBox");
  const statusSel = document.getElementById("statusSel");
  const styleSel = document.getElementById("styleSel");
  const sortSel = document.getElementById("sortSel");
  const yearRange = document.getElementById("yearRange");
  const yearVal = document.getElementById("yearVal");
  const listBox = document.getElementById("listBox");
  const kQuery = document.getElementById("kQuery");
  const kFilter = document.getElementById("kFilter");

  function setKpis() {
    kQuery.textContent = currentQuery ? currentQuery : "—";
    const parts = [];
    if (currentStatus !== "all") parts.push(`حالة: ${currentStatus}`);
    if (currentStyle !== "all") parts.push(`طراز: ${currentStyle}`);
    if (yearMaxSelected !== null && yearMax !== null && yearMaxSelected !== yearMax) parts.push(`حتى: ${yearMaxSelected}`);
    kFilter.textContent = parts.length ? parts.join(" | ") : "—";
  }

  function drawList() {
    const filtered = getFilteredFeatures();
    setKpis();
    updateLayerVisibility();

    if (filtered.length === 0) {
      listBox.innerHTML = `<div style="opacity:.8">لا يوجد نتائج.</div>`;
      return;
    }

    listBox.innerHTML = filtered.map((f) => {
      const p = f?.properties || {};
      const name = p.name || "مبنى بدون اسم";
      const year = p.year || "";
      const st = getStatus(f);
      const key = getFeatureKey(f);
      return `
        <button class="bItem" data-key="${escapeHtml(key)}"
          style="text-align:right; cursor:pointer; padding:10px 12px;
                 border:1px solid #333; border-radius:12px; background: rgba(255,255,255,.04);
                 color:#fff; font-family:inherit;">
          <div style="font-weight:800;">${escapeHtml(name)}</div>
          <div style="opacity:.78; font-size:12px; margin-top:3px; display:flex; gap:8px; flex-wrap:wrap;">
            ${year ? `<span>سنة: ${escapeHtml(String(year))}</span>` : ``}
            <span>حالة: ${escapeHtml(String(st))}</span>
          </div>
        </button>
      `;
    }).join("");

    listBox.querySelectorAll(".bItem").forEach(btn => {
      btn.addEventListener("click", () => {
        stopTour();
        const key = btn.getAttribute("data-key");
        const feature = buildingsData.find(f => getFeatureKey(f) === key);
        if (!feature) return;

        focusOnFeature(feature, { zoom: 19, animate: true });
        renderDetails(feature);
        highlightMarker(feature);
        setUrlSelection(key);
      });
    });
  }

  drawList();

  searchBox.addEventListener("input", debounce((e) => {
    currentQuery = e.target.value || "";
    drawList();
  }, 160));

  statusSel.addEventListener("change", (e) => {
    currentStatus = e.target.value;
    drawList();
  });

  styleSel.addEventListener("change", (e) => {
    currentStyle = e.target.value;
    drawList();
  });

  sortSel.addEventListener("change", (e) => {
    currentSort = e.target.value;
    drawList();
  });

  document.getElementById("btnZoomAll")?.addEventListener("click", () => {
    stopTour();
    zoomToAll();
  });

  if (yearRange) {
    yearRange.addEventListener("input", (e) => {
      yearMaxSelected = Number(e.target.value);
      if (yearVal) yearVal.textContent = String(yearMaxSelected);
      drawList();
    });
  }
}

// ===== زوم قوي للمبنى =====
function focusOnFeature(feature, opts = {}) {
  const { zoom = 19, animate = true } = opts;
  const coords = feature?.geometry?.coordinates;
  if (!coords || coords.length < 2) return;

  const lng = coords[0];
  const lat = coords[1];

  map.flyTo([lat, lng], zoom, {
    animate,
    duration: 1.15
  });
}

// ===== تفاصيل المبنى (في نفس اللوحة) =====
function renderDetails(feature) {
  const p = feature?.properties || {};
  const title = p.name || "مبنى";
  const year = p.year || "-";
  const style = p.style || "-";
  const status = p.status || "-";
  const story = p.story || "لا يوجد وصف بعد.";
  const img = p.image || "";
  const link = p.link || "";

  const key = getFeatureKey(feature);

  const imgHtml = img
    ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(title)}"
         style="width:100%; height:160px; object-fit:cover; border-radius:14px; margin-bottom:10px;" />`
    : "";

  const linkHtml = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener"
         style="display:inline-block; margin-top:10px; padding:8px 12px; border-radius:999px;
                background: #c8a86a; color:#111; font-weight:800; text-decoration:none;">
         مصدر / المزيد
       </a>`
    : "";

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
      <h2 style="margin:0;">${escapeHtml(title)}</h2>
      <button id="backToList"
        style="cursor:pointer; padding:8px 10px; border-radius:12px; border:1px solid #333;
               background: rgba(255,255,255,.04); color:#fff; font-family:inherit;">
        ← رجوع
      </button>
    </div>

    ${imgHtml}

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 12px;">
      <span class="pill">سنة: ${escapeHtml(String(year))}</span>
      <span class="pill">طراز: ${escapeHtml(String(style))}</span>
      <span class="pill">حالة: ${escapeHtml(String(status))}</span>
    </div>

    <p style="line-height:1.9; opacity:.9; margin:0;">${escapeHtml(String(story))}</p>

    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px;">
      ${linkHtml}
      <button id="btnCopyLink" class="btn btn--ghost btn--sm" style="border-radius:999px;">
        نسخ رابط هذا المبنى
      </button>
    </div>

    <p class="smallNote" style="margin-top:10px;">معرّف: <code style="opacity:.85;">${escapeHtml(String(key))}</code></p>
  `;

  document.getElementById("backToList")?.addEventListener("click", () => {
    renderBuildingsList();
  });

  document.getElementById("btnCopyLink")?.addEventListener("click", async () => {
    try{
      setUrlSelection(key);
      await navigator.clipboard.writeText(window.location.href);
      const btn = document.getElementById("btnCopyLink");
      if (btn) btn.textContent = "تم النسخ ✅";
      setTimeout(() => { const b = document.getElementById("btnCopyLink"); if (b) b.textContent = "نسخ رابط هذا المبنى"; }, 900);
    }catch(e){
      alert("لم أستطع نسخ الرابط. انسخي الرابط يدويًا من شريط العنوان.");
    }
  });
}

// ===== هايلايت نقطة على الخريطة =====
function highlightMarker(feature, baseStyle, highlightStyle) {
  const base = baseStyle || {
    radius: 7, fillColor: "#c8a86a", color: "#fff", weight: 1.5, opacity: 1, fillOpacity: 0.9
  };
  const hi = highlightStyle || {
    radius: 10, fillColor: "#ffd27a", color: "#000", weight: 2, opacity: 1, fillOpacity: 1
  };

  // رجّع السابق لوضعه الطبيعي
  if (highlighted && highlighted.setStyle) highlighted.setStyle(base);

  const key = getFeatureKey(feature);
  const layer = markerIndex.get(key);
  if (layer && layer.setStyle) {
    layer.setStyle(hi);
    highlighted = layer;
  }
}

// ===== الجولة (Story Tour) =====
function startTour() {
  const list = getFilteredFeatures();
  if (!list.length) return;

  btnTour.textContent = "إيقاف الجولة";
  tourIndex = 0;

  const step = () => {
    const f = list[tourIndex % list.length];
    tourIndex += 1;
    const key = getFeatureKey(f);
    focusOnFeature(f, { zoom: 19, animate: true });
    renderDetails(f);
    highlightMarker(f);
    setUrlSelection(key);
  };

  step();
  tourTimer = setInterval(step, 3500);
}

function stopTour() {
  if (!tourTimer) return;
  clearInterval(tourTimer);
  tourTimer = null;
  btnTour.textContent = "الجولة";
}
