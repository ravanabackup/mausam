import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "ol/ol.css";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import "highcharts/highcharts-more";
import "highcharts/modules/windbarb";
import "highcharts/modules/exporting";
import "highcharts/modules/export-data";
import "highcharts/modules/accessibility";
import Map from "ol/Map";
import View from "ol/View";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import XYZ from "ol/source/XYZ";
import TileWMS from "ol/source/TileWMS";
import VectorSource from "ol/source/Vector";
import { fromLonLat, toLonLat } from "ol/proj";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import { defaults as defaultControls, ScaleLine } from "ol/control";

type ForecastType = "1hr" | "3hr" | "6hr";

interface ForecastResponse {
  apcp: number[];
  temp: number[];
  rh: number[];
  tcdc: number[];
  wspd: number[];
  wdir: number[];
  content_color?: string;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

interface PincodeOption {
  label: string;
  pincode: string;
  lat: number;
  lon: number;
}

const FORECAST_META: Record<ForecastType, { fileUrl: string; stepHours: number }> = {
  "1hr": { fileUrl: "https://mausamgram.imd.gov.in/mmem_1hr.txt", stepHours: 1 },
  "3hr": { fileUrl: "https://mausamgram.imd.gov.in/mmem_3hr.txt", stepHours: 3 },
  "6hr": { fileUrl: "https://mausamgram.imd.gov.in/mmem_6hr.txt", stepHours: 6 },
};

const WARNING_THEME: Record<string, string> = {
  "1": "bg-red-100 text-red-700",
  "2": "bg-orange-100 text-orange-700",
  "3": "bg-yellow-100 text-yellow-700",
  "4": "bg-green-100 text-green-700",
  "5": "bg-purple-100 text-purple-700",
};

const INDIA_CENTER = fromLonLat([78.9629, 22.5937]);

function snapToGrid(lat: number, lon: number) {
  return {
    lat: (Math.floor(lat / 0.125) * 0.125).toFixed(3),
    lon: (Math.floor(lon / 0.125) * 0.125).toFixed(3),
  };
}

function parseLatestUtc(raw: string) {
  const compact = raw.trim();
  const tenDigits = compact.match(/(\d{10})/);
  if (tenDigits?.[1]) return tenDigits[1];
  const eightDigits = compact.match(/(\d{8})/);
  if (eightDigits?.[1]) return `${eightDigits[1]}00`;
  return "";
}

function toUtcDate(utcStamp: string) {
  if (!/^\d{10}$/.test(utcStamp)) return new Date();
  const year = Number(utcStamp.slice(0, 4));
  const month = Number(utcStamp.slice(4, 6)) - 1;
  const day = Number(utcStamp.slice(6, 8));
  const hour = Number(utcStamp.slice(8, 10));
  return new Date(Date.UTC(year, month, day, hour, 0, 0));
}

export default function App() {
  const baseUrl = import.meta.env.BASE_URL;
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markerSourceRef = useRef(new VectorSource());
  const pakistanBoundarySourceRef = useRef(new VectorSource());
  const baseLayerRef = useRef<{ arcgis: TileLayer<XYZ>; osm: TileLayer<XYZ> } | null>(null);
  const overlayLayerRef = useRef<{ state: TileLayer<TileWMS>; cyclone: TileLayer<TileWMS> } | null>(null);

  const [forecastType, setForecastType] = useState<ForecastType>("3hr");
  const [searchTerm, setSearchTerm] = useState("New Delhi");
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([]);
  const [activeBase, setActiveBase] = useState<"arcgis" | "osm">("arcgis");
  const [stateBoundaryVisible, setStateBoundaryVisible] = useState(true);
  const [cycloneVisible, setCycloneVisible] = useState(true);
  const [pincodeOptions, setPincodeOptions] = useState<PincodeOption[]>([]);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [latestUtc, setLatestUtc] = useState("");
  const [snappedLat, setSnappedLat] = useState("");
  const [snappedLon, setSnappedLon] = useState("");
  const [forecastData, setForecastData] = useState<ForecastResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isForecastLoading, setIsForecastLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const updateMarker = useCallback((lon: number, lat: number) => {
    markerSourceRef.current.clear();
    markerSourceRef.current.addFeature(
      new Feature({
        geometry: new Point(fromLonLat([lon, lat])),
      }),
    );
  }, []);

  const isInsidePakistan = useCallback((coordinate: number[]) => {
    return pakistanBoundarySourceRef.current
      .getFeatures()
      .some((feature) => feature.getGeometry()?.intersectsCoordinate(coordinate));
  }, []);

  const reverseGeocode = useCallback(async (lat: number, lon: number) => {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) return;
      const json = (await response.json()) as { display_name?: string };
      if (json.display_name) setSelectedAddress(json.display_name);
    } catch {
      setSelectedAddress(`Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`);
    }
  }, []);

  const fetchForecast = useCallback(
    async (lat: number, lon: number) => {
      const snapped = snapToGrid(lat, lon);
      setSnappedLat(snapped.lat);
      setSnappedLon(snapped.lon);
      setErrorMessage("");
      setIsForecastLoading(true);

      try {
        const latestRes = await fetch(FORECAST_META[forecastType].fileUrl);
        if (!latestRes.ok) throw new Error("Unable to fetch latest forecast cycle.");
        const latestText = await latestRes.text();
        const utcCycle = parseLatestUtc(latestText);
        if (!utcCycle) throw new Error("Latest cycle format was not recognized.");

        const sendDate = `${utcCycle}_${forecastType}_0p125`;
        setLatestUtc(utcCycle);

        const dataUrl = `https://mausamgram.imd.gov.in/test4_mme.php?lat_gfs=${snapped.lat}&lon_gfs=${snapped.lon}&date=${sendDate}`;
        const dataRes = await fetch(dataUrl);
        if (!dataRes.ok) throw new Error("Forecast API failed.");

        const json = (await dataRes.json()) as ForecastResponse;
        setForecastData(json);
      } catch (error) {
        setForecastData(null);
        setErrorMessage(error instanceof Error ? error.message : "Unexpected error while fetching forecast.");
      } finally {
        setIsForecastLoading(false);
      }
    },
    [forecastType],
  );

  const moveToLocation = useCallback(
    (lon: number, lat: number) => {
      if (!mapRef.current) return;

      const projected = fromLonLat([lon, lat]);
      mapRef.current.getView().animate({ center: projected, zoom: 8, duration: 900 });
      updateMarker(lon, lat);
      reverseGeocode(lat, lon);

      if (isInsidePakistan(projected)) {
        setErrorMessage("Selected point is inside Pakistan boundary and is blocked for this tool.");
        setForecastData(null);
        return;
      }

      fetchForecast(lat, lon);
    },
    [fetchForecast, isInsidePakistan, reverseGeocode, updateMarker],
  );

  useEffect(() => {
    const markerLayer = new VectorLayer({
      source: markerSourceRef.current,
      style: new Style({
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: "#f97316" }),
          stroke: new Stroke({ color: "#ffffff", width: 2 }),
        }),
      }),
      zIndex: 20,
    });

    const indiaBoundaryLayer = new VectorLayer({
      source: new VectorSource(),
      style: new Style({
        stroke: new Stroke({ color: "#0ea5e9", width: 1.2 }),
        fill: new Fill({ color: "rgba(14,165,233,0.06)" }),
      }),
      zIndex: 10,
    });

    const pakistanBoundaryLayer = new VectorLayer({
      source: pakistanBoundarySourceRef.current,
      style: new Style({
        stroke: new Stroke({ color: "#ef4444", width: 1.6 }),
        fill: new Fill({ color: "rgba(239,68,68,0.10)" }),
      }),
      zIndex: 9,
    });

    const arcgisBase = new TileLayer({
      source: new XYZ({
        url: "https://services.arcgisonline.com/arcgis/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
        crossOrigin: "anonymous",
      }),
      visible: true,
      zIndex: 0,
    });

    const osmBase = new TileLayer({
      source: new XYZ({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
      }),
      visible: false,
      zIndex: 0,
    });

    const stateBoundaryWms = new TileLayer({
      source: new TileWMS({
        url: "https://webgis.imd.gov.in/geoserver/IMD_Data/wms",
        params: { LAYERS: "IMD_Data:Admin2", TILED: true },
        crossOrigin: "anonymous",
      }),
      opacity: 0.7,
      visible: true,
      zIndex: 11,
    });

    const cycloneWms = new TileLayer({
      source: new TileWMS({
        url: "https://geoserver3.imd.gov.in/geoserver/static/wms",
        params: { LAYERS: "static:cou", TILED: true },
        crossOrigin: "anonymous",
      }),
      opacity: 0.6,
      visible: true,
      zIndex: 12,
    });

    const map = new Map({
      target: mapHostRef.current ?? undefined,
      layers: [arcgisBase, osmBase, pakistanBoundaryLayer, indiaBoundaryLayer, stateBoundaryWms, cycloneWms, markerLayer],
      controls: defaultControls().extend([new ScaleLine()]),
      view: new View({
        center: INDIA_CENTER,
        zoom: 4.8,
        minZoom: 4,
        maxZoom: 13,
      }),
    });

    mapRef.current = map;
    baseLayerRef.current = { arcgis: arcgisBase, osm: osmBase };
    overlayLayerRef.current = { state: stateBoundaryWms, cyclone: cycloneWms };

    map.on("singleclick", (evt) => {
      const [lon, lat] = toLonLat(evt.coordinate);
      moveToLocation(lon, lat);
    });

    const loadBoundary = async (path: string, source: VectorSource) => {
      try {
        const response = await fetch(path);
        if (!response.ok) return;
        const data = await response.json();
        const features = new GeoJSON().readFeatures(data, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        });
        source.addFeatures(features);
      } catch {
        // Optional local boundary files are ignored when absent.
      }
    };

    loadBoundary(`${baseUrl}geoBoundaries-PAK-ADM0_simplified.geojson`, pakistanBoundarySourceRef.current);
    loadBoundary(`${baseUrl}geoBoundaries-IND-ADM1_simplified.geojson`, indiaBoundaryLayer.getSource() as VectorSource);

    moveToLocation(77.209, 28.6139);

    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, [baseUrl, moveToLocation]);

  useEffect(() => {
    if (!baseLayerRef.current) return;
    baseLayerRef.current.arcgis.setVisible(activeBase === "arcgis");
    baseLayerRef.current.osm.setVisible(activeBase === "osm");
  }, [activeBase]);

  useEffect(() => {
    if (!overlayLayerRef.current) return;
    overlayLayerRef.current.state.setVisible(stateBoundaryVisible);
    overlayLayerRef.current.cyclone.setVisible(cycloneVisible);
  }, [cycloneVisible, stateBoundaryVisible]);

  useEffect(() => {
    const fetchPincodes = async () => {
      try {
        const response = await fetch("https://mausamgram.imd.gov.in/pincode.php");
        if (!response.ok) return;

        const text = await response.text();
        const parsed = JSON.parse(text) as Record<string, unknown>[];
        if (!Array.isArray(parsed)) return;

        const options: PincodeOption[] = parsed
          .map((item) => {
            const pincode = String(item.pincode ?? item.Pincode ?? "").trim();
            const lat = Number(item.lat ?? item.latitude);
            const lon = Number(item.lon ?? item.longitude);
            const district = String(item.district ?? item.city ?? "").trim();
            if (!pincode || Number.isNaN(lat) || Number.isNaN(lon)) return null;
            return {
              pincode,
              lat,
              lon,
              label: district ? `${pincode} - ${district}` : pincode,
            };
          })
          .filter((option): option is PincodeOption => Boolean(option))
          .slice(0, 700);

        setPincodeOptions(options);
      } catch {
        // Pincode dropdown remains optional.
      }
    };

    fetchPincodes();
  }, []);

  const runSearch = async () => {
    if (!searchTerm.trim()) return;
    setIsSearching(true);
    setErrorMessage("");
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchTerm)}&countrycodes=IN&format=json&limit=5`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) throw new Error("Search failed.");
      const json = (await response.json()) as NominatimResult[];
      setSearchResults(json);
    } catch (error) {
      setSearchResults([]);
      setErrorMessage(error instanceof Error ? error.message : "Search failed unexpectedly.");
    } finally {
      setIsSearching(false);
    }
  };

  const chartOptions = useMemo<Highcharts.Options>(() => {
    if (!forecastData) return {};

    const seriesLength = Math.max(forecastData.temp.length, forecastData.apcp.length);
    const startDate = toUtcDate(latestUtc);
    const categories = Array.from({ length: seriesLength }, (_, index) => {
      const pointDate = new Date(startDate.getTime() + index * FORECAST_META[forecastType].stepHours * 3600 * 1000);
      return pointDate.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      });
    });

    return {
      chart: {
        zooming: { type: "x" },
        backgroundColor: "transparent",
        animation: true,
      },
      title: { text: "IMD Meteogram" },
      subtitle: {
        text: `Grid: ${snappedLat}, ${snappedLon} | Forecast: ${forecastType}`,
      },
      xAxis: {
        categories,
        crosshair: true,
      },
      yAxis: [
        {
          title: { text: "Temp (C) / Wind" },
          opposite: false,
        },
        {
          title: { text: "Rainfall (mm)" },
          opposite: true,
          min: 0,
        },
        {
          title: { text: "Humidity (%) / Cloud (%)" },
          opposite: true,
          max: 100,
          min: 0,
        },
      ],
      tooltip: {
        shared: true,
        valueDecimals: 2,
      },
      legend: {
        enabled: true,
      },
      series: [
        {
          type: "line",
          name: "Temperature",
          data: forecastData.temp,
          color: "#ef4444",
          yAxis: 0,
        },
        {
          type: "line",
          id: "wind-speed",
          name: "Wind speed",
          data: forecastData.wspd,
          color: "#1d4ed8",
          yAxis: 0,
        },
        {
          type: "column",
          name: "Rainfall",
          data: forecastData.apcp,
          color: "#0ea5e9",
          yAxis: 1,
        },
        {
          type: "spline",
          name: "Humidity",
          data: forecastData.rh,
          color: "#16a34a",
          yAxis: 2,
        },
        {
          type: "area",
          name: "Cloud cover",
          data: forecastData.tcdc,
          color: "rgba(100,116,139,0.5)",
          yAxis: 2,
        },
        {
          type: "windbarb",
          name: "Wind direction",
          data: forecastData.wdir.map((direction, index) => [index, forecastData.wspd[index] ?? 0, direction]),
          yAxis: 0,
          color: "#0f172a",
        } as Highcharts.SeriesOptionsType,
      ],
      credits: { enabled: false },
    };
  }, [forecastData, forecastType, latestUtc, snappedLat, snappedLon]);

  const warningColor = forecastData?.content_color ? WARNING_THEME[forecastData.content_color] : "";

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(14,165,233,0.22), transparent 42%), radial-gradient(circle at 80% 8%, rgba(16,185,129,0.17), transparent 42%)",
        }}
      />

      <section className="relative grid min-h-screen grid-rows-[auto_1fr]">
        <header className="animate-fade-in border-b border-white/10 bg-slate-950/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img
                src="https://mausamgram.imd.gov.in/150_Logo_W.jpg"
                alt="IMD"
                className="h-11 w-11 rounded-full border border-white/20 object-cover"
              />
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-sky-300">India Meteorological Department</p>
                <h1 className="text-xl font-semibold text-white md:text-2xl">Mausamgram Forecast Map</h1>
              </div>
            </div>
            <p className="text-xs text-slate-300 md:text-sm">Click map or search place to load IMD grid forecast</p>
          </div>
        </header>

        <div className="grid min-h-0 md:grid-cols-[1fr_420px]">
          <div className="relative min-h-[48vh] md:min-h-0">
            <div ref={mapHostRef} className="map-shell h-full w-full animate-zoom-in" />
            <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-md border border-white/25 bg-slate-900/80 p-2 text-xs backdrop-blur">
              <button
                type="button"
                className={`rounded px-2 py-1 transition ${activeBase === "arcgis" ? "bg-sky-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                onClick={() => setActiveBase("arcgis")}
              >
                ArcGIS Base
              </button>
              <button
                type="button"
                className={`rounded px-2 py-1 transition ${activeBase === "osm" ? "bg-sky-500 text-white" : "bg-white/10 hover:bg-white/20"}`}
                onClick={() => setActiveBase("osm")}
              >
                OSM Base
              </button>
              <label className="ml-2 inline-flex items-center gap-1">
                <input type="checkbox" checked={stateBoundaryVisible} onChange={(e) => setStateBoundaryVisible(e.target.checked)} />
                State WMS
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={cycloneVisible} onChange={(e) => setCycloneVisible(e.target.checked)} />
                Cyclone WMS
              </label>
            </div>
          </div>

          <aside className="animate-slide-up space-y-4 overflow-y-auto border-l border-white/10 bg-slate-950/88 p-4 md:p-5">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-slate-300">Location Search (Nominatim India)</label>
              <div className="flex gap-2">
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="City, district, place"
                  className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={runSearch}
                  className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
                >
                  {isSearching ? "..." : "Search"}
                </button>
              </div>
              {searchResults.length > 0 && (
                <div className="max-h-28 space-y-1 overflow-auto rounded border border-white/10 bg-white/5 p-1 text-sm">
                  {searchResults.map((item) => (
                    <button
                      key={item.place_id}
                      type="button"
                      className="block w-full rounded px-2 py-1 text-left transition hover:bg-white/10"
                      onClick={() => moveToLocation(Number(item.lon), Number(item.lat))}
                    >
                      {item.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {pincodeOptions.length > 0 && (
              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide text-slate-300">Pincode Quick Select</label>
                <select
                  className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-sm"
                  onChange={(e) => {
                    const selected = pincodeOptions.find((option) => option.pincode === e.target.value);
                    if (selected) moveToLocation(selected.lon, selected.lat);
                  }}
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select pincode
                  </option>
                  {pincodeOptions.map((option) => (
                    <option key={option.pincode} value={option.pincode}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-slate-300">Forecast Interval</label>
              <div className="flex gap-2">
                {(["1hr", "3hr", "6hr"] as ForecastType[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setForecastType(option);
                      if (snappedLat && snappedLon) fetchForecast(Number(snappedLat), Number(snappedLon));
                    }}
                    className={`rounded px-3 py-1.5 text-sm transition ${
                      forecastType === option ? "bg-emerald-500 text-white" : "bg-white/10 hover:bg-white/20"
                    }`}
                  >
                    {option.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1 text-sm text-slate-200">
              <p>
                <span className="text-slate-400">Address:</span> {selectedAddress || "-"}
              </p>
              <p>
                <span className="text-slate-400">Snapped Grid:</span> {snappedLat || "-"}, {snappedLon || "-"}
              </p>
              <p>
                <span className="text-slate-400">Latest UTC:</span> {latestUtc || "-"}
              </p>
              {warningColor && (
                <p>
                  <span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${warningColor}`}>
                    Warning Level {forecastData?.content_color}
                  </span>
                </p>
              )}
            </div>

            {errorMessage && <p className="rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{errorMessage}</p>}

            <div className="min-h-72 rounded border border-white/10 bg-white/[0.03] p-2">
              {isForecastLoading && (
                <div className="flex h-72 items-center justify-center text-sm text-slate-300">
                  <span className="loading-dot mr-2 h-2 w-2 rounded-full bg-sky-400" />
                  Loading forecast chart...
                </div>
              )}
              {!isForecastLoading && forecastData && <HighchartsReact highcharts={Highcharts} options={chartOptions} />}
              {!isForecastLoading && !forecastData && !errorMessage && (
                <p className="p-4 text-sm text-slate-300">Select any map point to render forecast meteogram.</p>
              )}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
