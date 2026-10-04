// MUST be first: arms the rebrowser anti-detection patches before rebrowser-playwright is loaded.
import '../rebrowser-env'

import * as readline from 'readline'
import { Page } from 'rebrowser-playwright'

import { MicrosoftRewardsBot } from '../index'
import { RewardsApi } from '../rewards-api/RewardsApi'
import Browser, { ManagedBrowser } from '../../browser/Browser'
import { Login } from '../../functions/Login'
import Axios from '../../utils/Axios'
import { loadAccounts, loadConfig, saveSessionData } from '../../utils/Load'

import { Account } from '../../interfaces/Account'

/**
 * Interactive sign-in for one account (2FA / passkey / consent the bot can't get past headlessly).
 *
 * Every scheduled run re-derives its dapi access token from the SAVED browser session
 * (sessions/<email>/{desktop,mobile}_cookies.json + fingerprint): createBrowser → Login.login →
 * Login.getMobileAccessToken. If Microsoft demands 2FA, that headless run can't finish. This tool runs
 * the exact same classes in a VISIBLE window so the human can complete whatever the automation
 * can't, then proves the result by minting the OAuth token and reading the dapi balance — the same
 * steps the cron run will take — before saving the session.
 *
 * Because it goes through Browser.createBrowser, the session is created with the account's proxy,
 * geo/locale and the persisted fingerprint the bot will reuse (a session made in a hand-rolled
 * browser with a different UA/fingerprint is what the previous version of this helper produced).
 *
 * Usage:  npm run login [-- --email <addr>] [-- --desktop | --mobile]
 * Run it on a machine with a display. Docker deployments mount ./sessions, so run it on the host and
 * the container picks the new session up on its next run.
 */

// Human-paced steps (reading an SMS, approving on the phone) need far longer than the unattended
// defaults (3 min). Login reads these at call time; an explicit env value still wins.
const INTERACTIVE_WAIT_MS = 10 * 60_000
process.env.LOGIN_MAX_WAIT_MS ??= String(INTERACTIVE_WAIT_MS)
process.env.MOBILE_OAUTH_TIMEOUT_MS ??= String(INTERACTIVE_WAIT_MS)

interface Options {
    email?: string
    desktop: boolean
    mobile: boolean
    // Mode flags were given explicitly (so config.workers.doMobileSearch doesn't override them)
    explicitModes: boolean
}

interface ModeResult {
    label: string
    ok: boolean
    detail: string
}

function printUsage(): void {
    console.log([
        'Usage: npm run login -- [--email <addr>] [--desktop | --mobile]',
        '  --email <addr>  账户（默认：accounts.json 只有一个时自动选择，否则询问）/ account to sign in',
        '  --desktop       只登录桌面端会话 / desktop session only',
        '  --mobile        只登录移动端会话 / mobile session only',
        '  (默认两者都登录 / default: both)'
    ].join('\n'))
}

function parseArgs(argv: string[]): Options {
    let email: string | undefined
    let onlyDesktop = false
    let onlyMobile = false

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string
        if (arg === '--email' || arg === '-e') {
            email = argv[++i]
        } else if (arg.startsWith('--email=')) {
            email = arg.slice('--email='.length)
        } else if (arg === '--desktop') {
            onlyDesktop = true
        } else if (arg === '--mobile') {
            onlyMobile = true
        } else if (arg === '-dev') {
            // consumed by loadAccounts() (selects accounts.dev.json)
        } else if (arg === '--help' || arg === '-h') {
            printUsage()
            process.exit(0)
        } else {
            console.error(`未知参数 / Unknown argument: ${arg}`)
            printUsage()
            process.exit(1)
        }
    }

    if (argv.some(a => a === '--email' || a === '-e') && !email) {
        console.error('--email 需要一个邮箱 / --email needs an address')
        process.exit(1)
    }

    // Neither or both flags → both sessions
    const both = onlyDesktop === onlyMobile
    return { email, desktop: both || onlyDesktop, mobile: both || onlyMobile, explicitModes: !both }
}

/** One-shot prompt. Login.promptForInput opens its own readline for SMS codes, so never hold one open. */
function ask(question: string): Promise<string> {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(question, answer => {
            resolve(answer.trim())
            rl.close()
        })
        // stdin closed (Ctrl+D / non-interactive) — answer empty instead of hanging forever
        rl.once('close', () => resolve(''))
    })
}

/** Wait for Enter, but also move on when `until` settles or after timeoutMs (the terminal may not take input). */
function enterOr(question: string, until: Promise<unknown>, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const finish = (): void => {
            clearTimeout(timer)
            rl.close()
            resolve()
        }
        const timer = setTimeout(finish, timeoutMs)
        rl.question(question, finish)
        rl.once('close', finish)
        until.then(finish, finish)
    })
}

