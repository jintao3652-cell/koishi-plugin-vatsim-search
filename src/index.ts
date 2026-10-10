import { Context, Schema, h, Time } from 'koishi'
import axios from 'axios'
import type {} from '@shangxueink/koishi-plugin-puppeteer-without-canvas'

// ===================== 类型定义 =====================

interface VatsimGeneral {
  general: {
    version: number
    reload: number
    update: string
    update_timestamp: string
    connected_clients: number
    unique_users: number
  }
  pilots: VatsimPilotShort[]
}

interface VatsimPilotShort {
  cid: number
  name: string
  callsign: string
  pilot_rating: number
  military_rating: number
  latitude: number
  longitude: number
  altitude: number
  groundspeed: number
  transponder: string
  heading: number
  qnh_mb: number
  logon_time: string
  date: number
  deleted: boolean
  frequencies: number[]
  status: string
  toGoDist: number
  depDist: number
  arrival: string
  aircraft_short: string
  aircraft_faa: string
  departure: string
  flight_rules: string
  last_updated?: string
  server?: string
  flight_plan?: {
    flight_rules: string
    aircraft: string
    aircraft_faa: string
    aircraft_short: string
    departure: string
    arrival: string
    alternate: string
    cruise_tas: string
    altitude: string
    deptime: string
    enroute_time: string
    fuel_time: string
    remarks: string
    route: string
    revision_id: number
    assigned_transponder: string
  }
}

interface TransceiverData {
  callsign: string
  transceivers: {
    id: number
    frequency: number
    latDeg: number
    lonDeg: number
    heightMslM: number
    heightAglM: number
  }[]
}

interface ClassifiedFrequencies {
  primary: number | null
  secondary: number | null
  all: number[]
}

// ===================== 地图瓦片源 =====================

interface TileProvider {
  name: string
  /** 可含 {token} 占位符（由配置里的 mapboxToken 替换） */
  url: string
  attribution: string
  subdomains?: string
  /** 512px 矢量切片栅格化瓦片（Mapbox），需 tileSize=512 / zoomOffset=-1 */
  bigTiles?: boolean
  dark: boolean
}

const TILE_PROVIDERS: Record<string, TileProvider> = {
  'mapbox-dark': {
    name: 'Mapbox 暗色',
    url: 'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}@2x?access_token={token}',
    attribution: '&copy; Mapbox &copy; OpenStreetMap',
    bigTiles: true,
    dark: true,
  },
  'mapbox-light': {
    name: 'Mapbox 亮色',
    url: 'https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}@2x?access_token={token}',
    attribution: '&copy; Mapbox &copy; OpenStreetMap',
    bigTiles: true,
    dark: false,
  },
  'mapbox-streets': {
    name: 'Mapbox 街道',
    url: 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}@2x?access_token={token}',
    attribution: '&copy; Mapbox &copy; OpenStreetMap',
    bigTiles: true,
    dark: false,
  },
  'mapbox-satellite': {
    name: 'Mapbox 卫星',
    url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}@2x?access_token={token}',
    attribution: '&copy; Mapbox &copy; OpenStreetMap',
    bigTiles: true,
    dark: true,
  },
  'mapbox-night': {
    name: 'Mapbox 导航夜色',
    url: 'https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/tiles/{z}/{x}/{y}@2x?access_token={token}',
    attribution: '&copy; Mapbox &copy; OpenStreetMap',
    bigTiles: true,
    dark: true,
  },
  'esri-darkgray': {
    name: 'Esri 暗色底图',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, HERE, Garmin',
    dark: true,
  },
  'osm': {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    dark: false,
  },
  'esri-satellite': {
    name: 'Esri 卫星影像',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, Maxar, Earthstar Geographics',
    dark: true,
  },
  'esri-topo': {
    name: 'Esri 地形图',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri',
    dark: false,
  },
}

// 默认瓦片源：配置了 Mapbox token 就优先用 Mapbox 暗色，否则用 Esri
const DEFAULT_PROVIDER = 'mapbox-dark'

// ===================== 周围机组计算 =====================

