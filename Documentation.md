# CANOPY — Technical Documentation

<img width="1903" height="912" alt="Screenshot_19-4-2026_102119_127 0 0 1" src="https://github.com/user-attachments/assets/c5e9a3df-73d3-47c7-9f43-19af78c11152" />


---

## Table of contents

1. Architecture overview
2. Backend pipeline (app.py)
3. Sentinel Hub integration
4. Spectral index computation
5. Spatial change analysis
6. Gemma 4 Stage 1 — visual extraction
7. Gemma 4 Stage 2 — synthesis
8. Severity and confidence scoring
9. Frontend (app.js)
10. API reference
11. Configuration constants
12. Known limitations

---

## 1. Architecture overview

CANOPY is a Flask web application. The browser hosts a Leaflet satellite basemap. When the user clicks a location and presses Analyse, the frontend sends a single POST request to `/analyse-point`. The backend runs the entire pipeline synchronously on that request, using a thread pool to parallelise the ten Sentinel Hub image fetches, then calls Gemma 4 twice sequentially. The response is a single JSON object containing the report, all image data as base64 strings, and full metadata. The frontend renders the result without a page reload.

```
Browser
  |-- POST /analyse-point { lat, lon, window_km }
  |
  Flask (app.py)
    |-- ThreadPoolExecutor (10 workers)
    |     |-- Sentinel-2 truecolor x2 (baseline, current)
    |     |-- Sentinel-2 NDVI+EVI x2
    |     |-- Sentinel-2 NBR+BSI+NDWI x2
    |     |-- Sentinel-2 change mask x2
    |     |-- Sentinel-1 SAR VH x2
    |
    |-- compute_indices_ndvi_evi() x2
    |-- compute_nbr_bsi_ndwi() x2
    |-- compute_sar_stats() x2
    |-- build_change_overlay()  <-- pixel-level spatial analysis
    |-- call_gemma_stage1()     <-- 2 images, no spectral context
    |-- compute_severity()      <-- spectral + spatial + visual
    |-- compute_confidence()
    |-- build_stage2_prompt()
    |-- call_gemma_stage2()     <-- 2 images + full spectral + spatial prompt
    |
    |-- JSON response --> browser
```

---

## 2. Backend pipeline (app.py)

### Date window computation

Two same-season epochs are constructed relative to today:

- **Baseline**: 45-day window centred on the same calendar date two years ago. Same-season comparison eliminates the majority of phenological NDVI variation without needing a mid-period reference image.
- **Current**: 45-day window ending 5 days before today (Sentinel-2 processing latency buffer).

The `mosaickingOrder: leastCC` setting in Sentinel Hub causes the API to composite the least cloud-covered scene within each window, producing a single representative image per epoch.

### Bounding box

`fixed_bbox(clat, clon, km)` converts the selected window size to geographic degrees, accounting for latitude-dependent longitude compression via `cos(lat)`. All four fetches (S2 truecolor, S2 spectral A, S2 spectral B, S1) use the same bounding box.

### Parallel fetch

`fetch_all_sentinel()` submits all ten image fetch tasks to a `ThreadPoolExecutor` with 10 workers. A global timeout budget of 300 seconds covers the entire fetch phase. Individual fetch tasks use a 90-second per-request timeout with up to 2 retries on 5xx errors or connection failures.

---

## 3. Sentinel Hub integration

All imagery is retrieved via the Sentinel Hub Process API (`/api/v1/process`). Authentication uses OAuth2 client credentials with token caching to avoid re-authenticating on every request.

### Evalscripts

Four custom evalscripts are used, each encoding multiple indices into a single 3-band PNG to minimise API calls:

**EVALSCRIPT_S2_NDVI_EVI** (Band A)
- Red channel: NDVI = (B08 - B04) / (B08 + B04), mapped to [0, 255]
- Green channel: EVI = 2.5 * (B08 - B04) / (B08 + 6*B04 - 7.5*B02 + 1), clamped to [-1, 1], mapped to [0, 255]
- Blue channel: SCL (Scene Classification Layer) as raw DN, used for cloud masking

**EVALSCRIPT_S2_NBR_BSI_NDWI** (Band B)
- Red: NBR = (B8A - B12) / (B8A + B12)
- Green: BSI = ((B11 + B04) - (B08 + B02)) / ((B11 + B04) + (B08 + B02))
- Blue: NDWI = (B08 - B11) / (B08 + B11)

**EVALSCRIPT_S2_TRUECOLOR**
- Standard RGB composite with 3.5x brightness scaling for visual clarity

**EVALSCRIPT_S1_VH**
- VH backscatter converted to dB: `10 * log10(VH + 1e-10)`, mapped from [-35, +5] dB to [0, 255]

