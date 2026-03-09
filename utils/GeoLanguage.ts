import { log } from './Logger'
import AxiosClient from './Axios'
import { AccountProxy } from '../interfaces/Account'

// API响应接口定义
interface IpapiCoResponse {
    country_name?: string
    country_code?: string
    city?: string
    timezone?: string
    currency?: string
    ip?: string
    latitude?: number
    longitude?: number
}

interface IpinfoResponse {
    country?: string
    city?: string
    timezone?: string
    ip?: string
    loc?: string
}

interface FreegeoipResponse {
    country_name?: string
    country_code?: string
    city?: string
    time_zone?: string
    ip?: string
    latitude?: string
    longitude?: string
}

export interface GeoLocation {
    country: string
    countryCode: string
    city: string
    timezone: string
    language: string
    currency: string
    ip: string
    latitude: number
    longitude: number
}

export interface LanguageConfig {
    code: string
    name: string
    googleTrendsLocale: string
    searchQueries: {
        news: string[]
        common: string[]
        tech: string[]
        entertainment: string[]
        sports: string[]
        food: string[]
    }
}

export class GeoLanguageDetector {
    private static geoCache: Map<string, { location: GeoLocation; expiresAt: number }> = new Map()
    private static CACHE_DURATION = 24 * 60 * 60 * 1000 // 24小时缓存
    private static readonly DIRECT_CONNECTION_PROXY: AccountProxy = {
        proxyAxios: false,
        url: '',
        port: 0,
        password: '',
        username: ''
    }

    /**
     * 获取当前IP的地理位置信息
     */
    static async getCurrentLocation(proxy?: AccountProxy): Promise<GeoLocation> {
        const proxyConfig = this.getGeoLookupProxy(proxy)
        const cacheKey = this.getCacheKey(proxyConfig)

        // 检查缓存
        const cachedEntry = this.geoCache.get(cacheKey)
        if (cachedEntry && Date.now() < cachedEntry.expiresAt) {
            return cachedEntry.location
        }

        try {
            // 地理位置服务列表（按优先级排序）
            const geoServices = [
                'https://ipapi.co/json',
                'https://ipinfo.io/json',
                'https://freegeoip.app/json/'
            ]

            const axiosClient = new AxiosClient(proxyConfig)

            for (const service of geoServices) {
                try {
                    const response = await axiosClient.request({
                        method: 'GET',
                        timeout: 10000,
                        url: service
                    })
                    const location = this.parseLocationResponse(response.data, service)
                    
                    if (location) {
                        // 缓存结果
                        this.geoCache.set(cacheKey, {
                            expiresAt: Date.now() + this.CACHE_DURATION,
                            location
                        })
                        
                        log(false, 'GEO-DETECT', `Location detected: ${location.country} (${location.countryCode}) - Language: ${location.language}`)
                        return location
                    }
                } catch (error) {
                    log(false, 'GEO-DETECT', `Service ${service} failed: ${error}`, 'warn')
                    continue
                }
            }

            // 如果所有服务都失败，返回默认位置（根据时区推测）
            return this.getLocationFromTimezone()

        } catch (error) {
            log(false, 'GEO-DETECT', `All geo services failed, using timezone fallback: ${error}`, 'warn')
            return this.getLocationFromTimezone()
        }
    }

    private static getGeoLookupProxy(proxy?: AccountProxy): AccountProxy {
        if (!proxy?.url) {
            return this.DIRECT_CONNECTION_PROXY
        }

        return {
            ...proxy,
            proxyAxios: true
        }
    }

    private static getCacheKey(proxy: AccountProxy): string {
        if (!proxy.url) {
            return 'direct'
        }

        return `${proxy.url}:${proxy.port}:${proxy.username}`
    }

