import { Context, Schema, h, Time } from 'koishi'
import axios from 'axios'
import * as puppeteer from 'puppeteer'

// 定义接口
interface VatsimGeneral {
  general: {
    version: number
    reload: number
    update: string
    update_timestamp: string
    connected_clients: number
    unique_users: number
    sups?: any[]
    adm?: any[]
    supsCount?: number
    admCount?: number
    onlineWSUsers?: number
  }
  pilots: VatsimPilotShort[]
}

// 修改 frequencies 字段为数字类型
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
  frequencies: number[]  // 改为数字数组
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

// 新增：Transceiver 接口定义
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

// 新增：分类后的频率信息
interface ClassifiedFrequencies {
  primary: number | null  // 主频率 (feq0)
  secondary: number | null // 备频 (feq1)
  all: number[]           // 所有频率
}

// 配置Schema
export interface Config {
  interval: number
  log: boolean
  maxRetries: number
  retryDelay: number
  timeout: number
  useAlternativeAPI: boolean
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number().default(5 * Time.second).description('指令调用间隔(毫秒)'),
  log: Schema.boolean().default(false).description('是否输出日志'),
  maxRetries: Schema.number().default(3).description('API最大重试次数'),
  retryDelay: Schema.number().default(1000).description('重试延迟(毫秒)'),
  timeout: Schema.number().default(30000).description('API超时时间(毫秒)'),
  useAlternativeAPI: Schema.boolean().default(true).description('使用备用API源')
})

export const name = 'vatsim'
export const using = []

// 截图服务类
class ScreenshotService {
  private browser: puppeteer.Browser | null = null

  constructor(private ctx: Context) {}

  // 初始化浏览器
  async initBrowser() {
    if (this.browser) return

    try {
      this.ctx.logger.info('[SCREENSHOT] 正在启动浏览器...')
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        defaultViewport: {
          width: 1280,
          height: 720
        }
      })
      this.ctx.logger.info('[SCREENSHOT] 浏览器启动成功')
    } catch (error) {
      this.ctx.logger.error('[SCREENSHOT] 浏览器启动失败:', error)
      throw error
    }
  }

  // 重试机制包装器
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.ctx.logger.info(`[SCREENSHOT] ${operationName} - 第 ${attempt} 次尝试`)
        const result = await operation()
        this.ctx.logger.info(`[SCREENSHOT] ${operationName} - 第 ${attempt} 次尝试成功`)
        return result
      } catch (error) {
        lastError = error
        this.ctx.logger.warn(`[SCREENSHOT] ${operationName} - 第 ${attempt} 次尝试失败:`, error.message)
        
        if (attempt < 3) {
          this.ctx.logger.info(`[SCREENSHOT] ${operationName} - 等待 1000ms 后重试`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }
    
    this.ctx.logger.error(`[SCREENSHOT] ${operationName} - 所有 3 次尝试均失败`)
    throw lastError
  }

  // 截图函数 - 修复返回类型问题
  async takeScreenshot(url: string, waitTime: number = 10000): Promise<Buffer> {
    return this.withRetry(async () => {
      await this.initBrowser()

      let page: puppeteer.Page | null = null
      try {
        this.ctx.logger.info(`[SCREENSHOT] 正在打开页面: ${url}`)
        page = await this.browser!.newPage()
        
        // 设置用户代理
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
        
        // 设置超时
        page.setDefaultTimeout(30000)
        
        // 导航到页面
        await page.goto(url, { 
          waitUntil: 'networkidle2',
          timeout: 30000
        })

        this.ctx.logger.info(`[SCREENSHOT] 页面加载完成，等待 ${waitTime}ms`)
        
        // 等待指定时间
        await new Promise(resolve => setTimeout(resolve, waitTime))
        
        // 截图 - 修复返回类型问题
        this.ctx.logger.info('[SCREENSHOT] 开始截图')
        const screenshotData = await page.screenshot({
          type: 'png',
          fullPage: true
        })

        this.ctx.logger.info('[SCREENSHOT] 截图完成')
        
        // 将 Uint8Array 转换为 Buffer
        return Buffer.from(screenshotData)

      } catch (error) {
        this.ctx.logger.error('[SCREENSHOT] 截图失败:', error)
        throw error
      } finally {
        if (page) {
          await page.close().catch(error => {
            this.ctx.logger.warn('[SCREENSHOT] 页面关闭失败:', error)
          })
        }
      }
    }, `截图操作 URL:${url}`)
  }

  // 关闭浏览器
  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close()
        this.browser = null
        this.ctx.logger.info('[SCREENSHOT] 浏览器已关闭')
      } catch (error) {
        this.ctx.logger.error('[SCREENSHOT] 浏览器关闭失败:', error)
      }
    }
  }
}

