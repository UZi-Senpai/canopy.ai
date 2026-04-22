import os
import re
import base64
import io
import math
import time
import gc
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv
from google import genai
from google.genai import types
import requests as http_requests
from PIL import Image
import numpy as np
import json

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024

gemini_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

SH_TOKEN_URL   = "https://services.sentinel-hub.com/oauth/token"
SH_PROCESS_URL = "https://services.sentinel-hub.com/api/v1/process"

# ── Stage 1 system prompt — biome-aware, 3-image, no spectral context ─────────
STAGE1_SYSTEM_PROMPT = """You are an expert remote sensing analyst specialising in land-cover classification
and change detection using multispectral satellite imagery. You are RIGOROUS and scientifically precise.

CRITICAL BIOME DISAMBIGUATION — READ BEFORE ASSESSING ANYTHING:
You will be shown Sentinel-2 truecolor satellite images. Before reporting any deforestation signal,
you MUST correctly identify the land-cover type. Confusing these is a SERIOUS ERROR:

  DESERTS & DRYLANDS: Sandy/rocky terrain, yellow-orange-beige hues, no texture variation.
    Low greenness IS NOT deforestation. Oases appear bright green — NOT a forest loss area.

  SAVANNAS & GRASSLANDS: Open grass with scattered trees, brown-green mottled texture.
    Seasonally dry. Brown during dry season is PHENOLOGICAL, not forest loss.
    Miombo, Cerrado, Sahel: expect 0.2-0.5 NDVI green season, 0.1-0.3 dry season.

  AGRICULTURAL LAND: Geometric, regular patterns. Harvested fields look like bare soil.
    Fallow appears brown. Crop rotation creates large changes that ARE NOT deforestation.

  MEDITERRANEAN SCRUB: Olive-grey-green maquis, chaparral, fynbos. Naturally sparse.
    Summer browning is phenological drought response, not loss.

  BOREAL FOREST: Dark green, often with snow. Snow patches appear white/grey — NOT clearing.
    Seasonal snowmelt changes apparent canopy coverage.

  MANGROVE: Dark green fringe at coast/river margins. Tidal inundation patterns visible.
    Water-covered roots appear dark — NOT a clearing signal.

  TROPICAL RAINFOREST (primary deforestation target): Continuous, dark-green, granular, rough texture.
    High greenness year-round. Any NDVI drop here is high-concern.
    Logging roads = linear straight clearings. Edge clearing = bright rectangular patches.

  CLOUD / HAZE: Bright white or grey diffuse patches — NOT bare soil.
    Cloud SHADOW appears dark and can mimic clearing; check for penumbra edges.

TWO-IMAGE TEMPORAL ANALYSIS:
You will receive TWO images: BASELINE (oldest, ~2 years ago, same season) and CURRENT (newest).
Both images are from the same calendar season to minimise phenological noise.
Use the two images to determine whether any change is:
  STRUCTURAL DEFORESTATION: Canopy present in baseline, absent or reduced in current — permanent loss.
    Look for bright rectangular patches, linear road cuts, or expanded bare soil at forest edges.
  SEASONAL/PHENOLOGICAL: General greening or browning typical of the biome's seasonal cycle.
    Same-season comparison suppresses most of this — flag only if biome strongly implies residual seasonality.
  FIRE-RELATED: Burn scars or charred areas in current not present in baseline.
  STABLE: No meaningful change between the two epochs.
NOTE: Without a mid-period image you cannot observe intermediate recovery, so err toward flagging
structural signals and let Stage 2 spectral data disambiguate seasonality.

STRICT OUTPUT RULES:
- Return ONLY a valid JSON object. No preamble, no explanation, no markdown fences.
- All string values must be plain text with no markdown.
- Confidence values must be integers 0-100.
- Percentage values must be floats 0.0-100.0.
- If the scene is NOT forest, set is_forest_scene=false and explain in biome_classification."""

# ── Stage 2 system prompt — multi-index, 3-epoch, seasonal-aware synthesis ────
STAGE2_SYSTEM_PROMPT = """You are a senior remote sensing scientist and conservation ecologist with
20 years of experience in multi-sensor satellite data fusion, SAR interpretation, and global
deforestation dynamics across all biome types.

You will receive:
  (A) Spectral analysis — Python-computed from Sentinel-2 multi-band indices (NDVI, EVI, NBR, NDWI, BSI)
      and Sentinel-1 SAR backscatter, across BASELINE and CURRENT epochs.
  (B) Visual extraction — Gemma 4 direct image observations from the BASELINE and CURRENT truecolor images.
  (C) TWO TRUECOLOR IMAGES — baseline (first) and current (second) — which you must inspect directly
      to cross-check spectral and visual data. Use your vision to reconcile disagreements.
  (D) Pixel-level change statistics from a per-pixel NDVI delta overlay (loss_pct, gain_pct).

SPATIAL CLEARING SIGNAL — CRITICAL:
The spectral pipeline reports SCENE-MEAN indices. A 50×50 km window with 5% active clearing and
95% intact forest will show negligible mean NDVI drop yet be HIGH concern.
YOU MUST:
  - Weight pixel-level loss_pct heavily even when mean NDVI delta is small.
  - If loss_pct > 2% and visual stage 1 confirms active clearing or logging roads: report HIGH severity minimum.
  - If loss_pct > 5% regardless of visual: report HIGH severity minimum.
  - Describe the spatial distribution — is clearing localized (edge, corner, linear) or diffuse?
  - A localized 3% clearing in one corner of an intact forest is MORE alarming than a 3% diffuse NDVI drop.

YOUR PRIMARY TASK IS SEASONAL VS. STRUCTURAL CHANGE DISCRIMINATION:
  SEASONAL/PHENOLOGICAL: NDVI drops but vegetation type is non-forest or known seasonal biome.
    EVI mirrors NDVI. SAR is stable. loss_pct is low and spatially diffuse.
    → Do NOT report as deforestation. State "phenological variation consistent with [biome]."

  STRUCTURAL DEFORESTATION: Persistent loss across current. SAR backscatter drops.
    Logging roads or clearing visible optically. NDVI + EVI loss is sustained.
    loss_pct elevated and/or spatially concentrated at edges or interiors.
    → Report with full severity. Recommend immediate action.

  POST-FIRE RECOVERY: Large NBR drop. Current shows partial greenup (NDVI recovering).
    SAR intermediate. EVI recovery lags NDVI recovery.
    → Report trajectory: distinguish agricultural burning from wildfire cause.

  SELECTIVE LOGGING: SAR shows moderate backscatter loss. NDVI stable (canopy closure preserved).
    Logging roads visible. BSI elevated (soil exposure from road construction).
    → Flag as high concern even without major NDVI drop.

  CANOPY WATER STRESS: NDWI drops while NDVI is stable.
    → Not clearing — drought stress or canopy water deficit. Report separately.

CROSS-INDEX REASONING:
  EVI: Less susceptible to atmospheric effects than NDVI. Trust EVI over dense canopy.
  NBR: Fire-sensitive. Δ < -0.10 = low severity burn; Δ < -0.27 = high severity.
  BSI: Soil exposure. Δ > +0.15 = significant clearing confirmed by soil signal.
  NDWI: Canopy water content. Drop without NDVI drop = water stress, not clearing.
  SAR VH: Cloud-independent. Physical canopy removal confirmed when backscatter drops.

VISUAL CROSS-CHECK REQUIREMENT:
  The current truecolor image is provided directly. If Stage 1 says "no clearing" but spectral
  shows NDVI drop of >0.10, examine the image yourself and state your own observation.
  If you see clearing that Stage 1 missed, override and flag it explicitly.

STRICT OUTPUT RULES:
- Return ONLY a valid JSON object. No preamble, no explanation, no markdown fences.
- All string values must be plain text. No markdown: no **, no *, no #.
- Write Δ directly (Unicode). Numbered lists (1. 2. 3.) are fine inside string values.
- The seasonal_vs_structural field is REQUIRED and must always be populated."""

