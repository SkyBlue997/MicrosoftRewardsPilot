import { chromium, BrowserContext, Browser as PlaywrightBrowser } from 'rebrowser-playwright'

import { newInjectedContext } from 'fingerprint-injector'
import { FingerprintGenerator } from 'fingerprint-generator'

import { MicrosoftRewardsBot } from '../src/index'
import { loadSessionData, saveFingerprintData } from '../utils/Load'
import { updateFingerprintUserAgent } from '../utils/UserAgent'
import { GeoLanguageDetector, GeoLocation } from '../utils/GeoLanguage'
import { WebDriverStealth } from '../src/anti-detection/webdriver-stealth'
import { NextGenAntiDetectionController } from '../src/anti-detection/next-gen-controller'

import { AccountProxy } from '../interfaces/Account'

// 定义浏览器管理对象的接口
export interface ManagedBrowser {
    browserInstance: PlaywrightBrowser
    context: BrowserContext
    email: string
    isMobile: boolean
}

// 定义浏览器上下文选项的类型
interface BrowserContextOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fingerprint?: any // 第三方库的指纹类型，必须使用any以兼容外部库
    viewport?: { width: number; height: number }
    deviceScaleFactor?: number
    isMobile?: boolean
    hasTouch?: boolean
    userAgent?: string
    locale?: string
    timezoneId?: string
    permissions?: string[]
    geolocation?: { latitude: number; longitude: number }
    extraHTTPHeaders?: Record<string, string>
}

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

