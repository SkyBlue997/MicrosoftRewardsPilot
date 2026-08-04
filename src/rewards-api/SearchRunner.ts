import { Page } from 'rebrowser-playwright'

import { RewardsApi, ApiPromotion } from './RewardsApi'
import { HumanBehaviorSimulator } from '../anti-detection/human-behavior'
import { IntelligentDelaySystem } from '../anti-detection/intelligent-delay'
import { GeoLanguageDetector } from '../../utils/GeoLanguage'
import { MicrosoftRewardsBot } from '../index'

/**
 * Earns Bing search points with REAL, human-paced searches (search points cannot be claimed via the
 * activities API). Progress is read from the dapi search promotion (PCSearch / MobileSearch), so this
 * does not depend on the old rewards.bing.com DOM at all.
 *
 * Anti-detection:
 *  - Queries are LOCALE-AWARE (a JP account searches Japanese, not English) and drawn as a fresh,
 *    per-account + per-day random subset of a larger pool — never the same fixed basket every run.
 *  - Each query is typed character-by-character (HumanBehaviorSimulator), spaced with the
 *    IntelligentDelaySystem, with variable scrolling and the occasional result click + dwell.
 *  - The dapi progress re-check fires on a randomised cadence, and the loop stops the moment the
 *    daily cap is reached (no pointless extra searches).
 */
export class SearchRunner {
    private human = new HumanBehaviorSimulator()
    private delay = new IntelligentDelaySystem()

    constructor(
        private bot: MicrosoftRewardsBot,
        private api: RewardsApi,
        private page: Page,
        private accountEmail?: string
    ) {}