async function pickAccount(accounts: Account[], email?: string): Promise<Account> {
    if (!accounts.length) {
        throw new Error('config/accounts.json 中没有账户 / no accounts in config/accounts.json')
    }
    if (email) {
        const match = accounts.find(a => a.email.toLowerCase() === email.toLowerCase())
        if (!match) throw new Error(`accounts.json 中找不到 / not found in accounts.json: ${email}`)
        return match
    }
    if (accounts.length === 1) return accounts[0] as Account

    console.log('\n选择账户 / Choose an account:')
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.email}`))
    const choice = Number(await ask(`(1-${accounts.length}): `))
    const picked = Number.isInteger(choice) ? accounts[choice - 1] : undefined
    if (!picked) throw new Error('无效选择 / invalid choice')
    return picked
}

const SIGN_IN_HOSTS = ['login.live.com', 'login.microsoftonline.com', 'account.live.com']

function onSignInPage(page: Page): boolean {
    try {
        const host = new URL(page.url()).hostname
        return SIGN_IN_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
    } catch {
        return false
    }
}

/** Origin + path only — sign-in URLs carry kilobytes of state/nonce that only bury the useful part. */
function shortUrl(url: string): string {
    try {
        const u = new URL(url)
        return `${u.origin}${u.pathname}`
    } catch {
        return url
    }
}

/**
 * Resolves when the human is probably done: the window LEAVES Microsoft's sign-in pages (the flow
 * finished and redirected back), or — when there is a keyboard — they press Enter. Purely passive:
 * it never navigates, so it can't yank the page away in the middle of a 2FA step. Enter is optional
 * because the terminal may not take input (e.g. a read-only output panel).
 */
function waitUntilDone(page: Page, deadline: number): Promise<void> {
    return new Promise(resolve => {
        let settled = false
        let rl: readline.Interface | null = null
        let wasOnSignIn = onSignInPage(page)

        const finish = (): void => {
            if (settled) return
            settled = true
            clearInterval(timer)
            rl?.close()
            resolve()
        }

        const timer = setInterval(() => {
            if (page.isClosed() || Date.now() > deadline) {
                finish()
                return
            }
            const nowOnSignIn = onSignInPage(page)
            if (wasOnSignIn && !nowOnSignIn) {
                console.log(`\n   ✓ 已离开登录页 / left the sign-in pages → ${shortUrl(page.url())}`)
                finish()
                return
            }
            wasOnSignIn = nowOnSignIn
        }, 1500)

        if (process.stdin.isTTY) {
            rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            rl.question('   完成后会自动检测，也可按 Enter 立即校验 / Detected automatically when done — or press Enter to check now... ', finish)
        } else {
            console.log('   完成后会自动检测 / Detected automatically when you are done...')
        }
    })
}

/**
 * Fallback when the automated sign-in stopped (2FA, passkey, "stay signed in?", a Bing sign-in that
 * didn't stick, ...): the human fixes it in the window, then we re-run the bot's own Login.login().
 * That is idempotent ("Already logged in" path), applies the exact checks a scheduled run applies
 * (Rewards dashboard + Bing sign-in) and saves the session on success — so there is no separate,
 * weaker definition of "signed in" here to drift from the bot's.
 */
async function finishSignInManually(page: Page, verify: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + INTERACTIVE_WAIT_MS
    console.log('\n👉 请在打开的浏览器窗口中完成剩余步骤（2FA / Passkey / 授权确认 / 重新登录 Bing）。')
    console.log('👉 Complete the remaining steps in the browser window (2FA / passkey / consent / Bing sign-in).')

    for (let attempt = 1; ; attempt++) {
        if (page.isClosed()) throw new Error('浏览器窗口已关闭 / the browser window was closed')
        console.log(`   当前页面 / current page: ${shortUrl(page.url())}`)

        await waitUntilDone(page, deadline)
        if (page.isClosed()) throw new Error('浏览器窗口已关闭 / the browser window was closed')

        try {
            await verify()
            return
        } catch (error) {
            console.log(`\n⚠️ 校验仍未通过（第 ${attempt} 次）/ check still failing (attempt ${attempt}): ${error}`)
        }
        if (Date.now() > deadline) {
            throw new Error(`登录未在 ${INTERACTIVE_WAIT_MS / 60_000} 分钟内完成 / sign-in not completed in time`)
        }
    }
}

async function loginSession(account: Account, isMobile: boolean): Promise<ModeResult> {
    const label = isMobile ? '移动端 / Mobile' : '桌面端 / Desktop'
    console.log(`\n========== ${label} ==========`)

    const bot = new MicrosoftRewardsBot(isMobile)
    bot.config.headless = false
    bot.axios = new Axios(account.proxy)
    const login = new Login(bot)

    let managed: ManagedBrowser | null = null
    let page: Page | null = null
    try {
        managed = await new Browser(bot).createBrowser(account.proxy, account.email)
        page = await managed.context.newPage()
        const activePage = page

        // 1. Sign in with the bot's own automated flow (fills email/password, handles what it can — an
        //    SMS/email code is asked for in this terminal). Whatever it can't get past, the human finishes.
        //    Login.login saves the session itself once it passes.
        const signIn = (): Promise<void> => login.login(activePage, account.email, account.password)
        try {
            await signIn()
        } catch (error) {
            console.log(`\n⚠️ 自动登录未完成 / Automated sign-in stopped: ${error}`)
            await finishSignInManually(activePage, signIn)
        }

        // 2. The OAuth step every run performs. If Microsoft asks for consent / another check here,
        //    complete it in the window — that is exactly what would otherwise fail headlessly.
        const token = await login.getMobileAccessToken(activePage, account.email)

        // 3. Prove the session works end-to-end against the backend the bot earns through.
        const data = await new RewardsApi(bot, token).getData()

        // 4. Persist after OAuth so the refreshed login.live.com cookies are the ones the cron run reuses.
        await saveSessionData(bot.config.sessionPath, managed.context, account.email, isMobile)

        return {
            label,
            ok: true,
            detail: `余额 / balance ${data.balance} | ${data.promotions.length} promotions | country ${data.country}`
        }
    } catch (error) {
        // Leave the window up so the user can see where it got stuck — but don't hang on a keypress the
        // terminal may not be able to deliver: closing the window, or 2 minutes, also moves on.
        if (managed) {
            const windowClosed = page && !page.isClosed() ? page.waitForEvent('close', { timeout: 0 }) : Promise.resolve()
            await enterOr('\n按 Enter 或关闭窗口继续（2 分钟后自动继续）/ Press Enter or close the window to continue (auto in 2 min)... ', windowClosed, 120_000)
        }
        return { label, ok: false, detail: String(error) }
    } finally {
        if (managed) {
            await managed.context.close().catch(() => { })
            await managed.browserInstance.close().catch(() => { })
        }
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))

    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        console.error('❌ 需要图形界面来显示浏览器窗口。Docker 部署请在宿主机运行本工具（容器挂载了 ./sessions，下次运行自动生效）。')
        console.error('❌ A display is required for the browser window. For Docker, run this on the host — ./sessions is mounted into the container.')
        process.exit(1)
    }

    const account = await pickAccount(loadAccounts(), options.email)
    const config = loadConfig()

    const desktop = options.desktop
    let mobile = options.mobile
    // Mobile sessions are only used for mobile search — don't ask for a second 2FA round if it's off.
    if (mobile && !options.explicitModes && config.workers?.doMobileSearch === false) {
        console.log('ℹ️ 配置中已关闭移动端搜索，跳过移动端会话 / mobile search is disabled in config — skipping the mobile session')
        mobile = false
    }

    console.log('\nMicrosoft Rewards 主动登录 / Interactive sign-in')
    console.log(`账户 / Account : ${account.email}`)
    console.log(`会话 / Sessions: ${[desktop && 'desktop', mobile && 'mobile'].filter(Boolean).join(' + ')} → ${config.sessionPath}/${account.email}/`)
    console.log('将打开可见浏览器窗口；需要验证时请在窗口中完成。/ A browser window will open; complete any verification there.')

    const results: ModeResult[] = []
    if (desktop) results.push(await loginSession(account, false))
    if (mobile) results.push(await loginSession(account, true))

    console.log('\n========== 结果 / Result ==========')
    for (const r of results) {
        console.log(`${r.ok ? '✅' : '❌'} ${r.label}: ${r.detail}`)
    }
    if (results.every(r => r.ok)) {
        console.log('\n会话已保存，自动任务（含 Docker 容器）下次运行将直接复用。')
        console.log('Sessions saved — the next scheduled run (including the Docker container) will reuse them.')
    }

    // loadConfig/loadAccounts leave file watchers running; exit explicitly.
    process.exit(results.every(r => r.ok) ? 0 : 1)
}

if (require.main === module) {
    main().catch(error => {
        console.error('程序出错 / Error:', error)
        process.exit(1)
    })
}
