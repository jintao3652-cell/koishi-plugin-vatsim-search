# koishi-plugin-vatsim-search

[![npm](https://img.shields.io/npm/v/koishi-plugin-vatsim-search?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-vatsim-search)

查询 VATSIM 机组信息，附带本地绘制的位置地图（Mapbox / Esri 多瓦片源）。

## 功能

- 通过呼号 / CID / 姓名查询机组，展示高度、地速、航向、飞行计划、频率等信息
- 数据源：VATSIM Data API（<https://vatsim.dev/api/data-api/get-network-data>，`data.vatsim.net/v3/vatsim-data.json`）
- 本地 Leaflet 绘制位置图，支持 Mapbox（dark / light / streets / satellite / night，需填 token）与 Esri / OSM 免费瓦片源
- **周围在线机组**：地图上以橙色圆点标注目标周围（默认 300 海里内）的其他在线机组，并常驻显示其呼号标签
- **密度自动缩放**：机组密集时自动放大地图看细节，机组稀少时自动缩小看更大范围（可关闭，改用固定缩放）
- `vatsim.stats <CID>` 查询用户统计截图

## 主要配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `mapProvider` / `mapboxToken` | mapbox-dark | 瓦片源；mapbox 系需填 `pk.` 开头 token，未填自动回退 Esri 暗色 |
| `showNearby` | true | 是否在地图上显示周围在线机组（附呼号标签） |
| `nearRadiusNm` | 300 | 周围机组搜索半径（海里） |
| `nearbyMaxMarkers` | 40 | 地图上周围机组标记数量上限（按距离取最近的） |
| `autoZoom` | true | 按周围机组密度自动调整缩放（密集放大 / 稀少缩小） |
| `autoZoomMin` / `autoZoomMax` | 3 / 10 | 自动缩放的上下限 |
| `enableMap` / `--no-map` | true | 查询结果是否附带地图 |