# ── Constants ─────────────────────────────────────────────────────────────────
DEFAULT_ANALYSIS_KM  = 50
VALID_WINDOW_SIZES   = [10, 20, 50, 100]
SCL_VALID_LAND   = {4, 5}
SCL_CLOUD_SHADOW = {3}
SCL_CLOUD        = {7, 8, 9, 10}
SAR_DEFOR_THRESH  = -3.0
SAR_DEGRAD_THRESH = -1.5
SH_TIMEOUT       = 90
SH_MAX_RETRIES   = 2
SH_RETRY_DELAY   = 3
TOTAL_SH_BUDGET  = 300

_sh_token_cache = {"token": None, "expires_at": 0}

def get_sh_token():
    now = time.time()
    if _sh_token_cache["token"] and now < _sh_token_cache["expires_at"] - 60:
        return _sh_token_cache["token"]
    resp = http_requests.post(SH_TOKEN_URL, data={
        "grant_type": "client_credentials",
        "client_id":     os.environ["SH_CLIENT_ID"],
        "client_secret": os.environ["SH_CLIENT_SECRET"],
    }, timeout=15)
    resp.raise_for_status()
    j = resp.json()
    _sh_token_cache["token"]      = j["access_token"]
    _sh_token_cache["expires_at"] = now + j.get("expires_in", 3600)
    return _sh_token_cache["token"]


# ── Evalscripts ───────────────────────────────────────────────────────────────

# A: NDVI (R) + EVI (G) + SCL (B)
EVALSCRIPT_S2_NDVI_EVI = """
//VERSION=3
function setup() {
  return {
    input: [{bands: ["B02","B04","B08","SCL"], units: ["REFLECTANCE","REFLECTANCE","REFLECTANCE","DN"]}],
    output: {bands: 3, sampleType: "UINT8"}
  };
}
function evaluatePixel(s) {
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 1e-6);
  var evi  = 2.5 * (s.B08 - s.B04) / (s.B08 + 6*s.B04 - 7.5*s.B02 + 1.0 + 1e-6);
  evi = Math.max(-1, Math.min(1, evi));
  return [
    Math.round(Math.min(255, Math.max(0, (ndvi + 1) / 2 * 255))),
    Math.round(Math.min(255, Math.max(0, (evi  + 1) / 2 * 255))),
    s.SCL
  ];
}
"""

# B: NBR (R) + BSI (G) + NDWI (B)
EVALSCRIPT_S2_NBR_BSI_NDWI = """
//VERSION=3
function setup() {
  return {
    input: [{bands: ["B02","B04","B08","B8A","B11","B12"], units: "REFLECTANCE"}],
    output: {bands: 3, sampleType: "UINT8"}
  };
}
function evaluatePixel(s) {
  var nbr  = (s.B8A - s.B12) / (s.B8A + s.B12 + 1e-6);
  var bsi  = ((s.B11 + s.B04) - (s.B08 + s.B02)) / ((s.B11 + s.B04) + (s.B08 + s.B02) + 1e-6);
  var ndwi = (s.B08 - s.B11) / (s.B08 + s.B11 + 1e-6);
  return [
    Math.round(Math.min(255, Math.max(0, (nbr  + 1) / 2 * 255))),
    Math.round(Math.min(255, Math.max(0, (bsi  + 1) / 2 * 255))),
    Math.round(Math.min(255, Math.max(0, (ndwi + 1) / 2 * 255)))
  ];
}
"""

EVALSCRIPT_S2_TRUECOLOR = """
//VERSION=3
function setup() {
  return { input: [{bands:["B02","B03","B04"]}], output: {bands:3} };
}
function evaluatePixel(s) {
  return [Math.min(1, 3.5*s.B04), Math.min(1, 3.5*s.B03), Math.min(1, 3.5*s.B02)];
}
"""

EVALSCRIPT_S1_VH = """
//VERSION=3
function setup() {
  return {
    input: [{bands: ["VH"], units: "LINEAR_POWER"}],
    output: {bands: 1, sampleType: "UINT8"}
  };
}
function evaluatePixel(s) {
  var db  = 10 * Math.log10(s.VH + 1e-10);
  return [Math.round(Math.min(255, Math.max(0, (db + 35) / 40 * 255)))];
}
"""

EVALSCRIPT_CHANGE_MASK = """
//VERSION=3
function setup() {
  return {
    input: [{bands: ["B04","B08","SCL"], units: ["REFLECTANCE","REFLECTANCE","DN"], mosaickingOrder: "leastCC"}],
    output: {bands: 3, sampleType: "UINT8"}
  };
}
function evaluatePixel(s) {
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 1e-6);
  return [Math.round(Math.min(255, Math.max(0, (ndvi + 1) / 2 * 255))), s.SCL, 128];
}
"""


def optimal_pixel_size(km):
    """
    Return (width, height) that keeps effective GSD ≤ 20 m.
    Sentinel-2 native is 10 m; 512px at 10 km = ~20 m GSD — the upper limit we honour.
    At larger windows we scale pixels up proportionally, capped at 1024 to stay within
    Sentinel Hub's free-tier output size limits.
    """
    target_gsd_m = 20          # effective GSD ceiling in metres
    km_per_pixel = target_gsd_m / 1000.0
    px = int(round(km / km_per_pixel))
    px = max(256, min(px, 1024))  # always between 256 and 1024
    return px, px


