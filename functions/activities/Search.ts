import {Page} from 'rebrowser-playwright'
import {platform} from 'os'

import {Workers} from '../Workers'
import {IntelligentDelaySystem} from '../../src/anti-detection/intelligent-delay'
import {ContextualSearchGenerator} from '../../src/anti-detection/contextual-search'
import {HumanBehaviorSimulator} from '../../src/anti-detection/human-behavior'
import {SessionManager} from '../../src/anti-detection/session-manager'

import {Counters, DashboardData} from '../../interfaces/DashboardData'
import {GoogleSearch} from '../../interfaces/Search'
import {AxiosRequestConfig} from 'axios'

// 扩展 Window 和 Navigator 接口以支持非标准属性
declare global {
    interface Window {
        gc?: () => void
        ontouchstart?: (() => void) | null
    }

    interface Navigator {
        deviceMemory?: number
    }
}

// 定义语言配置接口
interface LanguageConfig {
    name: string
    code: string
    googleTrendsLocale: string
    searchQueries: {
        news: string[]
        common: string[]
        food: string[]
        tech: string[]
        entertainment: string[]
        sports: string[]
    }
}

// 定义地理位置接口
interface GeoLocation {
    country: string
    countryCode: string
    city: string
    timezone: string
    language: string
    currency: string
    ip: string
    latitude?: number
    longitude?: number
}

