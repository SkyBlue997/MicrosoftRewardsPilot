import { RewardsApi, ApiPromotion } from './RewardsApi'
import { MicrosoftRewardsBot } from '../index'

/**
 * Earns the claimable Rewards activities through the new dapi backend:
 * daily set, daily offers, explore-on-Bing, monthly topics (urlreward), daily check-in,
 * and read-to-earn. Search points are NOT handled here (they require real Bing searches).
 *
 * Claims are spaced with randomized human-like delays for anti-detection — a real member does
 * not complete a dozen activities in the same second.
 */
export class RewardsEarner {
    private api: RewardsApi

    constructor(private bot: MicrosoftRewardsBot, accessToken: string, country?: string) {
        this.api = new RewardsApi(bot, accessToken, country || 'us')
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

        const claimable = data.promotions.filter(p => RewardsApi.isClaimable(p))
        if (!claimable.length) {
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
                    if (gained > 0) { claimedCount++; totalGained += gained; didClaim = true }
                } else {
                    const res = await this.api.claim(p.offerId)
                    balance = res.balance || balance
                    if (res.duplicate) {
                        this.log(`• "${p.title}" already completed`)
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
            // Only pause after an activity that actually completed (no need to "wait" for a duplicate/no-op)
            if (didClaim) await this.humanDelay()
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
