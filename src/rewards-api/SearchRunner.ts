import { Page } from 'rebrowser-playwright'

import { RewardsApi, ApiPromotion } from './RewardsApi'
import { HumanBehaviorSimulator } from '../anti-detection/human-behavior'
import { IntelligentDelaySystem } from '../anti-detection/intelligent-delay'
import { MicrosoftRewardsBot } from '../index'

/**
 * Earns Bing search points with REAL, human-paced searches (search points cannot be claimed via the
 * activities API). Progress is read from the dapi search promotion (PCSearch / MobileSearch), so this
 * does not depend on the old rewards.bing.com DOM at all.
 *
 * Anti-detection: queries are varied, typed character-by-character with the HumanBehaviorSimulator,
 * spaced with the IntelligentDelaySystem, with occasional scrolling — and it stops as soon as the API
 * shows the daily search cap is reached (no pointless extra searches).
 */
export class SearchRunner {
    private human = new HumanBehaviorSimulator()
    private delay = new IntelligentDelaySystem()

    constructor(private bot: MicrosoftRewardsBot, private api: RewardsApi, private page: Page) {}

    private log(message: string, type: 'log' | 'warn' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'SEARCH', message, type, color)
    }

    /** Run searches until the daily search promotion is complete (or a safety cap is hit). */
    async run(): Promise<{ gained: number }> {
        const tag = this.bot.isMobile ? 'MobileSearch' : 'PCSearch'
        let promo = await this.findSearchPromotion(tag)
        if (!promo) {
            this.log(`No ${tag} promotion found (account may be too new or already maxed)`, 'warn')
            return { gained: 0 }
        }

        const startProgress = promo.progress
        this.log(`${tag}: ${promo.progress}/${promo.max} points`)
        if (promo.progress >= promo.max && promo.max > 0) {
            this.log('Search points already maxed today', 'log', 'green')
            return { gained: 0 }
        }

        const queries = this.buildQueries(40)
        const safetyCap = 40
        let count = 0
        let stalls = 0

        // Land on Bing once; subsequent searches reuse the result page's search box.
        await this.page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await this.bot.utils.wait(2000)

        while (promo.progress < promo.max && count < safetyCap && queries.length) {
            const query = queries.shift() as string
            try {
                await this.searchOnce(query)
            } catch (error) {
                this.log(`Search "${query}" failed: ${error}`, 'warn')
            }
            count++

            // Re-check progress from the API every 3 searches
            if (count % 3 === 0) {
                await this.bot.utils.wait(2000)
                const updated = await this.findSearchPromotion(tag)
                if (updated) {
                    if (updated.progress === promo.progress) { stalls++ } else { stalls = 0 }
                    promo = updated
                    this.log(`Progress: ${promo.progress}/${promo.max} (after ${count} searches)`)
                    if (stalls >= 2) { this.log('Search progress stalled — stopping', 'warn'); break }
                }
            }

            if (promo.progress < promo.max) {
                await this.bot.utils.wait(this.delay.calculateSearchDelay(count, this.bot.isMobile))
            }
        }

        const gained = Math.max(0, promo.progress - startProgress)
        this.log(`Search finished: ${promo.progress}/${promo.max} (+${gained} this run, ${count} searches)`, 'log', 'green')
        return { gained }
    }

    private async findSearchPromotion(tag: string): Promise<ApiPromotion | undefined> {
        const data = await this.api.getData()
        return data.promotions.find(p => p.type === 'search' && p.classificationTag === tag)
            || data.promotions.find(p => p.type === 'search')
    }

    private async searchOnce(query: string): Promise<void> {
        const box = await this.page.waitForSelector('#sb_form_q, textarea[name="q"], input[name="q"]', { state: 'visible', timeout: 10000 }).catch(() => null)
        if (box) {
            await box.click().catch(() => {})
            // clear any existing text, then type like a human
            await this.page.keyboard.press('Control+A').catch(() => {})
            await this.page.keyboard.press('Delete').catch(() => {})
            await this.human.humanType(this.page, query)
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1200))
            await this.page.keyboard.press('Enter')
        } else {
            // Fallback: direct query URL
            await this.page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        }
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
        // Occasional human-like result browsing
        if (Math.random() < 0.6) {
            await this.human.humanScroll(this.page, 'down').catch(() => {})
        }
        await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2500))
    }

    /** Varied, natural search queries (shuffled) — enough to reach the daily cap. */
    private buildQueries(n: number): string[] {
        const base = [
            'weather today', 'latest technology news', 'best pasta recipe', 'how to meditate',
            'history of the roman empire', 'top movies 2026', 'electric car comparison',
            'healthy breakfast ideas', 'world cup schedule', 'stock market today',
            'best hiking trails', 'how to learn guitar', 'space exploration news',
            'famous paintings', 'coffee brewing methods', 'travel destinations 2026',
            'home workout routine', 'climate change facts', 'best science fiction books',
            'how do solar panels work', 'jazz music history', 'national parks list',
            'easy dinner recipes', 'olympic games history', 'famous landmarks',
            'gardening tips for beginners', 'how to improve sleep', 'best podcasts 2026',
            'ancient egypt facts', 'mountain biking gear', 'photography composition tips',
            'best laptops 2026', 'mediterranean diet', 'volcano eruption facts',
            'how to start running', 'classical music composers', 'sustainable living tips',
            'deep sea creatures', 'origami instructions', 'world geography quiz'
        ]
        const arr = [...base]
        // shuffle (Math.random is fine here — this runs in the bot, not the workflow)
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j] as string, arr[i] as string]
        }
        return arr.slice(0, Math.min(n, arr.length))
    }
}
