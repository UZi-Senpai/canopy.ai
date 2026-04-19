/* ═══════════════════════════════════════════════════════════════════════════
   CANOPY v5 — app.js
   Two-epoch · Five-index · Biome-aware · Spatial-aware severity
   Stage 1 — visual extraction (2 images: baseline + current)
   Stage 2 — spectral + visual + pixel-level spatial synthesis
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Window size state ────────────────────────────────────────────────────────
const WINDOW_SIZES  = [50, 100, 10, 20];
let   windowSizeIdx = 0;
let   ANALYSIS_KM   = WINDOW_SIZES[0];

function cycleWindowSize() {
  windowSizeIdx = (windowSizeIdx + 1) % WINDOW_SIZES.length;
  ANALYSIS_KM   = WINDOW_SIZES[windowSizeIdx];
  const btn = document.getElementById('windowBtn');
  if (btn) btn.textContent = `⬚ ${ANALYSIS_KM} km`;
  if (selectedPoint) placeBox(selectedPoint.lat, selectedPoint.lon);
}

// ─── Clock ────────────────────────────────────────────────────────────────────
(function tick() {
  const n = new Date(), p = x => String(x).padStart(2, '0');
  document.getElementById('clk').textContent =
    `${p(n.getUTCHours())}:${p(n.getUTCMinutes())} UTC`;
  setTimeout(tick, 10_000);
})();

// ─── Map setup ────────────────────────────────────────────────────────────────
const map = L.map('map', { center: [5, 20], zoom: 3, zoomControl: false });
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri, Maxar', maxZoom: 18 }
).addTo(map);
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { opacity: 0.8, zIndex: 400, maxZoom: 18 }
).addTo(map);

// ─── Coord navigation ─────────────────────────────────────────────────────────
function goToCoords() {
  const latEl = document.getElementById('coordLat');
  const lonEl = document.getElementById('coordLon');
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    latEl.style.borderColor = 'var(--red)'; lonEl.style.borderColor = 'var(--red)';
    setTimeout(() => { latEl.style.borderColor = ''; lonEl.style.borderColor = ''; }, 1200);
    return;
  }
  map.flyTo([lat, lon], 9, { animate: true, duration: 1.6, easeLinearity: 0.25 });
  setTimeout(() => placeBox(lat, lon), 1700);
  const thint = document.getElementById('thint');
  if (thint) thint.textContent = `→ ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
}

document.addEventListener('DOMContentLoaded', () => {
  ['coordLat', 'coordLon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') goToCoords(); });
  });
});

// ─── State ────────────────────────────────────────────────────────────────────
let selectedPoint = null;
let boxLayer      = null;
let lastData      = null;
let stepTimer     = null;

// ─── Fixed bbox ───────────────────────────────────────────────────────────────
function computeFixedBbox(lat, lon) {
  const halfLat = (ANALYSIS_KM / 2) / 111.32;
  const halfLon = (ANALYSIS_KM / 2) / (111.32 * Math.cos(lat * Math.PI / 180));
  return { north: lat + halfLat, south: lat - halfLat,
           east:  lon + halfLon, west:  lon - halfLon };
}

// ─── Cursor preview ───────────────────────────────────────────────────────────
const cursorBox   = document.getElementById('cursorBox');
const cursorLabel = document.getElementById('cursorLabel');
const mapEl       = document.getElementById('map');

function showCursorBox(e) {
  if (selectedPoint) return;
  const { x, y } = e.containerPoint;
  const latlng = map.containerPointToLatLng([x, y]);
  const bb = computeFixedBbox(latlng.lat, latlng.lng);
  const sw = map.latLngToContainerPoint([bb.south, bb.west]);
  const ne = map.latLngToContainerPoint([bb.north, bb.east]);
  const mr = mapEl.getBoundingClientRect();
  cursorBox.style.cssText =
    `left:${mr.left+sw.x}px;top:${mr.top+ne.y}px;width:${Math.abs(ne.x-sw.x)}px;height:${Math.abs(sw.y-ne.y)}px;display:block;`;
  cursorLabel.style.cssText = `left:${mr.left+sw.x+4}px;top:${mr.top+ne.y+4}px;display:block;`;
  cursorLabel.textContent = `${ANALYSIS_KM} × ${ANALYSIS_KM} km`;
}
function hideCursorBox() { cursorBox.style.display = 'none'; cursorLabel.style.display = 'none'; }
map.on('mousemove', showCursorBox);
map.on('mouseout',  hideCursorBox);

// ─── Click → place box ────────────────────────────────────────────────────────
map.on('click', function (e) {
  if (document.body.classList.contains('open')) return;
  placeBox(e.latlng.lat, e.latlng.lng);
});

function placeBox(lat, lon) {
  selectedPoint = { lat, lon };
  hideCursorBox();
  const bb = computeFixedBbox(lat, lon);
  if (boxLayer) map.removeLayer(boxLayer);
  boxLayer = L.rectangle([[bb.south, bb.west], [bb.north, bb.east]], {
    color: '#00e87a', fillColor: '#00e87a', fillOpacity: 0.08, weight: 2,
  }).addTo(map);
  document.getElementById('bchips').innerHTML =
    `<span class="chip-fixed">⬚ ${ANALYSIS_KM} × ${ANALYSIS_KM} km</span>
     <span class="chip"><b>${lat.toFixed(3)}°, ${lon.toFixed(3)}°</b></span>`;
  document.getElementById('actionBar').classList.add('up');
  document.getElementById('hint').classList.add('gone');
}

function clearSel() {
  selectedPoint = null;
  if (boxLayer) { map.removeLayer(boxLayer); boxLayer = null; }
  if (window._changeOverlay) { map.removeLayer(window._changeOverlay); window._changeOverlay = null; }
  document.getElementById('actionBar').classList.remove('up');
  document.getElementById('hint').classList.remove('gone');
  const thint = document.getElementById('thint');
  if (thint) thint.textContent = '';
}

// ─── Drawer ───────────────────────────────────────────────────────────────────
function openDrawer()  { document.getElementById('drawer').classList.add('open'); document.body.classList.add('open'); }
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open'); document.body.classList.remove('open');
  setTimeout(() => map.invalidateSize(), 420);
}

// ─── Step progress (7 steps for 2-epoch pipeline) ────────────────────────────
const STEP_IDS    = ['s0','s1','s2','s3','s4','s5','s6'];
const STEP_END_MS = [3000, 5000, 10000, 50000, 30000, 65000, 120000];
const TOTAL_MS    = 130_000;
let pbInterval = null;

function resetSteps() {
  if (stepTimer)  { clearInterval(stepTimer);  stepTimer  = null; }
  if (pbInterval) { clearInterval(pbInterval); pbInterval = null; }
  STEP_IDS.forEach(id => document.getElementById(id).classList.remove('on', 'ok'));
  ['pbfill','pb-pct','pb-eta'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'pbfill') el.style.width = '0%';
    else if (id === 'pb-pct') el.textContent = '0%';
    else el.textContent = 'Estimated time: ~2 min';
  });
}

function advanceTo(n) {
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(STEP_IDS[i]);
    el.classList.remove('on'); el.classList.add('ok');
  }
  if (n < STEP_IDS.length) document.getElementById(STEP_IDS[n]).classList.add('on');
}

function startStepTimer() {
  let step = 0, pbStart = Date.now();
  advanceTo(step);
  pbInterval = setInterval(() => {
    const elapsed = Date.now() - pbStart;
    while (step < STEP_IDS.length - 1 && elapsed >= STEP_END_MS[step]) { step++; advanceTo(step); }
    const pct = elapsed < TOTAL_MS ? Math.round(elapsed / TOTAL_MS * 90) : Math.min(95, 90 + Math.floor((elapsed - TOTAL_MS) / 10000));
    const remSec = Math.max(0, Math.round((TOTAL_MS - elapsed) / 1000));
    const fill  = document.getElementById('pbfill');
    const pctEl = document.getElementById('pb-pct');
    const etaEl = document.getElementById('pb-eta');
    if (fill)  fill.style.width  = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (etaEl) etaEl.textContent = remSec > 5 ? `~${remSec}s remaining` : elapsed < TOTAL_MS ? 'Almost done…' : 'Finalising…';
  }, 500);
}

function completeSteps() {
  if (stepTimer)  { clearInterval(stepTimer);  stepTimer  = null; }
  if (pbInterval) { clearInterval(pbInterval); pbInterval = null; }
  STEP_IDS.forEach(id => { const el = document.getElementById(id); el.classList.remove('on'); el.classList.add('ok'); });
  const fill  = document.getElementById('pbfill');
  const pctEl = document.getElementById('pb-pct');
  const etaEl = document.getElementById('pb-eta');
  if (fill)  fill.style.width  = '100%';
  if (pctEl) pctEl.textContent = '100%';
  if (etaEl) etaEl.textContent = 'Analysis complete';
}

// ─── Risk helpers ─────────────────────────────────────────────────────────────
function detectRisk(report) {
  const t = (typeof report === 'string' ? report : JSON.stringify(report)).toLowerCase();
  if (t.includes('critical')) return 'critical';
  if (t.includes('high'))     return 'high';
  if (t.includes('medium'))   return 'medium';
  return 'low';
}
const RISK_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

// ─── Badge helpers ────────────────────────────────────────────────────────────
function cloudBadge(pct) {
  if (pct == null) return '';
  const cls  = pct > 60 ? 'cloud-bad' : pct > 30 ? 'cloud-warn' : 'cloud-ok';
  const icon = pct > 60 ? '☁' : pct > 30 ? '🌤' : '☀';
  return `<span class="cloud-badge ${cls}">${icon} ${pct.toFixed(0)}%</span>`;
}

function sarBadge(m) {
  if (!m.sar_available) return `<span class="sar-badge sar-inactive">📡 SAR N/A</span>`;
  if (m.sar_defor_flag) return `<span class="sar-badge sar-flag">📡 SAR DEFOR FLAG</span>`;
  return `<span class="sar-badge sar-active">📡 SAR ${(m.sar_label || 'stable').replace('_',' ').toUpperCase()}</span>`;
}

function seasonalBadge(m) {
  if (!m.vis_stage1_ok) return '';
  if (m.vis_seasonal_likely) return `<span class="vis-badge vis-seasonal">🌿 Likely Seasonal</span>`;
  const traj = (m.vis_trajectory || '').replace(/_/g, ' ');
  if (!traj || traj === 'not determinable') return '';
  const color = traj.includes('loss') ? 'vis-clear' : traj.includes('recovery') ? 'vis-road' : '';
  return `<span class="vis-badge ${color}">⟳ ${traj}</span>`;
}

function biomeBadge(m) {
  if (!m.vis_stage1_ok || !m.vis_biome || m.vis_biome === 'unknown') return '';
  return `<span class="vis-badge vis-biome"> ${m.vis_biome.replace(/_/g, ' ')}</span>`;
}

function visBadges(m) {
  if (!m.vis_stage1_ok) return '';
  const b = [];
  if (m.vis_logging_roads)   b.push(`<span class="vis-badge vis-road">🛤 Roads</span>`);
  if (m.vis_burn_scars)      b.push(`<span class="vis-badge vis-fire">🔥 Burn scars</span>`);
  if (m.vis_active_clearing) b.push(`<span class="vis-badge vis-clear">⬛ Clearing</span>`);
  b.push(`<span class="vis-badge vis-conf">👁 S1 ${m.vis_confidence}%</span>`);
  return b.join('');
}

function spatialBadge(m) {
  if (m.change_loss_pct == null) return '';
  const loss = m.change_loss_pct;
  const conc = m.change_concentration || 1;
  if (loss < 1) return '';
  const cls = loss >= 10 ? 'neg' : loss >= 3 ? 'mchip-warn' : '';
  const concNote = conc >= 2 ? ` · ${conc.toFixed(1)}× conc.` : '';
  return `<span class="mchip ${cls}">px-loss <b>${loss.toFixed(1)}%${concNote}</b></span>`;
}

function confClass(label) { return `conf-${(label || 'low').toLowerCase()}`; }

// ─── HTML sanitiser — strip angle brackets from any model string ──────────────
function sanitize(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Visual extraction panel ──────────────────────────────────────────────────
function buildVisualPanel(ve) {
  if (!ve || !ve._stage1_success) {
    return `<div class="vispanel vispanel-fail">
      <div class="vispanel-head">
        <span class="vispanel-label">GEMMA STAGE 1 · VISUAL EXTRACTION</span>
        <span class="vis-fail-tag">parse failed</span>
      </div>
      <div class="vispanel-note">Stage 1 JSON could not be parsed. Stage 2 used spectral data only.</div>
    </div>`;
  }
  const bool = v => v ? `<span class="vis-yes">YES</span>` : `<span class="vis-no">NO</span>`;
  const conf = ve.overall_confidence || 0;
  const confCls = conf >= 70 ? 'vconf-high' : conf >= 45 ? 'vconf-med' : 'vconf-low';
  const trajMap = { progressive_loss:'🔴', loss_then_stable:'🟠', loss_then_recovery:'🟡', stable:'🟢', seasonal_cycle:'🔵', not_determinable:'⚪' };
  const trajIcon = trajMap[ve.temporal_trajectory] || '⚪';

  return `<div class="vispanel">
    <div class="vispanel-head">
      <span class="vispanel-label">GEMMA STAGE 1 · VISUAL EXTRACTION · 2-IMAGE</span>
      <span class="${confCls}">${conf}/100</span>
    </div>
    <div class="vis-grid">
      <div class="vis-row"><span class="vis-k">Biome</span><span class="vis-v vis-text">${sanitize((ve.biome_classification||'—').replace(/_/g,' '))}</span></div>
      <div class="vis-row"><span class="vis-k">Forest scene</span><span class="vis-v">${bool(ve.is_forest_scene !== false)}</span></div>
      <div class="vis-row"><span class="vis-k">Trajectory</span><span class="vis-v vis-text">${trajIcon} ${sanitize((ve.temporal_trajectory||'—').replace(/_/g,' '))}</span></div>
      <div class="vis-row"><span class="vis-k">Seasonal likely</span><span class="vis-v">${ve.seasonal_change_likely ? '<span class="vis-seasonal-tag">SEASONAL</span>' : '<span class="vis-no">Structural/unclear</span>'}</span></div>
      <div class="vis-row"><span class="vis-k">Canopy cover</span><span class="vis-v">${ve.canopy_cover_pct != null ? ve.canopy_cover_pct.toFixed(1)+'%' : '—'}</span></div>
      <div class="vis-row"><span class="vis-k">Bare soil</span><span class="vis-v">${ve.bare_soil_exposure_pct != null ? ve.bare_soil_exposure_pct.toFixed(1)+'%' : '—'}</span></div>
      <div class="vis-row"><span class="vis-k">Logging roads</span><span class="vis-v">${bool(ve.logging_roads_detected)}${ve.logging_road_count_estimate > 0 ? `<span class="vis-count"> ~${ve.logging_road_count_estimate}</span>` : ''}</span></div>
      <div class="vis-row"><span class="vis-k">Burn scars</span><span class="vis-v">${bool(ve.burn_scars_detected)}${ve.burn_scar_pct > 0 ? `<span class="vis-count"> ${ve.burn_scar_pct.toFixed(1)}%</span>` : ''}</span></div>
      <div class="vis-row"><span class="vis-k">Active clearing</span><span class="vis-v">${bool(ve.active_clearing_detected)}</span></div>
      <div class="vis-row"><span class="vis-k">Agri encroachment</span><span class="vis-v">${bool(ve.agricultural_encroachment)}</span></div>
      <div class="vis-row"><span class="vis-k">Canopy texture</span><span class="vis-v vis-text">${sanitize((ve.canopy_texture||'—').replace(/_/g,' '))}</span></div>
      <div class="vis-row"><span class="vis-k">Change pattern</span><span class="vis-v vis-text">${sanitize((ve.dominant_change_pattern||'none').replace(/_/g,' '))}</span></div>
      <div class="vis-row"><span class="vis-k">Image quality</span><span class="vis-v vis-text">${sanitize(ve.image_quality_assessment||'—')}</span></div>
    </div>
    ${ve.baseline_vs_current_change ? `<div class="vis-temporal"><span class="vis-temporal-label">Baseline → Current</span><p class="vis-spatial-text">${sanitize(ve.baseline_vs_current_change)}</p></div>` : ''}
    ${ve.spatial_pattern_description ? `<div class="vis-spatial"><span class="vis-spatial-label">Spatial description</span><p class="vis-spatial-text">${sanitize(ve.spatial_pattern_description)}</p></div>` : ''}
  </div>`;
}

// ─── Section metadata ─────────────────────────────────────────────────────────
const SECTION_META = [
  { key: 'risk_level',              label: 'Risk Level' },
  { key: 'seasonal_vs_structural',  label: '🌿 Seasonal vs. Structural', special: 'seasonal' },
  { key: 'image_observations',      label: 'Image Observations (Baseline → Current)' },
  { key: 'spatial_analysis',        label: '  Spatial Distribution Analysis' },
  { key: 'index_synthesis',         label: 'Multi-Index Synthesis (NDVI · EVI · NBR · BSI · NDWI)' },
  { key: 'visual_spectral_agreement', label: 'Visual ↔ Spectral Agreement', special: 'agreement' },
  { key: 'likely_causes',           label: 'Likely Causes' },
  { key: 'trend_analysis',          label: 'Trend Analysis' },
  { key: 'recommended_actions',     label: 'Recommended Actions' },
];

function renderSections(report) {
  if (typeof report === 'string') {
    return `<div class="rsec"><div class="sbody" style="font-family:var(--mono);font-size:11px;white-space:pre-wrap">${sanitize(report)}</div></div>`;
  }
  return SECTION_META.filter(s => report[s.key]).map(s => {
    const cls = s.special === 'agreement' ? 'rsec rsec-agreement'
              : s.special === 'seasonal'  ? 'rsec rsec-seasonal'
              : 'rsec';
    return `<div class="${cls}"><div class="stag">${s.label}</div><div class="sbody">${sanitize(String(report[s.key]))}</div></div>`;
  }).join('');
}

// ─── 5-Index 2-point sparklines (baseline + current) ─────────────────────────
function multiIndexSparklines(m) {
  if (m.ndvi_base == null || m.ndvi_now == null) return '';
  const indices = [
    { label:'NDVI', base:m.ndvi_base, now:m.ndvi_now, mn:-0.1, mx:0.9, posGood:true },
    { label:'EVI',  base:m.evi_base,  now:m.evi_now,  mn:-0.1, mx:0.9, posGood:true },
    { label:'NBR',  base:m.nbr_base,  now:m.nbr_now,  mn:-1.0, mx:1.0, posGood:true },
    { label:'BSI',  base:m.bsi_base,  now:m.bsi_now,  mn:-0.5, mx:0.5, posGood:false },
    { label:'NDWI', base:m.ndwi_base, now:m.ndwi_now, mn:-1.0, mx:1.0, posGood:true },
  ].filter(ix => ix.base != null && ix.now != null);
  if (!indices.length) return '';

  const W=220, H=44, PAD=8;
  const toX = (i, total) => PAD + i * ((W - PAD*2) / Math.max(total-1, 1));
  const toY  = (v, mn, mx) => H - PAD - ((v - mn) / (mx - mn)) * (H - PAD*2);

  const rows = indices.map(ix => {
    const pts  = [ix.base, ix.now];
    const labs = ['Base', 'Now'];
    const coords = pts.map((v, i) => ({ x: toX(i, pts.length), y: toY(v, ix.mn, ix.mx), v }));
    const delta  = ix.now - ix.base;
    const color  = Math.abs(delta) < 0.02 ? '#5a7a6e' : (delta > 0) === ix.posGood ? '#00e87a' : '#ff6b6b';
    const line   = coords.map(p => `${p.x},${p.y}`).join(' ');
    const sign   = delta >= 0 ? '+' : '';
    const dots   = coords.map((p, i) => `
      <circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${color}"/>
      <text x="${p.x}" y="${p.y-5}" text-anchor="middle" font-family="'Space Mono',monospace" font-size="7" fill="${color}">${p.v.toFixed(3)}</text>
      <text x="${p.x}" y="${H+2}" text-anchor="middle" font-family="'Space Mono',monospace" font-size="6.5" fill="#3a5a50">${labs[i]}</text>
    `).join('');
    return `<div class="sparkrow">
      <div class="sparklabel">${ix.label} <span style="color:${color};font-size:10px">${sign}${delta.toFixed(3)}</span></div>
      <svg viewBox="0 0 ${W} ${H+10}" width="100%" style="overflow:visible">
        <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
        ${dots}
      </svg>
    </div>`;
  }).join('');

  return `<div class="sparkbar"><div class="sparklabeltitle">5-Index · Baseline → Current</div>${rows}</div>`;
}

function ndviToTrack(v) { return Math.max(0, Math.min(100, ((v + 1) / 2) * 100)).toFixed(1); }

// ─── Glossary ─────────────────────────────────────────────────────────────────
const GLOSSARY_TERMS = [
  { term:'NDVI', icon:'1.', full:'Normalized Difference Vegetation Index',
    plain:'A measure of how green and healthy vegetation looks from space. Ranges −1 to +1; higher = greener.',
    scale:[{label:'< 0.1',color:'#c2855a',text:'Bare soil, rock or water'},{label:'0.1–0.3',color:'#d4b84a',text:'Sparse vegetation, grassland'},{label:'0.3–0.5',color:'#8aaa3a',text:'Shrubland or young forest'},{label:'0.5–0.7',color:'#3a8c3a',text:'Moderate forest canopy'},{label:'0.7–1.0',color:'#1a5c1a',text:'Dense, healthy tropical forest'}]},
  { term:'EVI', icon:'2.', full:'Enhanced Vegetation Index',
    plain:'Like NDVI but corrects for atmospheric haze and canopy background. More reliable over very dense tropical forest.',
    scale:null },
  { term:'NBR', icon:'3.', full:'Normalized Burn Ratio',
    plain:'Highly sensitive to fire damage. A large negative Δ NBR is the strongest single-index indicator of fire impact.',
    scale:[{label:'Δ > −0.10',color:'#1a7a4a',text:'No significant burn'},{label:'Δ −0.10 to −0.27',color:'#c8a020',text:'Low-to-moderate severity burn'},{label:'Δ < −0.27',color:'#d4362a',text:'High-severity burn or major clearing'}]},
  { term:'BSI', icon:'4.', full:'Bare Soil Index',
    plain:'Rises when soil is exposed by clearing. Confirms deforestation through an independent pathway even when NDVI change is moderate.',
    scale:[{label:'Δ > +0.15',color:'#d4362a',text:'Significant soil exposure — confirms clearing'},{label:'Δ −0.05 to +0.15',color:'#5a7a6e',text:'Stable land surface'},{label:'Δ < −0.05',color:'#1a7a4a',text:'Increasing vegetation cover'}]},
  { term:'NDWI', icon:'5.', full:'Normalized Difference Water Index (canopy moisture)',
    plain:'Measures water content in leaf canopies. A drop without a NDVI drop = drought stress, not clearing.',
    scale:null },
  { term:'Pixel-Level Loss %', icon:'6.', full:'Per-pixel NDVI delta overlay — NOT scene mean',
    plain:'Fraction of valid pixels showing NDVI loss >0.08. Far more sensitive to localized clearing than scene means. A 5% loss_pct in a 50×50 km window can mean thousands of hectares of active clearing while leaving mean NDVI nearly unchanged.',
    scale:[{label:'< 2%',color:'#1a7a4a',text:'Minor — noise floor or small disturbance'},{label:'2–10%',color:'#c8a020',text:'Moderate — significant localized change'},{label:'> 10%',color:'#d4362a',text:'High — widespread or concentrated clearing'}]},
  { term:'Spatial Concentration', icon:'7.', full:'Ratio of worst-cell loss vs. scene mean',
    plain:'> 2× means clearing is confined to a corner or edge hotspot rather than diffuse. A localized 4% loss with 3× concentration is more alarming than 4% diffuse loss — it indicates an active clearing front.',
    scale:null },
  { term:'SAR / VH Backscatter', icon:'8.', full:'Synthetic Aperture Radar — cloud-independent',
    plain:'Works through clouds and at night. Forests return a distinctive signal; when it drops, trees have likely been removed. Thresholds are indicative for tropical IW forest.',
    scale:[{label:'≥ −14 dB',color:'#1a5c1a',text:'High — closed canopy'},{label:'−14 to −20 dB',color:'#8aaa3a',text:'Medium — open or degraded canopy'},{label:'< −20 dB',color:'#c2855a',text:'Low — sparse cover or bare soil'}]},
  { term:'Confidence Score', icon:'9.', full:'Overall reliability (0–92)',
    plain:'Penalised for cloud cover, boosted by SAR, multi-index agreement, Stage 1 visual confidence. Hard cap at 92.',
    scale:[{label:'70–92',color:'#1a7a4a',text:'High — results reliable'},{label:'45–69',color:'#c8a020',text:'Medium — treat with caution'},{label:'0–44',color:'#d4362a',text:'Low — heavy cloud or sparse data'}]},
];

function buildGlossary() {
  const rows = GLOSSARY_TERMS.map(t => {
    const sh = t.scale ? `<div class="gl-scale">${t.scale.map(s =>
      `<div class="gl-scalerow"><span class="gl-dot" style="background:${s.color}"></span><span class="gl-range">${s.label}</span><span class="gl-meaning">${s.text}</span></div>`
    ).join('')}</div>` : '';
    return `<div class="gl-term">
      <div class="gl-head"><span class="gl-icon">${t.icon}</span>
        <div><span class="gl-name">${t.term}</span><span class="gl-full">${t.full}</span></div>
      </div>
      <p class="gl-plain">${t.plain}</p>${sh}
    </div>`;
  }).join('');
  return `<div class="glossary"><div class="glossary-divider"><span class="glossary-label">What the numbers mean</span></div>${rows}</div>`;
}

function buildGlossaryHTML() {
  const rows = GLOSSARY_TERMS.map(t => {
    const sh = t.scale ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">${t.scale.map(s =>
      `<div style="display:flex;align-items:center;gap:8px;font-family:'Space Mono',monospace;font-size:11px">
        <span style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0;display:inline-block"></span>
        <span style="color:#000;min-width:120px">${s.label}</span>
        <span style="color:#333">${s.text}</span>
      </div>`).join('')}</div>` : '';
    return `<div style="padding:18px 0;border-bottom:1px solid #d4e8dd">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:8px">
        <span style="font-size:20px">${t.icon}</span>
        <div>
          <div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:#000">${t.term}</div>
          <div style="font-family:'Space Mono',monospace;font-size:10px;color:#333;margin-top:2px">${t.full}</div>
        </div>
      </div>
      <p style="font-family:'Outfit',sans-serif;font-size:14px;color:#000;line-height:1.7;margin:0 0 0 32px">${t.plain}</p>
      <div style="margin-left:32px">${sh}</div>
    </div>`;
  }).join('');
  return `<div style="margin-top:48px"><div style="border-top:2px solid #d4e8dd;padding-top:32px">
    <h2 style="font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#333;margin-bottom:4px">Glossary — What the numbers mean</h2>
    ${rows}</div></div>`;
}

// ─── Render sidebar drawer ────────────────────────────────────────────────────
function renderDrawer(data) {
  const m    = data.meta;
  const ve   = data.visual_extraction || {};
  const risk = m.severity || detectRisk(data.report);
  const sign = m.ndvi_delta >= 0 ? '+' : '';
  const dcls = m.ndvi_delta < -0.02 ? 'neg' : m.ndvi_delta > 0.02 ? 'pos' : '';

  const secsHtml  = renderSections(data.report);
  const visPanel  = buildVisualPanel(ve);
  const def   = (v, d=4) => v != null ? Number(v).toFixed(d) : 'N/A';
  const defpm = (v, d=4) => v != null ? (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(d) : 'N/A';

  const sarPanel = m.sar_available ? `
    <div class="sarbar">
      <div class="sarbar-head"><span>📡 Sentinel-1 SAR · VH · 2-epoch</span><b>${sanitize((m.sar_label||'').replace('_',' ').toUpperCase())}</b></div>
      <div class="sarrow">
        <span>Base <b>${def(m.sar_vh_base_db,2)} dB</b></span>
        <span>Now <b>${def(m.sar_vh_now_db,2)} dB</b></span>
        <span class="${m.sar_delta_db < 0 ? 'neg' : 'pos'}">Δ <b>${defpm(m.sar_delta_db,2)} dB</b></span>
        ${m.sar_defor_flag ? '<span style="color:var(--red)">⚠ DEFOR FLAG</span>' : ''}
      </div>
    </div>` : '';

  const confPanel = `
    <div class="confbar ${confClass(m.confidence_label)}">
      <div class="conflabels"><span>Confidence — <b>${sanitize(m.confidence_label||'Low')}</b></span><span>${m.confidence_score||0}/100</span></div>
      <div class="conftrack"><div class="confill" style="width:${m.confidence_score||0}%"></div></div>
    </div>`;

  // ── 2-image strip: baseline + current ─────────────────────────────────────
  const imgStrip = `
    <div class="satdouble">
      <div class="satframe">
        <img src="data:image/png;base64,${data.base_image_b64}" alt="Baseline">
        <div class="satcap"><span class="satyear">${m.base_date.slice(0,4)}</span>BASELINE · ${sanitize(m.base_window||m.base_date)}</div>
      </div>
      <div class="satframe">
        <img src="data:image/png;base64,${data.cur_image_b64}" alt="Current">
        <div class="satcap"><span class="satyear">${m.cur_date.slice(0,4)}</span>CURRENT · ${sanitize(m.cur_window||m.cur_date)}</div>
      </div>
    </div>`;

  // ── Spatial pixel stats panel ──────────────────────────────────────────────
  const spatialPanel = (m.change_loss_pct != null) ? (() => {
    const loss   = m.change_loss_pct;
    const severe = m.change_severe_loss_pct;
    const maxc   = m.change_max_cell_loss_pct;
    const conc   = m.change_concentration;
    const lossColor = loss >= 10 ? '#d4362a' : loss >= 3 ? '#c8a020' : '#1a6640';
    const concNote  = conc != null && conc >= 2.0
      ? `<span style="color:#c8a020"> · ${conc.toFixed(1)}× concentrated</span>` : '';
    return `<div class="spatialbar">
      <div class="spatialbar-head">  Pixel-Level NDVI Change</div>
      <div class="spatialrow">
        <span>Loss <b style="color:${lossColor}">${loss.toFixed(1)}%</b>${concNote}</span>
        ${severe != null ? `<span>Severe <b style="color:${severe>=5?'#d4362a':'#888'}">${severe.toFixed(1)}%</b></span>` : ''}
        ${maxc   != null ? `<span>Worst cell <b>${maxc.toFixed(1)}%</b></span>` : ''}
        <span>Gain <b style="color:#1a6640">${(m.change_gain_pct||0).toFixed(1)}%</b></span>
      </div>
    </div>`;
  })() : '';

  const badgeRow1 = `
    <div class="satchange-bar">
      <span class="sensor-chip">${sanitize(m.sensor||'Sentinel-2')} · ${m.resolution_m||10}m GSD · 5-index</span>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${cloudBadge(m.cloud_base)} ${cloudBadge(m.cloud_now)}
        ${sarBadge(m)}
        <span class="mchip ${dcls}">ΔNDVI <b>${sign}${Number(m.ndvi_delta).toFixed(4)}</b></span>
        ${m.nbr_delta != null ? `<span class="mchip ${m.nbr_delta < -0.10 ? 'neg' : ''}">ΔNBR <b>${defpm(m.nbr_delta,3)}</b></span>` : ''}
        ${m.bsi_delta != null ? `<span class="mchip ${m.bsi_delta > 0.10 ? 'neg' : ''}">ΔBSI <b>${defpm(m.bsi_delta,3)}</b></span>` : ''}
        ${spatialBadge(m)}
      </div>
    </div>`;

  const allBadges = [biomeBadge(m), seasonalBadge(m), visBadges(m)].filter(Boolean).join('');
  const badgeRow2 = allBadges ? `<div class="satchange-bar" style="border-top:none;padding-top:0">${allBadges}</div>` : '';

  document.getElementById('dres').innerHTML = `
    ${imgStrip}
    ${badgeRow1}
    ${badgeRow2}
    <div class="metabar">
      <span class="rpill r-${risk}">${RISK_LABEL[risk]}</span>
      <span class="mchip"><b>${sanitize(m.region)}</b></span>
      <span class="mchip">⬚ <b>${m.window_km}×${m.window_km} km</b></span>
      ${m.change_loss_pct != null ? `<span class="mchip neg">px-loss <b>${m.change_loss_pct.toFixed(1)}%</b></span>` : ''}
    </div>
    <div class="ndvibar">
      <div class="ndvilabels">
        <span>Baseline ${sanitize(m.base_window||m.base_date)} <b>${def(m.ndvi_base)}</b></span>
        <span>Current ${sanitize(m.cur_window||m.cur_date)} <b>${def(m.ndvi_now)}</b></span>
      </div>
      <div class="track">
        <div class="tbase" style="width:${ndviToTrack(m.ndvi_base)}%"></div>
        <div class="tnow"  style="width:${ndviToTrack(m.ndvi_now)}%"></div>
      </div>
    </div>
    ${spatialPanel}
    ${visPanel}
    ${sarPanel}
    ${confPanel}
    <div class="disclaimer">
      <b>⚠ Methodology v5:</b> Sentinel-2 L2A — 5 indices: NDVI (B08/B04), EVI, NBR (B8A+B12), BSI, NDWI (B08+B11). SCL-masked (classes 4+5). 8-bit encoding ±0.008 quantisation; changes &lt;±0.02 within noise floor. Two same-season epochs (baseline −2yr, current). Output: ${m.resolution_m||10}m GSD (scales with window). Pixel-level NDVI delta feeds severity directly — localized clearing is not masked by scene-mean. ${m.sar_available ? 'Sentinel-1 SAR VH 2-epoch.' : 'SAR unavailable.'} Stage 1: 2 images, biome-aware. Stage 2: visual cross-check + spectral + spatial stats. Ground-truth required before policy action.
    </div>
    ${secsHtml}
    ${buildGlossary()}
  `;

  document.getElementById('dres').style.display = 'block';
  document.getElementById('dtitle').textContent  = m.region;
  const thint = document.getElementById('thint');
  if (thint) thint.textContent = `${m.region} — ${RISK_LABEL[risk]} risk`;
  const rb = document.getElementById('reportbtn');
  rb.style.display = 'none'; void rb.offsetWidth; rb.style.display = 'inline-block';
}

function applyChangeOverlay(data) {
  if (window._changeOverlay) { map.removeLayer(window._changeOverlay); window._changeOverlay = null; }
}

// ─── Main analysis ────────────────────────────────────────────────────────────
async function runAnalysis() {
  if (!selectedPoint) return;
  const btn = document.getElementById('abtn');
  const sp  = document.getElementById('sp');
  const txt = document.getElementById('abtntxt');
  btn.disabled = true; sp.style.display = 'inline-block'; txt.textContent = 'Analysing…';
  document.getElementById('dload').style.display    = 'flex';
  document.getElementById('dres').style.display     = 'none';
  document.getElementById('dres').innerHTML         = '';
  document.getElementById('reportbtn').style.display = 'none';
  document.getElementById('dtitle').textContent     = 'Analysing…';
  resetSteps(); openDrawer(); startStepTimer();

  try {
    const res  = await fetch('/analyse-point', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: selectedPoint.lat, lon: selectedPoint.lon, window_km: ANALYSIS_KM }),
    });
    const data = await res.json();
    completeSteps();
    document.getElementById('dload').style.display = 'none';
    if (!data.success) throw new Error(data.error || 'Unknown server error');
    lastData = data;
    renderDrawer(data);
    applyChangeOverlay(data);
  } catch (err) {
    completeSteps();
    document.getElementById('dload').style.display = 'none';
    document.getElementById('dres').innerHTML = `<div class="derr">⚠ ${sanitize(err.message)}</div>`;
    document.getElementById('dres').style.display = 'block';
    document.getElementById('dtitle').textContent  = 'Error';
  } finally {
    btn.disabled = false; sp.style.display = 'none'; txt.textContent = '▶ Analyse';
    map.invalidateSize();
  }
}

// ─── Full report in new tab ───────────────────────────────────────────────────
function openFullReport() {
  if (!lastData) return;
  const data = lastData, m = data.meta, ve = data.visual_extraction || {};
  const risk = m.severity || detectRisk(data.report);
  const sign = m.ndvi_delta >= 0 ? '+' : '';
  const RISK_COLORS = {
    critical: ['#ff4d4d','rgba(255,77,77,0.08)'],
    high:     ['#ffb830','rgba(255,184,48,0.08)'],
    medium:   ['#ffdc00','rgba(255,220,0,0.08)'],
    low:      ['#00e87a','rgba(0,232,122,0.08)'],
  };
  const [rc, rbg] = RISK_COLORS[risk] || RISK_COLORS.low;
  const dclass = m.ndvi_delta < -0.02 ? '#d4362a' : m.ndvi_delta > 0.02 ? '#1a7a4a' : '#444';
  const def   = (v, d=4) => v != null ? Number(v).toFixed(d) : '—';
  const defpm = (v, d=4) => v != null ? (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(d) : '—';

  // Confidence fill colour resolved once in JS — never injected into CSS text
  const confColor = m.confidence_score >= 70 ? '#00c468' : m.confidence_score >= 45 ? '#ffb830' : '#ff4d4d';

  // All model-generated text sanitized before interpolation
  const report   = data.report;
  const secsHtml = (typeof report === 'object' && report !== null)
    ? SECTION_META.map(s => report[s.key] ? `
        <section class="rs ${s.special === 'agreement' ? 'rs-agreement' : s.special === 'seasonal' ? 'rs-seasonal' : ''}">
          <h3>${s.label}</h3><p>${sanitize(String(report[s.key]))}</p>
        </section>` : '').join('')
    : `<section class="rs"><pre>${sanitize(String(report))}</pre></section>`;

  const sarSection = m.sar_available ? `
    <div class="cloud-sec"><h4>Sentinel-1 SAR · VH Backscatter · 2-epoch</h4>
      <table>
        <tr><td>Baseline</td><td>${def(m.sar_vh_base_db,2)} dB</td><td></td></tr>
        <tr><td>Current</td><td>${def(m.sar_vh_now_db,2)} dB</td><td></td></tr>
        <tr><td>Δ Base→Current</td>
            <td style="color:${m.sar_delta_db < -3 ? '#d4362a' : m.sar_delta_db < -1.5 ? '#a07010' : '#1a6640'};font-weight:700">
              ${defpm(m.sar_delta_db,2)} dB</td>
            <td>${sanitize((m.sar_label||'').replace('_',' ').toUpperCase())}</td></tr>
        ${m.sar_defor_flag ? '<tr><td colspan="3" style="color:#d4362a;font-weight:700">⚠ SAR confirms canopy structure loss</td></tr>' : ''}
      </table>
    </div>` : `<div class="cloud-sec"><h4>Sentinel-1 SAR</h4><p style="font-family:var(--mono);font-size:11px">Not available.</p></div>`;

  const idxSection = `
    <div class="cloud-sec"><h4>5-Index Two-Epoch Spectral Analysis</h4>
      <table>
        <tr style="font-weight:700"><td>Index</td><td>Baseline</td><td>Current</td><td>Δ Base→Now</td></tr>
        <tr><td>NDVI</td><td>${def(m.ndvi_base)}</td><td>${def(m.ndvi_now)}</td>
            <td style="color:${m.ndvi_delta<-0.02?'#d4362a':m.ndvi_delta>0.02?'#1a6640':'#444'};font-weight:700">${defpm(m.ndvi_delta)}</td></tr>
        <tr><td>EVI</td><td>${def(m.evi_base)}</td><td>${def(m.evi_now)}</td>
            <td>${m.evi_base!=null&&m.evi_now!=null ? defpm(m.evi_now-m.evi_base) : '—'}</td></tr>
        <tr><td>NBR</td><td>${def(m.nbr_base)}</td><td>${def(m.nbr_now)}</td>
            <td style="color:${m.nbr_delta<-0.10?'#d4362a':'#444'};font-weight:${m.nbr_delta<-0.10?700:400}">${defpm(m.nbr_delta)}</td></tr>
        <tr><td>BSI</td><td>${def(m.bsi_base)}</td><td>${def(m.bsi_now)}</td>
            <td style="color:${m.bsi_delta>0.10?'#d4362a':'#444'};font-weight:${m.bsi_delta>0.10?700:400}">${defpm(m.bsi_delta)}</td></tr>
        <tr><td>NDWI</td><td>${def(m.ndwi_base)}</td><td>${def(m.ndwi_now)}</td>
            <td>${m.ndwi_base!=null&&m.ndwi_now!=null ? defpm(m.ndwi_now-m.ndwi_base) : '—'}</td></tr>
      </table>
    </div>`;

  const spatialSection = m.change_loss_pct != null ? `
    <div class="cloud-sec"><h4>  Pixel-Level Spatial Change Statistics</h4>
      <table>
        <tr><td>NDVI loss pixels (Δ &lt; −0.08)</td>
            <td style="color:${m.change_loss_pct>=10?'#d4362a':m.change_loss_pct>=3?'#a07010':'#1a6640'};font-weight:700">
              ${def(m.change_loss_pct,1)}%</td></tr>
        <tr><td>Severe loss pixels (Δ &lt; −0.15)</td>
            <td style="color:${(m.change_severe_loss_pct||0)>=5?'#d4362a':'#444'};font-weight:${(m.change_severe_loss_pct||0)>=5?700:400}">
              ${def(m.change_severe_loss_pct,1)}%</td></tr>
        <tr><td>NDVI gain pixels (Δ &gt; +0.08)</td><td>${def(m.change_gain_pct,1)}%</td></tr>
        <tr><td>Worst 1/9 cell loss</td>
            <td style="color:${(m.change_max_cell_loss_pct||0)>=15?'#d4362a':(m.change_max_cell_loss_pct||0)>=8?'#a07010':'#444'};font-weight:700">
              ${def(m.change_max_cell_loss_pct,1)}%</td></tr>
        <tr><td>Spatial concentration ratio</td>
            <td style="color:${(m.change_concentration||0)>=3?'#d4362a':(m.change_concentration||0)>=2?'#a07010':'#444'}">
              ${def(m.change_concentration,2)}×${(m.change_concentration||0)>=2?' — localized hotspot':''}</td></tr>
      </table>
    </div>` : '';

  const visSection = ve._stage1_success ? `
    <div class="cloud-sec"><h4>Gemma Stage 1 — Visual Extraction · 2 images · biome-aware</h4>
      <table>
        <tr><td>Biome</td><td colspan="3">${sanitize((ve.biome_classification||'—').replace(/_/g,' '))}</td></tr>
        <tr><td>Is forest scene</td><td colspan="3">${ve.is_forest_scene!==false?'YES':'NO'}</td></tr>
        <tr><td>Temporal trajectory</td><td colspan="3">${sanitize((ve.temporal_trajectory||'—').replace(/_/g,' '))}</td></tr>
        <tr><td>Seasonal change likely</td>
            <td colspan="3" style="color:${ve.seasonal_change_likely?'#a07010':'#1a6640'};font-weight:700">
              ${ve.seasonal_change_likely?'LIKELY SEASONAL/PHENOLOGICAL':'Structural or unclear'}</td></tr>
        <tr><td>Canopy cover</td><td>${ve.canopy_cover_pct!=null?ve.canopy_cover_pct.toFixed(1)+'%':'—'}</td>
            <td>Bare soil</td><td>${ve.bare_soil_exposure_pct!=null?ve.bare_soil_exposure_pct.toFixed(1)+'%':'—'}</td></tr>
        <tr><td>Logging roads</td>
            <td style="color:${ve.logging_roads_detected?'#d4362a':'#1a6640'};font-weight:700">
              ${ve.logging_roads_detected?'DETECTED (~'+ve.logging_road_count_estimate+')':'Not detected'}</td>
            <td>Burn scars</td>
            <td style="color:${ve.burn_scars_detected?'#d4362a':'#1a6640'};font-weight:700">
              ${ve.burn_scars_detected?'DETECTED ('+Number(ve.burn_scar_pct).toFixed(1)+'%)':'Not detected'}</td></tr>
        <tr><td>Active clearing</td><td>${ve.active_clearing_detected?'DETECTED':'Not detected'}</td>
            <td>Stage 1 confidence</td><td><b>${ve.overall_confidence}/100</b></td></tr>
      </table>
      ${ve.baseline_vs_current_change ? `<p style="font-family:'Outfit',sans-serif;font-size:13px;color:#000;margin-top:10px;line-height:1.7"><b>Baseline→Current:</b> ${sanitize(ve.baseline_vs_current_change)}</p>` : ''}
      ${ve.spatial_pattern_description ? `<p style="font-family:'Outfit',sans-serif;font-size:13px;color:#000;margin-top:6px;line-height:1.7">${sanitize(ve.spatial_pattern_description)}</p>` : ''}
    </div>` : `<div class="cloud-sec"><h4>Gemma Stage 1 — Visual Extraction</h4><p style="font-family:var(--mono);font-size:11px">JSON extraction failed.</p></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CANOPY Report — ${sanitize(m.region)} — ${m.cur_date}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--green:#00c468;--border:#d4e8dd;--bg:#f5fbf7;--surf:#fff;--mono:'Space Mono',monospace;--sans:'Outfit',sans-serif;--rc:${rc};--rbg:${rbg};}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--sans);color:#000;background:var(--bg)}
  .hd{background:#060b0a;color:#e8f5f0;padding:28px 48px 24px;display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
  .lt{font-family:var(--sans);font-weight:700;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#fff}
  .lt em{color:#00e87a;font-style:normal}
  h1{font-size:26px;font-weight:700;line-height:1.2;color:#fff;margin-top:6px}
  .sub{font-family:var(--mono);font-size:11px;color:rgba(255,255,255,.82);letter-spacing:.06em;margin-top:4px}
  .pipe-tag{font-family:var(--mono);font-size:10px;color:#4db8ff;border:1px solid rgba(77,184,255,.3);padding:3px 8px;border-radius:3px;display:inline-block;margin-top:6px}
  .rb{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rc);border:2px solid var(--rc);padding:8px 20px;border-radius:4px;background:var(--rbg);flex-shrink:0;margin-top:4px}
  .imgrow{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)}
  .imgf{position:relative;overflow:hidden}
  .imgf img{width:100%;height:220px;object-fit:cover;display:block}
  .imgcap{position:absolute;bottom:0;left:0;right:0;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.85));padding:20px 12px 8px;text-align:center}
  .imgcap .yr{font-size:16px;font-weight:700;display:block;line-height:1.1}
  .seasonal-banner{background:#fff8e6;border:1px solid #f0c030;border-radius:6px;padding:10px 18px;margin:12px 48px;font-family:var(--mono);font-size:11px;color:#7a5010}
  .mets{background:var(--surf);border-bottom:1px solid var(--border);padding:14px 48px;display:flex;flex-wrap:wrap;gap:20px;align-items:center}
  .met{display:flex;flex-direction:column;gap:2px}
  .ml{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#000;font-weight:600}
  .mv{font-family:var(--mono);font-size:13px;font-weight:700;color:#000}
  .md{width:1px;height:30px;background:var(--border)}
  .vb{background:var(--surf);border-bottom:1px solid var(--border);padding:12px 48px}
  .vl{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:#000;margin-bottom:6px}
  .vt{height:6px;background:#e8f0ec;border-radius:4px;position:relative;overflow:hidden}
  .vbase{position:absolute;left:0;top:0;height:100%;background:rgba(0,196,104,.28);border-radius:4px}
  .vnow{position:absolute;left:0;top:0;height:100%;background:var(--green);border-radius:4px}
  .conf-sec{background:var(--surf);border-bottom:1px solid var(--border);padding:10px 48px}
  .conf-sec h4{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#000;font-weight:700;margin-bottom:6px}
  .conf-track{height:5px;background:#e8f0ec;border-radius:3px;overflow:hidden}
  .conf-fill{height:100%;border-radius:3px}
  .cloud-sec{background:var(--surf);border-bottom:1px solid var(--border);padding:12px 48px}
  .cloud-sec h4{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#000;font-weight:700;margin-bottom:8px}
  table{border-collapse:collapse;font-family:var(--mono);font-size:11px}
  td{padding:3px 14px 3px 0;color:#000}
  .body{max-width:860px;margin:0 auto;padding:40px 48px 60px}
  .disc{background:#f0f7ff;border:1px solid #b8d4f0;border-radius:6px;padding:14px 18px;margin-bottom:32px;font-family:var(--mono);font-size:11px;color:#000;line-height:1.7}
  .disc b{color:#0a4090}
  .rs{margin-bottom:34px}
  .rs h3{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#000;font-weight:700;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  .rs p{font-size:15px;line-height:1.8;color:#000;white-space:pre-wrap}
  .rs-agreement{background:#f0f9f4;border-left:3px solid #00c468;padding-left:16px;border-radius:0 6px 6px 0;margin-bottom:34px}
  .rs-agreement h3{color:#0a5c30}
  .rs-seasonal{background:#fff8e6;border-left:3px solid #f0c030;padding-left:16px;border-radius:0 6px 6px 0;margin-bottom:34px}
  .rs-seasonal h3{color:#7a5010}
  footer{border-top:1px solid var(--border);padding:16px 48px;display:flex;align-items:center;justify-content:space-between;font-family:var(--mono);font-size:10px;color:#000;background:var(--surf)}
  .pb{position:fixed;bottom:24px;right:24px;background:#060b0a;color:#00e87a;font-family:var(--mono);font-size:12px;letter-spacing:.08em;border:1px solid rgba(0,232,122,.3);border-radius:6px;padding:10px 18px;cursor:pointer}
  @media print{.pb{display:none}}
  @media (max-width:600px){.hd{padding:20px 18px;flex-direction:column}.imgrow{grid-template-columns:1fr}.mets,.cloud-sec,.vb,.conf-sec{padding:10px 18px}.body{padding:20px 18px 40px}}
</style>
</head>
<body>
<header class="hd">
  <div>
    <div><span class="lt">CAN<em>OPY</em> Forest Intelligence</span></div>
    <h1>${sanitize(m.region)}</h1>
    <p class="sub">DEFORESTATION EARLY WARNING &nbsp;·&nbsp; ${new Date().toUTCString()} &nbsp;·&nbsp; ${m.window_km}×${m.window_km} km &nbsp;·&nbsp; ${m.center[0]}°, ${m.center[1]}°</p>
    <span class="pipe-tag">${sanitize(m.sensor||'Sentinel-2 L2A')} · ${m.resolution_m||10}m GSD · Gemma 4 · 2-epoch · 5-index</span>
  </div>
  <div class="rb">${RISK_LABEL[risk]} RISK</div>
</header>

<div class="imgrow">
  <div class="imgf"><img src="data:image/png;base64,${data.base_image_b64}" alt="Baseline">
    <div class="imgcap"><span class="yr">${m.base_date.slice(0,4)}</span>Baseline · ${sanitize(m.base_window||m.base_date)}</div></div>
  <div class="imgf"><img src="data:image/png;base64,${data.cur_image_b64}" alt="Current">
    <div class="imgcap"><span class="yr">${m.cur_date.slice(0,4)}</span>Current · ${sanitize(m.cur_window||m.cur_date)}</div></div>
</div>

${m.vis_seasonal_likely ? `<div class="seasonal-banner"> <b>Seasonal/phenological change is likely.</b> Biome classification suggests this NDVI variation may reflect a natural seasonal cycle. Verify with ground-truth before action.</div>` : ''}

<div class="mets">
  <div class="met"><span class="ml">NDVI Baseline</span><span class="mv">${def(m.ndvi_base)}</span></div><div class="md"></div>
  <div class="met"><span class="ml">NDVI Current</span><span class="mv">${def(m.ndvi_now)}</span></div><div class="md"></div>
  <div class="met"><span class="ml">NDVI Change</span><span class="mv" style="color:${dclass}">${sign}${Number(m.ndvi_delta).toFixed(4)}</span></div><div class="md"></div>
  ${m.change_loss_pct!=null?`<div class="met"><span class="ml">Pixel Loss %</span><span class="mv" style="color:${m.change_loss_pct>=10?'#d4362a':m.change_loss_pct>=3?'#a07010':'#444'}">${def(m.change_loss_pct,1)}%</span></div><div class="md"></div>`:''}
  ${m.nbr_delta!=null?`<div class="met"><span class="ml">Δ NBR (fire)</span><span class="mv" style="color:${m.nbr_delta<-0.10?'#d4362a':'#444'}">${defpm(m.nbr_delta)}</span></div><div class="md"></div>`:''}
  ${m.bsi_delta!=null?`<div class="met"><span class="ml">Δ BSI (soil)</span><span class="mv" style="color:${m.bsi_delta>0.10?'#d4362a':'#444'}">${defpm(m.bsi_delta)}</span></div><div class="md"></div>`:''}
  ${m.sar_available?`<div class="met"><span class="ml">SAR Δ VH</span><span class="mv" style="color:${m.sar_delta_db<-3?'#d4362a':'#444'}">${defpm(m.sar_delta_db,2)} dB</span></div><div class="md"></div>`:''}
  <div class="met"><span class="ml">Resolution</span><span class="mv">${m.resolution_m||10}m GSD</span></div>
</div>

<div class="vb">
  <div class="vl"><span>Baseline <b>${def(m.ndvi_base)}</b></span><span>Current <b>${def(m.ndvi_now)}</b></span></div>
  <div class="vt">
    <div class="vbase" style="width:${((Number(m.ndvi_base)+1)/2*100).toFixed(1)}%"></div>
    <div class="vnow"  style="width:${((Number(m.ndvi_now)+1)/2*100).toFixed(1)}%"></div>
  </div>
</div>

<div class="conf-sec">
  <h4>Confidence — ${sanitize(m.confidence_label)} (${m.confidence_score}/100)</h4>
  <div class="conf-track"><div class="conf-fill" style="width:${m.confidence_score}%;background:${confColor}"></div></div>
</div>

<div class="cloud-sec"><h4>SCL Cloud Masking (2 epochs)</h4>
  <table>
    <tr><td>Baseline</td><td style="color:${m.cloud_base>60?'#d4362a':m.cloud_base>30?'#a07010':'#1a6640'};font-weight:700">${Number(m.cloud_base).toFixed(1)}%</td><td>${(m.valid_base||0).toLocaleString()} valid px</td></tr>
    <tr><td>Current</td><td style="color:${m.cloud_now>60?'#d4362a':m.cloud_now>30?'#a07010':'#1a6640'};font-weight:700">${Number(m.cloud_now).toFixed(1)}%</td><td>${(m.valid_now||0).toLocaleString()} valid px</td></tr>
  </table>
</div>

${idxSection}${spatialSection}${sarSection}${visSection}

<div class="body">
  <div class="disc">
    <b>⚠ Methodology Disclosure (v5):</b>
    Sentinel-2 L2A — 5 indices: NDVI (B08/B04), EVI (B08/B04/B02), NBR (B8A/B12), BSI (B11+B04/B08+B02), NDWI (B08/B11).
    All SCL-masked (classes 4+5 only). 8-bit encoding introduces ±0.008 quantisation; changes &lt;±0.02 are within the noise floor.
    Two same-season epochs: baseline (−2yr), current. Output: ${m.resolution_m||10}m GSD (scales with window size, capped at 1024px).
    Pixel-level NDVI delta overlay feeds severity computation directly — localized clearing is NOT hidden by scene-mean averaging.
    ${m.sar_available?'Sentinel-1 GRD VH backscatter log-ratio (2-epoch). Thresholds indicative for tropical IW; ecosystem-dependent.':'SAR unavailable — optical-only assessment.'}
    Gemma Stage 1: 2 truecolor images (baseline + current), biome-aware disambiguation, no spectral input.
    Gemma Stage 2: receives both images directly for visual cross-check, alongside spectral indices and pixel-level spatial statistics.
    <b>Ground-truth required before policy action.</b>
  </div>
  ${secsHtml}
  ${buildGlossaryHTML()}
</div>

<footer>
  <span>CANOPY v5 · Gemma 4 · 2-epoch · 5-index · ${sanitize(m.sensor||'Sentinel-2 L2A')}</span>
  <span>${m.cur_date}</span>
</footer>
<button class="pb" onclick="window.print()">⎙ Print / Save PDF</button>
</body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}