def sh_process(evalscript, data_source_cfg, west, south, east, north,
               token, width=None, height=None, km=None):
    if width is None or height is None:
        w_px, h_px = optimal_pixel_size(km) if km else (512, 512)
        width  = width  or w_px
        height = height or h_px
    payload = {
        "input": {
            "bounds": {"bbox": [west, south, east, north],
                       "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"}},
            "data": [data_source_cfg]
        },
        "output": {
            "width": width, "height": height,
            "responses": [{"identifier": "default", "format": {"type": "image/png"}}]
        },
        "evalscript": evalscript
    }
    last_exc = None
    for attempt in range(1 + SH_MAX_RETRIES):
        try:
            resp = http_requests.post(
                SH_PROCESS_URL, json=payload,
                headers={"Authorization": f"Bearer {token}", "Accept": "image/png"},
                timeout=SH_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.content
        except (http_requests.exceptions.Timeout, http_requests.exceptions.ConnectionError) as exc:
            last_exc = exc
            if attempt < SH_MAX_RETRIES: time.sleep(SH_RETRY_DELAY); continue
            raise
        except http_requests.exceptions.HTTPError as exc:
            if exc.response is not None and exc.response.status_code < 500: raise
            last_exc = exc
            if attempt < SH_MAX_RETRIES: time.sleep(SH_RETRY_DELAY); continue
            raise
    raise last_exc


def s2_cfg(time_from, time_to):
    return {
        "type": "sentinel-2-l2a",
        "dataFilter": {
            "timeRange":       {"from": f"{time_from}T00:00:00Z", "to": f"{time_to}T23:59:59Z"},
            "mosaickingOrder": "leastCC",
            "maxCloudCoverage": 80,
        }
    }


def s1_cfg(time_from, time_to):
    return {
        "type": "sentinel-1-grd",
        "dataFilter": {
            "timeRange":      {"from": f"{time_from}T00:00:00Z", "to": f"{time_to}T23:59:59Z"},
            "acquisitionMode": "IW", "polarization": "DV", "resolution": "HIGH",
        },
        "processing": {"backCoeff": "GAMMA0_ELLIPSOID", "orthorectify": True, "demInstance": "COPERNICUS_30"}
    }


# ── Date windows ──────────────────────────────────────────────────────────────

def current_window(days=45):
    end = datetime.now(timezone.utc) - timedelta(days=5)
    return (end - timedelta(days=days)).strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')


def mid_window(days=45):
    """Same calendar season, 1 year ago — critical for phenology disambiguation."""
    end = datetime.now(timezone.utc) - timedelta(days=5)
    try: end_m = end.replace(year=end.year - 1)
    except ValueError: end_m = end.replace(year=end.year - 1, day=28)
    return (end_m - timedelta(days=days)).strftime('%Y-%m-%d'), end_m.strftime('%Y-%m-%d')


def baseline_window(years_back=2, days=45):
    """Same season 2 years ago — structural baseline."""
    end = datetime.now(timezone.utc) - timedelta(days=5)
    try: end_b = end.replace(year=end.year - years_back)
    except ValueError: end_b = end.replace(year=end.year - years_back, day=28)
    return (end_b - timedelta(days=days)).strftime('%Y-%m-%d'), end_b.strftime('%Y-%m-%d')


# ── Spatial helpers ───────────────────────────────────────────────────────────

def fixed_bbox(clat, clon, km):
    half_lat = (km / 2) / 111.32
    half_lon = (km / 2) / (111.32 * math.cos(math.radians(clat)))
    return clat + half_lat, clat - half_lat, clon + half_lon, clon - half_lon


# ── Image analysis ────────────────────────────────────────────────────────────

def compute_indices_ndvi_evi(img_bytes):
    """R=NDVI, G=EVI, B=SCL. Returns ndvi, evi, cloud_pct, valid_px, scl_stats."""
    img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
    a   = np.asarray(img, dtype=np.float32)
    img.close()
    ndvi = (a[:,:,0] / 255.0) * 2.0 - 1.0
    evi  = (a[:,:,1] / 255.0) * 2.0 - 1.0
    scl  = a[:,:,2].astype(np.uint8)
    del a

    nodata = (scl == 0)
    cloud  = np.isin(scl, list(SCL_CLOUD | SCL_CLOUD_SHADOW))
    valid  = np.isin(scl, list(SCL_VALID_LAND))
    total  = float(max(scl.size - int(np.sum(nodata)), 1))
    cloud_pct = int(np.sum(cloud)) / total * 100.0
    valid_px  = int(np.sum(valid))
    scl_stats = {
        "vegetation_pct":   float(np.sum(scl == 4) / total * 100),
        "bare_soil_pct":    float(np.sum(scl == 5) / total * 100),
        "water_pct":        float(np.sum(scl == 6) / total * 100),
        "cloud_shadow_pct": float(np.sum(scl == 3) / total * 100),
        "snow_pct":         float(np.sum(scl == 11) / total * 100),
    }
    if valid_px < 500:
        del ndvi, evi, scl, nodata, cloud, valid
        return float('nan'), float('nan'), cloud_pct, valid_px, scl_stats
    ndvi_mean = float(np.mean(ndvi[valid]))
    evi_mean  = float(np.mean(evi[valid]))
    del ndvi, evi, scl, nodata, cloud, valid
    return ndvi_mean, evi_mean, cloud_pct, valid_px, scl_stats


def compute_nbr_bsi_ndwi(img_bytes):
    """R=NBR, G=BSI, B=NDWI. Returns nbr, bsi, ndwi."""
    img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
    a   = np.asarray(img, dtype=np.float32)
    img.close()
    nbr  = (a[:,:,0] / 255.0) * 2.0 - 1.0
    bsi  = (a[:,:,1] / 255.0) * 2.0 - 1.0
    ndwi = (a[:,:,2] / 255.0) * 2.0 - 1.0
    valid = (a[:,:,0] > 1) & (a[:,:,0] < 254)
    del a
    if int(np.sum(valid)) < 200:
        del nbr, bsi, ndwi, valid
        return float('nan'), float('nan'), float('nan')
    result = float(np.mean(nbr[valid])), float(np.mean(bsi[valid])), float(np.mean(ndwi[valid]))
    del nbr, bsi, ndwi, valid
    return result


def compute_sar_stats(img_bytes):
    img = Image.open(io.BytesIO(img_bytes)).convert('L')
    a   = np.asarray(img, dtype=np.float32)
    img.close()
    vh_db = (a / 255.0) * 40.0 - 35.0
    valid = (a > 1) & (a < 254)
    del a
    if int(np.sum(valid)) < 200:
        del vh_db, valid
        return float('nan'), {}
    vh_v = vh_db[valid]
    del vh_db, valid
    stats = {
        "high_backscatter_pct":   float(np.sum(vh_v >= -14) / len(vh_v) * 100),
        "medium_backscatter_pct": float(np.sum((vh_v >= -20) & (vh_v < -14)) / len(vh_v) * 100),
        "low_backscatter_pct":    float(np.sum(vh_v < -20) / len(vh_v) * 100),
        "std_db":                 round(float(np.std(vh_v)), 2),
    }
    mean_vh = float(np.mean(vh_v))
    del vh_v
    return mean_vh, stats


def build_change_overlay(now_bytes, base_bytes):
    an = np.asarray(Image.open(io.BytesIO(now_bytes)).convert('RGB'),  dtype=np.float32)
    ab = np.asarray(Image.open(io.BytesIO(base_bytes)).convert('RGB'), dtype=np.float32)
    ndvi_now  = an[:,:,0] / 255.0 * 2.0 - 1.0
    ndvi_base = ab[:,:,0] / 255.0 * 2.0 - 1.0
    scl_now   = an[:,:,1].astype(np.uint8)
    scl_base  = ab[:,:,1].astype(np.uint8)
    del an, ab
    delta = ndvi_now - ndvi_base
    del ndvi_now, ndvi_base
    vn = np.isin(scl_now,  list(SCL_VALID_LAND))
    vb = np.isin(scl_base, list(SCL_VALID_LAND))
    del scl_now, scl_base
    both = vn & vb
    del vn, vb
    h, w = delta.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    loss = both & (delta < -0.08); sev = both & (delta < -0.15)
    rgba[loss, 0] = 220; rgba[loss, 3] = 160
    rgba[sev,  0] = 255; rgba[sev,  3] = 210
    gain = both & (delta > 0.08)
    rgba[gain, 1] = 200; rgba[gain, 3] = 140
    stable = both & ~loss & ~gain
    rgba[stable, 0] = 60; rgba[stable, 1] = 80; rgba[stable, 2] = 70; rgba[stable, 3] = 25
    tv = max(int(np.sum(both)), 1)
    img = Image.fromarray(rgba, 'RGBA')
    del rgba
    buf = io.BytesIO(); img.save(buf, format='PNG')
    img.close()

    # ── Spatial concentration: divide image into 3×3 grid, find max-loss cell ─
    loss_arr = loss.astype(np.float32)
    cell_h, cell_w = h // 3, w // 3
    cell_loss_pcts = []
    for r in range(3):
        for c in range(3):
            cell = loss_arr[r*cell_h:(r+1)*cell_h, c*cell_w:(c+1)*cell_w]
            both_cell = both[r*cell_h:(r+1)*cell_h, c*cell_w:(c+1)*cell_w]
            denom = max(int(np.sum(both_cell)), 1)
            cell_loss_pcts.append(float(np.sum(cell)) / denom * 100)
    max_cell_loss_pct = max(cell_loss_pcts)
    # Concentration ratio: how much is clearing confined to a single cell?
    mean_cell_loss_pct = float(np.mean(cell_loss_pcts))
    concentration_ratio = max_cell_loss_pct / max(mean_cell_loss_pct, 0.01)

    stats = {
        'loss_pct':             round(float(np.sum(loss)) / tv * 100, 1),
        'severe_loss_pct':      round(float(np.sum(sev))  / tv * 100, 1),
        'gain_pct':             round(float(np.sum(gain)) / tv * 100, 1),
        'stable_pct':           round(float(np.sum(stable)) / tv * 100, 1),
        'max_cell_loss_pct':    round(max_cell_loss_pct, 1),
        'concentration_ratio':  round(concentration_ratio, 2),
    }
    del delta, both, loss, sev, gain, stable, loss_arr
    return buf.getvalue(), stats


def interpret_sar_change(vh_now, vh_base):
    if math.isnan(vh_now) or math.isnan(vh_base): return float('nan'), "unavailable", False
    delta = vh_now - vh_base
    if delta <= SAR_DEFOR_THRESH:   label = "strong_loss"
    elif delta <= SAR_DEGRAD_THRESH: label = "degradation"
    elif delta >= 1.5:               label = "recovery"
    else:                            label = "stable"
    return delta, label, delta <= SAR_DEFOR_THRESH


# ── Severity & confidence ─────────────────────────────────────────────────────

def compute_severity(ndvi_delta, sar_label, nbr_delta=None, bsi_delta=None,
                     visual_extraction=None, change_stats=None):
    """
    Severity is driven by the WORST of: scene-mean spectral signal OR spatial pixel-level signal.
    A 5% localized clearing in a 50×50 km window has near-zero mean NDVI delta but is HIGH concern.
    """
    ORDER = ["low", "medium", "high", "critical"]
    def bump(b, n=1): return ORDER[min(ORDER.index(b) + n, 3)]

    # ── Scene-mean spectral baseline ──────────────────────────────────────────
    if sar_label == "strong_loss":
        base = "critical" if ndvi_delta < -0.05 else "high"
    elif ndvi_delta < -0.15: base = "critical"
    elif ndvi_delta < -0.08 or sar_label == "degradation": base = "high"
    elif ndvi_delta < -0.02: base = "medium"
    else: base = "low"

    # ── Spatial pixel-level signal (takes precedence over scene means) ────────
    if change_stats:
        loss_pct        = change_stats.get('loss_pct', 0) or 0
        severe_loss_pct = change_stats.get('severe_loss_pct', 0) or 0
        max_cell        = change_stats.get('max_cell_loss_pct', 0) or 0
        conc            = change_stats.get('concentration_ratio', 1) or 1

        # Hard floor from pixel loss — even if mean NDVI is near-zero
        if severe_loss_pct >= 10 or loss_pct >= 20:
            base = ORDER[max(ORDER.index(base), ORDER.index("critical"))]
        elif severe_loss_pct >= 5 or loss_pct >= 10:
            base = ORDER[max(ORDER.index(base), ORDER.index("high"))]
        elif loss_pct >= 3 or severe_loss_pct >= 1.5:
            base = ORDER[max(ORDER.index(base), ORDER.index("medium"))]

        # Concentrated clearing is more alarming than diffuse — bump an extra level
        if max_cell >= 15 and conc >= 3.0:
            base = bump(base)  # localized hotspot
        elif max_cell >= 8 and conc >= 2.0:
            base = bump(base)  # moderately concentrated

    # ── Additional spectral bumps ─────────────────────────────────────────────
    if nbr_delta is not None and not math.isnan(nbr_delta) and nbr_delta < -0.20:
        base = bump(base)
    if bsi_delta is not None and not math.isnan(bsi_delta) and bsi_delta > 0.15:
        base = bump(base)

    # ── Visual signal bumps ───────────────────────────────────────────────────
    if visual_extraction:
        if (visual_extraction.get("logging_roads_detected") or
            visual_extraction.get("burn_scars_detected") or
            visual_extraction.get("active_clearing_detected")):
            base = bump(base)
        if not visual_extraction.get("is_forest_scene", True):
            base = ORDER[max(ORDER.index(base) - 1, 0)]
    return base


def compute_confidence(cloud_now, cloud_base, valid_now, valid_base,
                       sar_avail, ndvi_signal_ok, visual_extraction=None,
                       nbr_avail=False):
    score = 0
    score += max(0, 28 - cloud_now  * 0.56)
    score += max(0, 20 - cloud_base * 0.40)
    if valid_now >= 40_000: score += 12
    elif valid_now >= 20_000: score += 8
    elif valid_now >= 5_000:  score += 4
    if ndvi_signal_ok: score += 8
    if nbr_avail: score += 5
    if sar_avail: score += 12
    if visual_extraction:
        vc = visual_extraction.get("overall_confidence", 0)
        if vc >= 80: score += 8
        elif vc >= 60: score += 5
        elif vc >= 40: score += 3
    score = max(0, min(92, int(round(score))))
    label = "High" if score >= 70 else ("Medium" if score >= 45 else "Low")
    return score, label


# ── Geocoding ─────────────────────────────────────────────────────────────────

def reverse_geocode(lat, lon):
    try:
        r = http_requests.get(
            'https://nominatim.openstreetmap.org/reverse',
            params={'lat': lat, 'lon': lon, 'format': 'json', 'zoom': 8, 'accept-language': 'en'},
            headers={'User-Agent': 'CanopyMonitor/3.0'}, timeout=6,
        )
        addr  = r.json().get('address', {})
        parts = [addr.get('state') or addr.get('county') or addr.get('region', ''), addr.get('country', '')]
        return ', '.join(p for p in parts if p) or f"{lat:.3f}°, {lon:.3f}°"
    except Exception:
        return f"{lat:.3f}°, {lon:.3f}°"


# ── STAGE 1 ───────────────────────────────────────────────────────────────────

STAGE1_SCHEMA = {
    "is_forest_scene":             "boolean — is the primary land cover actually forest? false for desert, farmland, grassland, urban",
    "biome_classification":        "string: tropical_rainforest / boreal_forest / temperate_forest / mangrove / savanna / dryland_shrubland / agriculture / desert / wetland / urban / unknown",
    "canopy_cover_pct":            "float 0-100 — estimated % of frame covered by intact canopy",
    "bare_soil_exposure_pct":      "float 0-100 — visible bare soil / cleared land",
    "logging_roads_detected":      "boolean — geometric linear clearings visible",
    "logging_road_count_estimate": "integer — rough count of distinct road features (0 if none)",
    "burn_scars_detected":         "boolean — dark/charred patches consistent with fire",
    "burn_scar_pct":               "float 0-100 — % of frame showing burn evidence",
    "active_clearing_detected":    "boolean — fresh bright clearings at forest edge",
    "water_bodies_pct":            "float 0-100 — rivers, lakes, wetlands visible",
    "agricultural_encroachment":   "boolean — geometric field patterns at forest boundary",
    "canopy_texture":              "string: dense_uniform / patchy / fragmented / degraded / sparse / non_forest",
    "dominant_change_pattern":     "string: edge_clearing / interior_clearing / linear_cuts / diffuse_degradation / seasonal_browning / post_fire_recovery / none",
    "temporal_trajectory":         "string: progressive_loss / loss_then_stable / loss_then_recovery / stable / seasonal_cycle / not_determinable",
    "seasonal_change_likely":      "boolean — is the observed change likely seasonal/phenological rather than structural?",
    "baseline_vs_current_change":  "string — 2-3 sentences: what changed between the baseline and current image? Describe texture, bare patches, roads, burn scars.",
    "spatial_pattern_description": "string — 1-2 sentences: where is change located spatially? (compass direction, proximity to water/roads)",
    "image_quality_assessment":    "string: clear / partial_cloud / heavy_cloud / haze",
    "overall_confidence":          "integer 0-100 — confidence in this visual extraction given image quality",
}


def build_stage1_prompt(region, clat, clon, km, cur_from, cur_to, base_from, base_to):
    return (
        f"You are examining TWO Sentinel-2 truecolor satellite images of {region} "
        f"(centre {clat:.3f}°, {clon:.3f}°, {km}×{km} km window).\n\n"
        f"Image 1 (first): BASELINE period {base_from} to {base_to} (~2 years ago, same calendar season).\n"
        f"Image 2 (second): CURRENT period {cur_from} to {cur_to} (most recent).\n\n"
        f"Both images are same-season composites — most phenological variation is suppressed.\n\n"
        f"STEP 1: Identify the biome. If NOT a forested region, adjust all assessments.\n"
        f"STEP 2: Compare the two images to determine if change is:\n"
        f"  - STRUCTURAL DEFORESTATION (canopy lost, bright clearings, new roads — permanent)\n"
        f"  - FIRE-RELATED (burn scars or charred texture appearing in current)\n"
        f"  - STABLE (no meaningful difference between baseline and current)\n"
        f"  - SEASONAL (flag only if biome is known seasonal and change pattern is diffuse)\n\n"
        f"IMPORTANT — ACTIVE CLEARING DETECTION:\n"
        f"Pay close attention to LOCALIZED changes — bright rectangular patches, sharp edge clearings,\n"
        f"or linear road cuts that occupy even a small fraction of the frame. A 5% clearing in a corner\n"
        f"of an otherwise intact forest is HIGH CONCERN. Report its approximate position and extent.\n\n"
        f"Work from what you see in the pixels only — no spectral indices are provided.\n\n"
        f"Return a single JSON object matching this schema exactly:\n"
        f"{json.dumps(STAGE1_SCHEMA, indent=2)}\n\n"
        f"Return ONLY the JSON. No explanation, no markdown."
    )


def call_gemma_stage1(tc_now, tc_base, region, clat, clon, km,
                      cur_from, cur_to, base_from, base_to):
    prompt = build_stage1_prompt(region, clat, clon, km, cur_from, cur_to, base_from, base_to)
    parts = [
        types.Part(inline_data=types.Blob(mime_type="image/png", data=base64.b64encode(tc_base).decode())),
        types.Part(inline_data=types.Blob(mime_type="image/png", data=base64.b64encode(tc_now).decode())),
        types.Part(text=prompt),
    ]
    resp = gemini_client.models.generate_content(
        model="gemma-4-26b-a4b-it",
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(system_instruction=STAGE1_SYSTEM_PROMPT),
    )
    raw = resp.text.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\s*```$', '', raw)
    try:
        ext = json.loads(raw)
        for f in ["canopy_cover_pct", "bare_soil_exposure_pct", "burn_scar_pct", "water_bodies_pct"]:
            if f in ext: ext[f] = max(0.0, min(100.0, float(ext[f])))
        if "overall_confidence" in ext:
            ext["overall_confidence"] = max(0, min(100, int(ext["overall_confidence"])))
        ext["_stage1_success"] = True
        return ext
    except Exception as exc:
        app.logger.warning("Stage 1 parse failed: %s | raw: %s", exc, raw[:300])
        return {
            "_stage1_success": False, "_stage1_raw": raw[:500],
            "overall_confidence": 0, "canopy_texture": "unknown",
            "image_quality_assessment": "unknown", "is_forest_scene": True,
            "biome_classification": "unknown", "seasonal_change_likely": False,
            "temporal_trajectory": "not_determinable",
        }


# ── STAGE 2 ───────────────────────────────────────────────────────────────────

def _scl_summary(s):
    if not s: return "N/A"
    snow = f", snow {s.get('snow_pct',0):.1f}%" if s.get('snow_pct', 0) > 1 else ""
    return (f"veg {s.get('vegetation_pct',0):.1f}%, bare {s.get('bare_soil_pct',0):.1f}%, "
            f"water {s.get('water_pct',0):.1f}%, cloud-shadow {s.get('cloud_shadow_pct',0):.1f}%{snow}")


def build_stage2_prompt(
    region, clat, clon, km,
    ndvi_now, evi_now, ndvi_base, evi_base,
    scl_now, scl_base, cloud_now, cloud_base,
    valid_now, valid_base,
    nbr_now, bsi_now, ndwi_now, nbr_base, bsi_base, ndwi_base,
    vh_now, vh_base, sar_delta_nb, sar_label,
    severity, conf_label, conf_score,
    cur_from, cur_to, base_from, base_to,
    visual_extraction, change_stats=None,
):
    def f(v, d=4): return f"{v:+.{d}f}" if not math.isnan(v) else "N/A"
    def fu(v, d=4): return f"{v:.{d}f}" if not math.isnan(v) else "N/A"
    def dn(a, b): return a - b if not (math.isnan(a) or math.isnan(b)) else float('nan')

    d_ndvi_nb = dn(ndvi_now, ndvi_base)
    d_evi_nb  = dn(evi_now,  evi_base)
    d_nbr_nb  = dn(nbr_now,  nbr_base)
    d_bsi_nb  = dn(bsi_now,  bsi_base)
    d_ndwi_nb = dn(ndwi_now, ndwi_base)

    sar_block = (
        f"  Baseline ({base_from}–{base_to}): {f(vh_base,2)} dB\n"
        f"  Current  ({cur_from}–{cur_to}):   {f(vh_now,2)} dB\n"
        f"  Δ VH Base→Current: {f(sar_delta_nb,2)} dB → {sar_label.replace('_',' ').upper()}\n"
        f"  SAR thresholds are indicative for tropical IW — treat as relative.\n"
    ) if not math.isnan(vh_now) else "  Status: NO DATA — optical-only assessment.\n"

    # ── Spatial pixel-level change block ──────────────────────────────────────
    cs = change_stats or {}
    spatial_block = (
        f"── (C) Pixel-Level Spatial Change Statistics ────────────────────────────\n"
        f"  These are PER-PIXEL NDVI delta counts — NOT scene means. Weight these heavily.\n"
        f"  NDVI loss pixels (Δ < −0.08):        {cs.get('loss_pct', 'N/A')}% of valid area\n"
        f"  Severe NDVI loss pixels (Δ < −0.15): {cs.get('severe_loss_pct', 'N/A')}% of valid area\n"
        f"  NDVI gain pixels (Δ > +0.08):        {cs.get('gain_pct', 'N/A')}% of valid area\n"
        f"  Max cell loss (worst 1/9 of scene):  {cs.get('max_cell_loss_pct', 'N/A')}%\n"
        f"  Spatial concentration ratio:         {cs.get('concentration_ratio', 'N/A')}x\n"
        f"  (Concentration >2x means clearing is LOCALIZED, not diffuse — treat as higher concern)\n"
    ) if cs else ""

    ve = visual_extraction or {}
    ok = ve.get("_stage1_success", False)
    vblock = (
        f"── (D) Gemma Stage 1 Visual Extraction (2 images: baseline + current) ───\n"
        f"  Biome:               {ve.get('biome_classification','unknown')}\n"
        f"  Is forest scene:     {'YES' if ve.get('is_forest_scene', True) else 'NO — reduce severity accordingly'}\n"
        f"  Seasonal change:     {'LIKELY SEASONAL/PHENOLOGICAL' if ve.get('seasonal_change_likely') else 'Structural or uncertain'}\n"
        f"  Temporal trajectory: {ve.get('temporal_trajectory','not_determinable')}\n"
        f"  Canopy cover:        {ve.get('canopy_cover_pct', 'N/A')}%\n"
        f"  Bare soil:           {ve.get('bare_soil_exposure_pct', 'N/A')}%\n"
        f"  Logging roads:       {'YES' if ve.get('logging_roads_detected') else 'NO'} (~{ve.get('logging_road_count_estimate', 0)} features)\n"
        f"  Burn scars:          {'YES' if ve.get('burn_scars_detected') else 'NO'} ({ve.get('burn_scar_pct', 0):.1f}%)\n"
        f"  Active clearing:     {'YES' if ve.get('active_clearing_detected') else 'NO'}\n"
        f"  Agri encroachment:   {'YES' if ve.get('agricultural_encroachment') else 'NO'}\n"
        f"  Canopy texture:      {ve.get('canopy_texture', 'unknown')}\n"
        f"  Change pattern:      {ve.get('dominant_change_pattern', 'unknown')}\n"
        f"  Baseline→Current:    {ve.get('baseline_vs_current_change', 'N/A')}\n"
        f"  Spatial:             {ve.get('spatial_pattern_description', 'N/A')}\n"
        f"  Image quality:       {ve.get('image_quality_assessment', 'unknown')}\n"
        f"  Stage 1 confidence:  {ve.get('overall_confidence', 0)}/100\n"
    ) if ok else (
        "── (D) Gemma Stage 1 Visual Extraction ─────────────────────────────────\n"
        "  Status: JSON extraction failed. Proceed spectral-only.\n"
    )

    ag = []
    if ok:
        if abs(ve.get("bare_soil_exposure_pct", 0) - (scl_now or {}).get("bare_soil_pct", 0)) > 15:
            ag.append("DISAGREE on bare soil: visual vs SCL spectral differ >15%")
        if ve.get("logging_roads_detected") and not math.isnan(d_ndvi_nb) and d_ndvi_nb > -0.02:
            ag.append("DISAGREE: logging roads visible but mean NDVI delta near-zero — likely selective logging; check spatial stats")
        if ve.get("burn_scars_detected") and not math.isnan(d_nbr_nb) and d_nbr_nb > -0.10:
            ag.append("PARTIAL DISAGREE: visual burn scars but NBR drop minor — old scar or haze artifact")
        if ve.get("seasonal_change_likely") and not math.isnan(d_ndvi_nb) and d_ndvi_nb < -0.15:
            ag.append("TENSION: visual marks seasonal but NDVI delta is large — verify biome classification")
        if not math.isnan(d_ndwi_nb) and d_ndwi_nb < -0.15 and not math.isnan(d_ndvi_nb) and d_ndvi_nb > -0.02:
            ag.append("CANOPY STRESS: NDWI drop without NDVI drop — drought/water stress, not clearing")
        if cs.get('max_cell_loss_pct', 0) >= 8 and not ve.get('active_clearing_detected'):
            ag.append("SPATIAL ALERT: pixel overlay shows localized loss hotspot but Stage 1 did not flag active clearing — examine image directly")
    ag_block = ("── Signal Agreement Analysis ───────────────────────────────────────────\n"
                + "".join(f"  ⚡ {n}\n" for n in ag)) if ag else ""

    nbr_note  = ('(HIGH SEVERITY BURN)' if not math.isnan(d_nbr_nb) and d_nbr_nb < -0.27 else
                 '(LOW SEVERITY BURN)'  if not math.isnan(d_nbr_nb) and d_nbr_nb < -0.10 else '')
    bsi_note  = '(SIGNIFICANT SOIL EXPOSURE)' if not math.isnan(d_bsi_nb)  and d_bsi_nb  > 0.15  else ''
    ndwi_note = '(CANOPY STRESS / DROUGHT)'   if not math.isnan(d_ndwi_nb) and d_ndwi_nb < -0.15 else ''

    schema = {
        "risk_level":              "2-3 sentences: state risk tier, justify from NDVI+EVI+NBR+BSI+SAR+pixel-loss%, note spectral/visual agreement",
        "seasonal_vs_structural":  "REQUIRED — 2-4 sentences: is this seasonal/phenological or structural deforestation? Use EVI/NBR, biome context, SAR, and spatial pixel stats. This is the most important field.",
        "image_observations":      "2-4 sentences: describe what the two images (baseline and current) show — texture, bare patches, burn scars, logging roads, localized vs. diffuse change",
        "spatial_analysis":        "2-3 sentences: describe spatial distribution of change from pixel stats — is loss localized or diffuse? Where in the scene? Why does this matter for early warning?",
        "index_synthesis":         "2-3 sentences: do EVI and NDVI agree? Does NBR confirm fire? Does BSI rise confirm soil exposure? Does NDWI indicate water stress vs. canopy loss?",
        "visual_spectral_agreement": "1-3 sentences: where do visual and spectral signals agree or disagree, and what is the most likely scientific explanation?",
        "likely_causes":           "2-3 sentences: link patterns to known regional drivers (agriculture, selective logging, wildfire, infrastructure, mining, pastoralism)",
        "trend_analysis":          "2-3 sentences: describe the trajectory from baseline to current. Accelerating, stable, or recovering?",
        "recommended_actions":     "3 numbered concrete actions for local authorities (monitoring frequency, agency, legal instrument)",
    }

    return (
        f"SYNTHESIS — two-epoch, five-index, two-sensor analysis of {region} "
        f"(centre {clat:.3f}°N {clon:.3f}°E | {km}×{km} km)\n"
        f"Two truecolor images are attached — Image 1=BASELINE, Image 2=CURRENT. "
        f"Use your vision to cross-check the data below. If you see clearing or roads the "
        f"Stage 1 summary missed, state your own finding and override where justified.\n\n"
        f"── (A) Spectral Analysis ─────────────────────────────────────────────────\n"
        f"Index interpretation: NDVI/EVI −1→+1 (higher=greener). NBR high=healthy, low=burned.\n"
        f"BSI: positive=bare soil, negative=vegetated. NDWI: high=wet canopy, low=stressed/cleared.\n\n"
        f"                BASELINE               CURRENT\n"
        f"                {base_from}–{base_to}   {cur_from}–{cur_to}\n"
        f"  NDVI         {fu(ndvi_base)}          {fu(ndvi_now)}\n"
        f"  EVI          {fu(evi_base)}          {fu(evi_now)}\n"
        f"  NBR          {fu(nbr_base)}          {fu(nbr_now)}\n"
        f"  BSI          {fu(bsi_base)}          {fu(bsi_now)}\n"
        f"  NDWI         {fu(ndwi_base)}          {fu(ndwi_now)}\n"
        f"  Cloud%       {cloud_base:.1f}%              {cloud_now:.1f}%\n"
        f"  SCL (base)   {_scl_summary(scl_base)}\n"
        f"  SCL (now)    {_scl_summary(scl_now)}\n\n"
        f"  Δ NDVI  Base→Current: {f(d_ndvi_nb)}\n"
        f"  Δ EVI   Base→Current: {f(d_evi_nb)}\n"
        f"  Δ NBR   Base→Current: {f(d_nbr_nb)} {nbr_note}\n"
        f"  Δ BSI   Base→Current: {f(d_bsi_nb)} {bsi_note}\n"
        f"  Δ NDWI  Base→Current: {f(d_ndwi_nb)} {ndwi_note}\n"
        f"  → Overall severity: {severity.upper()} (confidence: {conf_label} {conf_score}/100)\n\n"
        f"── (B) SAR Analysis — Sentinel-1 VH Backscatter ─────────────────────────\n"
        f"{sar_block}\n"
        f"{spatial_block}"
        f"{vblock}\n"
        f"{ag_block}\n"
        f"Write a structured synthesis report as a JSON object matching this schema:\n"
        f"{json.dumps(schema, indent=2)}\n\n"
        f"Return ONLY the JSON. No explanation, no markdown fences."
    )


def call_gemma_stage2(prompt, tc_now_bytes, tc_base_bytes):
    parts = [
        types.Part(inline_data=types.Blob(mime_type="image/png", data=base64.b64encode(tc_base_bytes).decode())),
        types.Part(inline_data=types.Blob(mime_type="image/png", data=base64.b64encode(tc_now_bytes).decode())),
        types.Part(text=prompt),
    ]
    resp = gemini_client.models.generate_content(
        model="gemma-4-26b-a4b-it",
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(system_instruction=STAGE2_SYSTEM_PROMPT),
    )
    raw = resp.text.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\s*```$', '', raw)
    try:
        r = json.loads(raw); r["_stage2_success"] = True; return r
    except Exception as exc:
        app.logger.warning("Stage 2 JSON parse failed: %s", exc)
        cleaned = re.sub(r'\*\*?(.+?)\*\*?', r'\1', raw); cleaned = re.sub(r'#{1,6}\s+', '', cleaned)
        return {"_stage2_success": False, "risk_level": cleaned[:2000], "seasonal_vs_structural": "Parse error."}


# ── Concurrent fetch ──────────────────────────────────────────────────────────

def fetch_all_sentinel(west, south, east, north, token, km,
                       cur_from, cur_to, base_from, base_to):
    tasks = {
        "tc_now":   (EVALSCRIPT_S2_TRUECOLOR,    s2_cfg(cur_from, cur_to)),
        "tc_base":  (EVALSCRIPT_S2_TRUECOLOR,    s2_cfg(base_from, base_to)),
        "s2a_now":  (EVALSCRIPT_S2_NDVI_EVI,     s2_cfg(cur_from, cur_to)),
        "s2a_base": (EVALSCRIPT_S2_NDVI_EVI,     s2_cfg(base_from, base_to)),
        "s2b_now":  (EVALSCRIPT_S2_NBR_BSI_NDWI, s2_cfg(cur_from, cur_to)),
        "s2b_base": (EVALSCRIPT_S2_NBR_BSI_NDWI, s2_cfg(base_from, base_to)),
        "cm_now":   (EVALSCRIPT_CHANGE_MASK,      s2_cfg(cur_from, cur_to)),
        "cm_base":  (EVALSCRIPT_CHANGE_MASK,      s2_cfg(base_from, base_to)),
        "s1_now":   (EVALSCRIPT_S1_VH,            s1_cfg(cur_from, cur_to)),
        "s1_base":  (EVALSCRIPT_S1_VH,            s1_cfg(base_from, base_to)),
    }
    results = {}; failures = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(sh_process, sc, cfg, west, south, east, north, token, km=km): nm
                   for nm, (sc, cfg) in tasks.items()}
        deadline = time.time() + TOTAL_SH_BUDGET
        for future in as_completed(futures, timeout=TOTAL_SH_BUDGET):
            nm = futures[future]
            try: results[nm] = future.result(timeout=max(1, deadline - time.time()))
            except Exception as exc: failures[nm] = exc
    return results, failures


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/health')
def health():
    return jsonify({
        'status': 'ok', 'model': 'gemma-4-26b-a4b-it',
        'pipeline': 'two-stage gemma | 2-epoch | 5-index (NDVI, EVI, NBR, BSI, NDWI)',
        'sensors': 'Sentinel-2 L2A + Sentinel-1 GRD',
        'epochs': 'baseline (−2yr same season) / current',
    })