/** 两点间大圆距离（海里） */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065 // 地球半径，海里
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

interface NearbyPilot {
  pilot: VatsimPilotShort
  distNm: number
}

/** 在全体飞行员中筛选目标周围 radiusNm 海里以内的机组，按距离升序排列 */
function collectNearbyPilots(all: VatsimPilotShort[], target: VatsimPilotShort, radiusNm: number): NearbyPilot[] {
  const list: NearbyPilot[] = []
  for (const p of all) {
    if (p.cid === target.cid || p.deleted) continue
    const d = haversineNm(target.latitude, target.longitude, p.latitude, p.longitude)
    if (d <= radiusNm) list.push({ pilot: p, distNm: d })
  }
  list.sort((a, b) => a.distNm - b.distNm)
  return list
}

/**
 * 依据周围机组密度计算地图缩放等级：
 * 取周围机组距离的高分位（约覆盖 85% 的机组）作为可视半径——
 * 机组密集时该半径小 → zoom 大（看得清细节）；机组稀少时半径大 → zoom 小（看更大范围）。
 */
function calcAutoZoom(lat: number, radiusNm: number, width: number, height: number, minZoom: number, maxZoom: number): number {
  // 可视范围稍留边距（×2.2），保证标签不被裁掉
  const spanMeters = Math.max(25, radiusNm) * 1852 * 2.2
  const px = Math.min(width, height)
  const metersPerPxNeeded = spanMeters / px
  // Web Mercator：赤道处每像素米数 = 156543.03392 / 2^zoom，按纬度修正
  const zoom = Math.log2((156543.03392 * Math.cos(lat * Math.PI / 180)) / metersPerPxNeeded)
  const snapped = Math.round(zoom * 4) / 4 // 0.25 步进
  return Math.min(maxZoom, Math.max(minZoom, snapped))
}

// ===================== 配置 =====================

export interface Config {
  interval: number
  log: boolean
  maxRetries: number
  retryDelay: number
  timeout: number
  dataCacheTTL: number
  enableMap: boolean
  mapProvider: string
  mapboxToken: string
  mapZoom: number
  mapWidth: number
  mapHeight: number
  mapScale: number
  mapTimeout: number
  showNearby: boolean
  nearRadiusNm: number
  nearbyMaxMarkers: number
  autoZoom: boolean
  autoZoomMin: number
  autoZoomMax: number
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number().default(5 * Time.second).description('指令调用间隔(毫秒)'),
  log: Schema.boolean().default(false).description('是否输出日志'),
  maxRetries: Schema.number().default(3).description('API最大重试次数'),
  retryDelay: Schema.number().default(1000).description('重试延迟(毫秒)'),
  timeout: Schema.number().default(30000).description('API超时时间(毫秒)'),
  dataCacheTTL: Schema.number().default(20).min(0).max(120).description('VATSIM 数据缓存时长（秒），0 为不缓存'),
  enableMap: Schema.boolean().default(true).description('查询结果附带本地绘制的位置图'),
  mapProvider: Schema.union(Object.keys(TILE_PROVIDERS).map(k =>
    Schema.const(k).description(TILE_PROVIDERS[k].name)
  )).default('mapbox-dark').description('地图瓦片源（本地绘制，不依赖 VATSIM RADAR；Mapbox 系需在下方填 token）'),
  mapboxToken: Schema.string().role('secret').default('')
    .description('Mapbox access token（pk.xxx 开头）。使用 mapbox-* 瓦片源时必填，未填则自动回退 Esri 暗色'),
  mapZoom: Schema.number().default(6).min(2).max(12).description('地图缩放级别'),
  mapWidth: Schema.number().default(900).min(400).max(2000).description('地图宽度（像素）'),
  mapHeight: Schema.number().default(620).min(300).max(1600).description('地图高度（像素）'),
  mapScale: Schema.number().default(2).min(1).max(3).description('地图渲染倍率（2 更清晰）'),
  mapTimeout: Schema.number().default(15000).description('地图渲染超时（毫秒）'),
  showNearby: Schema.boolean().default(true).description('在地图上显示目标机组周围的其他在线机组（附呼号标签）'),
  nearRadiusNm: Schema.number().default(300).min(50).max(1000).description('周围机组搜索半径（海里）'),
  nearbyMaxMarkers: Schema.number().default(40).min(1).max(120).description('周围机组标记数量上限（按距离取最近的）'),
  autoZoom: Schema.boolean().default(true).description('根据周围机组密度自动调整缩放：密集放大、稀少缩小（关闭则使用固定 mapZoom）'),
  autoZoomMin: Schema.number().default(3).min(1).max(8).description('自动缩放下限（机组稀少时的最小 zoom）'),
  autoZoomMax: Schema.number().default(10).min(6).max(14).description('自动缩放上限（机组密集时的最大 zoom）'),
})

