// MUST be first: arms the rebrowser anti-detection patches before rebrowser-playwright is loaded.
import './rebrowser-env'

import cluster from 'cluster'
import { Page } from 'rebrowser-playwright'

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
        })
    }

    private async runTasks(accounts: Account[]) {
        let completedAccounts = 0
        let failedAccounts = 0

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
        process.exit()
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
                    const searcher = new SearchRunner(this, new RewardsApi(this, this.accessToken), searchPage)
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

        // Mobile search only earns points when the dashboard actually offers a MobileSearch promotion
        // (Level 2+). At Level 1 it doesn't, so spinning up a second browser + sign-in would earn nothing
        // and just adds an unnecessary login (throttle / bot-score risk). When the desktop run already
        // fetched a token, reuse it to cheaply check, and skip mobile entirely if there is nothing to earn.
        if (this.accessToken) {
            try {
                const data = await new RewardsApi(this, this.accessToken).getData()
                const hasMobileSearch = data.promotions.some(p => p.type === 'search' && p.classificationTag === 'MobileSearch')
                if (!hasMobileSearch) {
                    log(this.isMobile, 'MAIN', 'No mobile-search points available at this account level — skipping mobile browser')
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
                const searcher = new SearchRunner(this, new RewardsApi(this, this.accessToken), searchPage)
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
    await rewardsBot.initialize()
    await rewardsBot.run()
}

// Start the bots
main().catch(error => {
    log('main', 'MAIN-ERROR', `Error running bots: ${error}`, 'error')
    process.exit(1)
})