**EVALSCRIPT_CHANGE_MASK**
- Encodes NDVI in the red channel and SCL in the green channel specifically for the pixel-level overlay computation

### Output resolution

`optimal_pixel_size(km)` targets 20 m effective GSD across all window sizes, scaled proportionally but capped at 1024 pixels to comply with Sentinel Hub output limits. The 8-bit PNG encoding introduces approximately 0.008 units of quantisation noise on all index values. Changes smaller than ±0.02 should be treated as within the noise floor.

---

## 4. Spectral index computation

### NDVI and EVI (`compute_indices_ndvi_evi`)

Reads the Band A PNG. Converts 8-bit red and green channels back to [-1, 1] index space. The SCL blue channel is decoded to identify pixel classes:

| SCL class | Meaning | Treatment |
|---|---|---|
| 4 | Vegetation | Valid |
| 5 | Bare soil | Valid |
| 3 | Cloud shadow | Excluded |
| 7, 8, 9, 10 | Cloud, cirrus | Excluded |
| 0 | No data | Excluded from denominator |

Mean NDVI and EVI are computed only over valid pixels (SCL 4 and 5). If fewer than 500 valid pixels exist, the function returns NaN and the route returns a 422 with a cloud coverage explanation.

SCL statistics (vegetation %, bare soil %, water %, cloud-shadow %, snow %) are returned for use in the Stage 2 prompt.

### NBR, BSI, NDWI (`compute_nbr_bsi_ndwi`)

Reads the Band B PNG. Converts all three channels to [-1, 1]. Valid pixels are defined as those with red channel values in (1, 254) — a proxy for non-saturated, non-nodata pixels. Requires at least 200 valid pixels.

### SAR (`compute_sar_stats`)

Reads the single-band SAR PNG. Converts to dB using the inverse of the evalscript mapping: `(pixel / 255) * 40 - 35`. Returns mean VH and a breakdown of high (>= -14 dB), medium (-20 to -14 dB), and low (< -20 dB) backscatter pixel fractions.

---

## 5. Spatial change analysis

`build_change_overlay()` takes the current and baseline change mask PNGs and produces:

1. A per-pixel RGBA overlay image where red pixels indicate NDVI loss > 0.08, bright red indicates loss > 0.15, and green indicates NDVI gain > 0.08. This is returned as a base64 PNG for map display.

2. A dictionary of spatial statistics:

| Statistic | Description |
|---|---|
| `loss_pct` | Fraction of valid pixels with NDVI delta < -0.08 |
| `severe_loss_pct` | Fraction with NDVI delta < -0.15 |
| `gain_pct` | Fraction with NDVI delta > +0.08 |
| `max_cell_loss_pct` | Highest loss fraction among the nine cells of a 3x3 grid |
| `concentration_ratio` | `max_cell_loss_pct` / mean cell loss pct — measures spatial hotspot intensity |

The 3x3 grid decomposition is the key innovation here. A concentration ratio above 2x indicates that clearing is spatially concentrated (edge clearing, interior patch, linear road corridor) rather than diffuse. A ratio above 3x, combined with visual confirmation, is treated as a high-concern localized clearing event regardless of what the scene mean shows.

---

## 6. Gemma 4 Stage 1 — visual extraction

**Function**: `call_gemma_stage1()`  
**Model**: `gemma-4-26b-a4b-it`  
**Input**: Two truecolor PNG images (baseline, current) + text prompt  
**No spectral data is provided** — Stage 1 works from pixel appearance only

The Stage 1 system prompt contains explicit biome disambiguation rules covering eight land-cover types: tropical rainforest, boreal forest, savanna/grassland, dryland shrubland, agricultural land, Mediterranean scrub, mangrove, and cloud/haze. Each type has specific visual signatures and explicit instructions on what NOT to interpret as deforestation (e.g., dry-season browning in savanna, snow patches in boreal forest, harvested agricultural fields).

The prompt additionally instructs the model to pay particular attention to localized changes — bright rectangular patches, linear road cuts, sharp edge clearings — that may occupy only a small fraction of the frame but represent active clearing fronts.

### Stage 1 output schema

```json
{
  "is_forest_scene": true,
  "biome_classification": "tropical_rainforest",
  "canopy_cover_pct": 84.0,
  "bare_soil_exposure_pct": 4.2,
  "logging_roads_detected": false,
  "logging_road_count_estimate": 0,
  "burn_scars_detected": false,
  "burn_scar_pct": 0.0,
  "active_clearing_detected": false,
  "water_bodies_pct": 1.1,
  "agricultural_encroachment": false,
  "canopy_texture": "dense_uniform",
  "dominant_change_pattern": "none",
  "temporal_trajectory": "stable",
  "seasonal_change_likely": false,
  "baseline_vs_current_change": "...",
  "spatial_pattern_description": "...",
  "image_quality_assessment": "clear",
  "overall_confidence": 88
}
```