    /**
     * 解析不同服务的响应格式
     */
    private static parseLocationResponse(data: unknown, service: string): GeoLocation | null {
        try {
            if (service.includes('ipapi.co')) {
                const apiData = data as IpapiCoResponse
                return {
                    country: apiData.country_name || 'Unknown',
                    countryCode: apiData.country_code || 'US',
                    city: apiData.city || 'Unknown',
                    timezone: apiData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                    language: this.getLanguageFromCountry(apiData.country_code || 'US'),
                    currency: apiData.currency || 'USD',
                    ip: apiData.ip || 'Unknown',
                    latitude: apiData.latitude || 0,
                    longitude: apiData.longitude || 0
                }
            } else if (service.includes('ipinfo.io')) {
                const apiData = data as IpinfoResponse
                // ipinfo.io使用"loc"字段返回"lat,lng"格式
                const coordinates = apiData.loc ? apiData.loc.split(',') : ['0', '0']
                const lat = coordinates[0] || '0'
                const lng = coordinates[1] || '0'
                const countryCode = apiData.country || 'US'
                const countryName = this.getCountryNameFromCode(countryCode)
                return {
                    country: countryName,
                    countryCode: countryCode,
                    city: apiData.city || 'Unknown',
                    timezone: apiData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                    language: this.getLanguageFromCountry(countryCode),
                    currency: 'USD', // ipinfo.io不提供货币信息
                    ip: apiData.ip || 'Unknown',
                    latitude: parseFloat(lat) || 0,
                    longitude: parseFloat(lng) || 0
                }
            } else if (service.includes('freegeoip.app')) {
                const apiData = data as FreegeoipResponse
                // 添加 freegeoip.app 解析
                const lat: string = apiData.latitude ? apiData.latitude : '0'
                const lng: string = apiData.longitude ? apiData.longitude : '0'
                return {
                    country: apiData.country_name || 'Unknown',
                    countryCode: apiData.country_code || 'US',
                    city: apiData.city || 'Unknown',
                    timezone: apiData.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                    language: this.getLanguageFromCountry(apiData.country_code || 'US'),
                    currency: 'USD', // freegeoip不提供货币信息
                    ip: apiData.ip || 'Unknown',
                    latitude: parseFloat(lat) || 0,
                    longitude: parseFloat(lng) || 0
                }
            }
        } catch (error) {
            log(false, 'GEO-PARSE', `Failed to parse response from ${service}: ${error}`, 'warn')
        }
        return null
    }

    /**
     * 根据时区推测位置（备用方案）
     */
    private static getLocationFromTimezone(): GeoLocation {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        
        // 常见时区到国家的映射（包含大概经纬度）
        const timezoneMap: { [key: string]: { 
            country: string, 
            code: string, 
            language: string,
            latitude: number,
            longitude: number
        } } = {
            'Asia/Tokyo': { country: 'Japan', code: 'JP', language: 'ja', latitude: 35.6762, longitude: 139.6503 },
            'Asia/Shanghai': { country: 'China', code: 'CN', language: 'zh-CN', latitude: 31.2304, longitude: 121.4737 },
            'Asia/Seoul': { country: 'South Korea', code: 'KR', language: 'ko', latitude: 37.5665, longitude: 126.9780 },
            'Europe/London': { country: 'United Kingdom', code: 'GB', language: 'en', latitude: 51.5074, longitude: -0.1278 },
            'Europe/Paris': { country: 'France', code: 'FR', language: 'fr', latitude: 48.8566, longitude: 2.3522 },
            'Europe/Berlin': { country: 'Germany', code: 'DE', language: 'de', latitude: 52.5200, longitude: 13.4050 },
            'America/New_York': { country: 'United States', code: 'US', language: 'en', latitude: 40.7128, longitude: -74.0060 },
            'America/Los_Angeles': { country: 'United States', code: 'US', language: 'en', latitude: 34.0522, longitude: -118.2437 },
            'Australia/Sydney': { country: 'Australia', code: 'AU', language: 'en', latitude: -33.8688, longitude: 151.2093 }
        }

        const location = timezoneMap[timezone] || { 
            country: 'United States', 
            code: 'US', 
            language: 'en',
            latitude: 40.7128,
            longitude: -74.0060
        }
        
        return {
            country: location.country,
            countryCode: location.code,
            city: 'Unknown',
            timezone,
            language: location.language,
            currency: 'USD',
            ip: 'Unknown',
            latitude: location.latitude,
            longitude: location.longitude
        }
    }

