// MUST be first: arms the rebrowser anti-detection patches before rebrowser-playwright is loaded.
import './rebrowser-env'

import cluster from 'cluster'
import { Page } from 'rebrowser-playwright'
import ms from 'ms'

import Browser, { ManagedBrowser } from '../browser/Browser'
import BrowserFunc from '../browser/BrowserFunc'
import BrowserUtil from '../browser/BrowserUtil'

import { log } from '../utils/Logger'
import Util from '../utils/Utils'
import { loadAccounts, loadConfig, saveSessionData, refreshAllConfigs } from '../utils/Load'

import { Login } from '../functions/Login'
import Activities from '../functions/Activities'
import { RewardsEarner } from './rewards-api/RewardsEarner'
import { RewardsApi } from './rewards-api/RewardsApi'
import { SearchRunner } from './rewards-api/SearchRunner'
import { ExploreRunner } from './rewards-api/ExploreRunner'
import { VisualSearchRunner } from './rewards-api/VisualSearchRunner'

import { Account } from '../interfaces/Account'
import Axios from '../utils/Axios'
import { StartupConfig } from '../utils/StartupConfig'
import { TwoFactorAuthRequiredError, LoginTimeoutError } from '../interfaces/Errors'


// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof log
    public config
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }
    public isMobile: boolean
    public homePage!: Page

    private activeWorkers: number
    private activeManagedBrowsers: Map<string, Set<ManagedBrowser>> = new Map()
    private spawnedInstances: MicrosoftRewardsBot[] = []
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private login = new Login(this)
    private accessToken: string = ''

    public axios!: Axios

    constructor(isMobile: boolean) {
        this.isMobile = isMobile
        this.log = log

        this.accounts = []
        this.utils = new Util()
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = 0
    }

    async initialize() {
        this.accounts = loadAccounts()
        log('main', 'MAIN-CONFIG', `Loaded ${this.accounts.length} accounts for processing`)
    }

    async run() {
        // 刷新配置以确保使用最新设置
        this.config = loadConfig()
        this.accounts = loadAccounts()
        
        log('main', 'MAIN', `Bot started with ${this.config.clusters} clusters`)
        log('main', 'MAIN-CONFIG', `Using ${this.accounts.length} accounts and ${this.config.clusters} clusters`)

        // Only cluster when there's more than 1 cluster demanded
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.runMaster()
            } else {
                this.runWorker()
            }
        } else {
            await this.runTasks(this.accounts)
        }
    }

    private runMaster() {
        log('main', 'MAIN-PRIMARY', 'Primary process started')

        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        this.activeWorkers = accountChunks.length

        if (this.activeWorkers === 0) {
            log('main', 'MAIN-PRIMARY', 'No account chunks to process. Exiting main process!')
            process.exit(0)
        }

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]
            worker.send({ chunk })
        }

        cluster.on('exit', (worker, code) => {
            this.activeWorkers -= 1

            log('main', 'MAIN-WORKER', `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                log('main', 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })
    }

    private runWorker() {
        log('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts from the master
        process.on('message', async ({ chunk }) => {
            await this.runTasks(chunk)
            // Workers always exit so the master's cluster.on('exit') accounting can complete
            process.exit(0)
        })
    }

    private async runTasks(accounts: Account[]) {
        let completedAccounts = 0
        let failedAccounts = 0

        // Randomise account order each run so accounts sharing an egress IP/proxy don't present a
        // stable processing sequence (and fixed inter-account time offsets) day after day.
        for (let i = accounts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = accounts[i] as Account
            accounts[i] = accounts[j] as Account
            accounts[j] = tmp
        }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i]
            if (!account) {
                log('main', 'MAIN-ERROR', `Account at index ${i} is undefined`, 'error')
                continue
            }
            
            const accountNumber = i + 1
            const totalAccounts = accounts.length

            log('main', 'MAIN-WORKER', `[${accountNumber}/${totalAccounts}] Started tasks for account ${account.email}`)

            try {
                // 在处理每个账户前刷新配置，确保使用最新设置
                this.config = loadConfig()

                // 设置账户处理超时（30分钟）
                const accountTimeout = this.utils.stringToMs(this.config.globalTimeout)

                const accountTask = this.processAccount(account)
                let timeoutHandle: NodeJS.Timeout | null = null
                let didTimeout = false

                try {
                    await Promise.race([
                        accountTask,
                        new Promise<never>((_, reject) => {
                            timeoutHandle = setTimeout(() => {
                                didTimeout = true
                                reject(new Error(`Account processing timeout after ${accountTimeout}ms`))
                            }, accountTimeout)
                        })
                    ])
                } catch (error) {
                    if (didTimeout) {
                        log('main', 'MAIN-TIMEOUT', `Timeout reached for ${account.email}, closing active resources...`, 'warn')
                        await this.cleanupAccountResources(account.email)

                        await Promise.race([
                            accountTask.catch(taskError => {
                                log('main', 'MAIN-TIMEOUT', `Timed-out account ${account.email} settled after cleanup: ${taskError}`, 'warn')
                            }),
                            this.utils.wait(10000)
                        ])
                    }

                    throw error
                } finally {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle)
                    }
                }

                completedAccounts++
                log('main', 'MAIN-WORKER', `[${accountNumber}/${totalAccounts}] ✅ Completed tasks for account ${account.email}`, 'log', 'green')

                // 添加账户间的延迟，避免请求过于频繁
                if (i < accounts.length - 1) {
                    // 使用配置文件中的延迟设置，如果没有则使用默认值
                    const accountDelayConfig = this.config.accountDelay || { min: '5min', max: '15min' }
                    const minDelay = this.utils.stringToMs(accountDelayConfig.min)
                    const maxDelay = this.utils.stringToMs(accountDelayConfig.max)
                    const delayMs = this.utils.randomNumber(minDelay, maxDelay)
                    
                    log('main', 'MAIN-WORKER', `⏱️ Waiting ${Math.round(delayMs/60000)} minutes before processing next account...`)
                    log('main', 'MAIN-WORKER', `Next account will start at: ${new Date(Date.now() + delayMs).toLocaleTimeString()}`)
                    
                    // 显示倒计时 - 每5分钟显示一次，避免频繁刷屏
                    const startTime = Date.now()
                    let lastDisplayTime = 0
                    const countdownInterval = setInterval(() => {
                        const currentTime = Date.now()
                        const remaining = delayMs - (currentTime - startTime)

                        if (remaining > 0) {
                            // 每5分钟显示一次，或者是第一次显示
                            if (currentTime - lastDisplayTime >= 300000 || lastDisplayTime === 0) {
                                console.log(`⏳ Time remaining: ${Math.round(remaining/60000)} minutes...`)
                                lastDisplayTime = currentTime
                            }
                        }
                    }, 60000)  // 每1分钟检查一次，但只在满足条件时显示
                    await this.utils.wait(delayMs)
                    clearInterval(countdownInterval)
                    console.log('\n')  // 换行
                }

            } catch (error) {
                failedAccounts++
                log('main', 'MAIN-ERROR', `[${accountNumber}/${totalAccounts}] ❌ Failed to process account ${account.email}: ${error}`, 'error')
                
                // 记录错误详情但继续处理下一个账户
                log('main', 'MAIN-ERROR', `Account ${account.email} error details: ${error instanceof Error ? error.stack : error}`, 'error')
                
                // 尝试清理可能残留的资源
                try {
                    await this.cleanupAccountResources(account.email)
                } catch (cleanupError) {
                    log('main', 'MAIN-ERROR', `Failed to cleanup resources for ${account.email}: ${cleanupError}`, 'error')
                }

                // 如果失败次数过多，暂停一段时间
                if (failedAccounts >= 2) {
                    log('main', 'MAIN-WORKER', 'Multiple account failures detected, waiting 30s before continuing...', 'warn')
                    await this.utils.wait(30000)
                }
            }
        }

        // 报告最终结果
        log('main', 'MAIN-SUMMARY', 'Task execution completed:', 'log', 'cyan')
        log('main', 'MAIN-SUMMARY', `✅ Successful accounts: ${completedAccounts}/${accounts.length}`, 'log', 'green')
        log('main', 'MAIN-SUMMARY', `❌ Failed accounts: ${failedAccounts}/${accounts.length}`, 'log', failedAccounts > 0 ? 'yellow' : 'green')
        
        log(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')
    }

    /**
     * 处理单个账户的任务
     */
    private async processAccount(account: Account): Promise<void> {
        this.axios = new Axios(account.proxy)

        // 🎯 为新账户清理弹窗处理历史
        this.browser.utils.clearPopupHistory()

        // Reset tracked child instances (e.g. the parallel-mode mobile bot) for this account
        this.spawnedInstances = []

        if (this.config.parallel) {
                // 并行处理，但要分别处理错误
                const results = await Promise.allSettled([
                    this.Desktop(account).catch(error => {
                        log('main', 'MAIN-ERROR', `Desktop task failed for ${account.email}: ${error}`, 'error')
                        throw error
                    }),
                    (async () => {
                        const mobileInstance = new MicrosoftRewardsBot(true)
                        mobileInstance.axios = this.axios
                        this.spawnedInstances.push(mobileInstance)
                        return mobileInstance.Mobile(account).catch(error => {
                            // 特殊处理2FA错误
                            if (error instanceof TwoFactorAuthRequiredError) {
                                log('main', 'MAIN-2FA-SKIP', `Mobile task skipped for ${account.email}: ${error.message}`, 'warn')
                                return // 不抛出错误，视为成功跳过
                            }
                            log('main', 'MAIN-ERROR', `Mobile task failed for ${account.email}: ${error}`, 'error')
                            throw error
                        })
                    })()
                ])

                // 检查并行任务的结果
                let hasFailure = false
                results.forEach((result, index) => {
                    const taskType = index === 0 ? 'Desktop' : 'Mobile'
                    if (result.status === 'rejected') {
                        log('main', 'MAIN-ERROR', `${taskType} task failed for ${account.email}: ${result.reason}`, 'error')
                        hasFailure = true
                    } else {
                        log('main', 'MAIN-SUCCESS', `${taskType} task completed for ${account.email}`, 'log', 'green')
                    }
                })

                if (hasFailure) {
                    throw new Error('One or more parallel tasks failed')
                }
            } else {
                const taskFailures: string[] = []

                // 顺序处理
                try {
                    this.isMobile = false
                    await this.Desktop(account)
                    log('main', 'MAIN-SUCCESS', `Desktop task completed for ${account.email}`, 'log', 'green')
                } catch (error) {
                    log('main', 'MAIN-ERROR', `Desktop task failed for ${account.email}: ${error}`, 'error')
                    taskFailures.push(`Desktop task failed: ${error instanceof Error ? error.message : String(error)}`)
                }

                try {
                    this.isMobile = true
                    await this.Mobile(account)
                    log('main', 'MAIN-SUCCESS', `Mobile task completed for ${account.email}`, 'log', 'green')
                } catch (error) {
                    // 特殊处理2FA错误
                    if (error instanceof TwoFactorAuthRequiredError) {
                        log('main', 'MAIN-2FA-SKIP', `Mobile task skipped for ${account.email}: ${error.message}`, 'warn')
                        // 不视为错误，继续处理下一个账户
                    } else {
                        log('main', 'MAIN-ERROR', `Mobile task failed for ${account.email}: ${error}`, 'error')
                        taskFailures.push(`Mobile task failed: ${error instanceof Error ? error.message : String(error)}`)
                    }
                }

                if (taskFailures.length > 0) {
                    throw new Error(taskFailures.join(' | '))
                }
            }
    }

    private registerManagedBrowser(managedBrowser: ManagedBrowser): void {
        const browsers = this.activeManagedBrowsers.get(managedBrowser.email) ?? new Set<ManagedBrowser>()
        browsers.add(managedBrowser)
        this.activeManagedBrowsers.set(managedBrowser.email, browsers)
    }

    private unregisterManagedBrowser(managedBrowser: ManagedBrowser): void {
        const browsers = this.activeManagedBrowsers.get(managedBrowser.email)
        if (!browsers) {
            return
        }

        browsers.delete(managedBrowser)
        if (browsers.size === 0) {
            this.activeManagedBrowsers.delete(managedBrowser.email)
        }
    }

    private async closeManagedBrowser(managedBrowser: ManagedBrowser, saveSession = true): Promise<void> {
        try {
            await this.browser.func.closeBrowser(managedBrowser, saveSession)
        } finally {
            this.unregisterManagedBrowser(managedBrowser)
        }
    }

    /**
     * 清理账户相关资源
     */
    private async cleanupAccountResources(email: string): Promise<void> {
        try {
            log('main', 'CLEANUP', `Cleaning up resources for account ${email}`)

            // Include child instances — the parallel-mode mobile bot registers its browsers on a
            // separate instance, so the main cleanup map alone cannot reach them.
            const instances: MicrosoftRewardsBot[] = [this, ...this.spawnedInstances]
            const activeBrowsers = instances.flatMap(inst =>
                Array.from(inst.activeManagedBrowsers.get(email) ?? []).map(browser => ({ inst, browser }))
            )
            if (activeBrowsers.length > 0) {
                log('main', 'CLEANUP', `Closing ${activeBrowsers.length} active browser(s) for ${email}`)
                await Promise.allSettled(activeBrowsers.map(({ inst, browser }) => inst.closeManagedBrowser(browser, false)))
            }

            // 强制垃圾回收（如果可用）
            if (global.gc) {
                global.gc()
                log('main', 'CLEANUP', 'Forced garbage collection')
            }

            // 给系统时间来清理资源
            await this.utils.wait(2000)

            log('main', 'CLEANUP', `Resource cleanup completed for account ${email}`)
        } catch (error) {
            log('main', 'CLEANUP-ERROR', `Resource cleanup failed for ${email}: ${error}`, 'error')
        }
    }

    /**
     * 手动刷新所有配置
     */
    public refreshConfigs(): void {
        refreshAllConfigs()
        this.config = loadConfig()
        this.accounts = loadAccounts()
        log('main', 'MAIN-CONFIG', 'All configurations manually refreshed')
    }

    // Desktop
    async Desktop(account: Account): Promise<void> {
        let managedBrowser: ManagedBrowser | null = null
        let sessionStable = false

        try {
            managedBrowser = await this.browserFactory.createBrowser(account.proxy, account.email)
            this.registerManagedBrowser(managedBrowser)
            this.homePage = await managedBrowser.context.newPage()

            log(this.isMobile, 'MAIN', 'Starting desktop browser')

            // Login into MS Rewards
            await this.login.login(this.homePage, account.email, account.password)
            sessionStable = true

            // The new rewards.bing.com SPA has no scrapable dashboard, so data + activity completion go
            // through the dapi backend. Get the OAuth token, then claim activities via the API.
            this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

            const earner = new RewardsEarner(this, this.accessToken)
            const result = await earner.run()
            log(this.isMobile, 'MAIN-POINTS', `Desktop activities done: claimed ${result.claimed}, +${result.pointsGained} points (balance ${result.balance})`)

            // Earn search points with real, human-paced Bing searches (search is not claimable via the API)
            if (this.config.workers.doDesktopSearch !== false) {
                const searchPage = await managedBrowser.context.newPage()
                try {
                    const api = new RewardsApi(this, this.accessToken)
                    // Explore-on-Bing offers credit via a category search launched from the rewards flyout.
                    // Do them first (best-effort) — these searches also count toward the PC search cap, so
                    // SearchRunner afterwards only tops up whatever's left.
                    if (this.config.workers.doMorePromotions !== false) {
                        try {
                            const explorer = new ExploreRunner(this, api, searchPage)
                            await explorer.run()
                        } catch (exploreError) {
                            log(this.isMobile, 'EXPLORE', `Explore-on-Bing failed: ${exploreError}`, 'warn')
                        }
                        // Visual-search activation offer (+10) — reverse-engineered upload + signed-in GET.
                        try {
                            const visual = new VisualSearchRunner(this, api, searchPage)
                            await visual.run()
                        } catch (visualError) {
                            log(this.isMobile, 'VISUAL-SEARCH', `Visual search failed: ${visualError}`, 'warn')
                        }
                    }
                    const searcher = new SearchRunner(this, api, searchPage, account.email)
                    await searcher.run()
                } catch (searchError) {
                    log(this.isMobile, 'SEARCH', `Desktop search failed: ${searchError}`, 'error')
                } finally {
                    await searchPage.close().catch(() => { })
                }
            }

            // Save cookies
            await saveSessionData(this.config.sessionPath, managedBrowser.context, account.email, this.isMobile)

            // Close desktop browser
            await this.closeManagedBrowser(managedBrowser, true)
            managedBrowser = null

        } catch (error) {
            log(this.isMobile, 'DESKTOP-ERROR', `Desktop task failed for ${account.email}: ${error}`, 'error')

            if (managedBrowser) {
                try {
                    await this.closeManagedBrowser(managedBrowser, sessionStable)
                    managedBrowser = null
                } catch (closeError) {
                    log(this.isMobile, 'DESKTOP-CLEANUP', `Failed to close managed browser: ${closeError}`, 'error')
                }
            }

            throw error
        }
    }

    // Mobile
    async Mobile(account: Account): Promise<void> {
        if (this.config.workers.doMobileSearch === false) {
            log(this.isMobile, 'MAIN', 'Mobile search disabled in config')
            return
        }

        // Cheap pre-check (reusing the desktop token): only spin up a second browser + sign-in when
        // mobile search can still earn. Mobile searches credit the SAME single search promotion as PC
        // (verified at Level 2 — there is no separate MobileSearch-tagged promotion; PC stalls at its
        // sub-cap and mobile fills the rest toward the daily max). So run whenever that promotion still
        // has room; skip when there's no search promotion (e.g. a brand-new account) or it's already
        // maxed (e.g. PC search already filled the whole daily cap) — avoids a pointless login.
        if (this.accessToken) {
            try {
                const data = await new RewardsApi(this, this.accessToken).getData()
                const searchPromo = data.promotions.find(p => p.type === 'search')
                if (!searchPromo) {
                    log(this.isMobile, 'MAIN', 'No search promotion available — skipping mobile browser')
                    return
                }
                if (searchPromo.max > 0 && searchPromo.progress >= searchPromo.max) {
                    log(this.isMobile, 'MAIN', 'Daily search cap already filled — skipping mobile browser')
                    return
                }
            } catch (error) {
                // Token check failed — fall through to the full flow (it also no-ops gracefully if there is no promotion)
                log(this.isMobile, 'MAIN', `Mobile pre-check failed (${error}); proceeding with full mobile flow`, 'warn')
            }
        }

        let managedBrowser: ManagedBrowser | null = null
        let sessionStable = false

        try {
            managedBrowser = await this.browserFactory.createBrowser(account.proxy, account.email)
            this.registerManagedBrowser(managedBrowser)
            this.homePage = await managedBrowser.context.newPage()

            log(this.isMobile, 'MAIN', 'Starting mobile browser')

            // Reuses the saved desktop session when possible (fast, no credential re-entry / anti-throttle)
            await this.login.login(this.homePage, account.email, account.password)
            sessionStable = true
            this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

            // Mobile search points via real, human-paced searches (activities are claimed in Desktop()).
            const searchPage = await managedBrowser.context.newPage()
            try {
                const searcher = new SearchRunner(this, new RewardsApi(this, this.accessToken), searchPage, account.email)
                await searcher.run()
            } finally {
                await searchPage.close().catch(() => { })
            }

            await saveSessionData(this.config.sessionPath, managedBrowser.context, account.email, this.isMobile)
            await this.closeManagedBrowser(managedBrowser, true)
            managedBrowser = null

        } catch (error) {
            // Mobile is best-effort (desktop already earned the main points): an OAuth/2FA prompt or any
            // mobile failure is logged and skipped rather than failing the whole account.
            if (error instanceof LoginTimeoutError || (error instanceof Error && error.message.includes('OAuth authorization timeout'))) {
                log(this.isMobile, 'MOBILE-OAUTH', `Mobile OAuth needs interaction for ${account.email} — skipping mobile search`, 'warn')
            } else {
                log(this.isMobile, 'MOBILE-ERROR', `Mobile task failed for ${account.email}: ${error}`, 'warn')
            }
            if (managedBrowser) {
                try {
                    await this.closeManagedBrowser(managedBrowser, sessionStable)
                } catch (closeError) {
                    log(this.isMobile, 'MOBILE-CLEANUP', `Failed to close managed browser: ${closeError}`, 'warn')
                }
            }
        }
    }
}

async function main() {
    const rewardsBot = new MicrosoftRewardsBot(false)
    if (cluster.isPrimary) {
        await StartupConfig.initialize()
    }
    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        log('main', 'MAIN-ERROR', `Error running desktop bot: ${error}`, 'error')
    }
}

/** 判断当前环境是否属于中文语言地区（zh / zh-CN / zh-TW / zh-HK / zh-Hant ...）。 */
function isZhLanguage(): boolean {
    const candidates = [
        process.env.LANG || '',
        process.env.LC_ALL || '',
        process.env.LC_MESSAGES || '',
        Intl.DateTimeFormat().resolvedOptions().locale
    ].filter(Boolean)
    return candidates.some(locale => /^zh(?=$|[-_])/i.test(locale))
}

/** 简单双语文案：zh 环境显示中文，其余回退英文。 */
function t(zh: string, en: string): string {
    return isZhLanguage() ? zh : en
}

/**
 * 每日定时调度器（无第三方依赖，用 setTimeout 实现）。
 * 配置项 config.json -> scheduler：
 *   enabled: 是否启用（启用后进程常驻，跑完一次不退出）
 *   times:   每天执行的时刻列表 "HH:mm"，如 ["06:10", "08:10", ...]
 *   timezone: 时区，默认 Asia/Shanghai
 *   runOnStart: 启动时是否立即执行一次，默认 true
 *   maxShortRunsPerDay: 单日“短执行”累计次数上限，达到后当天剩余时刻跳过
 *   shortRunThreshold: “短执行”的时长阈值（ms 可解析字符串，如 "5min"），默认 5 分钟
 * 互锁：到点触发时若上一次执行仍在进行（含启动时的立即执行），则跳过本次触发。
 */
function scheduleDailyTask(): (() => Promise<void>) | null {
    const cfg = loadConfig()
    const sched = cfg.scheduler
    if (!sched || sched.enabled === false) {
        log('main', 'SCHEDULER', t('调度器未启用 - 本次运行结束后进程退出', 'Scheduler disabled - process will exit after the run'), 'warn')
        return null
    }

    const times = Array.isArray(sched.times) && sched.times.length > 0
        ? sched.times
        : ['06:10', '08:10', '10:10', '12:10', '14:10', '16:10', '18:10', '20:10', '22:10']
    const timezone = sched.timezone || 'Asia/Shanghai'
    const maxShortRuns = sched.maxShortRunsPerDay ?? 3
    let shortRunThreshold = 5 * 60 * 1000 // 默认 5 分钟
    if (sched.shortRunThreshold) {
        const parsed = ms(sched.shortRunThreshold)
        if (parsed) {
            shortRunThreshold = parsed
        } else {
            log('main', 'SCHEDULER', t(`shortRunThreshold "${sched.shortRunThreshold}" 无效，使用默认 5 分钟`, `Invalid shortRunThreshold "${sched.shortRunThreshold}", using default 5min`), 'warn')
        }
    }

    let isRunning = false
    let lastRunDate = ''
    let shortRunsToday = 0
    let skipToday = false
    let timer: NodeJS.Timeout | null = null

    const parseTime = (t: string): { h: number; m: number } | null => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
        if (!m) return null
        const h = Number(m[1])
        const min = Number(m[2])
        if (h < 0 || h > 23 || min < 0 || min > 59) return null
        return { h, m: min }
    }

    // 指定时区下的当前 时分 与日期（兼容系统时区不是目标时区的情况）
    const nowParts = (): { h: number; m: number; s: number; day: string } => {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).formatToParts(new Date())
        const get = (type: string): number => Number(parts.find(p => p.type === type)?.value || '0')
        const pad = (type: string): string => String(parts.find(p => p.type === type)?.value || '00').padStart(2, '0')
        return { h: get('hour'), m: get('minute'), s: get('second'), day: `${pad('year')}-${pad('month')}-${pad('day')}` }
    }

    const nextFireInMs = (): number => {
        const now = nowParts()
        const minutes = times
            .map(parseTime)
            .filter((t): t is { h: number; m: number } => t !== null)
            .map(t => t.h * 60 + t.m)
            .sort((a, b) => a - b)
        if (minutes.length === 0) {
            // 配置错误时兜底：1小时后重试
            log('main', 'SCHEDULER', `No valid times in ${JSON.stringify(times)}, retrying in 1h`, 'warn')
            return 60 * 60 * 1000
        }
        const nowMin = now.h * 60 + now.m
        const todayNext = minutes.find(m => m > nowMin)
        const firstMinute = minutes[0]
        const target = todayNext !== undefined ? todayNext : (firstMinute !== undefined ? firstMinute + 24 * 60 : nowMin + 60)
        // 精确到秒：目标时刻减当前时刻（含秒），避免定时点晚触发最多近 1 分钟
        return ((target - nowMin) * 60 - now.s) * 1000
    }

    /** 今天剩余（尚未到达）的定时点数量。 */
    const remainingSlotsToday = (): number => {
        const now = nowParts()
        const nowMin = now.h * 60 + now.m
        return times
            .map(parseTime)
            .filter((x): x is { h: number; m: number } => x !== null)
            .filter(x => x.h * 60 + x.m > nowMin)
            .length
    }

    const formatDuration = (ms: number): string => {
        const h = Math.floor(ms / 3600000)
        const m = Math.floor((ms % 3600000) / 60000)
        const s = Math.floor((ms % 60000) / 1000)
        return `${h > 0 ? h + '小时' : ''}${m > 0 ? m + '分' : ''}${s}秒`
    }

    const run = async (): Promise<void> => {
        if (isRunning) {
            log('main', 'SCHEDULER', t('前一个任务仍在执行中，跳过本次执行', 'Previous task still running, skipping this run'), 'warn')
            return
        }
        const today = nowParts().day
        if (skipToday && lastRunDate === today) {
            log('main', 'SCHEDULER', t('今日已触发短执行上限，跳过当日后续执行', "Skipping today's remaining runs (short-run limit reached)"), 'warn')
            return
        }
        if (lastRunDate !== today) {
            lastRunDate = today
            shortRunsToday = 0
            skipToday = false
        }

        isRunning = true
        const start = Date.now()
        log('main', 'SCHEDULER', t(`开始执行定时任务，开始时间: ${new Date().toLocaleString()}`, `Scheduled task started at ${new Date().toLocaleString()}`))
        try {
            await main()
        } catch (error) {
            log('main', 'SCHEDULER-ERROR', t(`定时任务执行失败: ${error}`, `Scheduled task failed: ${error}`), 'error')
        } finally {
            isRunning = false
            const duration = Date.now() - start
            const remainingSlots = remainingSlotsToday()
            if (duration < shortRunThreshold) {
                shortRunsToday++
                log('main', 'SCHEDULER', t(
                    `定时任务执行完成，总耗时: ${formatDuration(duration)}；短执行 ${shortRunsToday}/${maxShortRuns} 次，剩余 ${Math.max(0, maxShortRuns - shortRunsToday)} 次触发跳过；今日剩余定时点 ${remainingSlots} 个`,
                    `Scheduled task finished, duration: ${formatDuration(duration)}; short runs ${shortRunsToday}/${maxShortRuns}, ${Math.max(0, maxShortRuns - shortRunsToday)} left; remaining slots today: ${remainingSlots}`
                ))
                if (shortRunsToday >= maxShortRuns) {
                    skipToday = true
                    log('main', 'SCHEDULER', t(`短执行累计 ${shortRunsToday}/${maxShortRuns} 次，将跳过今日后续执行`, `Reached ${shortRunsToday}/${maxShortRuns} short runs today - skipping remaining runs`), 'warn')
                }
            } else {
                log('main', 'SCHEDULER', t(
                    `定时任务执行完成，总耗时: ${formatDuration(duration)}；短执行 ${shortRunsToday}/${maxShortRuns} 次，剩余 ${Math.max(0, maxShortRuns - shortRunsToday)} 次触发跳过；今日剩余定时点 ${remainingSlots} 个`,
                    `Scheduled task finished, duration: ${formatDuration(duration)}; short runs ${shortRunsToday}/${maxShortRuns}, ${Math.max(0, maxShortRuns - shortRunsToday)} left; remaining slots today: ${remainingSlots}`
                ))
            }
        }
    }

    const scheduleNext = (): void => {
        const delay = Math.max(1000, nextFireInMs())
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            void run().finally(() => scheduleNext())
        }, delay)
    }

    log('main', 'SCHEDULER', t(`调度器已启动：每天 ${times.join(', ')}（${timezone}）`, `Scheduler enabled: daily at ${times.join(', ')} (${timezone})`))
    scheduleNext()
    return run
}

async function startApp() {
    log('main', 'START', t('应用启动', 'App started'))
    // 先注册定时器再执行首轮任务，避免长任务占用期间错过到点触发；首轮也走同一互锁与统计
    const runScheduled = scheduleDailyTask()
    const cfg = loadConfig()
    const runOnStart = cfg.scheduler?.runOnStart !== false
    if (runScheduled) {
        if (runOnStart) {
            await runScheduled()
        }
    } else {
        // 调度器未启用：保持“跑一次即退出”的原有行为
        if (runOnStart) {
            await main()
        }
        process.exit(0)
    }
}

// Start the bots
startApp().catch(error => {
    log('main', 'START-ERROR', `Error starting app: ${error}`, 'error')
    process.exit(1)
})