All percentage fields are clamped to [0.0, 100.0] and `overall_confidence` is clamped to [0, 100] in the parsing step.

---

## 7. Gemma 4 Stage 2 — synthesis

**Function**: `call_gemma_stage2()`  
**Model**: `gemma-4-26b-a4b-it`  
**Input**: Two truecolor PNG images (baseline, current) + structured text prompt

Stage 2 receives both images directly, enabling it to visually cross-check the Stage 1 JSON summary against the actual imagery. If Stage 1 reports no clearing but the spectral data shows a large NDVI drop, Stage 2 is instructed to examine the image itself and state its own independent observation.

### Stage 2 prompt structure

The prompt is assembled by `build_stage2_prompt()` in four labelled sections:

**(A) Spectral analysis** — two-column table of NDVI, EVI, NBR, BSI, NDWI for baseline and current, SCL summaries, cloud percentages, all deltas, severity tier, and confidence label.

**(B) SAR analysis** — baseline and current VH backscatter in dB, delta, and classification label (stable / degradation / strong_loss / recovery).

**(C) Pixel-level spatial statistics** — `loss_pct`, `severe_loss_pct`, `gain_pct`, `max_cell_loss_pct`, `concentration_ratio`, with explicit instruction to weight these heavily over scene means.

**(D) Stage 1 visual extraction summary** — all Stage 1 fields as structured text, plus signal agreement flags that highlight disagreements between visual and spectral signals (e.g., logging roads detected but NDVI delta near-zero suggests selective logging; burn scars visible but NBR drop minor suggests old scar).

### Stage 2 output schema

```json
{
  "risk_level": "...",
  "seasonal_vs_structural": "...",
  "image_observations": "...",
  "spatial_analysis": "...",
  "index_synthesis": "...",
  "visual_spectral_agreement": "...",
  "likely_causes": "...",
  "trend_analysis": "...",
  "recommended_actions": "..."
}
```

The `seasonal_vs_structural` field is marked REQUIRED in the system prompt — it must always be populated and represent the model's primary discriminating conclusion.

---

## 8. Severity and confidence scoring

### Severity (`compute_severity`)

Severity is computed as the maximum of two independent signals, not an average:

**Scene-mean spectral signal:**

| Condition | Tier |
|---|---|
| SAR strong_loss (delta <= -3 dB) | critical or high |
| NDVI delta < -0.15 | critical |
| NDVI delta < -0.08 or SAR degradation | high |
| NDVI delta < -0.02 | medium |
| Otherwise | low |

**Pixel-level spatial signal (hard floors):**

| Condition | Minimum tier |
|---|---|
| severe_loss_pct >= 10% or loss_pct >= 20% | critical |
| severe_loss_pct >= 5% or loss_pct >= 10% | high |
| loss_pct >= 3% or severe_loss_pct >= 1.5% | medium |

**Spatial concentration bumps:**

| Condition | Effect |
|---|---|
| max_cell_loss_pct >= 15% and concentration >= 3x | +1 tier |
| max_cell_loss_pct >= 8% and concentration >= 2x | +1 tier |

**Additional bumps:** NBR delta < -0.20 bumps +1. BSI delta > +0.15 bumps +1. Visual detection of logging roads, burn scars, or active clearing bumps +1. Non-forest scene identification drops -1.

Tiers are: low, medium, high, critical. Bumps are capped at critical.

### Confidence (`compute_confidence`)

Score is built from additive components, maximum 92:

| Component | Max points |
|---|---|
| Current cloud coverage (28 - cloud_now * 0.56) | 28 |
| Baseline cloud coverage (20 - cloud_base * 0.40) | 20 |
| Valid pixel count (current epoch) | 12 |
| NDVI signal present (abs delta > 0.02) | 8 |
| Stage 1 visual confidence >= 80 | 8 |
| SAR data available | 12 |
| NBR data available | 5 |

Labels: High (>= 70), Medium (>= 45), Low (< 45).

---

## 9. Frontend (app.js)

### Map

Leaflet with two tile layers: Esri World Imagery (satellite basemap) and Esri World Boundaries and Places (label overlay at z-index 400). Cursor preview box shows the analysis footprint before clicking. Coordinate navigation inputs in the topbar allow direct coordinate entry.

### Severity rendering