    /**
     * 根据国家代码获取国家名称
     */
    private static getCountryNameFromCode(countryCode: string): string {
        const countryNameMap: { [key: string]: string } = {
            // 英语国家
            'US': 'United States', 'GB': 'United Kingdom', 'CA': 'Canada', 'AU': 'Australia', 'NZ': 'New Zealand',
            'IE': 'Ireland', 'ZA': 'South Africa',

            // 亚洲国家
            'JP': 'Japan', 'CN': 'China', 'TW': 'Taiwan', 'HK': 'Hong Kong', 'KR': 'South Korea',
            'IN': 'India', 'TH': 'Thailand', 'VN': 'Vietnam', 'SG': 'Singapore', 'MY': 'Malaysia',
            'PH': 'Philippines', 'ID': 'Indonesia',

            // 欧洲国家
            'DE': 'Germany', 'AT': 'Austria', 'CH': 'Switzerland', 'FR': 'France', 'BE': 'Belgium',
            'IT': 'Italy', 'ES': 'Spain', 'PT': 'Portugal', 'NL': 'Netherlands', 'SE': 'Sweden',
            'NO': 'Norway', 'DK': 'Denmark', 'FI': 'Finland', 'PL': 'Poland', 'CZ': 'Czech Republic',
            'HU': 'Hungary', 'RO': 'Romania', 'BG': 'Bulgaria', 'HR': 'Croatia', 'GR': 'Greece',

            // 美洲国家
            'MX': 'Mexico', 'BR': 'Brazil', 'AR': 'Argentina', 'CL': 'Chile', 'CO': 'Colombia',
            'PE': 'Peru', 'VE': 'Venezuela', 'UY': 'Uruguay', 'EC': 'Ecuador',

            // 其他重要国家
            'RU': 'Russia', 'TR': 'Turkey', 'SA': 'Saudi Arabia', 'AE': 'United Arab Emirates',
            'IL': 'Israel', 'EG': 'Egypt', 'NG': 'Nigeria', 'KE': 'Kenya'
        }
        return countryNameMap[countryCode] || countryCode
    }

    /**
     * 根据国家代码获取主要语言
     */
    private static getLanguageFromCountry(countryCode: string): string {
        const countryLanguageMap: { [key: string]: string } = {
            // 英语国家
            'US': 'en', 'GB': 'en', 'CA': 'en', 'AU': 'en', 'NZ': 'en', 'IE': 'en', 'ZA': 'en',

            // 亚洲语言
            'JP': 'ja',
            'CN': 'zh-CN', 'TW': 'zh-TW', 'HK': 'zh-HK',
            'KR': 'ko',
            'IN': 'hi', 'TH': 'th', 'VN': 'vi', 'SG': 'en', 'MY': 'ms', 'PH': 'en', 'ID': 'id',

            // 欧洲语言
            'DE': 'de', 'AT': 'de', 'CH': 'de',
            'FR': 'fr', 'BE': 'fr',
            'IT': 'it',
            'ES': 'es', 'PT': 'pt',
            'NL': 'nl',
            'SE': 'sv', 'NO': 'no', 'DK': 'da', 'FI': 'fi',
            'PL': 'pl', 'CZ': 'cs', 'HU': 'hu', 'RO': 'ro', 'BG': 'bg', 'HR': 'hr', 'GR': 'el',

            // 美洲语言
            'MX': 'es', 'AR': 'es', 'CL': 'es', 'CO': 'es', 'PE': 'es', 'VE': 'es', 'UY': 'es', 'EC': 'es',
            'BR': 'pt-BR',

            // 其他语言
            'RU': 'ru',
            'TR': 'tr',
            'SA': 'ar', 'AE': 'ar', 'EG': 'ar',
            'IL': 'he'
        }

        return countryLanguageMap[countryCode] || 'en'
    }

