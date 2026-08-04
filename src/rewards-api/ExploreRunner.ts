import { Page } from 'rebrowser-playwright'

import { RewardsApi, ApiPromotion } from './RewardsApi'
import { HumanBehaviorSimulator } from '../anti-detection/human-behavior'
import { MicrosoftRewardsBot } from '../index'

/**
 * Earns the "Explore on Bing" offers (the "在必应上浏览" cards, offerids like
 * `ENUS_<category>_exploreonbing_*`). These are NOT claimable via the activities API and visiting the
 * destination alone does nothing — verified mechanism: land on Bing through the offer's flyout URL
 * (`...&rwAutoFlyout=exb`) and then run a category-relevant Bing search in that same tab; the offer
 * flips complete=True and credits (typically +10).
 *
 * Only offers that are unlocked, not yet complete, and worth points (max > 0) are attempted; the
 * many `max:-1` engagement cards are skipped. These searches also count toward the daily PC search
 * cap, so running this before SearchRunner is efficient (no extra searches beyond what's needed).
 */
export class ExploreRunner {
    private human = new HumanBehaviorSimulator()

    constructor(private bot: MicrosoftRewardsBot, private api: RewardsApi, private page: Page) {}

    private log(message: string, type: 'log' | 'warn' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'EXPLORE', message, type, color)
    }

    /** Natural, category-matched Bing queries (the offers are ENUS, so English queries fit their intent). */
    private static readonly CATEGORY_QUERIES: Record<string, string[]> = {
        jewelry: ['diamond necklace gift ideas', 'engagement ring styles'],
        insurance: ['best car insurance quotes', 'home insurance plans compare'],
        mattress: ['best mattress reviews', 'memory foam mattress deals'],
        petsupplies: ['dog food and pet supplies', 'cat toys and accessories'],
        creditreport: ['check my credit score free', 'how to read a credit report'],
        weather: ['weather forecast this week', 'weekend weather near me'],
        hotel: ['hotel deals near me', 'cheap hotel booking'],
        realestate: ['houses for sale near me', 'homes for sale listings'],
        sports: ['latest sports scores', 'sports news today'],
        flight: ['cheap flight deals', 'flight tickets compare'],
        personalloan: ['compare personal loan rates', 'best personal loans'],
        shopping: ['online shopping deals today', 'best shopping offers'],
        cellphoneplans: ['best cell phone plans', 'unlimited data plans compare'],
        cruises: ['cruise vacation deals', 'caribbean cruise packages'],
        internetproviders: ['best internet providers near me', 'home internet deals'],
        travel: ['travel destinations ideas', 'vacation packages deals'],
        gardening: ['gardening tips for beginners', 'best plants for a garden'],
        fitness: ['home fitness workout plans', 'best exercises for beginners']
    }

    private categoryOf(offerId: string): string | null {
        const m = /_([a-z]+)_exploreonbing/i.exec(offerId || '')
        return m && m[1] ? m[1].toLowerCase() : null
    }

    /** Earn every currently-earnable Explore-on-Bing offer. */
    async run(): Promise<{ earned: number }> {
        let data
        try {
            data = await this.api.getData()
        } catch (error) {
            this.log(`Failed to fetch data: ${error}`, 'warn')
            return { earned: 0 }
        }

        const offers = data.promotions.filter(p =>
            /exploreonbing/i.test(p.offerId) &&
            p.attributes.is_unlocked === 'True' &&
            !p.complete &&
            p.max > 0
        )
        if (!offers.length) {
            this.log('No earnable Explore-on-Bing offers right now')
            return { earned: 0 }
        }
        this.log(`${offers.length} Explore-on-Bing offer(s) to earn`)

        let earned = 0
        for (const offer of offers) {
            try {
                const ok = await this.earnOne(offer)
                if (ok) {
                    earned += offer.max
                    this.log(`✅ "${offer.title}" (+${offer.max})`, 'log', 'green')
                } else {
                    this.log(`• "${offer.title}" not credited (mechanism may have changed)`, 'warn')
                }
            } catch (error) {
                this.log(`❌ "${offer.title}": ${error}`, 'warn')
            }
            // human spacing between offers
            await this.bot.utils.wait(this.bot.utils.randomNumber(8000, 20000))
        }

        this.log(`Explore-on-Bing done — ~+${earned} this run`, 'log', 'green')
        return { earned }
    }

    /** Land on Bing via the offer's flyout URL, then run the category search(es) until it credits. */
    private async earnOne(offer: ApiPromotion): Promise<boolean> {
        const cat = this.categoryOf(offer.offerId)
        const queries = (cat && ExploreRunner.CATEGORY_QUERIES[cat]) || ['top stories today', 'news near me']

        const dest = offer.destination || 'https://www.bing.com/?form=ML2PCR&OCID=ML2PCR&PUBL=RewardsDO&rwAutoFlyout=exb'
        await this.page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 6000))

        for (const query of queries) {
            await this.searchInTab(query)
            // Re-check: the offer flips complete=True once the qualifying search registers.
            const updated = await this.findOffer(offer.offerId)
            if (updated && updated.complete) return true
        }
        const final = await this.findOffer(offer.offerId)
        return !!(final && final.complete)
    }

    private async searchInTab(query: string): Promise<void> {
        const box = await this.page.waitForSelector('#sb_form_q, textarea[name="q"], input[name="q"]', { state: 'visible', timeout: 10000 }).catch(() => null)
        if (box) {
            await box.click().catch(() => {})
            await this.page.keyboard.press('Control+A').catch(() => {})
            await this.page.keyboard.press('Delete').catch(() => {})
            await this.human.humanType(this.page, query)
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))
            await this.page.keyboard.press('Enter')
        } else {
            // Fallback: keep the rewards form code on the query URL so the search still ties to the flyout.
            await this.page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&form=ML2PCR`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        }
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
        await this.human.humanScroll(this.page, 'down').catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(2500, 5000))
    }

    private async findOffer(offerId: string): Promise<ApiPromotion | undefined> {
        const data = await this.api.getData()
        return data.promotions.find(p => p.offerId === offerId)
    }
}