@app.route('/analyse-point', methods=['POST'])
def analyse_point():
    try:
        d    = request.get_json()
        clat = float(d['lat'])
        clon = float(d['lon'])
        km   = int(d.get('window_km', DEFAULT_ANALYSIS_KM))
        if km not in VALID_WINDOW_SIZES: km = DEFAULT_ANALYSIS_KM
        if not (-90 <= clat <= 90 and -180 <= clon <= 180):
            return jsonify({'success': False, 'error': 'Invalid coordinates'}), 400

        north, south, east, west = fixed_bbox(clat, clon, km)
        region   = reverse_geocode(clat, clon)
        cur_from, cur_to   = current_window()
        base_from, base_to = baseline_window()
        token = get_sh_token()

        results, failures = fetch_all_sentinel(
            west, south, east, north, token, km,
            cur_from, cur_to, base_from, base_to,
        )

        for req in ("s2a_now", "s2a_base", "tc_now", "tc_base"):
            if req not in results:
                exc = failures.get(req, Exception("Unknown"))
                return jsonify({'success': False,
                    'error': f"Sentinel-2 fetch failed ({req}): {exc}. Retry in 30s."}), 502

        # ── NDVI + EVI ────────────────────────────────────────────────────────
        ndvi_now,  evi_now,  cloud_now,  valid_now,  scl_now  = compute_indices_ndvi_evi(results["s2a_now"])
        results.pop("s2a_now", None)
        ndvi_base, evi_base, cloud_base, valid_base, scl_base = compute_indices_ndvi_evi(results["s2a_base"])
        results.pop("s2a_base", None)

        if math.isnan(ndvi_now) or math.isnan(ndvi_base):
            return jsonify({'success': False,
                'error': f'Too few valid pixels (cur cloud={cloud_now:.0f}%, base cloud={cloud_base:.0f}%)',
                'cloud_now': round(cloud_now,1), 'cloud_base': round(cloud_base,1)}), 422

        ndvi_delta = ndvi_now - ndvi_base

        # ── NBR + BSI + NDWI ─────────────────────────────────────────────────
        nan3 = (float('nan'), float('nan'), float('nan'))
        nbr_now,  bsi_now,  ndwi_now  = compute_nbr_bsi_ndwi(results.pop("s2b_now",  None) or b'') if "s2b_now"  in results else nan3
        nbr_base, bsi_base, ndwi_base = compute_nbr_bsi_ndwi(results.pop("s2b_base", None) or b'') if "s2b_base" in results else nan3

        def dn(a, b): return a - b if not (math.isnan(a) or math.isnan(b)) else float('nan')
        nbr_delta = dn(nbr_now, nbr_base); bsi_delta = dn(bsi_now, bsi_base)

        # ── SAR ───────────────────────────────────────────────────────────────
        vh_now = vh_base = float('nan')
        sar_available = False
        try:
            if "s1_now" in results and "s1_base" in results:
                vh_now,  _ = compute_sar_stats(results.pop("s1_now"))
                vh_base, _ = compute_sar_stats(results.pop("s1_base"))
                sar_available = not (math.isnan(vh_now) or math.isnan(vh_base))
        except Exception as exc:
            results.pop("s1_now",  None)
            results.pop("s1_base", None)
            app.logger.warning("SAR error: %s", exc)

        sar_delta_nb, sar_label, sar_defor_flag = interpret_sar_change(vh_now, vh_base)

        # ── Change overlay ────────────────────────────────────────────────────
        change_overlay_bytes = None; change_stats = {}
        try:
            cm_now_bytes  = results.pop("cm_now",  results.get("s2a_now"))
            cm_base_bytes = results.pop("cm_base", results.get("s2a_base"))
            change_overlay_bytes, change_stats = build_change_overlay(cm_now_bytes, cm_base_bytes)
            del cm_now_bytes, cm_base_bytes
        except Exception as exc: app.logger.warning("Overlay error: %s", exc)

        # ── Stage 1 ───────────────────────────────────────────────────────────
        ve = call_gemma_stage1(
            results["tc_now"], results["tc_base"],
            region, clat, clon, km,
            cur_from, cur_to, base_from, base_to,
        )
        app.logger.info("Stage1: %s", json.dumps(ve, indent=2))

        # ── Severity & confidence ──────────────────────────────────────────────
        severity = compute_severity(
            ndvi_delta, sar_label,
            nbr_delta=nbr_delta, bsi_delta=bsi_delta,
            visual_extraction=ve, change_stats=change_stats,
        )
        conf_score, conf_label = compute_confidence(
            cloud_now, cloud_base, valid_now, valid_base,
            sar_available, abs(ndvi_delta) > 0.02,
            visual_extraction=ve, nbr_avail=not math.isnan(nbr_now),
        )

        # ── Stage 2 ───────────────────────────────────────────────────────────
        prompt = build_stage2_prompt(
            region, clat, clon, km,
            ndvi_now, evi_now, ndvi_base, evi_base,
            scl_now, scl_base, cloud_now, cloud_base,
            valid_now, valid_base,
            nbr_now, bsi_now, ndwi_now, nbr_base, bsi_base, ndwi_base,
            vh_now, vh_base, sar_delta_nb, sar_label,
            severity, conf_label, conf_score,
            cur_from, cur_to, base_from, base_to,
            ve, change_stats,
        )
        report = call_gemma_stage2(prompt, results["tc_now"], results["tc_base"])

        # ── Base64-encode images for response, then free raw bytes ────────────
        cur_image_b64  = base64.b64encode(results.pop("tc_now")).decode()
        base_image_b64 = base64.b64encode(results.pop("tc_base")).decode()
        change_overlay_b64 = base64.b64encode(change_overlay_bytes).decode() if change_overlay_bytes else None
        del change_overlay_bytes
        # All satellite image bytes are now freed; only scalars and b64 strings remain
        results.clear()
        gc.collect()

        def safe(v, d=4): return round(v, d) if not math.isnan(v) else None
        px, _ = optimal_pixel_size(km)
        effective_gsd_m = round((km * 1000) / px)

        return jsonify({
            'success': True,
            'report': report,
            'visual_extraction': ve,
            'cur_image_b64':  cur_image_b64,
            'base_image_b64': base_image_b64,
            'change_overlay_b64': change_overlay_b64,
            'meta': {
                'region': region,
                'sensor': 'Sentinel-2 L2A + Sentinel-1 GRD' if sar_available else 'Sentinel-2 L2A',
                'resolution_m': effective_gsd_m,
                'pipeline': 'two-stage gemma | 2-epoch | 5-index',
                # NDVI
                'ndvi_now': safe(ndvi_now), 'ndvi_base': safe(ndvi_base), 'ndvi_delta': safe(ndvi_delta),
                # EVI
                'evi_now': safe(evi_now), 'evi_base': safe(evi_base),
                # NBR
                'nbr_now': safe(nbr_now), 'nbr_base': safe(nbr_base), 'nbr_delta': safe(nbr_delta),
                # BSI
                'bsi_now': safe(bsi_now), 'bsi_base': safe(bsi_base), 'bsi_delta': safe(bsi_delta),
                # NDWI
                'ndwi_now': safe(ndwi_now), 'ndwi_base': safe(ndwi_base),
                # Cloud
                'cloud_now': round(cloud_now, 1), 'cloud_base': round(cloud_base, 1),
                'valid_now': valid_now, 'valid_base': valid_base,
                'scl_now': scl_now, 'scl_base': scl_base,
                # SAR
                'sar_available': sar_available,
                'sar_vh_now_db': safe(vh_now, 2), 'sar_vh_base_db': safe(vh_base, 2),
                'sar_delta_db': safe(sar_delta_nb, 2),
                'sar_label': sar_label, 'sar_defor_flag': sar_defor_flag,
                # Visual
                'vis_logging_roads':   ve.get("logging_roads_detected", False),
                'vis_burn_scars':      ve.get("burn_scars_detected", False),
                'vis_active_clearing': ve.get("active_clearing_detected", False),
                'vis_canopy_texture':  ve.get("canopy_texture", "unknown"),
                'vis_confidence':      ve.get("overall_confidence", 0),
                'vis_stage1_ok':       ve.get("_stage1_success", False),
                'vis_biome':           ve.get("biome_classification", "unknown"),
                'vis_is_forest':       ve.get("is_forest_scene", True),
                'vis_seasonal_likely': ve.get("seasonal_change_likely", False),
                'vis_trajectory':      ve.get("temporal_trajectory", "not_determinable"),
                # Risk
                'severity': severity, 'confidence_score': conf_score, 'confidence_label': conf_label,
                # Window
                'window_km': km,
                'cur_date': cur_to, 'base_date': base_to,
                'cur_window': f"{cur_from} → {cur_to}",
                'base_window': f"{base_from} → {base_to}",
                'center': [round(clat, 4), round(clon, 4)],
                'bbox': {'north': round(north,3), 'south': round(south,3), 'east': round(east,3), 'west': round(west,3)},
                # Spatial change stats
                'change_loss_pct':          change_stats.get('loss_pct')          if change_stats else None,
                'change_severe_loss_pct':   change_stats.get('severe_loss_pct')   if change_stats else None,
                'change_gain_pct':          change_stats.get('gain_pct')          if change_stats else None,
                'change_stable_pct':        change_stats.get('stable_pct')        if change_stats else None,
                'change_max_cell_loss_pct': change_stats.get('max_cell_loss_pct') if change_stats else None,
                'change_concentration':     change_stats.get('concentration_ratio') if change_stats else None,
            },
        })
    except Exception as e:
        app.logger.exception("analyse-point unhandled error")
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run()