// VATSIM 服务类
class VatsimService {
  private screenshotService: ScreenshotService
  private transceiversData: TransceiverData[] | null = null
  private lastTransceiversUpdate: number = 0

  constructor(private ctx: Context, private config: Config) {
    this.screenshotService = new ScreenshotService(ctx)
  }

  // 重试机制包装器
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error
    
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        this.ctx.logger.info(`[VATSIM] ${operationName} - 第 ${attempt} 次尝试`)
        const result = await operation()
        this.ctx.logger.info(`[VATSIM] ${operationName} - 第 ${attempt} 次尝试成功`)
        return result
      } catch (error) {
        lastError = error
        this.ctx.logger.warn(`[VATSIM] ${operationName} - 第 ${attempt} 次尝试失败:`, error.message)
        
        if (attempt < this.config.maxRetries) {
          this.ctx.logger.info(`[VATSIM] ${operationName} - 等待 ${this.config.retryDelay}ms 后重试`)
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay))
        }
      }
    }
    
    this.ctx.logger.error(`[VATSIM] ${operationName} - 所有 ${this.config.maxRetries} 次尝试均失败`)
    throw lastError
  }

  // 创建axios实例，添加必要的请求头
  private createAxiosInstance() {
    return axios.create({
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Referer': 'https://vatsim-radar.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      }
    })
  }

  // 获取VATSIM数据 - 使用备用API
  async getVatsimData(): Promise<VatsimGeneral> {
    return this.withRetry(async () => {
      this.ctx.logger.info('[VATSIM] 开始获取VATSIM数据')
      const startTime = Date.now()
      
      const axiosInstance = this.createAxiosInstance()
      
      // 尝试多个API端点
      const apiEndpoints = [
        'https://data.vatsim.net/v3/vatsim-data.json',
        'https://api.vatsim.net/v2/network-data'
      ]
      
      if (!this.config.useAlternativeAPI) {
        apiEndpoints.unshift('https://vatsim-radar.com/api/data/vatsim/data/short')
      }
      
      let lastError: Error
      
      for (const endpoint of apiEndpoints) {
        try {
          this.ctx.logger.info(`[VATSIM] 尝试API端点: ${endpoint}`)
          const response = await axiosInstance.get(endpoint)
          
          const endTime = Date.now()
          this.ctx.logger.info(`[VATSIM] VATSIM数据获取完成，端点: ${endpoint}，耗时 ${endTime - startTime}ms`)
          
          // 转换数据格式以适应不同的API响应结构
          const data = this.transformVatsimData(response.data, endpoint)
          this.ctx.logger.info(`[VATSIM] 找到 ${data.pilots?.length || 0} 个在线飞行员`)
          
          return data
        } catch (error) {
          lastError = error
          this.ctx.logger.warn(`[VATSIM] API端点 ${endpoint} 失败:`, error.message)
          continue
        }
      }
      
      throw lastError
    }, '获取VATSIM数据')
  }

  // 获取Transceivers数据
  async getTransceiversData(): Promise<TransceiverData[]> {
    // 使用缓存，避免频繁请求
    const now = Date.now()
    if (this.transceiversData && now - this.lastTransceiversUpdate < 30000) { // 30秒缓存
      return this.transceiversData
    }

    return this.withRetry(async () => {
      this.ctx.logger.info('[VATSIM] 开始获取Transceivers数据')
      const startTime = Date.now()
      
      const axiosInstance = this.createAxiosInstance()
      
      try {
        const response = await axiosInstance.get('https://data.vatsim.net/v3/transceivers-data.json')
        const endTime = Date.now()
        
        this.transceiversData = response.data
        this.lastTransceiversUpdate = now
        
        this.ctx.logger.info(`[VATSIM] Transceivers数据获取完成，耗时 ${endTime - startTime}ms，找到 ${this.transceiversData.length} 个呼号`)
        return this.transceiversData
      } catch (error) {
        this.ctx.logger.error('[VATSIM] 获取Transceivers数据失败:', error)
        throw error
      }
    }, '获取Transceivers数据')
  }

  // 根据呼号获取分类频率数据
  async getClassifiedFrequenciesByCallsign(callsign: string): Promise<ClassifiedFrequencies> {
    try {
      const transceiversData = await this.getTransceiversData()
      const callsignData = transceiversData.find(item => item.callsign === callsign)
      
      if (!callsignData || !callsignData.transceivers) {
        this.ctx.logger.info(`[VATSIM] 未找到呼号 ${callsign} 的Transceivers数据`)
        return {
          primary: null,
          secondary: null,
          all: []
        }
      }
      
      // 提取频率并转换为MHz，取前6位
      const frequencies: number[] = []
      for (const transceiver of callsignData.transceivers) {
        // 将Hz转换为MHz，然后取前6位
        const frequencyMHz = transceiver.frequency / 1000000
        // 取前6位数字（包括小数点）
        const frequencyStr = frequencyMHz.toString()
        const shortFrequency = parseFloat(frequencyStr.substring(0, 6))
        
        if (!isNaN(shortFrequency)) {
          frequencies.push(shortFrequency)
        }
      }
      
      // 分类频率：feq0为主频率，feq1为备频
      let primary: number | null = null
      let secondary: number | null = null
      
      if (frequencies.length >= 1) {
        primary = frequencies[0] // feq0 主频率
      }
      
      if (frequencies.length >= 2) {
        secondary = frequencies[1] // feq1 备频
      }
      
      this.ctx.logger.info(`[VATSIM] 呼号 ${callsign} 的分类频率数据 - 主频率: ${primary}, 备频: ${secondary}, 所有频率: ${JSON.stringify(frequencies)}`)
      
      return {
        primary,
        secondary,
        all: frequencies
      }
    } catch (error) {
      this.ctx.logger.warn(`[VATSIM] 获取呼号 ${callsign} 的分类频率数据失败:`, error)
      return {
        primary: null,
        secondary: null,
        all: []
      }
    }
  }

  // 转换不同API的数据格式
  private transformVatsimData(data: any, endpoint: string): VatsimGeneral {
    this.ctx.logger.info(`[VATSIM] 转换API数据，端点: ${endpoint}`)
    
    if (endpoint.includes('vatsim-radar.com')) {
      // vatsim-radar.com 格式 - 已经是正确的格式
      return data as VatsimGeneral
    } else if (endpoint.includes('data.vatsim.net')) {
      // data.vatsim.net v3 格式 - 需要转换
      const transformedData: VatsimGeneral = {
        general: {
          version: data.version || 3,
          reload: data.reload || 1,
          update: data.update || new Date().toISOString(),
          update_timestamp: data.update_timestamp || new Date().toISOString(),
          connected_clients: data.connected_clients || 0,
          unique_users: data.unique_users || 0
        },
        pilots: data.pilots || []
      }
      return transformedData
    } else {
      // api.vatsim.net v2 格式或其他 - 需要转换
      const transformedData: VatsimGeneral = {
        general: {
          version: data.version || 3,
          reload: data.reload || 1,
          update: data.update || new Date().toISOString(),
          update_timestamp: data.update_timestamp || new Date().toISOString(),
          connected_clients: data.connected_clients || 0,
          unique_users: data.unique_users || 0
        },
        pilots: data.pilots || []
      }
      return transformedData
    }
  }

  // 获取飞行员详情（改进版本，使用Transceivers数据获取分类频率）
  async getPilotDetail(cid: number): Promise<VatsimPilotShort> {
    return this.withRetry(async () => {
      this.ctx.logger.info(`[VATSIM] 开始获取飞行员详情 CID: ${cid}`)
      const startTime = Date.now()

      try {
        // 首先从基础数据中获取飞行员信息
        this.ctx.logger.info(`[VATSIM] 尝试从基础数据获取飞行员信息 CID: ${cid}`)
        const basicInfo = await this.getBasicPilotInfo(cid)
        
        // 然后尝试从Transceivers数据获取分类频率信息
        try {
          const classifiedFrequencies = await this.getClassifiedFrequenciesByCallsign(basicInfo.callsign)
          if (classifiedFrequencies.all.length > 0) {
            this.ctx.logger.info(`[VATSIM] 成功从Transceivers数据获取分类频率 CID: ${cid}`)
            // 将所有频率存储在frequencies字段中
            basicInfo.frequencies = classifiedFrequencies.all
          }
        } catch (freqError) {
          this.ctx.logger.warn(`[VATSIM] 获取分类频率数据失败 CID: ${cid}:`, freqError.message)
        }

        // 返回合并后的信息
        const endTime = Date.now()
        this.ctx.logger.info(`[VATSIM] 飞行员详情处理完成 CID: ${cid}，耗时 ${endTime - startTime}ms`)
        return basicInfo

      } catch (error) {
        this.ctx.logger.error(`[VATSIM] 获取飞行员信息失败 CID: ${cid}:`, error)
        throw error
      }
    }, `获取飞行员详情 CID:${cid}`)
  }

  // 获取基础飞行员信息（降级方案）
  private async getBasicPilotInfo(cid: number): Promise<VatsimPilotShort> {
    this.ctx.logger.info(`[VATSIM] 获取基础飞行员信息 CID: ${cid}`)
    
    // 从通用数据中查找该飞行员
    const generalData = await this.getVatsimData()
    const pilot = generalData.pilots.find(p => p.cid === cid)
    
    if (!pilot) {
      throw new Error(`未找到飞行员 CID: ${cid}`)
    }
    
    // 处理频率数据
    const frequencies = this.processFrequencies(pilot.frequencies)
    
    this.ctx.logger.info(`[VATSIM] 基础信息频率数据: ${JSON.stringify(frequencies)}`)

    // 构建基础信息
    const basicInfo: VatsimPilotShort = {
      cid: pilot.cid,
      name: pilot.name,
      callsign: pilot.callsign,
      server: pilot.server || 'Unknown',
      pilot_rating: pilot.pilot_rating,
      military_rating: pilot.military_rating,
      latitude: pilot.latitude,
      longitude: pilot.longitude,
      altitude: pilot.altitude,
      groundspeed: pilot.groundspeed,
      transponder: pilot.transponder,
      heading: pilot.heading,
      qnh_mb: pilot.qnh_mb,
      flight_plan: pilot.flight_plan,
      logon_time: pilot.logon_time,
      last_updated: pilot.last_updated || new Date().toISOString(),
      date: pilot.date,
      deleted: pilot.deleted,
      frequencies: frequencies,
      depDist: pilot.depDist,
      toGoDist: pilot.toGoDist,
      status: pilot.status,
      arrival: pilot.arrival,
      aircraft_short: pilot.aircraft_short,
      aircraft_faa: pilot.aircraft_faa,
      departure: pilot.departure,
      flight_rules: pilot.flight_rules
    }
    
    return basicInfo
  }

  // 处理频率数据的辅助方法
  private processFrequencies(freqData: any): number[] {
    let frequencies: number[] = []
    
    if (Array.isArray(freqData)) {
      for (const freq of freqData) {
        if (typeof freq === 'string') {
          const numFreq = parseFloat(freq)
          if (!isNaN(numFreq)) {
            frequencies.push(numFreq)
          }
        } else if (typeof freq === 'number') {
          frequencies.push(freq)
        }
      }
    } else if (typeof freqData === 'string') {
      const numFreq = parseFloat(freqData)
      if (!isNaN(numFreq)) {
        frequencies = [numFreq]
      }
    } else if (typeof freqData === 'number') {
      frequencies = [freqData]
    }
    
    return frequencies
  }

  // 获取用户统计截图
  async getUserStatsScreenshot(vatsimId: string): Promise<Buffer> {
    this.ctx.logger.info(`[VATSIM] 开始获取用户统计截图 ID: ${vatsimId}`)
    
    const url = `https://stats.vatsim.net/stats/${vatsimId}`
    this.ctx.logger.info(`[VATSIM] 统计页面URL: ${url}`)
    
    try {
      const screenshotBuffer = await this.screenshotService.takeScreenshot(url, 10000)
      this.ctx.logger.info(`[VATSIM] 用户统计截图获取成功 ID: ${vatsimId}`)
      return screenshotBuffer
    } catch (error) {
      this.ctx.logger.error(`[VATSIM] 用户统计截图获取失败 ID: ${vatsimId}:`, error)
      throw error
    }
  }
}

