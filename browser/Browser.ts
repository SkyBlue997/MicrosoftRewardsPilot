import { chromium, BrowserContext, Browser as PlaywrightBrowser, Page } from 'rebrowser-playwright'

import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import { MicrosoftRewardsBot } from '../src/index'
import { loadSessionData, saveFingerprintData } from '../utils/Load'
import { setBrowserEngineVersion, updateFingerprintUserAgent } from '../utils/UserAgent'
import { GeoLanguageDetector } from '../utils/GeoLanguage'

import { AccountProxy } from '../interfaces/Account'

// 定义浏览器管理对象的接口
export interface ManagedBrowser {
    browserInstance: PlaywrightBrowser
    context: BrowserContext
    email: string
    isMobile: boolean
}

// The part of a fingerprint's `screen` object the window geometry is derived from
interface FingerprintScreen {
    width: number
    height: number
    availWidth: number
    availHeight: number
    outerWidth: number
    outerHeight: number
    devicePixelRatio: number
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

    /** Timezone of the IP the browser will appear from (through the account's proxy, if any). */
    private async detectTimezone(proxy: AccountProxy): Promise<string> {
        try {
            const location = await GeoLanguageDetector.getCurrentLocation(proxy)
            this.bot.log(this.bot.isMobile, 'BROWSER-GEO', `Location: ${location.country} (${location.countryCode}), ${location.city} | timezone: ${location.timezone}`)
            return location.timezone
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'BROWSER-GEO', `Failed to detect location, using default timezone (Asia/Tokyo): ${error}`, 'warn')
            return 'Asia/Tokyo'
        }
    }

    /**
     * The real viewport (window.innerWidth/innerHeight) and device scale that agree with what the
     * injected fingerprint reports for the screen and for window.outerWidth/outerHeight.
     *
     * fingerprint-injector's own default is a viewport of the full SCREEN size, while it reports the
     * fingerprint's recorded (smaller) outer size: a page then sees innerWidth > outerWidth and a
     * window as large as the monitor — impossible for a real browser. It also reports the
     * fingerprint's devicePixelRatio without the page actually being rendered at that scale.
     */
    private windowGeometry(screen: FingerprintScreen): { viewport: { width: number, height: number }, deviceScaleFactor: number } {
        const within = (value: number, max: number): boolean => value > 0 && value <= max
        const availWidth = within(screen.availWidth, screen.width) ? screen.availWidth : screen.width
        const availHeight = within(screen.availHeight, screen.height) ? screen.availHeight : screen.height
        const outerWidth = within(screen.outerWidth, screen.width) ? screen.outerWidth : availWidth
        const outerHeight = within(screen.outerHeight, screen.height) ? screen.outerHeight : availHeight
        const deviceScaleFactor = screen.devicePixelRatio > 0 ? screen.devicePixelRatio : 1

        if (this.bot.isMobile) {
            // A mobile browser has no window frame: the page area is the window.
            return { viewport: { width: outerWidth, height: outerHeight }, deviceScaleFactor }
        }

        // Desktop Edge: tab strip + toolbar above the page (87 CSS px); a window that isn't maximised
        // also has its frame (8 px left, right and bottom).
        const windowed = outerWidth < availWidth
        return {
            viewport: {
                width: Math.max(320, outerWidth - (windowed ? 16 : 0)),
                height: Math.max(240, outerHeight - (windowed ? 95 : 87))
            },
            deviceScaleFactor
        }
    }

    /**
     * Give the browser itself the client-hint values the fingerprint claims (brands, full versions,
     * platform version, model, ...). Without this Playwright derives them from the UA string alone, so
     * when a site asks for them (Bing does, via Accept-CH) the request headers say e.g.
     * platform-version "10.0" and model "" while navigator.userAgentData in the page says something
     * else — and "10.0" is not a value any real Windows Edge sends.
     */
    private async applyClientHints(context: BrowserContext, page: Page, fingerprint: BrowserFingerprintWithHeaders): Promise<void> {
        try {
            const navigator = fingerprint.fingerprint.navigator
            const data = navigator.userAgentData as unknown as {
                brands: { brand: string, version: string }[]
                fullVersionList: { brand: string, version: string }[]
                platform: string
                platformVersion: string
                architecture: string
                bitness: string
                model: string
            }
            const session = await context.newCDPSession(page)
            await session.send('Emulation.setUserAgentOverride', {
                userAgent: navigator.userAgent,
                acceptLanguage: fingerprint.headers['accept-language'],
                platform: navigator.platform,
                userAgentMetadata: {
                    brands: data.brands,
                    fullVersionList: data.fullVersionList,
                    fullVersion: data.fullVersionList[0]?.version ?? '',
                    platform: data.platform,
                    platformVersion: data.platformVersion,
                    architecture: data.architecture,
                    bitness: data.bitness,
                    model: data.model,
                    mobile: this.bot.isMobile,
                    wow64: false
                }
            })
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'BROWSER', `Could not set client-hint metadata on a page: ${error}`, 'warn')
        }
    }

    async createBrowser(proxy: AccountProxy, email: string): Promise<ManagedBrowser> {
        const timezoneId = await this.detectTimezone(proxy)

        const browser = await chromium.launch({
            // Headless runs use Chromium's NEW headless mode — the full browser without a window. The
            // default headless is a separate, stripped-down "headless shell" binary and a page can
            // tell: no window.chrome, no plugins / PDF viewer, Notification permission "denied".
            ...(this.bot.config.headless && { channel: 'chromium' }),
            headless: this.bot.config.headless,
            ...(proxy.url && { proxy: { username: proxy.username, password: proxy.password, server: `${proxy.url}:${proxy.port}` } }),
            args: [
                // 基础安全参数（保留必要的）
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',

                // 反检测：在 blink 层移除 webdriver 标识（与 rebrowser 的 Runtime.enable 修复互为冗余保险）
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor',

                // WebRTC 隐私保护
                '--disable-webrtc-hw-encoding',
                '--disable-webrtc-hw-decoding',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',

                // 性能和稳定性（保持自然）
                '--enable-features=NetworkService,NetworkServiceLogging',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--use-mock-keychain',

                // 保留必要的稳定性参数
                '--no-first-run',
                '--disable-gpu',
                '--memory-pressure-off',
                '--max_old_space_size=4096',
                '--password-store=basic'
                // NOTE: removed the malformed/contradictory switches that previously lived here
                // (--exclude-switches=enable-automation, --disable-automation, --enable-automation=false,
                // and several '...=false'-suffixed flags). Chromium boolean switches take no '=false'
                // value, so those were no-ops at best and an inconsistent launch signature at worst.
            ]
        })

        // The UA may not claim a newer browser than the engine that is really running; both the
        // saved-fingerprint check in loadSessionData and a fresh fingerprint depend on this.
        setBrowserEngineVersion(browser.version())

        const sessionData = await loadSessionData(this.bot.config.sessionPath, email, this.bot.isMobile, this.bot.config.saveFingerprint)

        const fingerprint = sessionData.fingerprint ? sessionData.fingerprint : await this.generateFingerprint()

        // fingerprint-injector only reads `fingerprint` and `newContextOptions` — context options
        // passed beside them (as this used to do with viewport, isMobile, hasTouch, timezone, ...) are
        // silently dropped. The user agent comes from the fingerprint.
        const { viewport, deviceScaleFactor } = this.windowGeometry(fingerprint.fingerprint.screen as FingerprintScreen)
        //
        // It also sends every header stored in the fingerprint on EVERY request. The full version list
        // is a high-entropy hint a browser only sends to sites that asked for it, so it must not be in
        // there; the browser sends it itself once applyClientHints has told it the values.
        const injectedHeaders = { ...fingerprint.headers }
        delete injectedHeaders['sec-ch-ua-full-version-list']
        const context = await newInjectedContext(browser as PlaywrightBrowser, {
            fingerprint: { ...fingerprint, headers: injectedHeaders },
            newContextOptions: {
                viewport,
                deviceScaleFactor,
                // so the device-width/device-height media queries agree with the injected window.screen
                screen: { width: fingerprint.fingerprint.screen.width, height: fingerprint.fingerprint.screen.height },
                timezoneId,
                // Real touch + mobile viewport behaviour, to go with the fingerprint's maxTouchPoints
                ...(this.bot.isMobile && { isMobile: true, hasTouch: true })
            }
        })

        // Pages the bot opens get the client hints before they can navigate; pages a site opens
        // (target=_blank) get them as soon as they exist.
        const openPage = context.newPage.bind(context)
        context.newPage = async (): Promise<Page> => {
            const page = await openPage()
            await this.applyClientHints(context, page, fingerprint)
            return page
        }
        context.on('page', (page: Page) => { void this.applyClientHints(context, page, fingerprint) })

        // Per-action default timeout — deliberately short so a single hung selector/navigation
        // fails fast instead of blocking for the entire globalTimeout (the per-account run budget).
        context.setDefaultTimeout(30_000)
        context.setDefaultNavigationTimeout(60_000)

        await context.addCookies(sessionData.cookies)

        if (this.bot.config.saveFingerprint) {
            await saveFingerprintData(this.bot.config.sessionPath, email, this.bot.isMobile, fingerprint)
        }

        this.bot.log(this.bot.isMobile, 'BROWSER', `Created browser (Chromium ${browser.version()}) with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`)
        this.bot.log(this.bot.isMobile, 'BROWSER', `Window: ${viewport.width}x${viewport.height} @${deviceScaleFactor}x${this.bot.isMobile ? ', touch' : ''} | timezone: ${timezoneId}`)

        // Anti-detection fingerprint is applied at the context level by newInjectedContext
        // (fingerprint-injector), covering every page in the context. No per-page stealth
        // injection is done here (it previously ran on a throwaway page and had no effect).

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
