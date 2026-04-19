# CANOPY — Forest Intelligence

Deforestation early-warning system powered by Gemma 4.

CANOPY is a two-stage multimodal pipeline that detects, classifies, and reports forest loss across any location on Earth. It combines satellite-derived spectral indices, synthetic aperture radar, and Gemma 4 vision to produce structured scientific reports — discriminating between permanent structural deforestation and seasonal phenological variation, a distinction that simpler systems consistently fail to make.

Built for the Gemma 4 Hackathon.

---
---

## What it does

Click any location on a live satellite basemap. CANOPY places a configurable analysis window and runs a full pipeline in parallel:

1. Fetches Sentinel-2 L2A truecolor and multi-band imagery for two same-season epochs separated by approximately two years
2. Computes five spectral indices per epoch at pixel level, cloud-masked using the SCL band
3. Builds a per-pixel NDVI delta overlay with 3x3 spatial hotspot analysis
4. Fetches Sentinel-1 SAR GRD VH backscatter for both epochs
5. Sends both truecolor images to Gemma 4 Stage 1 for biome-aware visual extraction
6. Sends both truecolor images plus all spectral and spatial data to Gemma 4 Stage 2 for synthesis
7. Combines spectral, spatial, SAR, and visual signals into a severity tier and confidence score
8. Renders a structured report in a sidebar drawer and generates a full printable HTML report

---

## Quick start

```bash
git clone <repo>
cd canopy
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and add your keys
flask run --port 5000
```

Open `http://localhost:5000`, click a forested area, press Analyse.

---

## Environment variables

```
GEMINI_API_KEY=<Google AI Studio key with Gemma 4 access>
SH_CLIENT_ID=<Sentinel Hub OAuth2 client ID>
SH_CLIENT_SECRET=<Sentinel Hub OAuth2 client secret>
```

Create a `.env` file in the project root. The app loads it automatically via python-dotenv.

---

## Analysis window sizes

| Window | Output pixels | Effective GSD |
|---|---|---|
| 10 km | 512 x 512 | ~20 m |
| 20 km | 1000 x 1000 | ~20 m |
| 50 km | 1024 x 1024 | ~49 m |
| 100 km | 1024 x 1024 | ~98 m |

Output resolution scales with window size to maintain approximately 20 m GSD, capped at 1024 pixels to stay within Sentinel Hub processing limits. The report header displays the actual effective GSD for the selected window.

---

## Project structure

```
canopy/
  app.py              Flask backend — pipeline, Sentinel Hub integration, Gemma 4 calls
  static/
    app.js            Map UI, drawer renderer, full report generator
    styles.css        Dark-theme design tokens and component styles
  templates/
    index.html        Single-page application shell
  requirements.txt
  README.md
  DOCUMENTATION.md
```

---

## License

MIT