    /**
     * 获取语言配置
     */
    static getLanguageConfig(languageCode: string): LanguageConfig {
        const configs: { [key: string]: LanguageConfig } = {
            'ja': {
                code: 'ja',
                name: 'Japanese',
                googleTrendsLocale: 'JP',
                searchQueries: {
                    news: [
                        '今日のニュース',
                        '最新ニュース',
                        '日本のニュース',
                        '世界のニュース',
                        '経済ニュース',
                        'スポーツニュース',
                        '政治ニュース',
                        'テクノロジーニュース'
                    ],
                    common: [
                        '美味しいレシピ',
                        '料理の作り方',
                        '旅行先おすすめ',
                        '健康的な生活',
                        'ダイエット方法',
                        '映画レビュー',
                        '本のおすすめ',
                        'ショッピング情報',
                        '天気予報',
                        '交通情報'
                    ],
                    tech: [
                        '最新技術',
                        'AI人工知能',
                        'スマートフォン',
                        'ゲーム情報',
                        'アプリおすすめ',
                        'パソコン選び方',
                        'インターネット',
                        'プログラミング'
                    ],
                    entertainment: [
                        'アニメ新作',
                        'ドラマおすすめ',
                        '音楽ランキング',
                        '芸能ニュース',
                        '映画館情報',
                        'コンサート情報',
                        'イベント情報'
                    ],
                    sports: [
                        '野球結果',
                        'サッカー情報',
                        'オリンピック',
                        'スポーツニュース',
                        'プロ野球',
                        'Jリーグ',
                        'テニス結果'
                    ],
                    food: [
                        'グルメ情報',
                        'レストランおすすめ',
                        '和食レシピ',
                        'お弁当作り方',
                        'ケーキ作り方',
                        '地方グルメ',
                        'カフェ情報'
                    ]
                }
            },
            'en': {
                code: 'en',
                name: 'English',
                googleTrendsLocale: 'US',
                searchQueries: {
                    news: [
                        'latest news today',
                        'breaking news',
                        'world news',
                        'technology news',
                        'business news',
                        'sports news',
                        'entertainment news',
                        'health news'
                    ],
                    common: [
                        'how to cook',
                        'best recipes',
                        'travel destinations',
                        'fitness tips',
                        'healthy lifestyle',
                        'movie reviews',
                        'book recommendations',
                        'shopping deals',
                        'weather forecast'
                    ],
                    tech: [
                        'artificial intelligence',
                        'latest technology',
                        'smartphone reviews',
                        'gaming news',
                        'app recommendations',
                        'computer buying guide',
                        'internet trends',
                        'programming tutorials'
                    ],
                    entertainment: [
                        'new movies',
                        'TV shows',
                        'music charts',
                        'celebrity news',
                        'streaming services',
                        'concert tickets',
                        'entertainment events'
                    ],
                    sports: [
                        'football scores',
                        'basketball news',
                        'baseball results',
                        'soccer updates',
                        'olympic games',
                        'tennis results',
                        'sports highlights'
                    ],
                    food: [
                        'restaurant reviews',
                        'cooking tips',
                        'healthy recipes',
                        'food delivery',
                        'baking recipes',
                        'diet plans',
                        'food trends'
                    ]
                }
            },
            'zh-CN': {
                code: 'zh-CN',
                name: 'Chinese Simplified',
                googleTrendsLocale: 'CN',
                searchQueries: {
                    news: [
                        '今日新闻',
                        '最新消息',
                        '国内新闻',
                        '国际新闻',
                        '科技新闻',
                        '财经新闻',
                        '体育新闻',
                        '娱乐新闻'
                    ],
                    common: [
                        '美食制作',
                        '旅游攻略',
                        '健康生活',
                        '减肥方法',
                        '电影推荐',
                        '购物优惠',
                        '天气预报',
                        '学习方法'
                    ],
                    tech: [
                        '人工智能',
                        '最新科技',
                        '手机评测',
                        '游戏资讯',
                        '软件推荐',
                        '电脑配置',
                        '互联网',
                        '编程教程'
                    ],
                    entertainment: [
                        '电视剧推荐',
                        '音乐排行',
                        '明星动态',
                        '综艺节目',
                        '演唱会',
                        '娱乐资讯'
                    ],
                    sports: [
                        '足球比分',
                        '篮球赛事',
                        '体育赛事',
                        '奥运会',
                        '网球比赛',
                        '运动健身'
                    ],
                    food: [
                        '美食推荐',
                        '菜谱大全',
                        '餐厅推荐',
                        '家常菜',
                        '烘焙教程',
                        '地方美食'
                    ]
                }
            },
            'vi': {
                code: 'vi',
                name: 'Vietnamese',
                googleTrendsLocale: 'VN',
                searchQueries: {
                    news: [
                        'tin tức hôm nay',
                        'tin mới nhất',
                        'tin trong nước',
                        'tin quốc tế',
                        'tin công nghệ',
                        'tin kinh tế',
                        'tin thể thao',
                        'tin giải trí'
                    ],
                    common: [
                        'cách nấu ăn',
                        'địa điểm du lịch',
                        'sức khỏe',
                        'giảm cân',
                        'phim hay',
                        'mua sắm',
                        'dự báo thời tiết',
                        'học tập'
                    ],
                    tech: [
                        'trí tuệ nhân tạo',
                        'công nghệ mới',
                        'đánh giá điện thoại',
                        'tin game',
                        'ứng dụng hay',
                        'máy tính',
                        'internet',
                        'lập trình'
                    ],
                    entertainment: [
                        'phim truyền hình',
                        'nhạc hot',
                        'sao Việt',
                        'gameshow',
                        'ca nhạc',
                        'showbiz'
                    ],
                    sports: [
                        'bóng đá',
                        'bóng rổ',
                        'thể thao',
                        'Olympic',
                        'tennis',
                        'gym'
                    ],
                    food: [
                        'món ngon',
                        'công thức nấu ăn',
                        'nhà hàng',
                        'món ăn gia đình',
                        'làm bánh',
                        'ẩm thực'
                    ]
                }
            }
        }

        // 如果没有找到对应语言，返回英文配置
        return configs[languageCode] || configs['en']!
    }

