import fs from 'fs'
import path from 'path'

import { RewardsApi, ApiPromotion } from './RewardsApi'
import { MicrosoftRewardsBot } from '../index'

const APP_CHECK_IN = 'app-check-in'

/**
 * Earns the claimable Rewards activities through the new dapi backend:
 * daily set, daily offers, monthly topics (urlreward), daily check-in, and read-to-earn.
 * Search points are NOT handled here (they require real Bing searches), nor are Explore-on-Bing
 * offers (ExploreRunner).
 *
 * Claims are spaced with randomized human-like delays for anti-detection — a real member does
 * not complete a dozen activities in the same second.
 */
export class RewardsEarner {
    private api: RewardsApi

    /**
     * @param email When given, what was claimed today is remembered in the account's session folder,
     *              so the day's later runs don't ask for the same things again.
     */
    constructor(private bot: MicrosoftRewardsBot, accessToken: string, country?: string, private email?: string) {
        this.api = new RewardsApi(bot, accessToken, country || 'us')
    }

    /**
     * The promotions list doesn't say that today's check-in, app check-in or read-to-earn is already
     * done — a claim just answers "no points". With several runs a day those requests were repeated
     * on every run; this is the per-day record that stops that.
     */
    private claimedTodayFile(): string | null {
        return this.email ? path.join(process.cwd(), this.bot.config.sessionPath, this.email, 'claims_today.json') : null
    }

    private static today(): string {
        const now = new Date()
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    private loadClaimedToday(): Set<string> {
        const file = this.claimedTodayFile()
        try {
            if (file && fs.existsSync(file)) {
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { day?: string, ids?: string[] }
                if (saved.day === RewardsEarner.today() && Array.isArray(saved.ids)) {
                    return new Set(saved.ids)
                }
            }
        } catch {
            // unreadable record: start the day over (worst case one repeated request per item)
        }
        return new Set()
    }

    private saveClaimedToday(ids: Set<string>): void {
        const file = this.claimedTodayFile()
        if (!file) return
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, JSON.stringify({ day: RewardsEarner.today(), ids: [...ids] }))
        } catch (error) {
            this.log(`Could not save today's claim record: ${error}`, 'warn')
        }
    }

    private log(message: string, type: 'log' | 'warn' | 'error' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'REWARDS-API', message, type, color)
    }

    private async humanDelay(): Promise<void> {
        // Randomized spacing between activities (anti-detection)
        await this.bot.utils.wait(this.bot.utils.randomNumber(6000, 22000))
    }

    async run(): Promise<{ claimed: number, pointsGained: number, balance: number }> {
        let data
        try {
            data = await this.api.getData()
        } catch (error) {
            this.log(`Failed to fetch rewards data: ${error}`, 'error')
            throw error
        }

        this.log(`Balance: ${data.balance} | ${data.promotions.length} promotions | country: ${data.country}`)

        const claimedToday = this.loadClaimedToday()
        const claimable = data.promotions.filter(p => RewardsApi.isClaimable(p) && !claimedToday.has(p.offerId))
        const appCheckInDue = !claimedToday.has(APP_CHECK_IN)
        if (!claimable.length && !appCheckInDue) {
            this.log('No claimable activities — everything is already complete')
            return { claimed: 0, pointsGained: 0, balance: data.balance }
        }
        this.log(`${claimable.length} claimable activities found, completing them...`)

        let claimedCount = 0
        let totalGained = 0
        let balance = data.balance

        for (const p of claimable) {
            let didClaim = false
            try {
                if (p.type === 'msnreadearn') {
                    const gained = await this.doReadToEarn(p)
                    // Nothing gained can also mean "not available yet", so only a finished read is recorded.
                    if (gained > 0) { claimedCount++; totalGained += gained; didClaim = true; claimedToday.add(p.offerId) }
                } else {
                    const res = await this.api.claim(p.offerId)
                    claimedToday.add(p.offerId)
                    balance = res.balance || balance
                    if (res.duplicate || res.points === 0) {
                        // No points credited: already completed today, future-dated/locked (e.g. a daily
                        // set or explore-on-Bing card that unlocks tomorrow), or one that needs a real
                        // page visit. This is expected and not an error — there is simply nothing to earn.
                        this.log(`• "${p.title}" — no points (already done, locked, or needs a visit)`)
                    } else {
                        claimedCount++
                        totalGained += res.points
                        didClaim = true
                        this.log(`✅ "${p.title}" (+${res.points}) | balance ${res.balance}`, 'log', 'green')
                    }
                }
            } catch (error) {
                this.log(`❌ Failed "${p.title}" (${p.offerId}): ${error}`, 'warn')
            }
            this.saveClaimedToday(claimedToday)
            // Space the claims like a human: a real pause after a genuine completion, a short jitter
            // after a no-op (keeps the POSTs from firing in a burst without wasting minutes on nothing).
            if (didClaim) {
                await this.humanDelay()
            } else {
                await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 4000))
            }
        }

        // Bing-app daily check-in (type:103, the "必应应用连签" streak) — separate from the web check-in
        // claimed in the loop above. Once a day; it no-ops when repeated.
        if (appCheckInDue) {
            try {
                const ci = await this.api.appCheckIn()
                claimedToday.add(APP_CHECK_IN)
                this.saveClaimedToday(claimedToday)
                if (ci.points > 0) {
                    claimedCount++
                    totalGained += ci.points
                    balance = ci.balance || balance
                    this.log(`✅ App check-in (+${ci.points}) | balance ${ci.balance}`, 'log', 'green')
                } else {
                    this.log('• App check-in — already done today')
                }
            } catch (error) {
                this.log(`App check-in failed: ${error}`, 'warn')
            }
        }

        this.log(`Activities done — claimed ${claimedCount}, +${totalGained} points (balance ~${balance})`, 'log', 'green')
        return { claimed: claimedCount, pointsGained: totalGained, balance }
    }

    /** Read-to-earn pays per article; claim repeatedly until the balance stops increasing. */
    private async doReadToEarn(p: ApiPromotion): Promise<number> {
        const maxArticles = 10
        let gained = 0
        let lastBalance = -1
        for (let i = 0; i < maxArticles; i++) {
            const res = await this.api.claim(p.offerId)
            if (res.duplicate || res.points === 0 || res.balance === lastBalance) {
                this.log('Read-to-earn: no more articles to read')
                break
            }
            gained += res.points
            lastBalance = res.balance
            this.log(`📖 Read article ${i + 1}/${maxArticles} (+${res.points})`)
            await this.humanDelay()
        }
        return gained
    }
}