    private log(message: string, type: 'log' | 'warn' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'SEARCH', message, type, color)
    }

    /** Run searches until the daily search promotion is complete (or a safety cap is hit). */
    async run(): Promise<{ gained: number }> {
        const tag = this.bot.isMobile ? 'MobileSearch' : 'PCSearch'

        // One read up front: gives us both the search promotion AND the account market (for query locale).
        const data = await this.api.getData()
        let promo = data.promotions.find(p => p.type === 'search' && p.classificationTag === tag)
            || data.promotions.find(p => p.type === 'search')
        if (!promo) {
            this.log(`No ${tag} promotion found (account may be too new or already maxed)`, 'warn')
            return { gained: 0 }
        }

        const lang = GeoLanguageDetector.getLanguageFromCountry((data.country || 'us').toUpperCase())
        const startProgress = promo.progress
        this.log(`${tag}: ${promo.progress}/${promo.max} points | query locale: ${lang}`)
        if (promo.progress >= promo.max && promo.max > 0) {
            this.log('Search points already maxed today', 'log', 'green')
            return { gained: 0 }
        }

        const safetyCap = 40
        const queries = this.buildQueries(safetyCap, lang)
        let count = 0
        let stalls = 0
        let nextCheckAt = this.bot.utils.randomNumber(2, 5)

        // Land on Bing once; subsequent searches reuse the result page's search box.
        await this.page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 3500))

        while (promo.progress < promo.max && count < safetyCap && queries.length) {
            const query = queries.shift() as string
            try {
                await this.searchOnce(query)
            } catch (error) {
                this.log(`Search "${query}" failed: ${error}`, 'warn')
            }
            count++

            // Re-check progress from the API on a randomised cadence (every 2-5 searches), not a fixed beat.
            if (count >= nextCheckAt) {
                await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 3500))
                const updated = await this.findSearchPromotion(tag)
                if (updated) {
                    if (updated.progress === promo.progress) { stalls++ } else { stalls = 0 }
                    promo = updated
                    this.log(`Progress: ${promo.progress}/${promo.max} (after ${count} searches)`)
                    if (stalls >= 2) { this.log('Search progress stalled — stopping', 'warn'); break }
                }
                nextCheckAt = count + this.bot.utils.randomNumber(2, 5)
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
        await this.browseResults()
    }

    /**
     * Human-like SERP browsing: a real member doesn't fire a search and instantly type the next one.
     * Variable-direction scrolling, and ~28% of the time an organic result click with a heavy-tailed
     * dwell before returning to the results page. (The search already counted on Enter, so this only
     * adds realism — it never costs a point.)
     */
    private async browseResults(): Promise<void> {
        const passes = 1 + Math.floor(Math.random() * 3)
        for (let i = 0; i < passes; i++) {
            const direction = Math.random() < 0.8 ? 'down' : 'up'
            await this.human.humanScroll(this.page, direction).catch(() => {})
            await this.bot.utils.wait(this.bot.utils.randomNumber(400, 1500))
        }

        if (Math.random() < 0.28) {
            const link = await this.page.$('#b_results h2 a').catch(() => null)
            if (link) {
                await link.click({ timeout: 5000 }).catch(() => {})
                await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
                // Heavy-tailed dwell: usually a quick glance, occasionally a long read.
                const dwell = Math.random() < 0.75
                    ? this.bot.utils.randomNumber(3000, 12000)
                    : this.bot.utils.randomNumber(12000, 30000)
                await this.bot.utils.wait(dwell)
                if (Math.random() < 0.6) await this.human.humanScroll(this.page, 'down').catch(() => {})
                await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2000))
            }
        }

        await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2500))
    }

    /**
     * Build the run's query basket: locale-appropriate topics (Japanese for a JP account, etc.) plus
     * date-derived time-sensitive terms, deduped, then shuffled with a per-account + per-day seed so
     * different accounts get different baskets and each account drifts day to day (instead of every
     * run firing the identical 40-string English list — the textbook public-bot signature).
     */
    private buildQueries(count: number, lang: string): string[] {
        const cfg = GeoLanguageDetector.getLanguageConfig(lang)
        const sq = cfg.searchQueries
        let pool: string[] = [
            ...sq.news, ...sq.common, ...sq.tech, ...sq.entertainment, ...sq.sports, ...sq.food,
            ...GeoLanguageDetector.generateTimeBasedQueries(lang)
        ]
        // English accounts get the extra evergreen topics too, for a larger pool (year-free — the
        // time-sensitive terms come from generateTimeBasedQueries so nothing goes stale).
        if (cfg.code === 'en') {
            pool = pool.concat(SearchRunner.EN_EVERGREEN)
        }
        pool = [...new Set(pool)]

        const rand = this.seededRandom()
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1))
            const tmp = pool[i] as string
            pool[i] = pool[j] as string
            pool[j] = tmp
        }
        return pool.slice(0, Math.min(count, pool.length))
    }

    /**
     * Deterministic PRNG seeded by (account, day). Same account+day → same basket (stable across a
     * retry); different account or day → different basket. Falls back to a date-only seed when the
     * email isn't supplied.
     */
    private seededRandom(): () => number {
        const today = new Date().toISOString().slice(0, 10)
        const seedStr = `${this.accountEmail || 'anon'}|${today}`
        let h = 1779033703 ^ seedStr.length
        for (let i = 0; i < seedStr.length; i++) {
            h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353)
            h = (h << 13) | (h >>> 19)
        }
        let a = h >>> 0
        return () => {
            a |= 0
            a = (a + 0x6D2B79F5) | 0
            let t = Math.imul(a ^ (a >>> 15), 1 | a)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
    }

    /** Evergreen English topics (no year literals — kept temporally fresh by generateTimeBasedQueries). */
    private static readonly EN_EVERGREEN = [
        'weather today', 'latest technology news', 'best pasta recipe', 'how to meditate',
        'history of the roman empire', 'electric car comparison', 'healthy breakfast ideas',
        'stock market today', 'best hiking trails', 'how to learn guitar', 'space exploration news',
        'famous paintings', 'coffee brewing methods', 'home workout routine', 'climate change facts',
        'best science fiction books', 'how do solar panels work', 'jazz music history',
        'national parks list', 'easy dinner recipes', 'olympic games history', 'famous landmarks',
        'gardening tips for beginners', 'how to improve sleep', 'ancient egypt facts',
        'mountain biking gear', 'photography composition tips', 'mediterranean diet',
        'volcano eruption facts', 'how to start running', 'classical music composers',
        'sustainable living tips', 'deep sea creatures', 'origami instructions', 'world geography quiz'
    ]
}