    /**
     * 根据时间生成时效性搜索查询
     */
    static generateTimeBasedQueries(languageCode: string): string[] {
        const currentDate = new Date()
        const currentYear = currentDate.getFullYear()
        const currentMonth = currentDate.toLocaleDateString(languageCode === 'ja' ? 'ja-JP' : 'en-US', { month: 'long' })

        if (languageCode === 'ja') {
            return [
                `${currentYear}年のニュース`,
                `${currentMonth}の出来事`,
                '今日の話題',
                `${currentYear}年トレンド`,
                `最新の${currentMonth}情報`
            ]
        } else if (languageCode === 'zh-CN') {
            return [
                `${currentYear}年新闻`,
                `${currentMonth}大事件`,
                '今日热点',
                `${currentYear}年趋势`,
                '最新资讯'
            ]
        } else if (languageCode === 'vi') {
            return [
                `tin tức ${currentYear}`,
                `sự kiện tháng ${currentDate.getMonth() + 1}`,
                'tin hot hôm nay',
                `xu hướng ${currentYear}`,
                'cập nhật mới nhất'
            ]
        } else {
            return [
                `${currentYear} news`,
                `${currentMonth} ${currentYear} events`,
                'today\'s trending topics',
                `${currentYear} trends`,
                `latest ${currentMonth} updates`
            ]
        }
    }

    /**
     * 清除缓存（用于测试）
     */
    static clearCache(): void {
        this.geoCache.clear()
    }

    /**
     * 自动设置系统时区基于地理位置
     */
    static async autoSetTimezone(): Promise<boolean> {
        try {
            const location = await this.getCurrentLocation()
            const detectedTimezone = location.timezone
            const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
            
            // 如果检测到的时区与当前时区不同，进行设置
            if (detectedTimezone !== currentTimezone) {
                log(false, 'TIMEZONE-AUTO', `Detected timezone: ${detectedTimezone}, Current: ${currentTimezone}`)
                
                const success = await this.setSystemTimezone(detectedTimezone)
                if (success) {
                    log(false, 'TIMEZONE-AUTO', `Successfully switched timezone from ${currentTimezone} to ${detectedTimezone}`)
                    return true
                } else {
                    log(false, 'TIMEZONE-AUTO', `Failed to switch timezone to ${detectedTimezone}, keeping ${currentTimezone}`, 'warn')
                    return false
                }
            } else {
                log(false, 'TIMEZONE-AUTO', `Timezone already matches location: ${currentTimezone}`)
                return true
            }
        } catch (error) {
            log(false, 'TIMEZONE-AUTO', `Error in auto timezone detection: ${error}`, 'warn')
            return false
        }
    }

