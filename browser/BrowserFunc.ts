import { BrowserContext, Page } from 'rebrowser-playwright'
import { CheerioAPI, load } from 'cheerio'
import { AxiosRequestConfig } from 'axios'

import { MicrosoftRewardsBot } from '../src/index'
import { saveSessionData } from '../utils/Load'
import { ManagedBrowser } from './Browser'

import { Counters, DashboardData, MorePromotion, PromotionalItem } from './../interfaces/DashboardData'
import { QuizData } from './../interfaces/QuizData'
import { AppUserData } from '../interfaces/AppUserData'
import { EarnablePoints } from '../interfaces/Points'


export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }


    /**
     * Navigate the provided page to rewards homepage
     * @param {Page} page Playwright page
    */
    async goHome(page: Page) {

        try {
            const dashboardURL = new URL(this.bot.config.baseURL)

            if (page.url() === dashboardURL.href) {
                return
            }

            await page.goto(this.bot.config.baseURL)

            const maxIterations = 5 // Maximum iterations set to 5

            for (let iteration = 1; iteration <= maxIterations; iteration++) {
                await this.bot.utils.wait(3000)
                await this.bot.browser.utils.tryDismissAllMessages(page)

                // Check if account is suspended
                const isSuspended = await page.waitForSelector('#suspendedAccountHeader', { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)
                if (isSuspended) {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'This account is suspended!', 'error')
                    throw new Error('Account has been suspended!')
                }

                try {
                    // Different selectors for mobile and desktop
                    if (this.bot.isMobile) {
                        // Mobile-specific success indicators
                        const mobileSelectors = [
                            '#more-activities',
                            '.rewards-homepage',
                            '.daily-sets',
                            'a[href*="/pointsbreakdown"]',
                            '.point-breakdown',
                            '#userPointsBreakdown'
                        ]
                        
                        let pageLoaded = false
                        for (const selector of mobileSelectors) {
                            try {
                                await page.waitForSelector(selector, { timeout: 1000 })
                                pageLoaded = true
                                break
                            } catch {
                                // Try next selector
                            }
                        }
                        
                        if (pageLoaded) {
                            this.bot.log(this.bot.isMobile, 'GO-HOME', 'Mobile homepage loaded successfully')
                            break
                        }
                    } else {
                        // Desktop version - use original selector
                        await page.waitForSelector('#more-activities', { timeout: 1000 })
                        this.bot.log(this.bot.isMobile, 'GO-HOME', 'Desktop homepage loaded successfully')
                        break
                    }

                } catch (error) {
                    // Continue if element is not found
                }

                // Below runs if the homepage was unable to be visited
                const currentURL = new URL(page.url())

                if (currentURL.hostname !== dashboardURL.hostname) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    await this.bot.utils.wait(2000)
                    await page.goto(this.bot.config.baseURL)
                } else {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'Visited homepage successfully')
                    break
                }

                await this.bot.utils.wait(5000)
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GO-HOME', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

    /**
     * Fetch user dashboard data
     * @returns {DashboardData} Object of user bing rewards dashboard data
    */
    async getDashboardData(): Promise<DashboardData> {
        try {
            // 检查主页是否已关闭
            if (this.bot.homePage.isClosed()) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Homepage was closed, reopening...', 'warn')
                // 重新打开主页而不是抛出错误
                this.bot.homePage = await this.bot.homePage.context().newPage()
                await this.goHome(this.bot.homePage)
            }

            const dashboardURL = new URL(this.bot.config.baseURL)
            const currentURL = new URL(this.bot.homePage.url())

            // Should never happen since tasks are opened in a new tab!
            if (currentURL.hostname !== dashboardURL.hostname) {
                this.bot.log(this.bot.isMobile, 'DASHBOARD-DATA', 'Provided page did not equal dashboard page, redirecting to dashboard page')
                await this.goHome(this.bot.homePage)
            }

            // Reload the page to get new data with timeout
            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Reloading page to fetch fresh dashboard data...')
            await Promise.race([
                this.bot.homePage.reload({ waitUntil: 'domcontentloaded' }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Page reload timeout after 30 seconds')), 30000)
                )
            ])

            const scriptContent = await this.bot.homePage.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script'))
                const targetScript = scripts.find(script => script.innerText.includes('var dashboard'))

                return targetScript?.innerText ? targetScript.innerText : null
            })

            if (!scriptContent) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Dashboard data not found within script', 'error')
                throw new Error('Dashboard data not found within script')
            }

            // Extract the dashboard object from the script content
            const dashboardData = await this.bot.homePage.evaluate((scriptContent: string) => {
                // Extract the dashboard object using regex
                const regex = /var dashboard = (\{.*?\});/
                const match = regex.exec(scriptContent)

                if (match && match[1]) {
                    return JSON.parse(match[1])
                }

            }, scriptContent)

            if (!dashboardData) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Unable to parse dashboard script', 'error')
                throw new Error('Unable to parse dashboard script')
            }

            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Successfully fetched dashboard data')
            return dashboardData

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', `Error fetching dashboard data: ${error}`, 'error')
            throw new Error(`Error fetching dashboard data: ${error}`)
        }

    }

    /**
     * Get search point counters
     * @returns {Counters} Object of search counter data
    */
    async getSearchPoints(): Promise<Counters> {
        const dashboardData = await this.getDashboardData() // Always fetch newest data

        return dashboardData.userStatus.counters
    }

    /**
     * Get total earnable points with web browser
     * @returns {number} Total earnable points
    */
    async getBrowserEarnablePoints(): Promise<EarnablePoints> {
        try {
            let desktopSearchPoints = 0
            let mobileSearchPoints = 0
            let dailySetPoints = 0
            let morePromotionsPoints = 0

            const data = await this.getDashboardData()

            // Desktop Search Points
            if (data.userStatus.counters.pcSearch?.length) {
                data.userStatus.counters.pcSearch.forEach(x => desktopSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Mobile Search Points
            if (data.userStatus.counters.mobileSearch?.length) {
                data.userStatus.counters.mobileSearch.forEach(x => mobileSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Daily Set
            data.dailySetPromotions[this.bot.utils.getFormattedDate()]?.forEach(x => dailySetPoints += (x.pointProgressMax - x.pointProgress))

            // More Promotions
            if (data.morePromotions?.length) {
                data.morePromotions.forEach(x => {
                    // Only count points from supported activities
                    if (['quiz', 'urlreward'].includes(x.promotionType) && x.exclusiveLockedFeatureStatus !== 'locked') {
                        morePromotionsPoints += (x.pointProgressMax - x.pointProgress)
                    }
                })
            }

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-BROWSER-EARNABLE-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

    /**
     * Get total earnable points with mobile app
     * @returns {number} Total earnable points
    */
    async getAppEarnablePoints(accessToken: string) {
        try {
            const points = {
                readToEarn: 0,
                checkIn: 0,
                totalEarnablePoints: 0
            }

            const eligibleOffers = [
                'ENUS_readarticle3_30points',
                'Gamification_Sapphire_DailyCheckIn'
            ]

            const data = await this.getDashboardData()
            let geoLocale = data.userProfile.attributes.country
            geoLocale = (this.bot.config.searchSettings.useGeoLocaleQueries && geoLocale.length === 2) ? geoLocale.toLowerCase() : 'us'

            const userDataRequest: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                }
            }

            const userDataResponse: AppUserData = (await this.bot.axios.request(userDataRequest)).data
            const userData = userDataResponse.response
            const eligibleActivities = userData.promotions.filter((x) => eligibleOffers.includes(x.attributes.offerid ?? ''))

            for (const item of eligibleActivities) {
                if (item.attributes.type === 'msnreadearn') {
                    points.readToEarn = parseInt(item.attributes.pointmax ?? '') - parseInt(item.attributes.pointprogress ?? '')
                    break
                } else if (item.attributes.type === 'checkin') {
                    const checkInDay = parseInt(item.attributes.progress ?? '') % 7

                    if (checkInDay < 6 && (new Date()).getDate() != (new Date(item.attributes.last_updated ?? '')).getDate()) {
                        points.checkIn = parseInt(item.attributes['day_' + (checkInDay + 1) + '_points'] ?? '')
                    }
                    break
                }
            }

            points.totalEarnablePoints = points.readToEarn + points.checkIn

            return points
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

    /**
     * Get current point amount
     * @returns {number} Current total point amount
    */
    async getCurrentPoints(): Promise<number> {
        try {
            const data = await this.getDashboardData()

            return data.userStatus.availablePoints
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-CURRENT-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

    /**
     * Parse quiz data from provided page with enhanced fallback methods
     * @param {Page} page Playwright page
     * @returns {QuizData} Quiz data object
    */
    async getQuizData(page: Page): Promise<QuizData> {
        try {
            // 首先检查页面是否已关闭
            if (page.isClosed()) {
                throw new Error('Page has been closed')
            }

            // 方法1: 直接从JavaScript变量获取数据
            const directData = await this.getQuizDataDirect(page)
            if (directData) {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Quiz data obtained via direct JS evaluation')
                return directData
            }

            // 方法2: 从Script标签解析数据
            const scriptData = await this.getQuizDataFromScript(page)
            if (scriptData) {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Quiz data obtained via script parsing')
                return scriptData
            }

            // 方法3: 监听网络请求获取数据
            const apiData = await this.getQuizDataFromAPI(page)
            if (apiData) {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Quiz data obtained via API interception')
                return apiData
            }

            // 记录调试信息
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', `Page URL: ${page.url()}`, 'warn')
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'All quiz data extraction methods failed', 'error')
            throw new Error('All quiz data extraction methods failed')

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', `Quiz data extraction failed: ${error}`, 'error')
            throw error
        }
    }

    /**
     * 直接从JavaScript变量获取Quiz数据
     */
    private async getQuizDataDirect(page: Page): Promise<QuizData | null> {
        try {
            const quizData = await page.evaluate(() => {
                // 定义Quiz数据的基本结构
                interface QuizDataStructure {
                    maxQuestions?: number
                    correctAnswer?: string | number
                    numberOfOptions?: number
                    questions?: Array<{
                        question: string
                        options: string[]
                        correctAnswerIndex?: number
                    }>
                    currentQuestionIndex?: number
                    [key: string]: unknown
                }

                // 定义window的扩展类型
                interface ExtendedWindow extends Window {
                    _w?: { rewardsQuizRenderInfo?: QuizDataStructure }
                    rewardsQuizRenderInfo?: QuizDataStructure
                    Microsoft?: { Rewards?: { Quiz?: QuizDataStructure } }
                    quiz_data?: QuizDataStructure
                    quizData?: QuizDataStructure
                    REWARDS_QUIZ_DATA?: QuizDataStructure
                }

                const win = window as ExtendedWindow
                
                // 尝试多种可能的全局变量
                const candidates = [
                    win._w?.rewardsQuizRenderInfo,
                    win.rewardsQuizRenderInfo,
                    win.Microsoft?.Rewards?.Quiz,
                    win.quiz_data,
                    win.quizData,
                    win.REWARDS_QUIZ_DATA
                ]

                for (const candidate of candidates) {
                    if (candidate && typeof candidate === 'object') {
                        // 验证是否包含Quiz必需的字段
                        if (candidate.maxQuestions || candidate.correctAnswer || candidate.numberOfOptions) {
                            return candidate
                        }
                    }
                }
                return null
            })

            return quizData as unknown as QuizData | null
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-DIRECT', `Direct evaluation failed: ${error}`, 'warn')
            return null
        }
    }

    /**
     * 从Script标签解析Quiz数据
     */
    private async getQuizDataFromScript(page: Page): Promise<QuizData | null> {
        try {
            const html = await page.content()
            const $ = load(html)

            // 扩展的script数据模式
            const scriptPatterns = [
                { name: '_w.rewardsQuizRenderInfo', regex: /_w\.rewardsQuizRenderInfo\s*=\s*({.*?});/ },
                { name: 'rewardsQuizRenderInfo', regex: /rewardsQuizRenderInfo\s*[=:]\s*({.*?});?/ },
                { name: 'window.rewardsQuizRenderInfo', regex: /window\.rewardsQuizRenderInfo\s*=\s*({.*?});/ },
                { name: 'Microsoft.Rewards.Quiz', regex: /Microsoft\.Rewards\.Quiz[^=]*=\s*({.*?});/ },
                { name: 'quiz_data', regex: /quiz_data\s*[=:]\s*({.*?});?/ },
                { name: 'quizData', regex: /quizData\s*[=:]\s*({.*?});?/ },
                { name: 'REWARDS_QUIZ_DATA', regex: /REWARDS_QUIZ_DATA\s*[=:]\s*({.*?});?/ }
            ]

            let scriptContent = ''

            // 检查每个script标签
            for (const pattern of scriptPatterns) {
                const scripts = $('script').filter((_, element) => {
                    const content = $(element).text() || ''
                    const searchTerm = pattern.name.split('.')[0] || pattern.name
                    return content.includes(searchTerm)
                })
                
                if (scripts.length > 0) {
                    scriptContent = scripts.text()
                    this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-SCRIPT', `Found pattern: ${pattern.name}`)
                    
                    const match = pattern.regex.exec(scriptContent)
                    if (match && match[1]) {
                        try {
                            const quizData = JSON.parse(match[1])
                            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-SCRIPT', 'Quiz data parsed successfully')
                            return quizData as QuizData
                        } catch (parseError) {
                            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-SCRIPT', `JSON parse failed for ${pattern.name}: ${parseError}`, 'warn')
                            continue // 尝试下一个模式
                        }
                    }
                }
            }

            return null
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-SCRIPT', `Script parsing failed: ${error}`, 'warn')
            return null
        }
    }

    /**
     * 通过API请求拦截获取Quiz数据
     */
    private async getQuizDataFromAPI(page: Page): Promise<QuizData | null> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 8000)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let responseHandler: ((response: any) => void) | null = null

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseHandler = async (response: any) => {
                try {
                    if (!response || typeof response.url !== 'function') return
                    
                    const url = response.url()
                    if (!url || typeof url !== 'string') return
                    
                    // 检查可能的Quiz API端点
                    if (url.includes('/quiz/') || 
                        url.includes('/rewards/api/') ||
                        (url.includes('quiz') && url.includes('api')) ||
                        url.includes('/activities/quiz')) {
                        
                        if (typeof response.headers === 'function') {
                        const headers = response.headers()
                        const contentType = String(headers['content-type'] || headers['Content-Type'] || '')
                            if (contentType.includes('application/json') && typeof response.json === 'function') {
                            const data = await response.json()
                            
                            // 验证是否为Quiz数据
                            if (data && (data.maxQuestions || data.correctAnswer || data.numberOfOptions)) {
                                clearTimeout(timeout)
                                if (responseHandler) {
                                    page.off('response', responseHandler)
                                }
                                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA-API', `Quiz data found via API: ${url}`)
                                resolve(data as QuizData)
                                return
                                }
                            }
                        }
                    }
                } catch (error) {
                    // 忽略非JSON响应或解析错误
                }
            }

            page.on('response', responseHandler)

            // 触发可能的数据加载
            page.reload().catch(() => {
                // 如果页面已经在加载中，忽略错误
            })
        })
    }

    async waitForQuizRefresh(page: Page): Promise<boolean> {
        try {
            // 尝试多种积分显示元素
            const creditSelectors = [
                'span.rqMCredits',
                '.rqMCredits',
                '[class*="credits"]',
                '[data-testid*="points"]',
                '[data-testid*="credits"]',
                '.points-earned',
                '.quiz-points'
            ]
            
            let found = false
            for (const selector of creditSelectors) {
                try {
                    await page.waitForSelector(selector, { state: 'visible', timeout: 2000 })
                    this.bot.log(this.bot.isMobile, 'QUIZ-REFRESH', `Quiz refresh detected with selector: ${selector}`)
                    found = true
                    break
                } catch {
                    continue
                }
            }
            
            if (!found) {
                // 如果没有找到积分元素，等待页面稳定
                await this.bot.utils.wait(3000)
                this.bot.log(this.bot.isMobile, 'QUIZ-REFRESH', 'No credit element found, assuming refresh completed')
            }

            await this.bot.utils.wait(2000)
            return true
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'QUIZ-REFRESH', 'An error occurred:' + error, 'error')
            return false
        }
    }

    async checkQuizCompleted(page: Page): Promise<boolean> {
        try {
            // 尝试多种Quiz完成指示器
            const completionSelectors = [
                '#quizCompleteContainer',
                '.quiz-complete',
                '.quiz-finished',
                '[data-testid="quiz-complete"]',
                '[class*="complete"]',
                '.completion-message',
                '.quiz-results'
            ]
            
            for (const selector of completionSelectors) {
                try {
                    await page.waitForSelector(selector, { state: 'visible', timeout: 1000 })
                    this.bot.log(this.bot.isMobile, 'QUIZ-COMPLETE', `Quiz completion detected with selector: ${selector}`)
                    await this.bot.utils.wait(2000)
                    return true
                } catch {
                    continue
                }
            }
            
            return false
        } catch (error) {
            return false
        }
    }

    async loadInCheerio(page: Page): Promise<CheerioAPI> {
        const html = await page.content()
        const $ = load(html)

        return $
    }

    async getPunchCardActivity(page: Page, activity: PromotionalItem | MorePromotion): Promise<string> {
        let selector = ''
        try {
            const html = await page.content()
            const $ = load(html)

            const element = $('.offer-cta').toArray().find(x => x.attribs.href?.includes(activity.offerId))
            if (element) {
                selector = `a[href*="${element.attribs.href}"]`
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-PUNCHCARD-ACTIVITY', 'An error occurred:' + error, 'error')
        }

        return selector
    }

    async closeBrowser(managedBrowser: ManagedBrowser) {
        try {
            // Save cookies
            await saveSessionData(this.bot.config.sessionPath, managedBrowser.context, managedBrowser.email, managedBrowser.isMobile)

            await this.bot.utils.wait(2000)

            // Close browser context first
            await managedBrowser.context.close()
            this.bot.log(managedBrowser.isMobile, 'CLOSE-BROWSER', 'Browser context closed')

            // Then close the browser instance to prevent process leakage
            await managedBrowser.browserInstance.close()
            this.bot.log(managedBrowser.isMobile, 'CLOSE-BROWSER', 'Browser instance closed cleanly!')

        } catch (error) {
            this.bot.log(managedBrowser.isMobile, 'CLOSE-BROWSER', `An error occurred: ${error}`, 'error')

            // Attempt force cleanup if normal close fails
            try {
                if (managedBrowser.context && !(managedBrowser.context as any).isClosed) {
                    await managedBrowser.context.close()
                }
                if (managedBrowser.browserInstance && managedBrowser.browserInstance.isConnected()) {
                    await managedBrowser.browserInstance.close()
                }
            } catch (forceCloseError) {
                this.bot.log(managedBrowser.isMobile, 'CLOSE-BROWSER', `Force close also failed: ${forceCloseError}`, 'error')
            }

            throw new Error(`Browser cleanup failed: ${error}`)
        }
    }

    // 保持向后兼容的方法（已弃用）
    async closeBrowserLegacy(browser: BrowserContext, email: string) {
        try {
            // Save cookies
            await saveSessionData(this.bot.config.sessionPath, browser, email, this.bot.isMobile)

            await this.bot.utils.wait(2000)

            // Close browser context only (legacy behavior)
            await browser.close()
            this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER-LEGACY', 'Browser context closed (legacy mode - browser instance may still be running!)', 'warn')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER-LEGACY', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }
}