export const name = 'vatsim'
export const inject = ['puppeteer']

// ===================== 地图绘制服务 =====================

class MapRenderer {
  constructor(private ctx: Context, private config: Config) {}

  /**
   * 本地绘制飞行员位置图（Leaflet + Mapbox/第三方瓦片源）。
   * nearby: 目标周围的其他在线机组（按距离升序），会在图上以小圆点 + 呼号标签标注；
   * zoomRadiusNm: 自动缩放所依据的可视半径（海里），不传则用配置的搜索半径。
   * 返回 PNG Buffer；失败抛出异常，由调用方决定是否降级为纯文字。
   */
  async renderPilotMap(pilot: VatsimPilotShort, nearby: NearbyPilot[] = [], zoomRadiusNm?: number): Promise<Buffer> {
    let provider = TILE_PROVIDERS[this.config.mapProvider] || TILE_PROVIDERS[DEFAULT_PROVIDER]
    const token = (this.config.mapboxToken || '').trim()

    // Mapbox 系瓦片源需要 token，未配置时回退 Esri
    if (provider.url.includes('{token}') && !token) {
      this.ctx.logger.warn('[VATSIM] 当前瓦片源 %s 需要 Mapbox token，但未配置 mapboxToken，回退为 Esri 暗色', this.config.mapProvider)
      provider = TILE_PROVIDERS['esri-darkgray']
    }

    const tileUrl = provider.url.replace('{token}', encodeURIComponent(token))
    const { latitude: lat, longitude: lon, heading, callsign } = pilot
    const dark = provider.dark

    // ---- 缩放等级：按周围机组密度自动调整，密集放大、稀少缩小 ----
    const useAutoZoom = this.config.autoZoom && nearby.length > 0
    const zoom = useAutoZoom
      ? calcAutoZoom(
          lat,
          zoomRadiusNm ?? this.config.nearRadiusNm,
          this.config.mapWidth, this.config.mapHeight,
          this.config.autoZoomMin, this.config.autoZoomMax,
        )
      : this.config.mapZoom

    // 航向矢量终点（约 150 海里外的投影点，用于画航向线）
    const nmAhead = 150
    const rad = (heading || 0) * Math.PI / 180
    const dLat = nmAhead / 60 * Math.cos(rad)
    const dLon = nmAhead / 60 * Math.sin(rad) / Math.max(0.2, Math.cos(lat * Math.PI / 180))
    const hdgLat = lat + dLat
    const hdgLon = lon + dLon

    const accent = dark ? '#4fc3f7' : '#0277bd'
    const nearbyColor = '#ff9d2e'
    const panelBg = dark ? 'rgba(20, 24, 31, 0.88)' : 'rgba(255, 255, 255, 0.92)'
    const panelText = dark ? '#e8eaed' : '#1a1c1e'
    const subText = dark ? '#9aa0a6' : '#5f6368'
    const labelBg = dark ? 'rgba(20, 24, 31, 0.82)' : 'rgba(255, 255, 255, 0.88)'
    const labelText = dark ? '#ffd9a8' : '#8a4b00'

    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const fp = pilot.flight_plan
    const routeInfo = fp
      ? `${escapeHtml(fp.departure || '----')} → ${escapeHtml(fp.arrival || '----')}`
      : '无飞行计划'

    const nearbyInfo = nearby.length > 0
      ? `周围 ${nearby.length} 架在线机组${useAutoZoom ? ` · 自动缩放 Z${zoom.toFixed(2)}` : ''}`
      : `周围 ${nearby.length} 架在线机组`

    // 周围机组数据注入页面（只取必要字段，防 HTML 注入做转义）
    const nearbyJson = JSON.stringify(nearby.map(n => ({
      lat: n.pilot.latitude,
      lon: n.pilot.longitude,
      cs: escapeHtml(n.pilot.callsign),
      alt: Math.round(n.pilot.altitude),
    }))).replace(/</g, '\\u003c')

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js"></script>
<style>
  html, body { margin: 0; padding: 0; }
  #map { width: ${this.config.mapWidth}px; height: ${this.config.mapHeight}px; background: ${dark ? '#14181f' : '#dfe3e8'}; }
  .info-panel {
    position: absolute; top: 10px; left: 10px; z-index: 1000;
    background: ${panelBg}; color: ${panelText};
    padding: 10px 14px; border-radius: 8px;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.5;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    pointer-events: none;
  }
  .info-panel .callsign { font-size: 19px; font-weight: 700; color: ${accent}; }
  .info-panel .sub { color: ${subText}; font-size: 13px; }
  .plane-icon { transition: none; }
  .near-dot { background: ${nearbyColor}; border: 1.5px solid ${dark ? '#3a2a10' : '#ffffff'}; border-radius: 50%; box-shadow: 0 0 4px rgba(0,0,0,0.4); }
  .callsign-label {
    background: ${labelBg} !important; color: ${labelText} !important;
    border: none !important; box-shadow: 0 1px 3px rgba(0,0,0,0.35) !important;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 11px; font-weight: 600; padding: 1px 5px !important; border-radius: 4px !important;
  }
  .callsign-label::before { display: none; } /* 去掉 tooltip 小箭头 */
  .leaflet-control-attribution { background: ${dark ? 'rgba(20, 24, 31, 0.7)' : 'rgba(255, 255, 255, 0.8)'} !important; color: ${subText} !important; }
  .leaflet-control-attribution a { color: ${subText} !important; }
</style>
</head>
<body>
<div id="map"></div>
<div class="info-panel">
  <div class="callsign">${escapeHtml(callsign)}</div>
  <div>ALT ${Math.round(pilot.altitude)} ft &nbsp;|&nbsp; GS ${Math.round(pilot.groundspeed)} kt &nbsp;|&nbsp; HDG ${Math.round(heading || 0)}°</div>
  <div class="sub">${routeInfo}</div>
  <div class="sub">${nearbyInfo}</div>
</div>
<script>
  window.__mapReady = false
  var nearby = ${nearbyJson}
  var map = L.map('map', {
    center: [${lat}, ${lon}],
    zoom: ${zoom},
    zoomSnap: 0.25,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  })
  var tiles = L.tileLayer('${tileUrl}', {
    attribution: '${provider.attribution}',
    ${provider.subdomains ? `subdomains: '${provider.subdomains}',` : ''}
    ${provider.bigTiles ? 'tileSize: 512, zoomOffset: -1,' : ''}
    maxZoom: 19,
  })
  tiles.addTo(map)
  map.attributionControl.setPrefix('')

  // 航向线
  L.polyline([[${lat}, ${lon}], [${hdgLat.toFixed(5)}, ${hdgLon.toFixed(5)}]], {
    color: '${accent}', weight: 2.5, opacity: 0.85, dashArray: '8 6',
  }).addTo(map)

  // 周围在线机组：小圆点 + 常驻呼号标签
  for (var i = 0; i < nearby.length; i++) {
    (function (p) {
      L.circleMarker([p.lat, p.lon], {
        radius: 4.5, color: '${dark ? '#3a2a10' : '#ffffff'}', weight: 1.5,
        fillColor: '${nearbyColor}', fillOpacity: 0.95, interactive: false,
      }).addTo(map)
      L.tooltip({ permanent: true, direction: 'right', offset: [6, 0], className: 'callsign-label', interactive: false, opacity: 1 })
        .setLatLng([p.lat, p.lon])
        .setContent(p.cs)
        .addTo(map)
    })(nearby[i])
  }

  // 飞机图标（按航向旋转）
  var planeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24">' +
    '<circle cx="12" cy="12" r="11.4" fill="${accent}" fill-opacity="0.18"/>' +
    '<path d="M12 2 L13.6 9.2 L21.5 13.6 L21.5 15.4 L13.6 12.9 L13.1 18.6 L15.6 20.6 L15.6 22 L12 20.8 L8.4 22 L8.4 20.6 L10.9 18.6 L10.4 12.9 L2.5 15.4 L2.5 13.6 L10.4 9.2 Z" fill="${accent}" stroke="${dark ? '#0b2a36' : '#ffffff'}" stroke-width="0.8"/>' +
    '</svg>'
  var icon = L.divIcon({
    className: 'plane-icon',
    html: '<div style="transform: rotate(${Math.round(heading || 0)}deg); width:34px; height:34px;">' + planeSvg + '</div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
  L.marker([${lat}, ${lon}], { icon: icon, interactive: false, zIndexOffset: 1000 }).addTo(map)

  var pending = 0
  tiles.on('tileloadstart', function () { pending++ })
  tiles.on('tileload', function () { pending--; if (pending <= 0) window.__mapReady = true })
  tiles.on('tileerror', function () { pending--; })
  // 兜底：无论瓦片状态如何，超时后强制置 ready，保证总能出图
  setTimeout(function () { window.__mapReady = true }, 8000)
</script>
</body>
</html>`

    const page = await this.ctx.puppeteer.page()
    try {
      await page.setViewport({
        width: this.config.mapWidth,
        height: this.config.mapHeight,
        deviceScaleFactor: this.config.mapScale,
      })
      await page.setContent(html, { waitUntil: 'load', timeout: this.config.mapTimeout })
      // 等待首屏瓦片就绪（带超时兜底，超时也照样截图）
      await page.waitForFunction(() => (window as any).__mapReady === true, { timeout: this.config.mapTimeout })
        .catch(() => { /* 忽略，直接截图 */ })
      const buf = await page.screenshot({ type: 'png', omitBackground: false })
      return Buffer.from(buf as any)
    } finally {
      await page.close().catch(() => {})
    }
  }
}

// ===================== 统计页截图服务 =====================

class ScreenshotService {
  constructor(private ctx: Context) {}

  async takeScreenshot(url: string, waitTime: number = 6000): Promise<Buffer> {
    const page = await this.ctx.puppeteer.page()
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
      await page.evaluate(async () => {
        await document.fonts?.ready
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      await new Promise(resolve => setTimeout(resolve, waitTime))
      const data = await page.screenshot({ type: 'png', fullPage: true })
      return Buffer.from(data as any)
    } finally {
      await page.close().catch(() => {})
    }
  }
}

// ===================== VATSIM 数据服务 =====================

class VatsimService {
  private screenshotService: ScreenshotService
  private transceiversData: TransceiverData[] | null = null
  private lastTransceiversUpdate: number = 0
  private dataCache: { data: VatsimGeneral; ts: number } | null = null

  constructor(private ctx: Context, private config: Config) {
    this.screenshotService = new ScreenshotService(ctx)
  }

  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error = new Error(`${operationName} 执行失败`)
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error: any) {
        lastError = error
        this.ctx.logger.warn(`[VATSIM] ${operationName} - 第 ${attempt} 次尝试失败:`, error.message)
        if (attempt < this.config.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay))
        }
      }
    }
    throw lastError
  }

  private createAxiosInstance() {
    return axios.create({
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    })
  }

  // 获取VATSIM数据（带短缓存，避免连续查询重复拉取全量数据）
  async getVatsimData(): Promise<VatsimGeneral> {
    const ttl = this.config.dataCacheTTL * 1000
    if (ttl > 0 && this.dataCache && Date.now() - this.dataCache.ts < ttl) {
      return this.dataCache.data
    }

    return this.withRetry(async () => {
      const startTime = Date.now()
      const axiosInstance = this.createAxiosInstance()

      // VATSIM Data API（文档: https://vatsim.dev/api/data-api/get-network-data）
      const apiEndpoints = [
        'https://data.vatsim.net/v3/vatsim-data.json',
        'https://api.vatsim.net/api/network-data',
      ]

      let lastError: Error = new Error('所有 VATSIM API 端点均不可用')

      for (const endpoint of apiEndpoints) {
        try {
          const response = await axiosInstance.get(endpoint)
          const data = this.transformVatsimData(response.data)
          if (this.config.log) {
            this.ctx.logger.info(`[VATSIM] 数据获取完成，端点: ${endpoint}，耗时 ${Date.now() - startTime}ms，${data.pilots?.length || 0} 个飞行员`)
          }
          this.dataCache = { data, ts: Date.now() }
          return data
        } catch (error: any) {
          lastError = error
          this.ctx.logger.warn(`[VATSIM] API端点 ${endpoint} 失败:`, error.message)
        }
      }

      throw lastError
    }, '获取VATSIM数据')
  }

  async getTransceiversData(): Promise<TransceiverData[]> {
    const now = Date.now()
    if (this.transceiversData && now - this.lastTransceiversUpdate < 30000) {
      return this.transceiversData
    }

    return this.withRetry(async () => {
      const axiosInstance = this.createAxiosInstance()
      const response = await axiosInstance.get('https://data.vatsim.net/v3/transceivers-data.json')
      const transceiversData: TransceiverData[] = Array.isArray(response.data) ? response.data : []
      this.transceiversData = transceiversData
      this.lastTransceiversUpdate = Date.now()
      return transceiversData
    }, '获取Transceivers数据')
  }

  async getClassifiedFrequenciesByCallsign(callsign: string): Promise<ClassifiedFrequencies> {
    try {
      const transceiversData = await this.getTransceiversData()
      const callsignData = transceiversData.find(item => item.callsign === callsign)

      if (!callsignData || !callsignData.transceivers) {
        return { primary: null, secondary: null, all: [] }
      }

      const frequencies: number[] = []
      for (const transceiver of callsignData.transceivers) {
        const frequencyMHz = transceiver.frequency / 1000000
        const shortFrequency = parseFloat(frequencyMHz.toFixed(3))
        if (!isNaN(shortFrequency) && !frequencies.includes(shortFrequency)) {
          frequencies.push(shortFrequency)
        }
      }

      return {
        primary: frequencies[0] ?? null,
        secondary: frequencies[1] ?? null,
        all: frequencies,
      }
    } catch (error) {
      this.ctx.logger.warn(`[VATSIM] 获取呼号 ${callsign} 的分类频率数据失败:`, error)
      return { primary: null, secondary: null, all: [] }
    }
  }

  private transformVatsimData(data: any): VatsimGeneral {
    return {
      general: {
        version: data.version || 3,
        reload: data.reload || 1,
        update: data.update || new Date().toISOString(),
        update_timestamp: data.update_timestamp || new Date().toISOString(),
        connected_clients: data.connected_clients || 0,
        unique_users: data.unique_users || 0,
      },
      pilots: data.pilots || [],
    }
  }

  async getPilotDetail(cid: number): Promise<VatsimPilotShort> {
    const generalData = await this.getVatsimData()
    const pilot = generalData.pilots.find(p => p.cid === cid)
    if (!pilot) {
      throw new Error(`未找到飞行员 CID: ${cid}`)
    }

    // 合并 Transceivers 频率
    try {
      const classifiedFrequencies = await this.getClassifiedFrequenciesByCallsign(pilot.callsign)
      if (classifiedFrequencies.all.length > 0) {
        pilot.frequencies = classifiedFrequencies.all
      }
    } catch (freqError: any) {
      this.ctx.logger.warn(`[VATSIM] 获取分类频率数据失败 CID: ${cid}:`, freqError.message)
    }

    return pilot
  }

  async getUserStatsScreenshot(vatsimId: string): Promise<Buffer> {
    const url = `https://stats.vatsim.net/stats/${vatsimId}`
    return this.screenshotService.takeScreenshot(url, 6000)
  }
}

// ===================== 插件入口 =====================

export function apply(ctx: Context, config: Config) {
  const lastCallTime = new Map<string, number>()
  const vatsimService = new VatsimService(ctx, config)
  const mapRenderer = new MapRenderer(ctx, config)

  ctx.command('vatsim <query:string>', '查询VATSIM飞行员信息')
    .usage('支持三种查询方式：\n- 呼号: vatsim CPA123\n- CID: vatsim 1234567\n- 姓名: vatsim "John Smith"')
    .example('vatsim CPA123 - 通过呼号查询')
    .example('vatsim 1234567 - 通过CID查询')
    .example('vatsim "John Smith" - 通过姓名查询')
    .option('nomap', '--no-map 不附带位置图')
    .action(async ({ session, options }, query) => {
      if (!query) {
        return '请输入查询内容（呼号、CID或姓名）'
      }
      if (!session) return '当前上下文无法识别用户。'
      const searchQuery: string = String(query).trim()

      const userId = session.userId || session.channelId || 'unknown'
      const now = Date.now()
      const lastTime = lastCallTime.get(userId) || 0

      if (now - lastTime < config.interval) {
        const waitTime = Math.ceil((config.interval - (now - lastTime)) / 1000)
        return `调用过于频繁，请等待 ${waitTime} 秒后再试`
      }
      lastCallTime.set(userId, now)

      try {
        if (config.log) {
          ctx.logger.info(`[VATSIM] 用户查询请求 - 用户: ${userId}, 查询内容: ${query}`)
        }

        const data = await vatsimService.getVatsimData()

        // 搜索匹配的飞行员
        let pilot: VatsimPilotShort | undefined
        const cid = parseInt(searchQuery)

        if (!isNaN(cid)) {
          pilot = data.pilots.find(p => p.cid === cid)
          if (!pilot) return `未找到CID为 ${cid} 的飞行员`
        } else if (searchQuery.match(/^[A-Za-z0-9]+$/)) {
          const callsign = searchQuery.toUpperCase()
          pilot = data.pilots.find(p => p.callsign.toUpperCase() === callsign)
          if (!pilot) return `未找到呼号为 ${callsign} 的飞行员`
        } else {
          const name = searchQuery.toLowerCase()
          pilot = data.pilots.find(p => p.name.toLowerCase().includes(name))
          if (!pilot) return `未找到姓名包含 ${query} 的飞行员`
        }

        const pilotDetail = await vatsimService.getPilotDetail(pilot.cid)
        const classifiedFrequencies = await vatsimService.getClassifiedFrequenciesByCallsign(pilotDetail.callsign)

        // ---------- 周围在线机组 ----------
        let nearbyAll: NearbyPilot[] = []
        if (config.showNearby) {
          nearbyAll = collectNearbyPilots(data.pilots, pilotDetail, config.nearRadiusNm)
        }

        // ---------- 本地绘制位置图 ----------
        const wantMap = config.enableMap && !options?.nomap
        let mapImage: Buffer | null = null
        if (wantMap) {
          try {
            // 自动缩放半径：取第 15 近的周围机组距离（约让 15 个标签落在图内），
            // 密集 → 第 15 近也很近 → 放大看细节；稀少 → 只能撑满搜索半径 → 缩小看更大范围
            const AUTO_ZOOM_TARGET = 15
            let zoomRadiusNm = config.nearRadiusNm
            if (nearbyAll.length >= AUTO_ZOOM_TARGET) {
              zoomRadiusNm = nearbyAll[AUTO_ZOOM_TARGET - 1].distNm
            } else if (nearbyAll.length > 0) {
              zoomRadiusNm = Math.max(60, nearbyAll[nearbyAll.length - 1].distNm)
            }
            zoomRadiusNm = Math.min(config.nearRadiusNm, Math.max(25, zoomRadiusNm))
            mapImage = await mapRenderer.renderPilotMap(pilotDetail, nearbyAll.slice(0, config.nearbyMaxMarkers), zoomRadiusNm)
          } catch (mapError: any) {
            ctx.logger.warn('[VATSIM] 本地地图绘制失败，降级为纯文字:', mapError.message)
          }
        }

        // ---------- 文字信息 ----------
        const messageParts: any[] = []
        if (mapImage) {
          messageParts.push(h.image(mapImage, 'image/png'), '\n')
        }

        messageParts.push(
          '=== VATSIM 飞行员信息 ===\n',
          `CID: ${pilotDetail.cid}\n`,
          `姓名: ${pilotDetail.name}\n`,
          `呼号: ${pilotDetail.callsign}\n`,
          `服务器: ${pilotDetail.server || 'Unknown'}\n`,
          `高度: ${Math.round(pilotDetail.altitude)} 英尺\n`,
          `地速: ${Math.round(pilotDetail.groundspeed)} 节\n`,
          `航向: ${Math.round(pilotDetail.heading)}°\n`,
          `应答机: ${pilotDetail.transponder}\n`,
          `位置: 纬度 ${pilotDetail.latitude.toFixed(4)}, 经度 ${pilotDetail.longitude.toFixed(4)}`,
        )

        if (config.showNearby) {
          messageParts.push(
            `\n周围 ${config.nearRadiusNm} 海里内在线机组: ${nearbyAll.length} 架`,
            nearbyAll.length > 0 && nearbyAll.length <= 10
              ? `（${nearbyAll.slice(0, 10).map(n => n.pilot.callsign).join('、')}）`
              : '',
            '\n',
          )
        }

        if (pilotDetail.flight_plan) {
          messageParts.push(
            '\n--- 飞行计划 ---\n',
            `起飞机场: ${pilotDetail.flight_plan.departure}\n`,
            `目的机场: ${pilotDetail.flight_plan.arrival}\n`,
            `备降机场: ${pilotDetail.flight_plan.alternate || '无'}\n`,
            `机型: ${pilotDetail.flight_plan.aircraft_faa}\n`,
            `巡航高度: ${pilotDetail.flight_plan.altitude}\n`,
            `计划航路: ${pilotDetail.flight_plan.route}`,
          )
        } else {
          messageParts.push('\n--- 飞行计划 ---\n', '无飞行计划')
        }

        const primaryFrequency = classifiedFrequencies.primary
        const secondaryFrequency = classifiedFrequencies.secondary

        messageParts.push(
          '\n--- 频率 ---\n',
          `主频率: ${primaryFrequency ? primaryFrequency.toFixed(3) : '无'}\n`,
          `备频: ${secondaryFrequency ? secondaryFrequency.toFixed(3) : '无'}`,
        )

        return messageParts

      } catch (error: any) {
        ctx.logger.error(`[VATSIM] 用户 ${userId} 的查询处理失败:`, error)

        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          return '网络连接失败，请检查网络状态后重试'
        } else if (error.response?.status === 403) {
          return 'VATSIM API访问被拒绝，可能是临时限制，请稍后重试'
        } else if (error.response?.status === 404) {
          return 'VATSIM服务暂时不可用，请稍后重试'
        } else {
          return '查询VATSIM数据时出现错误，请稍后重试'
        }
      }
    })

  // VATSIM 统计数据截图
  ctx.command('vatsim.stats <cid:string>', '查询VATSIM用户统计（截图）')
    .alias('vatsim.统计')
    .action(async ({ session }, cid) => {
      if (!cid || !/^\d+$/.test(cid)) {
        return '请输入有效的数字 CID，例如: vatsim.stats 1234567'
      }
      await session.send(`正在查询 VATSIM 用户 ${cid} 的统计数据...`)
      try {
        const buffer = await vatsimService.getUserStatsScreenshot(cid)
        return h.image(buffer, 'image/png')
      } catch (error: any) {
        ctx.logger.error(`[VATSIM] 统计截图失败 CID: ${cid}:`, error)
        return '获取统计数据失败，请稍后重试'
      }
    })
}