Risk tiers map to colour tokens: critical (#ff4d4d), high (#ffb830), medium (#ffdc00), low (#00e87a). These appear on the risk pill, in the report header badge, and in the full report's CSS custom properties.

### HTML sanitization

All model-generated string fields are passed through `sanitize()` before interpolation into HTML. This function escapes `&`, `<`, `>`, `"`, and `'` to their HTML entities, preventing any special characters in model output from breaking the report markup or injecting executable content.

### Full report

`openFullReport()` generates a self-contained HTML document as a string and opens it in a new tab via `window.open()`. The document contains:

- Two-column image grid (baseline, current)
- Metric bar (NDVI baseline, current, delta, pixel loss %, NBR delta, BSI delta, SAR delta, resolution)
- NDVI visual track bar
- Confidence strip
- Cloud masking table (2 epochs)
- 5-index spectral table
- Spatial change statistics table
- SAR table
- Stage 1 visual extraction table
- Stage 2 narrative sections
- Methodology disclosure
- Glossary (9 terms with scale references)

The confidence fill colour is computed as a JS variable (`confColor`) and injected into an inline `style` attribute on the fill element — not into a CSS `<style>` block — to prevent any model-generated value from contaminating the style context.

---

## 10. API reference

### POST /analyse-point

Request body:
```json
{
  "lat": 3.8634,
  "lon": 11.5213,
  "window_km": 50
}
```

`window_km` must be one of 10, 20, 50, 100. Defaults to 50.

Response (success):
```json
{
  "success": true,
  "report": { ...stage2 fields... },
  "visual_extraction": { ...stage1 fields... },
  "cur_image_b64": "<png base64>",
  "base_image_b64": "<png base64>",
  "change_overlay_b64": "<rgba png base64 or null>",
  "meta": {
    "region": "Cameroon",
    "sensor": "Sentinel-2 L2A + Sentinel-1 GRD",
    "resolution_m": 49,
    "pipeline": "two-stage gemma | 2-epoch | 5-index",
    "ndvi_now": 0.6213,
    "ndvi_base": 0.6891,
    "ndvi_delta": -0.0678,
    "evi_now": 0.4102,
    "evi_base": 0.4489,
    "nbr_now": 0.5201,
    "nbr_base": 0.5634,
    "nbr_delta": -0.0433,
    "bsi_now": -0.2341,
    "bsi_base": -0.2619,
    "bsi_delta": 0.0278,
    "ndwi_now": 0.1823,
    "ndwi_base": 0.2011,
    "cloud_now": 4.2,
    "cloud_base": 11.7,
    "valid_now": 198432,
    "valid_base": 172819,
    "sar_available": true,
    "sar_vh_now_db": -16.42,
    "sar_vh_base_db": -15.88,
    "sar_delta_db": -0.54,
    "sar_label": "stable",
    "sar_defor_flag": false,
    "severity": "medium",
    "confidence_score": 74,
    "confidence_label": "High",
    "window_km": 50,
    "cur_date": "2025-04-14",
    "base_date": "2023-04-14",
    "change_loss_pct": 2.1,
    "change_severe_loss_pct": 0.4,
    "change_gain_pct": 1.8,
    "change_max_cell_loss_pct": 5.9,
    "change_concentration": 2.31
  }
}
```

Response (error):
```json
{
  "success": false,
  "error": "Too few valid pixels (cur cloud=91%, base cloud=44%)"
}
```

HTTP status codes: 200 (success), 400 (invalid coordinates), 422 (insufficient valid pixels), 502 (Sentinel Hub fetch failure), 500 (unhandled error).

### GET /health

Returns pipeline status:
```json
{
  "status": "ok",
  "model": "gemma-4-26b-a4b-it",
  "pipeline": "two-stage gemma | 2-epoch | 5-index (NDVI, EVI, NBR, BSI, NDWI)",
  "sensors": "Sentinel-2 L2A + Sentinel-1 GRD",
  "epochs": "baseline (-2yr same season) / current"
}
```

---

## 11. Configuration constants

Defined at the top of `app.py`:

| Constant | Default | Description |
|---|---|---|
| `DEFAULT_ANALYSIS_KM` | 50 | Default window size if not specified |
| `VALID_WINDOW_SIZES` | [10, 20, 50, 100] | Accepted window sizes in km |
| `SCL_VALID_LAND` | {4, 5} | SCL classes counted as valid (vegetation, bare soil) |
| `SCL_CLOUD_SHADOW` | {3} | Cloud shadow class |
| `SCL_CLOUD` | {7, 8, 9, 10} | Cloud and cirrus classes |
| `SAR_DEFOR_THRESH` | -3.0 | VH delta threshold for strong_loss classification (dB) |
| `SAR_DEGRAD_THRESH` | -1.5 | VH delta threshold for degradation classification (dB) |
| `SH_TIMEOUT` | 90 | Per-request timeout for Sentinel Hub calls (seconds) |
| `SH_MAX_RETRIES` | 2 | Maximum retry attempts on 5xx errors |
| `SH_RETRY_DELAY` | 3 | Delay between retries (seconds) |
| `TOTAL_SH_BUDGET` | 300 | Total wall-clock budget for all parallel fetches (seconds) |

---