class Browser {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * 根据地理位置获取浏览器配置
     */
    private async getGeoLocationConfig(proxy: AccountProxy): Promise<{
        locale: string
        timezoneId: string
        geolocation: { latitude: number; longitude: number }
        extraHTTPHeaders: Record<string, string>
    }> {
        try {
            // 获取地理位置信息（包含真实的IP定位经纬度）
            const location: GeoLocation = await GeoLanguageDetector.getCurrentLocation(proxy)
            
            // 根据国家代码获取语言设置
            const localeMap: Record<string, string> = {
                'JP': 'ja-JP',
                'CN': 'zh-CN', 
                'TW': 'zh-TW',
                'HK': 'zh-HK',
                'KR': 'ko-KR',
                'VN': 'vi-VN',
                'TH': 'th-TH',
                'US': 'en-US',
                'GB': 'en-GB',
                'AU': 'en-AU',
                'CA': 'en-CA',
                'DE': 'de-DE',
                'FR': 'fr-FR',
                'ES': 'es-ES',
                'IT': 'it-IT',
                'BR': 'pt-BR',
                'RU': 'ru-RU',
                'IN': 'hi-IN',
                'ID': 'id-ID',
                'MY': 'ms-MY',
                'PH': 'en-PH',
                'SG': 'en-SG'
            }

            const locale = localeMap[location.countryCode] || 'en-US'
            
            // 使用真实的IP定位经纬度
            const coordinates = {
                latitude: location.latitude,
                longitude: location.longitude
            }

            // 根据语言设置HTTP头部
            const acceptLanguage = this.getAcceptLanguageHeader(location.language)
            
            this.bot.log(this.bot.isMobile, 'BROWSER-GEO', 
                `Auto-detected location: ${location.country} (${location.countryCode}) | ` +
                `Language: ${location.language} | Locale: ${locale} | ` +
                `Timezone: ${location.timezone} | Real coordinates: ${coordinates.latitude}, ${coordinates.longitude} | ` +
                `City: ${location.city}`)

            return {
                locale,
                timezoneId: location.timezone,
                geolocation: coordinates,
                extraHTTPHeaders: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': acceptLanguage,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Upgrade-Insecure-Requests': '1',
                    ...(this.bot.isMobile && {
                        'sec-ch-ua-mobile': '?1',
                        'sec-ch-ua-platform': '"Android"'
                    })
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'BROWSER-GEO', 
                `Failed to detect location, using default (Japan): ${error}`, 'warn')
            
            // 如果地理位置检测失败，返回默认的日本配置
            return {
                locale: 'ja-JP',
                timezoneId: 'Asia/Tokyo',
                geolocation: { latitude: 35.6762, longitude: 139.6503 },
                extraHTTPHeaders: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Upgrade-Insecure-Requests': '1',
                    ...(this.bot.isMobile && {
                        'sec-ch-ua-mobile': '?1',
                        'sec-ch-ua-platform': '"Android"'
                    })
                }
            }
        }
    }

    /**
     * 根据语言生成Accept-Language头部
     */
    private getAcceptLanguageHeader(language: string): string {
        const languageHeaders: Record<string, string> = {
            'ja': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
            'zh-CN': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'zh-TW': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'zh-HK': 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'ko': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'vi': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'th': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
            'en': 'en-US,en;q=0.9',
            'de': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
            'fr': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'es': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
            'it': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'pt-BR': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'ru': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'hi': 'hi-IN,hi;q=0.9,en-US;q=0.8,en;q=0.7'
        }

        return languageHeaders[language] || 'en-US,en;q=0.9'
    }

    async createBrowser(proxy: AccountProxy, email: string): Promise<ManagedBrowser> {
        // 获取地理位置配置
        const geoConfig = await this.getGeoLocationConfig(proxy)

        // 调试日志：确认headless配置
        this.bot.log(this.bot.isMobile, 'BROWSER-DEBUG', `Headless mode from config: ${this.bot.config.headless}`)

        const browser = await chromium.launch({
            //channel: 'msedge', // Uses Edge instead of chrome
            headless: this.bot.config.headless,
            ...(proxy.url && { proxy: { username: proxy.username, password: proxy.password, server: `${proxy.url}:${proxy.port}` } }),
            args: [
                // 基础安全参数（保留必要的）
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',

                // 关键反检测参数
                '--disable-blink-features=AutomationControlled',
                '--exclude-switches=enable-automation',
                '--disable-automation',
                '--disable-features=VizDisplayCompositor',

                // WebRTC 隐私保护
                '--disable-webrtc-hw-encoding',
                '--disable-webrtc-hw-decoding',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',

                // 性能和稳定性（保持自然）
                '--disable-background-timer-throttling=false',
                '--disable-backgrounding-occluded-windows=false',
                '--disable-renderer-backgrounding=false',
                '--enable-features=NetworkService,NetworkServiceLogging',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--use-mock-keychain',

                // 移除明显的自动化标识
                // 注释掉这些明显的机器人参数：
                // '--disable-web-security',
                // '--disable-features=TranslateUI',
                // '--disable-plugins',
                // '--disable-extensions',
                // '--disable-sync',
                // '--disable-background-networking',
                // '--no-default-browser-check',

                // 保留必要的稳定性参数
                '--no-first-run',
                '--disable-gpu',
                '--memory-pressure-off',
                '--max_old_space_size=4096',

                // 新增自然浏览器行为
                '--enable-automation=false',
                '--password-store=basic',
                '--disable-component-extensions-with-background-pages=false'
            ]
        })

        const sessionData = await loadSessionData(this.bot.config.sessionPath, email, this.bot.isMobile, this.bot.config.saveFingerprint)

        const fingerprint = sessionData.fingerprint ? sessionData.fingerprint : await this.generateFingerprint()

        // 创建浏览器上下文，使用自动检测的地理位置配置
        const baseContextOptions: BrowserContextOptions = { 
            fingerprint: fingerprint,
            locale: geoConfig.locale,
            timezoneId: geoConfig.timezoneId,
            geolocation: geoConfig.geolocation,
            extraHTTPHeaders: geoConfig.extraHTTPHeaders
        }

        let contextOptions: BrowserContextOptions

        // 关键修复：为移动端添加完整的移动设备配置
        if (this.bot.isMobile) {
            contextOptions = {
                ...baseContextOptions,
                viewport: { 
                    width: 412, 
                    height: 915 
                }, // 标准移动端屏幕尺寸
                deviceScaleFactor: 3, // 高分辨率移动设备
                isMobile: true, // 关键：标识为移动设备
                hasTouch: true, // 关键：启用触摸支持
                userAgent: fingerprint.fingerprint.navigator.userAgent, // 确保使用移动端UA
                permissions: ['geolocation'] // 移动端权限
            }
            
            this.bot.log(this.bot.isMobile, 'BROWSER-MOBILE', 'Configuring browser with full mobile device simulation')
            this.bot.log(this.bot.isMobile, 'BROWSER-MOBILE', 'Viewport: 412x915, Touch: enabled, Mobile: true')
            this.bot.log(this.bot.isMobile, 'BROWSER-MOBILE', `Auto-detected locale: ${geoConfig.locale}, timezone: ${geoConfig.timezoneId}`)
        } else {
            // 桌面端配置
            contextOptions = {
                ...baseContextOptions,
                viewport: { 
                    width: 1920, 
                    height: 1080 
                }
            }
            
            this.bot.log(this.bot.isMobile, 'BROWSER-DESKTOP', `Auto-detected locale: ${geoConfig.locale}, timezone: ${geoConfig.timezoneId}`)
        }

        const context = await newInjectedContext(browser as PlaywrightBrowser, contextOptions)

        // Set timeout to preferred amount
        context.setDefaultTimeout(this.bot.utils.stringToMs(this.bot.config?.globalTimeout ?? 30000))

        await context.addCookies(sessionData.cookies)

        if (this.bot.config.saveFingerprint) {
            await saveFingerprintData(this.bot.config.sessionPath, email, this.bot.isMobile, fingerprint)
        }

        this.bot.log(this.bot.isMobile, 'BROWSER', `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`)
        this.bot.log(this.bot.isMobile, 'BROWSER', `Location settings: ${geoConfig.locale} | ${geoConfig.timezoneId} | ${geoConfig.geolocation.latitude}, ${geoConfig.geolocation.longitude}`)

        // 移动端额外验证日志
        if (this.bot.isMobile) {
            this.bot.log(this.bot.isMobile, 'BROWSER-MOBILE', 'Mobile browser features: Touch=✓, Mobile=✓, Viewport=412x915, Platform=Android')
        }

        // 注入反检测脚本
        try {
            const page = await context.newPage()

            // 基础隐身脚本
            await WebDriverStealth.injectStealthScript(page)
            await WebDriverStealth.injectCanvasNoise(page)

            if (this.bot.isMobile) {
                await WebDriverStealth.injectMobileStealth(page)
            }

            // 下一代反检测系统
            const nextGenController = new NextGenAntiDetectionController()
            await nextGenController.initialize(context, page)

            await page.close()
            this.bot.log(this.bot.isMobile, 'ANTI-DETECTION', 'Next-Gen Anti-Detection System activated successfully')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'ANTI-DETECTION', `Failed to inject anti-detection systems: ${error}`, 'warn')
        }

        // 返回包含浏览器实例和上下文的管理对象
        return {
            browserInstance: browser as PlaywrightBrowser,
            context: context as BrowserContext,
            email: email,
            isMobile: this.bot.isMobile
        }
    }

    async generateFingerprint() {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: this.bot.isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: this.bot.isMobile ? ['android'] : ['windows'],
            browsers: [{ name: 'edge' }]
        })

        const updatedFingerPrintData = await updateFingerprintUserAgent(fingerPrintData, this.bot.isMobile)

        return updatedFingerPrintData
    }
}

export default Browser