type GoogleTrendsResponse = [
    string,
    [
        string,
        ...null[],
        [string, ...string[]]
    ][]
];

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''
    private consecutiveFailures = 0
    private adaptiveDelayMultiplier = 1.0

    // 反检测系统实例
    private intelligentDelay: IntelligentDelaySystem
    private contextualSearch: ContextualSearchGenerator
    private humanBehavior: HumanBehaviorSimulator
    private sessionManager: SessionManager

    constructor(bot: any) {
        super(bot)
        this.intelligentDelay = new IntelligentDelaySystem()
        this.contextualSearch = new ContextualSearchGenerator()
        this.humanBehavior = new HumanBehaviorSimulator()
        this.sessionManager = new SessionManager({
            userType: 'normal',
            activityLevel: 'medium',
            attentionSpan: 'medium',
            multitaskingTendency: 'low'
        })
    }

    public async doSearch(page: Page, data: DashboardData) {
        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Starting Bing searches')

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        // 记录初始搜索状态
        if (this.bot.isMobile) {
            const mobileSearchData = searchCounters.mobileSearch?.[0]
            if (mobileSearchData) {
                this.bot.log(this.bot.isMobile, 'SEARCH-INITIAL-STATUS',
                    `Mobile search initial status: ${mobileSearchData.pointProgress}/${mobileSearchData.pointProgressMax} points`)
            }
        } else {
            const pcSearchData = searchCounters.pcSearch?.[0]
            const edgeSearchData = searchCounters.pcSearch?.[1]
            this.bot.log(this.bot.isMobile, 'SEARCH-INITIAL-STATUS',
                `Desktop search initial status: PC(${pcSearchData?.pointProgress || 0}/${pcSearchData?.pointProgressMax || 0}), Edge(${edgeSearchData?.pointProgress || 0}/${edgeSearchData?.pointProgressMax || 0})`)
        }

        if (missingPoints === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Bing searches have already been completed')
            return
        }

        // 多源搜索查询生成
        let allSearchQueries = await this.generateDiversifiedQueries(data)
        allSearchQueries = this.bot.utils.shuffleArray(allSearchQueries) as (GoogleSearch | string)[]

        // 去重搜索词
        allSearchQueries = Array.from(new Set(allSearchQueries))

        this.bot.log(this.bot.isMobile, 'SEARCH-QUERY-SOURCE', `Generated ${allSearchQueries.length} diversified search queries`)

        // Go to bing
        await page.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)

        await this.bot.utils.wait(2000)

        await this.bot.browser.utils.tryDismissAllMessages(page)

        let maxLoop = 0 // If the loop hits 10 this when not gaining any points, we're assuming it's stuck. If it doesn't continue after 5 more searches with alternative queries, abort search

        const queries: string[] = []
        // Mobile search doesn't seem to like related queries?
        allSearchQueries.forEach(x => {
            if (typeof x === 'string') {
                queries.push(x)
            } else {
                this.bot.isMobile ? queries.push(x.topic) : queries.push(x.topic, ...x.related)
            }
        })

        // Loop over search queries
        const searchStartTime = Date.now()
        const searchTimeoutMs = 20 * 60 * 1000 // 20分钟总体超时
        const totalQueries = queries.length
        let completedSearches = 0
        let earnedPoints = 0
        const lastPointsCheck = missingPoints

        this.bot.log(this.bot.isMobile, 'SEARCH-PROGRESS', `Starting ${this.bot.isMobile ? 'mobile' : 'desktop'} search: ${missingPoints} points needed, ${totalQueries} queries available`)

        let lastSuccessfulQuery: string | null = null
        let contextSearchCount = 0

        for (let i = 0; i < queries.length; i++) {
            // 检查总体超时
            if (Date.now() - searchStartTime > searchTimeoutMs) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search process timeout after 20 minutes, stopping searches', 'warn')
                break
            }

            let query = queries[i] as string

            // 如果应该使用上下文搜索，并且有上一个成功的查询
            if (this.shouldUseContextualSearch() && lastSuccessfulQuery && contextSearchCount < 3) {
                const contextQueries = this.generateContextualSearches(lastSuccessfulQuery,
                    data.userProfile?.attributes?.country === 'JP' ? 'ja' :
                        data.userProfile?.attributes?.country === 'CN' ? 'zh' : 'en')

                if (contextQueries.length > 0) {
                    const contextQuery = contextQueries[0]
                    if (contextQuery) {
                        query = contextQuery
                        contextSearchCount++
                        this.bot.log(this.bot.isMobile, 'SEARCH-CONTEXT', `Using contextual search: ${query}`)
                    }
                }
            } else {
                contextSearchCount = 0
            }

            // 显示详细进度
            completedSearches++
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `[${completedSearches}/${totalQueries}] ${missingPoints} Points Remaining | Query: ${query}`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            // 计算本次搜索获得的积分
            const pointsGained = missingPoints - newMissingPoints
            if (pointsGained > 0) {
                earnedPoints += pointsGained
                this.bot.log(this.bot.isMobile, 'SEARCH-PROGRESS', `Earned ${pointsGained} points (Total: ${earnedPoints} points)`)

                // 记录详细的积分变化
                if (this.bot.isMobile) {
                    const mobileSearchData = searchCounters.mobileSearch?.[0]
                    if (mobileSearchData) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-POINTS-DETAIL',
                            `Mobile search progress: ${mobileSearchData.pointProgress}/${mobileSearchData.pointProgressMax} points`)
                    }
                } else {
                    // 桌面端详细积分跟踪
                    const pcSearchData = searchCounters.pcSearch?.[0]
                    const edgeSearchData = searchCounters.pcSearch?.[1]

                    if (pcSearchData) {
                        const pcRemaining = pcSearchData.pointProgressMax - pcSearchData.pointProgress
                        this.bot.log(this.bot.isMobile, 'SEARCH-POINTS-DETAIL',
                            `PC search progress: ${pcSearchData.pointProgress}/${pcSearchData.pointProgressMax} points (${pcRemaining} remaining)`)
                    }

                    if (edgeSearchData) {
                        const edgeRemaining = edgeSearchData.pointProgressMax - edgeSearchData.pointProgress
                        this.bot.log(this.bot.isMobile, 'SEARCH-POINTS-DETAIL',
                            `Edge search progress: ${edgeSearchData.pointProgress}/${edgeSearchData.pointProgressMax} points (${edgeRemaining} remaining)`)
                    }
                }
            }

            // If the new point amount is the same as before
            if (newMissingPoints == missingPoints) {
                maxLoop++ // Add to max loop
                if (maxLoop === 3) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-WARNING', `No points gained for ${maxLoop} searches, may need to wait longer between searches`)

                    // 强制检查积分状态
                    this.bot.log(this.bot.isMobile, 'SEARCH-FORCE-CHECK', 'Force checking current search points status...')
                    try {
                        const forceCheckCounters = await this.bot.browser.func.getSearchPoints()
                        const forceCheckMissingPoints = this.calculatePoints(forceCheckCounters)

                        if (forceCheckMissingPoints !== missingPoints) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-FORCE-CHECK', `Points updated after force check: ${missingPoints} -> ${forceCheckMissingPoints}`)
                            missingPoints = forceCheckMissingPoints
                            maxLoop = 0 // 重置计数器
                            continue
                        }
                    } catch (checkError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-FORCE-CHECK', `Force check failed: ${checkError}`, 'warn')
                    }
                }

                if (maxLoop === 5) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-WARNING', `No points gained for ${maxLoop} searches, adding extra delay`)
                    await this.bot.utils.wait(30000) // 额外等待30秒
                }

                // 桌面端特殊处理：延长重试次数
                if (!this.bot.isMobile && maxLoop === 8) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-DESKTOP-EXTENDED', 'Desktop search needs more time, extending retry limit', 'warn')
                    // 桌面端获取完整积分通常需要更多搜索，给予更长的重试时间
                    await this.bot.utils.wait(60000) // 等待1分钟
                }
            } else { // There has been a change in points
                maxLoop = 0 // Reset the loop
                lastSuccessfulQuery = query // 记录成功的查询
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-COMPLETE', `✅ Search completed! Total earned: ${earnedPoints} points`)

                // 最终验证积分状态
                await this.bot.utils.wait(2000)
                const finalCounters = await this.bot.browser.func.getSearchPoints()
                const finalMissingPoints = this.calculatePoints(finalCounters)

                if (finalMissingPoints === 0) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-FINAL-VERIFY', '✅ Final verification: All search points earned successfully!')
                } else {
                    this.bot.log(this.bot.isMobile, 'SEARCH-FINAL-VERIFY', `⚠️ Final verification: ${finalMissingPoints} points still missing after completion`, 'warn')
                }
                break
            }

            // 显示预计剩余时间
            if (completedSearches % 5 === 0) {
                const avgTimePerSearch = (Date.now() - searchStartTime) / completedSearches
                const estimatedSearchesNeeded = Math.ceil(missingPoints / 5) // 假设每次搜索5分
                const estimatedTimeRemaining = avgTimePerSearch * estimatedSearchesNeeded
                const minutes = Math.ceil(estimatedTimeRemaining / 60000)
                this.bot.log(this.bot.isMobile, 'SEARCH-ESTIMATE', `Estimated time remaining: ~${minutes} minutes`)
            }

            // Only for mobile searches
            if (maxLoop > 5 && this.bot.isMobile) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 5 iterations, likely bad User-Agent', 'warn')

                // 尝试重新生成 User-Agent
                try {
                    this.bot.log(this.bot.isMobile, 'SEARCH-UA-REFRESH', 'Attempting to refresh User-Agent...', 'warn')

                    // 获取新的 User-Agent
                    const {getUserAgent} = await import('../../utils/UserAgent')
                    const newUserAgent = await getUserAgent(this.bot.isMobile)

                    // 更新浏览器的 User-Agent
                    await page.setExtraHTTPHeaders({
                        'User-Agent': newUserAgent.userAgent
                    })

                    this.bot.log(this.bot.isMobile, 'SEARCH-UA-REFRESH', `Updated User-Agent: ${newUserAgent.userAgent}`)

                    // 等待较短时间后继续
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Waiting 30 seconds before continuing with new User-Agent...', 'warn')
                    await this.bot.utils.wait(30000) // 等待30秒

                } catch (error) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-UA-REFRESH', `Failed to refresh User-Agent: ${error}`, 'error')
                    // 如果更新失败，等待3分钟
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Waiting 3 minutes before continuing mobile search...', 'warn')
                    await this.bot.utils.wait(180000) // 等待3分钟
                }

                maxLoop = 0 // 重置计数器
                continue // 继续搜索而不是break
            }

            // 桌面端和移动端使用不同的maxLoop限制
            const maxLoopLimit = this.bot.isMobile ? 10 : 15 // 桌面端允许更多重试

            // If we didn't gain points for multiple iterations, assume it's stuck
            if (maxLoop > maxLoopLimit) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search didn't gain point for ${maxLoopLimit} iterations aborting searches`, 'warn')

                // 在放弃前做最后一次积分检查
                this.bot.log(this.bot.isMobile, 'SEARCH-FINAL-CHECK', 'Performing final points check before giving up...')
                try {
                    await this.bot.utils.wait(5000) // 等待5秒让系统更新
                    const finalCheckCounters = await this.bot.browser.func.getSearchPoints()
                    const finalCheckMissingPoints = this.calculatePoints(finalCheckCounters)

                    if (finalCheckMissingPoints < missingPoints) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-FINAL-CHECK', `Points updated in final check: ${missingPoints} -> ${finalCheckMissingPoints}`)
                        missingPoints = finalCheckMissingPoints
                        if (missingPoints === 0) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-COMPLETE', `✅ Search completed after final check! Total earned: ${earnedPoints + (lastPointsCheck - missingPoints)} points`)
                            break
                        }
                    }
                } catch (finalCheckError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-FINAL-CHECK', `Final check failed: ${finalCheckError}`, 'warn')
                }

                maxLoop = 0 // Reset to 0 so we can retry with related searches below
                break
            }

            // 智能延迟计算
            const smartDelay = await this.getSmartSearchDelay()
            await this.bot.utils.wait(smartDelay)

            // 移动端特殊检测：检查是否需要User-Agent刷新
            if (this.bot.isMobile && maxLoop === 3) {
                this.bot.log(this.bot.isMobile, 'SEARCH-MOBILE-CHECK', 'Mobile search stalled, checking device compatibility...')

                // 检查当前页面的移动端特征
                try {
                    const mobileFeatures = await page.evaluate(() => {
                        return {
                            userAgent: navigator.userAgent,
                            isMobile: /Mobile|Android/i.test(navigator.userAgent),
                            touchPoints: navigator.maxTouchPoints,
                            screenWidth: window.screen.width,
                            innerWidth: window.innerWidth,
                            devicePixelRatio: window.devicePixelRatio
                        }
                    })

                    this.bot.log(this.bot.isMobile, 'SEARCH-MOBILE-FEATURES',
                        `Mobile features: UA=${mobileFeatures.isMobile}, Touch=${mobileFeatures.touchPoints}, Screen=${mobileFeatures.screenWidth}x${mobileFeatures.innerWidth}, DPR=${mobileFeatures.devicePixelRatio}`)

                    // 如果移动端特征不完整，可能需要刷新User-Agent
                    if (!mobileFeatures.isMobile || mobileFeatures.touchPoints === 0 || mobileFeatures.screenWidth > 500) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-MOBILE-UA-REFRESH', 'Mobile features incomplete, will refresh User-Agent on next retry', 'warn')
                    }
                } catch (checkError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-MOBILE-CHECK', `Mobile check failed: ${checkError}`, 'warn')
                }
            }
        }

        // If we still got remaining search queries, generate extra ones
        if (missingPoints > 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search completed but we're missing ${missingPoints} points, generating extra searches`)

            // 为桌面端生成更多的额外搜索
            const maxExtraSearches = this.bot.isMobile ? 20 : 50 // 桌面端需要更多搜索
            let extraSearchCount = 0

            let i = 0
            while (missingPoints > 0 && extraSearchCount < maxExtraSearches) {
                if (i >= allSearchQueries.length) {
                    // 如果用完了所有预定义查询，生成新的
                    this.bot.log(this.bot.isMobile, 'SEARCH-GENERATE-MORE', 'Generating additional search queries...')
                    const additionalQueries = await this.generateAdditionalQueries()
                    allSearchQueries.push(...additionalQueries)
                }

                const query = allSearchQueries[i++] as GoogleSearch | string

                // Get related search terms to the search queries
                const relatedTerms = await this.getRelatedTerms(typeof query === 'string' ? query : (query as GoogleSearch).topic)
                if (relatedTerms.length > 3) {
                    // Search for the first 2 related terms
                    for (const term of relatedTerms.slice(1, 3)) {
                        if (extraSearchCount >= maxExtraSearches) break

                        this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', `${missingPoints} Points Remaining | Extra Query ${extraSearchCount + 1}/${maxExtraSearches}: ${term}`)

                        searchCounters = await this.bingSearch(page, term)
                        const newMissingPoints = this.calculatePoints(searchCounters)
                        extraSearchCount++

                        // If the new point amount is the same as before
                        if (newMissingPoints == missingPoints) {
                            maxLoop++ // Add to max loop
                        } else { // There has been a change in points
                            maxLoop = 0 // Reset the loop
                        }

                        missingPoints = newMissingPoints

                        // If we satisfied the searches
                        if (missingPoints === 0) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-EXTRA-COMPLETE', `✅ All points earned with extra searches! Completed ${extraSearchCount} extra searches.`)
                            break
                        }

                        // Try 5 more times, then we tried a total of 15 times, fair to say it's stuck
                        if (maxLoop > 5) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', 'Search didn\'t gain point for 5 iterations aborting searches', 'warn')
                            return
                        }
                    }
                }

                if (missingPoints === 0) break
            }

            if (missingPoints > 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-INCOMPLETE', `Search ended with ${missingPoints} points still needed after ${extraSearchCount} extra searches`, 'warn')
                // 显示详细的剩余积分信息
                if (!this.bot.isMobile) {
                    const finalCounters = await this.bot.browser.func.getSearchPoints()
                    const pcSearchData = finalCounters.pcSearch?.[0]
                    const edgeSearchData = finalCounters.pcSearch?.[1]

                    if (pcSearchData) {
                        const pcRemaining = pcSearchData.pointProgressMax - pcSearchData.pointProgress
                        this.bot.log(this.bot.isMobile, 'SEARCH-INCOMPLETE-DETAIL',
                            `PC search final: ${pcSearchData.pointProgress}/${pcSearchData.pointProgressMax} (${pcRemaining} remaining)`)
                    }

                    if (edgeSearchData) {
                        const edgeRemaining = edgeSearchData.pointProgressMax - edgeSearchData.pointProgress
                        this.bot.log(this.bot.isMobile, 'SEARCH-INCOMPLETE-DETAIL',
                            `Edge search final: ${edgeSearchData.pointProgress}/${edgeSearchData.pointProgressMax} (${edgeRemaining} remaining)`)
                    }
                }
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Completed searches')
    }

    /**
     * 生成多样化的搜索查询 - 基于地理位置的多语言优化 + 上下文感知
     * 混合多种来源以降低检测风险
     */
    private async generateDiversifiedQueries(data: DashboardData): Promise<(GoogleSearch | string)[]> {
        const allQueries: (GoogleSearch | string)[] = []

        // 30%的查询使用上下文感知生成
        const contextualQueryCount = Math.floor(20 * 0.3) // 假设需要20个查询
        for (let i = 0; i < contextualQueryCount; i++) {
            const contextualQuery = this.contextualSearch.generateContextualSearch()
            allQueries.push(contextualQuery)
        }

        // 10%的查询使用日本本地化搜索
        const japaneseQueryCount = Math.floor(20 * 0.1)
        for (let i = 0; i < japaneseQueryCount; i++) {
            const japaneseQuery = this.contextualSearch.generateJapaneseLocalizedSearch()
            allQueries.push(japaneseQuery)
        }

        try {
            // 获取地理位置和语言信息
            const geoLocation = await this.getGeoLocationWithFallback(data)
            const languageConfig = await this.getLanguageConfigFromGeo(geoLocation)

            this.bot.log(this.bot.isMobile, 'SEARCH-GEO',
                `Location: ${geoLocation.country} (${geoLocation.countryCode}) | Language: ${languageConfig.name} (${languageConfig.code})`)

            // 1. Google Trends查询（40%）- 使用地理位置相关的趋势
            const trendsQueries = await this.getGeoLocalizedTrends(languageConfig.googleTrendsLocale)
            const trendsCount = Math.floor(trendsQueries.length * 0.4)
            allQueries.push(...trendsQueries.slice(0, trendsCount))

            // 2. 时事相关查询（25%）- 使用本地语言
            const newsQueries = await this.generateLocalizedNewsQueries(languageConfig)
            allQueries.push(...newsQueries)

            // 3. 常见搜索查询（20%）- 使用本地语言
            const commonQueries = this.generateLocalizedCommonQueries(languageConfig)
            allQueries.push(...commonQueries)

            // 4. 技术和娱乐查询（15%）- 使用本地语言
            const techEntertainmentQueries = this.generateLocalizedTechEntertainmentQueries(languageConfig)
            allQueries.push(...techEntertainmentQueries)

            this.bot.log(this.bot.isMobile, 'SEARCH-MULTILANG',
                `Generated queries: Trends(${trendsCount}), News(${newsQueries.length}), Common(${commonQueries.length}), Tech/Entertainment(${techEntertainmentQueries.length}) in ${languageConfig.name}`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GEO-ERROR', `Error generating localized queries: ${error}`, 'warn')
            // 如果地理语言检测失败，回退到原有的多样化方案
            return await this.generateFallbackDiversifiedQueries(data)
        }

        return allQueries
    }

    /**
     * 获取地理位置信息（包含备用方案）
     */
    private async getGeoLocationWithFallback(data: DashboardData): Promise<GeoLocation> {
        try {
            // 优先级1: 尝试通过IP地址检测地理位置
            this.bot.log(this.bot.isMobile, 'SEARCH-GEO', 'Attempting IP-based location detection...', 'log')
            const {GeoLanguageDetector} = await import('../../utils/GeoLanguage')
            const ipLocation = await GeoLanguageDetector.getCurrentLocation()

            // 如果IP检测成功且不是未知位置
            if (ipLocation && ipLocation.country !== 'Unknown' && ipLocation.ip !== 'Unknown') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GEO',
                    `IP detection successful: ${ipLocation.country} (${ipLocation.countryCode}) - Language: ${ipLocation.language}`)
                return ipLocation
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GEO', 'IP-based location detection failed', 'warn')
        }

        // 优先级2: 使用账户资料中的国家信息
        try {
            const profileCountry = data.userProfile?.attributes?.country
            if (profileCountry) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GEO',
                    `Using account profile country: ${profileCountry}`, 'log')

                // 根据国家代码映射语言
                const countryLanguageMap: Record<string, string> = {
                    'JP': 'ja', 'CN': 'zh-CN', 'KR': 'ko', 'VN': 'vi',
                    'US': 'en', 'GB': 'en', 'AU': 'en', 'CA': 'en',
                    'DE': 'de', 'FR': 'fr', 'ES': 'es', 'IT': 'it',
                    'BR': 'pt-BR', 'PT': 'pt', 'RU': 'ru', 'IN': 'hi',
                    'MX': 'es', 'AR': 'es', 'CL': 'es', 'CO': 'es',
                    'TH': 'th', 'ID': 'id', 'MY': 'ms', 'PH': 'en',
                    'TW': 'zh-TW', 'HK': 'zh-HK', 'SG': 'en', 'NZ': 'en'
                }

                const inferredLanguage = countryLanguageMap[profileCountry] || 'en'

                return {
                    country: profileCountry,
                    countryCode: profileCountry,
                    language: inferredLanguage,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    city: 'Unknown',
                    currency: 'USD',
                    ip: 'Unknown'
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GEO', 'Failed to use profile country', 'warn')
        }

        // 优先级3: 使用时区推测（最后的备用方案）
        this.bot.log(this.bot.isMobile, 'SEARCH-GEO',
            'Falling back to timezone-based location detection', 'warn')

        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        const timezoneMap: Record<string, { country: string, code: string, language: string }> = {
            'Asia/Tokyo': {country: 'Japan', code: 'JP', language: 'ja'},
            'Asia/Shanghai': {country: 'China', code: 'CN', language: 'zh-CN'},
            'Asia/Seoul': {country: 'South Korea', code: 'KR', language: 'ko'},
            'Asia/Ho_Chi_Minh': {country: 'Vietnam', code: 'VN', language: 'vi'},
            'Asia/Bangkok': {country: 'Thailand', code: 'TH', language: 'th'},
            'Europe/London': {country: 'United Kingdom', code: 'GB', language: 'en'},
            'Europe/Paris': {country: 'France', code: 'FR', language: 'fr'},
            'Europe/Berlin': {country: 'Germany', code: 'DE', language: 'de'},
            'America/New_York': {country: 'United States', code: 'US', language: 'en'},
            'America/Los_Angeles': {country: 'United States', code: 'US', language: 'en'},
            'Australia/Sydney': {country: 'Australia', code: 'AU', language: 'en'}
        }

        const location = timezoneMap[timezone] || {country: 'United States', code: 'US', language: 'en'}

        this.bot.log(this.bot.isMobile, 'SEARCH-GEO-TIMEZONE',
            `Using timezone ${timezone}: ${location.country} (${location.code}) with language: ${location.language}`)

        return {
            country: location.country,
            countryCode: location.code,
            language: location.language,
            timezone: timezone,
            city: 'Unknown',
            currency: 'USD',
            ip: 'Unknown'
        }
    }

    /**
     * 从地理位置获取语言配置
     */
    private async getLanguageConfigFromGeo(geoLocation: GeoLocation): Promise<LanguageConfig> {
        try {
            const {GeoLanguageDetector} = await import('../../utils/GeoLanguage')
            return GeoLanguageDetector.getLanguageConfig(geoLocation.language)
        } catch (error) {
            // 备用方案：返回日文配置
            return {
                code: 'ja',
                name: 'Japanese',
                googleTrendsLocale: 'JP',
                searchQueries: {
                    news: ['最新ニュース', '速報ニュース', '世界のニュース'],
                    common: ['料理の作り方', 'おすすめレシピ', '旅行先'],
                    tech: ['人工知能', '最新技術', 'スマートフォンレビュー'],
                    entertainment: ['新作映画', 'テレビ番組', '音楽ランキング'],
                    sports: ['サッカー結果', 'バスケットボールニュース', 'スポーツハイライト'],
                    food: ['レストランレビュー', '料理のコツ', 'ヘルシーレシピ']
                }
            }
        }
    }

    /**
     * 获取基于地理位置的Google Trends
     */
    private async getGeoLocalizedTrends(locale: string): Promise<GoogleSearch[]> {
        try {
            // 使用地理位置相关的locale获取趋势
            return await this.getGoogleTrends(locale)
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS-GEO', `Failed to get geo trends for ${locale}, using default`, 'warn')
            // 回退到默认的Google Trends
            return await this.getGoogleTrends('JP')
        }
    }

    /**
     * 生成本地化的时事查询
     */
    private async generateLocalizedNewsQueries(languageConfig: LanguageConfig): Promise<string[]> {
        try {
            const {GeoLanguageDetector} = await import('../../utils/GeoLanguage')
            const timeBasedQueries = GeoLanguageDetector.generateTimeBasedQueries(languageConfig.code)

            const newsQueries = languageConfig.searchQueries.news || []

            // 合并时效性查询和常规新闻查询
            const combinedQueries = [...timeBasedQueries, ...newsQueries]

            // 随机选择4-6个查询
            const selectedCount = 4 + Math.floor(Math.random() * 3)
            return this.bot.utils.shuffleArray(combinedQueries).slice(0, selectedCount) as string[]
        } catch (error) {
            // 备用方案：日文时事查询
            const currentDate = new Date()
            const currentYear = currentDate.getFullYear()
            return [
                `${currentYear}年のニュース`,
                '今日の最新情報',
                '速報',
                '世界情勢'
            ]
        }
    }

    /**
     * 生成本地化的常见查询
     */
    private generateLocalizedCommonQueries(languageConfig: LanguageConfig): string[] {
        const commonQueries = languageConfig.searchQueries.common || []
        const foodQueries = languageConfig.searchQueries.food || []

        // 合并常见查询和美食查询
        const combinedQueries = [...commonQueries, ...foodQueries]

        // 随机选择3-5个查询
        const selectedCount = 3 + Math.floor(Math.random() * 3)
        return this.bot.utils.shuffleArray(combinedQueries).slice(0, selectedCount) as string[]
    }

    /**
     * 生成本地化的技术娱乐查询
     */
    private generateLocalizedTechEntertainmentQueries(languageConfig: LanguageConfig): string[] {
        const techQueries: string[] = languageConfig.searchQueries.tech || []
        const entertainmentQueries: string[] = languageConfig.searchQueries.entertainment || []
        const sportsQueries: string[] = languageConfig.searchQueries.sports || []

        // 从每个类别选择1-2个查询
        const selectedTech: string[] = this.bot.utils.shuffleArray(techQueries).slice(0, 1 + Math.floor(Math.random() * 2)) as string[]
        const selectedEntertainment: string[] = this.bot.utils.shuffleArray(entertainmentQueries).slice(0, 1 + Math.floor(Math.random() * 2)) as string[]
        const selectedSports: string[] = this.bot.utils.shuffleArray(sportsQueries).slice(0, 1 + Math.floor(Math.random() * 2)) as string[]

        return [...selectedTech, ...selectedEntertainment, ...selectedSports]
    }

    /**
     * 备用的多样化查询生成（原有逻辑）
     */
    private async generateFallbackDiversifiedQueries(data: DashboardData): Promise<(GoogleSearch | string)[]> {
        const allQueries: (GoogleSearch | string)[] = []

        try {
            // 1. Google Trends查询（50%）
            const trendsQueries = await this.getGoogleTrends(
                this.bot.config.searchSettings.useGeoLocaleQueries ?
                    data.userProfile.attributes.country : 'JP'
            )
            const trendsCount = Math.floor(trendsQueries.length * 0.5)
            allQueries.push(...trendsQueries.slice(0, trendsCount))

            // 2. 时事相关查询（20%）
            const newsQueries = await this.generateNewsQueries()
            allQueries.push(...newsQueries)

            // 3. 常见搜索查询（15%）
            const commonQueries = this.generateCommonQueries()
            allQueries.push(...commonQueries)

            // 4. 随机话题查询（15%）
            const randomQueries = await this.generateRandomTopicQueries()
            allQueries.push(...randomQueries)

            this.bot.log(this.bot.isMobile, 'SEARCH-FALLBACK',
                `Fallback query sources: Trends(${trendsCount}), News(${newsQueries.length}), Common(${commonQueries.length}), Random(${randomQueries.length})`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-FALLBACK-ERROR', `Error generating fallback queries: ${error}`, 'warn')
            // 最后的备用方案：返回原有的Google Trends
            return await this.getGoogleTrends(
                this.bot.config.searchSettings.useGeoLocaleQueries ?
                    data.userProfile.attributes.country : 'JP'
            )
        }

        return allQueries
    }

    /**
     * 生成时事相关搜询
     */
    private async generateNewsQueries(): Promise<string[]> {
        const currentDate = new Date()
        const currentYear = currentDate.getFullYear()
        const currentMonth = currentDate.toLocaleDateString('en-US', {month: 'long'})

        const newsQueries = [
            `${currentYear} news today`,
            `${currentMonth} ${currentYear} events`,
            'today\'s headlines',
            `current events ${currentYear}`,
            `news updates ${currentMonth}`,
            'breaking news today',
            `world news ${currentYear}`,
            'latest technology news',
            'sports news today',
            'weather forecast today'
        ]

        // 随机选择3-5个时事查询
        const selectedCount = 3 + Math.floor(Math.random() * 3)
        return this.bot.utils.shuffleArray(newsQueries).slice(0, selectedCount)
    }

    /**
     * 生成常见搜索查询
     */
    private generateCommonQueries(): string[] {
        const commonTopics = [
            'how to cook pasta',
            'best movies 2024',
            'healthy recipes',
            'travel destinations',
            'fitness tips',
            'home improvement ideas',
            'online learning',
            'productivity apps',
            'book recommendations',
            'gardening tips',
            'DIY projects',
            'career advice',
            'investment tips',
            'language learning',
            'photography tips'
        ]

        // 随机选择2-4个常见查询
        const selectedCount = 2 + Math.floor(Math.random() * 3)
        return this.bot.utils.shuffleArray(commonTopics).slice(0, selectedCount)
    }

    /**
     * 生成随机话题查询
     */
    private async generateRandomTopicQueries(): Promise<string[]> {
        const randomTopics = [
            'artificial intelligence future',
            'sustainable living tips',
            'space exploration news',
            'electric vehicles 2024',
            'renewable energy trends',
            'digital art techniques',
            'mindfulness meditation',
            'cryptocurrency updates',
            'virtual reality gaming',
            'climate change solutions',
            'healthy lifestyle habits',
            'remote work productivity',
            'scientific discoveries 2024',
            'cultural festivals around world',
            'innovative technology startups'
        ]

        // 随机选择2-3个随机话题
        const selectedCount = 2 + Math.floor(Math.random() * 2)
        return this.bot.utils.shuffleArray(randomTopics).slice(0, selectedCount)
    }

    private async bingSearch(searchPage: Page, query: string) {
        const platformControlKey = platform() === 'darwin' ? 'Meta' : 'Control'

        // Try a max of 5 times
        for (let i = 0; i < 5; i++) {
            try {
                // 检查页面是否崩溃或关闭
                if (searchPage.isClosed()) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search page was closed, creating new tab', 'warn')
                    searchPage = await this.bot.browser.utils.getLatestTab(searchPage)
                    await searchPage.goto('https://bing.com')
                    await this.bot.utils.wait(2000)
                }

                // 🎯 在搜索前检查并处理弹窗
                try {
                    const handledPopups = await this.bot.browser.utils.handleRewardsPopups(searchPage)
                    if (handledPopups) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Handled popups before search')
                    }
                } catch (popupError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Popup handling warning: ${popupError}`, 'warn')
                }

                // 检查页面是否仍然响应
                try {
                    await searchPage.evaluate(() => document.readyState, {timeout: 5000})
                } catch (evalError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Page evaluation failed, likely crashed. Creating new tab...', 'warn')

                    // 创建新的页面
                    try {
                        const context = searchPage.context()
                        searchPage = await context.newPage()
                        await searchPage.goto('https://bing.com')
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Created new page after crash', 'warn')
                        await this.bot.utils.wait(3000)
                        // 强制垃圾回收（如果支持）
                        try {
                            await searchPage.evaluate(() => {
                                if (window.gc) {
                                    window.gc()
                                }
                            })
                        } catch (gcError) {
                            // 忽略GC错误
                        }
                        continue // 直接进入下一次循环
                    } catch (newPageError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Failed to create new page: ${newPageError}`, 'error')
                        return await this.getEmptySearchCounters()
                    }
                }

                // This page had already been set to the Bing.com page or the previous search listing, we just need to select it
                searchPage = await this.bot.browser.utils.getLatestTab(searchPage)

                // 在操作前先等待页面稳定
                await this.bot.utils.wait(1000)

                // 移动端关键修复：验证和强化移动端特征
                if (this.bot.isMobile) {
                    try {
                        // 验证移动端特征是否正确设置
                        const mobileFeatures = await searchPage.evaluate(() => {
                            return {
                                isMobile: 'ontouchstart' in window,
                                hasTouch: navigator.maxTouchPoints > 0,
                                userAgent: navigator.userAgent,
                                viewport: {
                                    width: window.innerWidth,
                                    height: window.innerHeight
                                },
                                platform: navigator.platform,
                                deviceMemory: navigator.deviceMemory || 'unknown'
                            }
                        })

                        this.bot.log(this.bot.isMobile, 'MOBILE-VERIFY',
                            `Mobile features check: Touch=${mobileFeatures.hasTouch}, Viewport=${mobileFeatures.viewport.width}x${mobileFeatures.viewport.height}, Platform=${mobileFeatures.platform}`)

                        // 如果检测到移动端特征不正确，尝试修复
                        if (!mobileFeatures.hasTouch || mobileFeatures.viewport.width > 600) {
                            this.bot.log(this.bot.isMobile, 'MOBILE-VERIFY', 'Mobile features not properly set, attempting to reinforce...', 'warn')

                            // 强化移动端特征
                            await searchPage.evaluate(() => {
                                // 设置移动端特征
                                Object.defineProperty(navigator, 'maxTouchPoints', {
                                    writable: false,
                                    value: 5
                                })

                                // 触发触摸事件支持
                                if (!('ontouchstart' in window)) {
                                    window.ontouchstart = () => {
                                    }
                                }

                                // 确保移动端UA检测
                                if (!navigator.userAgent.includes('Mobile')) {
                                    this.bot.log(this.bot.isMobile, 'MOBILE-VERIFY', 'User-Agent missing Mobile identifier!', 'error')
                                }
                            })
                        }

                        // 设置移动端专用HTTP头部
                        await searchPage.setExtraHTTPHeaders({
                            'sec-ch-ua-mobile': '?1',
                            'sec-ch-ua-platform': '"Android"',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
                        })

                    } catch (verifyError) {
                        this.bot.log(this.bot.isMobile, 'MOBILE-VERIFY', `Mobile verification failed: ${verifyError}`, 'warn')
                    }
                }

                // 安全的页面滚动 - 避免使用可能崩溃的 evaluate
                try {
                    await searchPage.keyboard.press('Home')
                } catch (scrollError) {
                    // 如果快捷键失败，尝试直接导航到顶部
                    try {
                        await searchPage.evaluate(() => window.scrollTo(0, 0), {timeout: 2000})
                    } catch (evalError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Unable to scroll to top, continuing...', 'warn')
                    }
                }

                await this.bot.utils.wait(500)

                // 确保在正确的搜索页面
                const currentUrl = searchPage.url()
                if (!currentUrl.includes('bing.com')) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Not on Bing page, navigating to Bing...', 'warn')
                    await searchPage.goto('https://bing.com', {waitUntil: 'domcontentloaded', timeout: 30000})
                    await this.bot.utils.wait(2000)
                }

                const searchBar = '#sb_form_q'

                // 等待搜索框出现，增加重试机制
                let searchBarFound = false
                for (let waitAttempt = 0; waitAttempt < 3; waitAttempt++) {
                    try {
                        await searchPage.waitForSelector(searchBar, {state: 'visible', timeout: 30000})
                        searchBarFound = true
                        break
                    } catch (waitError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search bar not found, attempt ${waitAttempt + 1}/3`, 'warn')

                        // 尝试刷新页面
                        if (waitAttempt < 2) {
                            try {
                                await searchPage.reload({waitUntil: 'domcontentloaded', timeout: 15000})
                                await this.bot.utils.wait(3000)
                            } catch (reloadError) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Page reload failed: ${reloadError}`, 'warn')
                            }
                        }
                    }
                }

                if (!searchBarFound) {
                    throw new Error('Search bar not found after 3 attempts')
                }

                // 添加焦点检查和重试机制
                let clickRetries = 0
                while (clickRetries < 5) {
                    try {
                        await searchPage.click(searchBar, {timeout: 8000})

                        // 验证搜索框是否已获得焦点
                        const isFocused = await searchPage.evaluate(() => {
                            const element = document.querySelector('#sb_form_q') as HTMLInputElement
                            return element && element === document.activeElement
                        })

                        if (isFocused) {
                            break
                        } else if (clickRetries < 4) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search bar not focused, retry ${clickRetries + 1}/5`, 'warn')
                            await this.bot.utils.wait(2000)
                        }
                    } catch (clickError) {
                        clickRetries++
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search bar click failed, retry ${clickRetries}/5`, 'warn')
                        if (clickRetries >= 5) {
                            throw clickError
                        }
                        await this.bot.utils.wait(3000)
                    }
                    clickRetries++
                }

                // 使用增强的人类行为模拟
                await this.humanBehavior.simulateThinking()

                // 更安全的文本清除方法
                try {
                    await searchPage.keyboard.down(platformControlKey)
                    await searchPage.keyboard.press('A')
                    await searchPage.keyboard.press('Backspace')
                    await searchPage.keyboard.up(platformControlKey)
                } catch (keyboardError) {
                    // 如果键盘操作失败，尝试使用 fill 方法
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Keyboard clearing failed, using fill method', 'warn')
                    await searchPage.fill(searchBar, '')
                }

                // 使用增强的人类化打字输入
                await this.humanBehavior.humanType(searchPage, query)

                // 5%概率使用搜索建议
                if (Math.random() < 0.05) {
                    const suggestionClicked = await this.clickSearchSuggestion(searchPage)
                    if (suggestionClicked) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BEHAVIOR', 'Used search suggestion instead of typing full query')
                    }
                }

                // 随机的提交前停顿
                await this.bot.utils.wait(Math.random() * 1000 + 500)

                await searchPage.keyboard.press('Enter')

                await this.bot.utils.wait(3000)

                // Bing.com in Chrome opens a new tab when searching
                const resultPage = await this.bot.browser.utils.getLatestTab(searchPage)
                this.searchPageURL = new URL(resultPage.url()).href // Set the results page

                // 🎯 在搜索结果页面检查并处理弹窗
                try {
                    const handledPopups = await this.bot.browser.utils.handleRewardsPopups(resultPage)
                    if (handledPopups) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Handled popups on search results page')
                    }
                } catch (popupError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Popup handling warning on results: ${popupError}`, 'warn')
                }

                // 添加页面加载超时检查
                try {
                    await resultPage.waitForLoadState('domcontentloaded', {timeout: 15000})
                } catch (loadError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Page load timeout: ${loadError}`, 'warn')
                    // 继续执行，可能页面已经部分加载
                }

                await this.bot.browser.utils.reloadBadPage(resultPage)

                // <div class="banner"><div class="banner-container"><div class="banner-content"><div class="banner-icon"><img class="rms_img" loading="lazy" src="/rp/tWiuavlqiKIvA7l0-qYN7_MAF68.svg" data-bm="14"></div><div class="banner-text">Enhance your search experience with a quick verification.</div></div><button id="verify-btn" class="verify-btn">Verify</button></div></div>
                // 检查当前页面是否有验证 verify-btn
                const verifyButton = await resultPage.$('#verify-btn')
                if (verifyButton) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Verification button detected on results page, clicking...', 'warn')
                    try {
                        await verifyButton.click()
                        await this.bot.utils.wait(3000)
                    } catch (verifyError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Failed to click verification button: ${verifyError}`, 'error')
                        // 继续执行搜索
                    }
                }

                // 移动端搜索后验证：检查是否在移动版Bing
                if (this.bot.isMobile) {
                    try {
                        const isMobileBing = await resultPage.evaluate(() => {
                            // 检查是否为移动版Bing的特征
                            const body = document.body
                            return {
                                hasMobileClass: body ? body.classList.contains('mobile') || body.classList.contains('m') : false,
                                viewport: body ? body.getAttribute('data-viewport') : null,
                                width: window.innerWidth,
                                userAgent: navigator.userAgent.includes('Mobile'),
                                touchPoints: navigator.maxTouchPoints > 0
                            }
                        })

                        if (!isMobileBing.userAgent || !isMobileBing.touchPoints) {
                            this.bot.log(this.bot.isMobile, 'MOBILE-BING-CHECK',
                                `Warning: Mobile features not detected on result page. UA Mobile: ${isMobileBing.userAgent}, Touch: ${isMobileBing.touchPoints}`, 'warn')
                        } else {
                            this.bot.log(this.bot.isMobile, 'MOBILE-BING-CHECK',
                                `✓ Mobile Bing detected: Width=${isMobileBing.width}, Touch=${isMobileBing.touchPoints}`)
                        }
                    } catch (checkError) {
                        this.bot.log(this.bot.isMobile, 'MOBILE-BING-CHECK', `Mobile Bing verification failed: ${checkError}`, 'warn')
                    }
                }

                // 更安全的人类行为模拟
                try {
                    await this.simulateHumanBehaviorSafe(resultPage)
                } catch (behaviorError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BEHAVIOR', `Behavior simulation failed: ${behaviorError}`, 'warn')
                    // 继续执行搜索
                }

                // 10%概率查看搜索结果第二页
                if (Math.random() < 0.1) {
                    try {
                        const navigatedToSecondPage = await this.navigateToSecondPage(resultPage)
                        if (navigatedToSecondPage) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BEHAVIOR', 'Viewed second page of search results')
                        }
                    } catch (navError) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BEHAVIOR', `Second page navigation failed: ${navError}`, 'warn')
                    }
                }

                // 智能延迟系统
                const delayMs = await this.calculateSmartDelay(i)
                this.bot.log(this.bot.isMobile, 'SEARCH-BING-DELAY', `Waiting ${Math.round(delayMs / 1000)}s before next search...`)
                await this.bot.utils.wait(delayMs)

                // 获取搜索点数，添加超时保护
                try {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Fetching updated search points...')
                    const searchPoints = await Promise.race([
                        this.bot.browser.func.getSearchPoints(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('getSearchPoints timeout after 20 seconds')), 20000)
                        )
                    ]) as Counters

                    // 搜索成功，重置失败计数
                    this.handleSearchSuccess()

                    return searchPoints
                } catch (pointsError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Failed to get search points: ${pointsError}`, 'warn')
                    // 如果获取点数失败，返回空的计数器，让主循环继续
                    return await this.getEmptySearchCounters()
                }

            } catch (error) {
                // 处理搜索失败
                this.handleSearchFailure()

                // 增强的错误检测和分类
                const errorMessage = String(error)
                const isBrowserClosed = errorMessage.includes('Target page, context or browser has been closed') ||
                    errorMessage.includes('page.reload: Target page') ||
                    searchPage.isClosed()

                const isTargetCrashed = errorMessage.includes('Target crashed') ||
                    errorMessage.includes('page.evaluate: Target crashed') ||
                    errorMessage.includes('Protocol error')

                const isMemoryError = errorMessage.includes('out of memory') ||
                    errorMessage.includes('memory') ||
                    errorMessage.includes('OOM')

                if (isBrowserClosed) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Browser or page has been closed, ending search', 'warn')
                    return await this.getEmptySearchCounters()
                }

                if (isTargetCrashed || isMemoryError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Page crashed (attempt ${i + 1}/5): ${errorMessage}`, 'error')

                    // 如果页面崩溃，尝试创建新页面
                    if (i < 4) { // 还有重试机会
                        try {
                            const context = searchPage.context()
                            searchPage = await context.newPage()
                            await searchPage.goto('https://bing.com')
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Created new page after crash', 'warn')
                            await this.bot.utils.wait(3000)
                            // 强制垃圾回收（如果支持）
                            try {
                                await searchPage.evaluate(() => {
                                    if (window.gc) {
                                        window.gc()
                                    }
                                })
                            } catch (gcError) {
                                // 忽略GC错误
                            }
                            continue // 直接进入下一次循环
                        } catch (newPageError) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Failed to create new page: ${newPageError}`, 'error')
                            return await this.getEmptySearchCounters()
                        }
                    }
                }

                if (i === 4) { // 第5次重试（索引从0开始）
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed after 5 retries... An error occurred:' + error, 'error')
                    break
                }

                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed, An error occurred:' + error, 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Retrying search, attempt ${i + 1}/5`, 'warn')

                try {
                    // Reset the tabs
                    const lastTab = await this.bot.browser.utils.getLatestTab(searchPage)
                    await this.closeTabs(lastTab)
                } catch (tabError) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Failed to reset tabs: ${tabError}`, 'warn')
                    // 如果连tab操作都失败了，很可能浏览器已经关闭
                    return await this.getEmptySearchCounters()
                }

                await this.bot.utils.wait(4000)
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed after 5 retries, ending', 'error')
        return await this.getEmptySearchCounters()
    }

    /**
     * 更安全的人类行为模拟，减少页面崩溃风险
     */
    private async simulateHumanBehaviorSafe(page: Page): Promise<void> {
        try {
            // 移动端特殊处理
            if (this.bot.isMobile) {
                await this.simulateMobileUserBehaviorSafe(page)
                return
            }

            // 桌面端安全行为模拟
            const behaviors = ['scroll', 'click', 'simple_wait', 'none']
            const selectedBehavior = behaviors[Math.floor(Math.random() * behaviors.length)]

            switch (selectedBehavior) {
                case 'scroll':
                    if (this.bot.config.searchSettings.scrollRandomResults) {
                        await this.bot.utils.wait(1000 + Math.random() * 2000)
                        await this.safeRandomScroll(page)
                    }
                    break

                case 'click':
                    if (this.bot.config.searchSettings.clickRandomResults) {
                        await this.bot.utils.wait(2000 + Math.random() * 3000)
                        await this.safeClickRandomLink(page)
                    }
                    break

                case 'simple_wait':
                    // 简单等待，最安全的选择
                    await this.bot.utils.wait(2000 + Math.random() * 3000)
                    break

                case 'none':
                    // 只是查看结果，不做任何操作
                    await this.bot.utils.wait(3000 + Math.random() * 2000)
                    break
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BEHAVIOR-SAFE', `Safe behavior simulation failed: ${error}`, 'warn')
            // 失败时简单等待
            await this.bot.utils.wait(2000)
        }
    }

    /**
     * 更安全的移动端行为模拟
     */
    private async simulateMobileUserBehaviorSafe(page: Page): Promise<void> {
        try {
            // 使用简单的等待和基本操作，避免复杂的evaluate调用
            const behaviorPattern = Math.random()

            if (behaviorPattern < 0.4) {
                // 40% - 简单等待模式（最安全）
                await this.bot.utils.wait(2000 + Math.random() * 3000)

            } else if (behaviorPattern < 0.7) {
                // 30% - 基本滚动模式
                await this.bot.utils.wait(1000 + Math.random() * 1000)

                // 使用键盘滚动而不是evaluate
                for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
                    await page.keyboard.press('PageDown')
                    await this.bot.utils.wait(1000 + Math.random() * 1500)
                }

            } else {
                // 30% - 尝试安全点击
                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(1500 + Math.random() * 1500)
                    await this.safeClickMobileResult(page)
                }
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'MOBILE-BEHAVIOR-SAFE', `Safe mobile behavior failed: ${error}`, 'warn')
            // 失败时简单等待
            await this.bot.utils.wait(2000)
        }
    }

    /**
     * 更安全的随机滚动
     */
    private async safeRandomScroll(page: Page): Promise<void> {
        try {
            // 使用键盘滚动而不是evaluate，更稳定
            const scrollSteps = 1 + Math.floor(Math.random() * 3) // 1-3次滚动

            for (let i = 0; i < scrollSteps; i++) {
                await page.keyboard.press('PageDown')
                await this.bot.utils.wait(800 + Math.random() * 1200)
            }

            // 偶尔滚回顶部
            if (Math.random() < 0.3) {
                await this.bot.utils.wait(500)
                await page.keyboard.press('Home')
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SAFE-SCROLL', `Safe scroll failed: ${error}`, 'warn')
        }
    }

    /**
     * 更安全的链接点击
     */
    private async safeClickRandomLink(page: Page): Promise<void> {
        try {
            const selectors = [
                '#b_results .b_algo h2 a',
                '.b_algo h2 a',
                '#b_results h2 a'
            ]

            for (const selector of selectors) {
                try {
                    const elements = await page.$$(selector)
                    if (elements.length > 0) {
                        const randomIndex = Math.floor(Math.random() * Math.min(elements.length, 3)) // 只点击前3个
                        const element = elements[randomIndex]

                        if (element) {
                            await element.click({timeout: 3000})
                            await this.bot.utils.wait(2000 + Math.random() * 3000)

                            // 返回搜索结果
                            await page.goBack({timeout: 5000})
                            await this.bot.utils.wait(1000)
                            break
                        }
                    }
                } catch (selectorError) {
                    // 继续尝试下一个选择器
                    continue
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SAFE-CLICK', `Safe click failed: ${error}`, 'warn')
        }
    }

    /**
     * 更安全的移动端结果点击
     */
    private async safeClickMobileResult(page: Page): Promise<void> {
        try {
            const mobileSelectors = [
                '#b_results .b_algo h2 a',
                '.b_algo h2 a'
            ]

            for (const selector of mobileSelectors) {
                try {
                    const elements = await page.$$(selector)
                    if (elements.length > 0) {
                        const element = elements[0] // 总是点击第一个结果
                        if (element) {
                            await element.click({timeout: 3000})
                            await this.bot.utils.wait(3000 + Math.random() * 2000)
                            await page.goBack({timeout: 5000})
                            await this.bot.utils.wait(1000)
                            break
                        }
                    }
                } catch (selectorError) {
                    continue
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SAFE-MOBILE-CLICK', `Safe mobile click failed: ${error}`, 'warn')
        }
    }


    /**
     * 智能延迟计算系统 - 使用新的反检测延迟系统
     */
    private async calculateSmartDelay(searchIndex: number): Promise<number> {
        // 使用新的智能延迟系统
        const hasFailures = this.consecutiveFailures > 0
        const delay = this.intelligentDelay.calculateSearchDelay(searchIndex, this.bot.isMobile, hasFailures)

        // 记录延迟调整信息
        if (this.consecutiveFailures > 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ADAPTIVE-DELAY',
                `Adjusted delay due to ${this.consecutiveFailures} consecutive failures: ${Math.round(delay / 1000)}s`)
        }

        // 记录搜索到会话管理器
        this.sessionManager.recordSearch()

        // 检查是否需要会话中断
        const interruption = this.sessionManager.simulateLifeInterruption()
        if (interruption.shouldInterrupt) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LIFE-INTERRUPTION',
                `Life interruption: ${interruption.reason} (${Math.round(interruption.duration / 1000)}s)`)
            return delay + interruption.duration
        }

        return delay
    }

    /**
     * 处理搜索失败，调整自适应参数
     */
    private handleSearchFailure(): void {
        this.consecutiveFailures++
        this.adaptiveDelayMultiplier = Math.min(2.0, this.adaptiveDelayMultiplier + 0.2)
    }

    /**
     * 处理搜索成功，重置自适应参数
     */
    private handleSearchSuccess(): void {
        this.consecutiveFailures = 0
        if (this.adaptiveDelayMultiplier > 1.0) {
            this.adaptiveDelayMultiplier = Math.max(1.0, this.adaptiveDelayMultiplier - 0.1)
        }
    }

    /**
     * 返回空的搜索计数器，用于处理浏览器关闭等异常情况
     */
    private async getEmptySearchCounters(): Promise<Counters> {
        try {
            // 尝试获取真实的搜索点数
            return await this.bot.browser.func.getSearchPoints()
        } catch (error) {
            // 如果失败，返回空的计数器
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed to get search points, returning empty counters', 'warn')
            return {
                pcSearch: [],
                mobileSearch: [],
                shopAndEarn: [],
                activityAndQuiz: [],
                dailyPoint: []
            }
        }
    }

    private async getGoogleTrends(geoLocale: string = 'JP'): Promise<GoogleSearch[]> {
        // 检查是否是中国大陆地区
        if (geoLocale.toUpperCase() === 'CN' || geoLocale.toUpperCase() === 'ZH-CN') {
            this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS', 'Detected China region, using alternative trend source')
            return await this.getChinaTrends()
        }

        const queryTerms: GoogleSearch[] = []
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries, can take a while! | GeoLocale: ${geoLocale}`)

        try {
            const request: AxiosRequestConfig = {
                url: 'https://trends.google.com/_/TrendsUi/data/batchexecute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`
            }

            const response = await this.bot.axios.request(request, this.bot.config.proxy.proxyGoogleTrends)
            const rawText = response.data

            const trendsData = this.extractJsonFromResponse(rawText)
            if (!trendsData) {
                throw this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse Google Trends response', 'error')
            }

            const mappedTrendsData = trendsData.map(query => [query[0], query[9]!.slice(1)])
            if (mappedTrendsData.length < 90) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Insufficient search queries, falling back to JP', 'warn')
                return this.getGoogleTrends()
            }

            for (const [topic, relatedQueries] of mappedTrendsData) {
                queryTerms.push({
                    topic: topic as string,
                    related: relatedQueries as string[]
                })
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'An error occurred:' + error, 'error')
        }

        return queryTerms
    }

    /**
     * 获取中国地区的热门搜索趋势
     * 使用百度、微博等本地化数据源
     */
    private async getChinaTrends(): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        const chinaConfig = this.bot.config.searchSettings.chinaRegionAdaptation

        // 如果未启用中国地区适配，直接返回备用查询
        if (!chinaConfig?.enabled) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CHINA-TRENDS', 'China region adaptation disabled, using fallback queries')
            return this.getChineseFallbackQueries()
        }

        try {
            // 方案1：使用百度热搜榜
            if (chinaConfig.useBaiduTrends) {
                const baiduTrends = await this.getBaiduTrends()
                if (baiduTrends.length > 0) {
                    queryTerms.push(...baiduTrends)
                }
            }

            // 方案2：使用微博热搜
            if (chinaConfig.useWeiboTrends) {
                const weiboTrends = await this.getWeiboTrends()
                if (weiboTrends.length > 0) {
                    queryTerms.push(...weiboTrends)
                }
            }

            // 如果获取失败或数量不足，使用预定义的中文搜索词
            if (chinaConfig.fallbackToLocalQueries && queryTerms.length < 50) {
                const fallbackQueries = this.getChineseFallbackQueries()
                queryTerms.push(...fallbackQueries)
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-CHINA-TRENDS', `Generated ${queryTerms.length} search queries for China region`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CHINA-TRENDS', `Error getting China trends: ${error}`, 'warn')
            // 使用预定义的备用查询
            if (chinaConfig.fallbackToLocalQueries) {
                return this.getChineseFallbackQueries()
            }
        }

        return queryTerms
    }

    /**
     * 获取百度热搜数据
     */
    private async getBaiduTrends(): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []

        try {
            // 百度热搜榜API
            const request: AxiosRequestConfig = {
                url: 'https://top.baidu.com/board?tab=realtime',
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9'
                }
            }

            const response = await this.bot.axios.request(request, false) // 不使用代理
            const htmlContent = response.data as string

            // 解析热搜数据
            const dataMatch = htmlContent.match(/<!--s-data:(.*?)-->/s)
            if (dataMatch) {
                try {
                    const data = JSON.parse(dataMatch?.[1] || '{}')?.data?.cards?.[0]?.content || []

                    for (const item of data.slice(0, 30)) { // 取前30个热搜
                        if (item.word) {
                            queryTerms.push({
                                topic: item.word,
                                related: this.generateChineseRelatedTerms(item.word)
                            })
                        }
                    }
                } catch (parseError) {
                    this.bot.log(this.bot.isMobile, 'BAIDU-TRENDS', 'Failed to parse Baidu trends data', 'warn')
                }
            }

            this.bot.log(this.bot.isMobile, 'BAIDU-TRENDS', `Fetched ${queryTerms.length} trends from Baidu`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'BAIDU-TRENDS', `Error fetching Baidu trends: ${error}`, 'warn')
        }

        return queryTerms
    }

    /**
     * 获取微博热搜数据
     */
    private async getWeiboTrends(): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []

        try {
            // 微博热搜API
            const request: AxiosRequestConfig = {
                url: 'https://weibo.com/ajax/side/hotSearch',
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': 'https://weibo.com/'
                }
            }

            const response = await this.bot.axios.request(request, false) // 不使用代理

            if (response.data?.data?.realtime) {
                for (const item of response.data.data.realtime.slice(0, 30)) { // 取前30个热搜
                    if (item.word) {
                        queryTerms.push({
                            topic: item.word,
                            related: this.generateChineseRelatedTerms(item.word)
                        })
                    }
                }
            }

            this.bot.log(this.bot.isMobile, 'WEIBO-TRENDS', `Fetched ${queryTerms.length} trends from Weibo`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'WEIBO-TRENDS', `Error fetching Weibo trends: ${error}`, 'warn')
        }

        return queryTerms
    }

    /**
     * 生成中文相关搜索词
     */
    private generateChineseRelatedTerms(baseQuery: string): string[] {
        const patterns = [
            `${baseQuery} 最新消息`,
            `${baseQuery} 是什么`,
            `${baseQuery} 怎么样`,
            `${baseQuery} 详情`,
            `${baseQuery} 原因`,
            `${baseQuery} 结果`,
            `${baseQuery} 影响`,
            `${baseQuery} 评论`
        ]

        // 随机选择3-5个相关词
        const selectedCount = 3 + Math.floor(Math.random() * 3)
        return this.bot.utils.shuffleArray(patterns).slice(0, selectedCount)
    }

    /**
     * 中文备用搜索查询
     */
    private getChineseFallbackQueries(): GoogleSearch[] {
        const currentDate = new Date()
        const currentYear = currentDate.getFullYear()
        const currentMonth = currentDate.getMonth() + 1

        const topics = [
            // 时事热点
            `${currentYear}年${currentMonth}月新闻`,
            '今日头条',
            '热点新闻',
            '国内新闻',
            '国际新闻',
            '财经新闻',
            '科技新闻',
            '体育新闻',
            '娱乐新闻',

            // 生活相关
            '天气预报',
            '美食推荐',
            '旅游攻略',
            '健康养生',
            '购物优惠',
            '电影推荐',
            '音乐排行榜',
            '游戏攻略',

            // 科技话题
            '人工智能',
            '5G技术',
            '新能源汽车',
            '手机评测',
            '电脑配置',
            '软件推荐',
            '编程教程',
            '区块链',

            // 热门品牌和产品
            '华为',
            '小米',
            'OPPO',
            'vivo',
            '比亚迪',
            '特斯拉',
            '抖音',
            '微信',
            '支付宝',
            '淘宝',
            '京东',
            '拼多多',

            // 教育学习
            '考研',
            '高考',
            '英语学习',
            '编程学习',
            '职业规划',
            '面试技巧',

            // 投资理财
            '股票行情',
            '基金推荐',
            '理财产品',
            '房价走势',
            '黄金价格',

            // 热门话题
            '减肥方法',
            '护肤技巧',
            '穿搭推荐',
            '家居装修',
            '宠物养护',
            '植物种植',
            '美食制作',
            '旅游景点',

            // 节日相关（根据时间动态调整）
            '春节',
            '中秋节',
            '国庆节',
            '双十一',
            '双十二'
        ]

        // 将简单的字符串转换为 GoogleSearch 格式
        return topics.map(topic => ({
            topic,
            related: this.generateChineseRelatedTerms(topic)
        }))
    }

    private extractJsonFromResponse(text: string): GoogleTrendsResponse[1] | null {
        const lines = text.split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                try {
                    return JSON.parse(JSON.parse(trimmed)[0][2])[1]
                } catch {
                    continue
                }
            }
        }

        return null
    }

    private async getRelatedTerms(term: string): Promise<string[]> {
        try {
            const request = {
                url: `https://api.bing.com/osjson.aspx?query=${term}`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            const response = await this.bot.axios.request(request, this.bot.config.proxy.proxyBingTerms)

            return response.data[1] as string[]
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING-RELATED', 'An error occurred:' + error, 'error')
        }

        return []
    }

    private async closeTabs(lastTab: Page) {
        const browser = lastTab.context()
        const tabs = browser.pages()

        try {
            if (tabs.length > 2) {
                // If more than 2 tabs are open, close the last tab

                await lastTab.close()
                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', `More than 2 were open, closed the last tab: "${new URL(lastTab.url()).host}"`)

            } else if (tabs.length === 1) {
                // If only 1 tab is open, open a new one to search in

                const newPage = await browser.newPage()
                await this.bot.utils.wait(1000)

                await newPage.goto(this.bingHome)
                await this.bot.utils.wait(3000)
                this.searchPageURL = newPage.url()

                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'There was only 1 tab open, crated a new one')
            } else {
                // Else reset the last tab back to the search listing or Bing.com

                lastTab = await this.bot.browser.utils.getLatestTab(lastTab)
                await lastTab.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'An error occurred:' + error, 'error')
        }

    }

    private calculatePoints(counters: Counters) {
        const mobileData = counters.mobileSearch?.[0] // Mobile searches
        const genericData = counters.pcSearch?.[0] // Normal searches
        const edgeData = counters.pcSearch?.[1] // Edge searches

        if (this.bot.isMobile && mobileData) {
            // 移动端只计算移动搜索积分
            return mobileData.pointProgressMax - mobileData.pointProgress
        } else {
            // 桌面端计算PC搜索 + Edge搜索
            const genericMissing = genericData ? genericData.pointProgressMax - genericData.pointProgress : 0
            const edgeMissing = edgeData ? edgeData.pointProgressMax - edgeData.pointProgress : 0

            // 记录详细的桌面端积分状态
            if (genericData || edgeData) {
                this.bot.log(this.bot.isMobile, 'SEARCH-POINTS-BREAKDOWN',
                    `Desktop breakdown: PC(${genericData?.pointProgress || 0}/${genericData?.pointProgressMax || 0}), Edge(${edgeData?.pointProgress || 0}/${edgeData?.pointProgressMax || 0})`)
            }

            return genericMissing + edgeMissing
        }
    }

    /**
     * 智能调整搜索延迟
     */
    private async getSmartSearchDelay(): Promise<number> {
        const baseMin = this.bot.isMobile ? 60000 : 45000 // 移动端60s，桌面端45s
        const baseMax = this.bot.isMobile ? 150000 : 120000 // 移动端150s，桌面端120s

        // 根据连续失败次数调整延迟
        const failureMultiplier = Math.min(1 + (this.consecutiveFailures * 0.5), 3) // 最多3倍延迟

        // 根据自适应倍数调整
        const adaptiveMultiplier = this.adaptiveDelayMultiplier

        const adjustedMin = baseMin * failureMultiplier * adaptiveMultiplier
        const adjustedMax = baseMax * failureMultiplier * adaptiveMultiplier

        const delay = Math.floor(Math.random() * (adjustedMax - adjustedMin + 1)) + adjustedMin

        if (failureMultiplier > 1 || adaptiveMultiplier > 1) {
            this.bot.log(this.bot.isMobile, 'SEARCH-SMART-DELAY',
                `Smart delay: ${Math.round(delay / 1000)}s (base: ${Math.round(baseMin / 1000)}-${Math.round(baseMax / 1000)}s, failure multiplier: ${failureMultiplier.toFixed(1)}, adaptive: ${adaptiveMultiplier.toFixed(1)})`)
        }

        return delay
    }

    /**
     * 生成有上下文关联的搜索序列
     */
    private generateContextualSearches(baseQuery: string, language: string = 'ja'): string[] {
        const contextualPatterns: Record<string, string[]> = {
            'ja': [
                `${baseQuery}`,
                `${baseQuery} とは`,
                `${baseQuery} 意味`,
                `${baseQuery} 使い方`,
                `${baseQuery} おすすめ`,
                `${baseQuery} 比較`,
                `${baseQuery} 評価`,
                `${baseQuery} 口コミ`
            ],
            'en': [
                `${baseQuery}`,
                `what is ${baseQuery}`,
                `${baseQuery} meaning`,
                `how to use ${baseQuery}`,
                `best ${baseQuery}`,
                `${baseQuery} vs`,
                `${baseQuery} review`,
                `${baseQuery} guide`
            ],
            'zh': [
                `${baseQuery}`,
                `${baseQuery} 是什么`,
                `${baseQuery} 怎么用`,
                `${baseQuery} 推荐`,
                `${baseQuery} 比较`,
                `${baseQuery} 评价`,
                `${baseQuery} 教程`
            ]
        }

        const patterns = contextualPatterns[language] || contextualPatterns['en']
        // 随机选择2-3个相关搜索
        const selectedCount = 2 + Math.floor(Math.random() * 2)
        return this.bot.utils.shuffleArray(patterns as string[]).slice(0, selectedCount) as string[]
    }

    /**
     * 检查是否应该使用上下文搜索
     */
    private shouldUseContextualSearch(): boolean {
        // 30%的概率使用上下文搜索
        return Math.random() < 0.3
    }

    /**
     * 模拟搜索建议点击
     */
    private async clickSearchSuggestion(page: Page): Promise<boolean> {
        try {
            // 等待搜索建议出现
            await this.bot.utils.wait(500 + Math.random() * 1000)

            // 搜索建议的选择器
            const suggestionSelectors = [
                '.sa_sg',  // Bing搜索建议
                '.sa_tm_text',  // 相关搜索文本
                '#sw_as .sa_tm'  // 下拉建议
            ]

            for (const selector of suggestionSelectors) {
                const suggestions = await page.$$(selector)
                if (suggestions.length > 0) {
                    // 倾向于选择前面的建议（更相关）
                    const index = Math.floor(Math.random() * Math.min(3, suggestions.length))
                    const suggestion = suggestions[index]
                    if (suggestion) {
                        await suggestion.click()
                        this.bot.log(this.bot.isMobile, 'SEARCH-SUGGESTION', 'Clicked search suggestion')
                        return true
                    }
                }
            }

            return false
        } catch (error) {
            return false
        }
    }

    /**
     * 模拟查看搜索结果第二页
     */
    private async navigateToSecondPage(page: Page): Promise<boolean> {
        try {
            // 30%概率查看第二页
            if (Math.random() > 0.3) return false

            // 滚动到页面底部
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight)
            })
            await this.bot.utils.wait(1000 + Math.random() * 1000)

            // 查找"下一页"按钮
            const nextPageSelectors = [
                'a.sb_pagN',  // 下一页按钮
                'a[title="下一页"]',
                'a[title="Next page"]',
                'a[aria-label="下一页"]'
            ]

            for (const selector of nextPageSelectors) {
                const nextButton = await page.$(selector)
                if (nextButton) {
                    await nextButton.click()
                    await this.bot.utils.wait(2000 + Math.random() * 2000)
                    this.bot.log(this.bot.isMobile, 'SEARCH-PAGINATION', 'Navigated to second page')

                    // 在第二页稍作停留
                    await this.safeRandomScroll(page)

                    return true
                }
            }

            return false
        } catch (error) {
            return false
        }
    }

    /**
     * 生成额外的搜索查询（当预定义查询不足时）
     */
    private async generateAdditionalQueries(): Promise<(GoogleSearch | string)[]> {
        const additionalQueries: (GoogleSearch | string)[] = []

        try {
            // 1. 基于时间的查询
            const currentDate = new Date()
            const currentYear = currentDate.getFullYear()
            const currentMonth = currentDate.getMonth() + 1
            const currentDay = currentDate.getDate()

            const timeBasedQueries = [
                `${currentYear}年${currentMonth}月のニュース`,
                `${currentYear}年の出来事`,
                `今日は${currentMonth}月${currentDay}日`,
                '最新のトレンド',
                '今週のニュース',
                '今月のイベント',
                '最新技術',
                '注目の話題'
            ]

            additionalQueries.push(...timeBasedQueries)

            // 2. 随机生成的组合查询
            const subjects = ['技術', '映画', '音楽', '料理', '旅行', '健康', '学習', 'ビジネス', 'スポーツ', 'ファッション']
            const modifiers = ['最新', '人気', 'おすすめ', 'ランキング', 'レビュー', '比較', '方法', 'コツ']

            for (let i = 0; i < 10; i++) {
                const subject = subjects[Math.floor(Math.random() * subjects.length)]
                const modifier = modifiers[Math.floor(Math.random() * modifiers.length)]
                additionalQueries.push(`${subject} ${modifier}`)
            }

            // 3. 常见搜索模式
            const commonPatterns = [
                'どうやって',
                'なぜ',
                'いつ',
                'どこで',
                'だれが',
                '何のため',
                'いくら',
                'どのくらい'
            ]

            const topics = ['仕事', '勉強', '家族', '友達', 'お金', '時間', '健康', '幸せ']

            for (const pattern of commonPatterns) {
                const topic = topics[Math.floor(Math.random() * topics.length)]
                additionalQueries.push(`${pattern}${topic}`)
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-ADDITIONAL', `Generated ${additionalQueries.length} additional search queries`)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ADDITIONAL-ERROR', `Error generating additional queries: ${error}`, 'warn')
        }

        return additionalQueries
    }

}