    /**
     * 设置系统时区
     */
    private static async setSystemTimezone(timezone: string): Promise<boolean> {
        try {
            // 验证时区是否有效
            if (!this.isValidTimezone(timezone)) {
                log(false, 'TIMEZONE-SET', `Invalid timezone: ${timezone}`, 'warn')
                return false
            }

            // Node.js环境中设置时区
            process.env.TZ = timezone
            
            // 验证设置是否成功
            const newTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
            if (newTimezone === timezone || this.areTimezonesEquivalent(newTimezone, timezone)) {
                log(false, 'TIMEZONE-SET', `Timezone set successfully: ${timezone}`)
                return true
            } else {
                log(false, 'TIMEZONE-SET', `Timezone setting verification failed. Expected: ${timezone}, Got: ${newTimezone}`, 'warn')
                return false
            }
        } catch (error) {
            log(false, 'TIMEZONE-SET', `Error setting timezone: ${error}`, 'warn')
            return false
        }
    }

    /**
     * 验证时区是否有效
     */
    private static isValidTimezone(timezone: string): boolean {
        try {
            Intl.DateTimeFormat(undefined, { timeZone: timezone })
            return true
        } catch (error) {
            return false
        }
    }

    /**
     * 检查两个时区是否等效（考虑别名）
     */
    private static areTimezonesEquivalent(tz1: string, tz2: string): boolean {
        // 时区别名映射
        const timezoneAliases: { [key: string]: string[] } = {
            'Asia/Tokyo': ['Japan', 'JST'],
            'Asia/Shanghai': ['Asia/Beijing', 'China/Shanghai', 'PRC'],
            'America/New_York': ['US/Eastern', 'EST', 'EDT'],
            'America/Los_Angeles': ['US/Pacific', 'PST', 'PDT'],
            'Europe/London': ['GB', 'GMT', 'BST'],
            'Europe/Paris': ['CET', 'CEST'],
            'Europe/Berlin': ['CET', 'CEST']
        }

        // 直接匹配
        if (tz1 === tz2) return true

        // 检查别名
        for (const [standard, aliases] of Object.entries(timezoneAliases)) {
            if ((tz1 === standard && aliases.includes(tz2)) ||
                (tz2 === standard && aliases.includes(tz1))) {
                return true
            }
        }

        return false
    }

    /**
     * 获取时区显示信息
     */
    static getTimezoneInfo(): {
        current: string
        offset: string
        name: string
        isDST: boolean
    } {
        const now = new Date()
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        const offset = now.getTimezoneOffset()
        const offsetHours = Math.floor(Math.abs(offset) / 60)
        const offsetMinutes = Math.abs(offset) % 60
        const offsetSign = offset <= 0 ? '+' : '-'
        
        // 获取时区名称
        const timezoneName = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            timeZoneName: 'long'
        }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value || timezone

        // 检测是否为夏令时
        const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset()
        const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset()
        const isDST = Math.max(jan, jul) !== now.getTimezoneOffset()

        return {
            current: timezone,
            offset: `UTC${offsetSign}${offsetHours.toString().padStart(2, '0')}:${offsetMinutes.toString().padStart(2, '0')}`,
            name: timezoneName,
            isDST
        }
    }

    /**
     * 检测时区是否与地理位置匹配
     */
    static async checkTimezoneLocationMatch(): Promise<{
        isMatched: boolean
        detectedTimezone: string
        currentTimezone: string
        recommendation: string
    }> {
        try {
            const location = await this.getCurrentLocation()
            const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
            const detectedTimezone = location.timezone
            
            const isMatched = this.areTimezonesEquivalent(currentTimezone, detectedTimezone)
            
            let recommendation = ''
            if (!isMatched) {
                recommendation = `建议将时区从 ${currentTimezone} 切换到 ${detectedTimezone} 以匹配您的地理位置 (${location.country})`
            } else {
                recommendation = `时区设置正确，与地理位置 (${location.country}) 匹配`
            }
            
            return {
                isMatched,
                detectedTimezone,
                currentTimezone,
                recommendation
            }
        } catch (error) {
            log(false, 'TIMEZONE-CHECK', `Error checking timezone match: ${error}`, 'warn')
            return {
                isMatched: false,
                detectedTimezone: 'Unknown',
                currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                recommendation: '无法检测地理位置，保持当前时区设置'
            }
        }
    }
}
