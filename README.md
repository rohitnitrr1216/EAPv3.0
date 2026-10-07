# Dam Inundation Finder – village update

Repository layout (add the new parts to your existing repo):

    index.html                      <- updated tool (replace the old one)
    data/State_Boundary.geojson     <- already in your repo
    data/District_Boundary.geojson  <- already in your repo
    data/villages/index.json        <- NEW  (from village_data_for_github.zip)
    data/villages/as.json ... wb.json  <- NEW (one file per State, 0.1 - 19 MB each, ~55 MB total)

Unzip `village_data_for_github.zip` in the repo root so the `data/villages` folder is created, commit, and enable GitHub Pages.

The original village GeoJSONs (~900 MB, EPSG:7755) are too large for GitHub (100 MB per file limit) and for a browser,
so `prepare_villages.js` converts them to compact WGS84 files (boundaries simplified to ~12 m, only the needed attributes).
To regenerate: `node prepare_villages.js <folder with vb_soi_*.GeoJSON> data/villages`.