export function apply(ctx: Context, config: Config) {
  // 存储最后一次调用时间
  const lastCallTime = new Map<string, number>()
  
  // 初始化VATSIM服务
  const vatsimService = new VatsimService(ctx, config)

  // 原有的查询指令
  ctx.command('vatsim <query:string>', '查询VATSIM飞行员信息')
    .usage('支持三种查询方式：\n- 呼号: vatsim CPA123\n- CID: vatsim 1234567\n- 姓名: vatsim "John Smith"')
    .example('vatsim CPA123 - 通过呼号查询')
    .example('vatsim 1234567 - 通过CID查询')
    .example('vatsim "John Smith" - 通过姓名查询')
    .action(async ({ session }, query) => {
      if (!query) {
        return '请输入查询内容（呼号、CID或姓名）'
      }

      const userId = session.userId
      const now = Date.now()
      const lastTime = lastCallTime.get(userId) || 0
      
      // 检查调用间隔
      if (now - lastTime < config.interval) {
        const waitTime = Math.ceil((config.interval - (now - lastTime)) / 1000)
        return `调用过于频繁，请等待 ${waitTime} 秒后再试`
      }
      
      lastCallTime.set(userId, now)

      try {
        if (config.log) {
          ctx.logger.info(`[VATSIM] 用户查询请求 - 用户: ${userId}, 查询内容: ${query}`)
        }

        // 获取VATSIM数据
        ctx.logger.info(`[VATSIM] 开始处理用户 ${userId} 的查询: ${query}`)
        const data = await vatsimService.getVatsimData()
        
        // 搜索匹配的飞行员
        let pilot: VatsimPilotShort
        const cid = parseInt(query)
        
        if (!isNaN(cid)) {
          // CID查询
          ctx.logger.info(`[VATSIM] 使用CID查询模式: ${cid}`)
          pilot = data.pilots.find(p => p.cid === cid)
          if (!pilot) {
            ctx.logger.info(`[VATSIM] 未找到CID为 ${cid} 的飞行员`)
            return `未找到CID为 ${cid} 的飞行员`
          }
        } else if (query.match(/^[A-Z0-9_]+$/)) {
          // 呼号查询（只包含字母、数字、下划线）
          const callsign = query.toUpperCase()
          ctx.logger.info(`[VATSIM] 使用呼号查询模式: ${callsign}`)
          pilot = data.pilots.find(p => p.callsign.toUpperCase() === callsign)
          if (!pilot) {
            ctx.logger.info(`[VATSIM] 未找到呼号为 ${callsign} 的飞行员`)
            return `未找到呼号为 ${callsign} 的飞行员`
          }
        } else {
          // 姓名查询
          const name = query.toLowerCase()
          ctx.logger.info(`[VATSIM] 使用姓名查询模式: ${name}`)
          pilot = data.pilots.find(p => p.name.toLowerCase().includes(name))
          if (!pilot) {
            ctx.logger.info(`[VATSIM] 未找到姓名包含 ${query} 的飞行员`)
            return `未找到姓名为 ${query} 的飞行员`
          }
        }

        ctx.logger.info(`[VATSIM] 找到匹配的飞行员 - 呼号: ${pilot.callsign}, CID: ${pilot.cid}, 姓名: ${pilot.name}`)

        // 获取详细信息
        ctx.logger.info(`[VATSIM] 开始获取飞行员 ${pilot.cid} 的详细信息`)
        const pilotDetail = await vatsimService.getPilotDetail(pilot.cid)

        // 获取分类频率信息
        ctx.logger.info(`[VATSIM] 开始获取分类频率信息 呼号: ${pilot.callsign}`)
        const classifiedFrequencies = await vatsimService.getClassifiedFrequenciesByCallsign(pilot.callsign)

        // 生成地图URL
        const mapUrl = `https://vatsim-radar.com/?center=${pilotDetail.longitude},${pilotDetail.latitude}&zoom=8.84`

        // 构建回复消息
        const messageParts = [
          '=== VATSIM 飞行员信息 ===',
          `CID: ${pilotDetail.cid}`,
          `姓名: ${pilotDetail.name}`,
          `呼号: ${pilotDetail.callsign}`,
          `服务器: ${pilotDetail.server || 'Unknown'}`,
          `高度: ${Math.round(pilotDetail.altitude)} 英尺`,
          `地速: ${Math.round(pilotDetail.groundspeed)} 节`,
          `应答机: ${pilotDetail.transponder}`,
          `位置: 纬度 ${pilotDetail.latitude.toFixed(4)}, 经度 ${pilotDetail.longitude.toFixed(4)}`,
          `查看地图位置: ${mapUrl}`,
        ]

        // 添加飞行计划信息
        if (pilotDetail.flight_plan) {
          messageParts.push(
            '',
            '--- 飞行计划 ---',
            `起飞机场: ${pilotDetail.flight_plan.departure}`,
            `目的机场: ${pilotDetail.flight_plan.arrival}`,
            `备降机场: ${pilotDetail.flight_plan.alternate}`,
            `机型: ${pilotDetail.flight_plan.aircraft_faa}`,
            `巡航高度: ${pilotDetail.flight_plan.altitude}`,
            `计划航路: ${pilotDetail.flight_plan.route}`
          )
        } else {
          messageParts.push('', '--- 飞行计划 ---', '无飞行计划')
        }

        // 添加分类频率信息 - feq0为主频率，feq1为备频
        const primaryFrequency = classifiedFrequencies.primary
        const secondaryFrequency = classifiedFrequencies.secondary
        
        messageParts.push(
          '',
          '--- 频率 ---',
          `主频率 (feq0): ${primaryFrequency ? primaryFrequency.toFixed(3) : '无'}`,
          `备频 (feq1): ${secondaryFrequency ? secondaryFrequency.toFixed(3) : '无'}`
        )

        ctx.logger.info(`[VATSIM] 用户 ${userId} 的查询处理完成，准备发送结果`)
        return messageParts.join('\n')

      } catch (error) {
        ctx.logger.error(`[VATSIM] 用户 ${userId} 的查询处理失败:`, error)
        
        // 根据错误类型提供不同的错误信息
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

  

  // 插件卸载时关闭浏览器
  ctx.on('dispose', () => {
    vatsimService['screenshotService'].closeBrowser()
  })
}