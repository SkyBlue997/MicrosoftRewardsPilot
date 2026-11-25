import { Frame, Page } from 'rebrowser-playwright'

import { RewardsApi } from './RewardsApi'
import { HumanBehaviorSimulator } from '../anti-detection/human-behavior'
import { MicrosoftRewardsBot } from '../index'

interface ExploreCard {
    title: string
    description: string
    points: number
    locked: boolean
    complete: boolean
}

/**
 * Earns the "Explore on Bing" offers (+10 each) the way a member does, through the Rewards panel
 * ("flyout") on bing.com. Verified mechanism:
 *   1. Open the flyout and CLICK the offer's card in its "Explore on Bing" checklist. That click
 *      activates the offer (POST /msrewards/api/v1/reportactivity, ActivityType "bingredirect";
 *      the panel then says "Activated! Search on Bing to complete this activity").
 *   2. Run a Bing search on the offer's topic. The offer completes: its card stays in the checklist
 *      but switches to the completed style ("10 Points added to the account").
 * A topic search WITHOUT step 1 does not credit (tested side by side) — which is why the previous
 * version, which only searched, mostly reported "not credited".
 *
 * The flyout is also the only reliable list of what is earnable today. The dapi promotions list
 * (what this class used to read) is not: it showed a different set of unlocked explore offers than
 * the flyout — offers the flyout did not have at all — and changed between consecutive calls.
 * Locked ("Available tomorrow"), point-less and already-completed cards are skipped.
 */
export class ExploreRunner {
    // The address every Explore-on-Bing card points at: the Bing homepage with the Rewards panel.
    private static readonly FLYOUT_URL = 'https://www.bing.com/?form=ML2PCR&OCID=ML2PCR&PUBL=RewardsDO&CREA=ML2PCR&PC=ML2PCR&rwAutoFlyout=exb'
    private static readonly CHECKLIST = '#exb-activityChecklist'
    private static readonly MAX_OFFERS_PER_RUN = 4

    private human = new HumanBehaviorSimulator()
    private flyout: Frame | null = null

    constructor(private bot: MicrosoftRewardsBot, private api: RewardsApi, private page: Page) {}

    private log(message: string, type: 'log' | 'warn' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'EXPLORE', message, type, color)
    }

    /** Earn every Explore-on-Bing offer the flyout lists as available today. */
    async run(): Promise<{ earned: number }> {
        let cards = await this.readChecklist()
        if (!cards) {
            this.log('Rewards panel did not open on bing.com — skipping Explore-on-Bing', 'warn')
            return { earned: 0 }
        }
        const earnable = (list: ExploreCard[]): ExploreCard[] => list.filter(c => !c.locked && !c.complete && c.points > 0)
        if (!earnable(cards).length) {
            this.log('No earnable Explore-on-Bing offers right now')
            return { earned: 0 }
        }
        this.log(`${earnable(cards).length} Explore-on-Bing offer(s) to earn`)

        const startBalance = await this.api.getData().then(d => d.balance).catch(() => null)
        const tried = new Set<string>()
        let earned = 0

        while (tried.size < ExploreRunner.MAX_OFFERS_PER_RUN) {
            const card = earnable(cards).find(c => !tried.has(c.title))
            if (!card) break
            tried.add(card.title)

            try {
                await this.activateAndSearch(card)
            } catch (error) {
                this.log(`❌ "${card.title}": ${error}`, 'warn')
            }
            // human spacing between offers
            await this.bot.utils.wait(this.bot.utils.randomNumber(8000, 20000))

            // Re-reading the checklist is both the confirmation for this offer (its card now shows the
            // completed style) and the list for the next one.
            const reread = await this.readChecklist()
            if (!reread) {
                this.log(`Could not re-open the Rewards panel to confirm "${card.title}"`, 'warn')
                break
            }
            if (reread.some(c => c.title === card.title && c.complete)) {
                earned += card.points
                this.log(`✅ "${card.title}" (+${card.points})`, 'log', 'green')
            } else {
                this.log(`• "${card.title}" not credited (its card is not marked complete after activating and searching)`, 'warn')
            }
            cards = reread
        }

        const endBalance = await this.api.getData().then(d => d.balance).catch(() => null)
        const balances = startBalance !== null && endBalance !== null ? ` (balance ${startBalance} → ${endBalance})` : ''
        this.log(`Explore-on-Bing done — +${earned} this run${balances}`, 'log', 'green')
        return { earned }
    }

    /**
     * Open bing.com with the Rewards panel and read every card of its Explore-on-Bing checklist.
     * Returns null when the panel could not be opened, [] when it has no checklist.
     */
    private async readChecklist(): Promise<ExploreCard[] | null> {
        this.flyout = null
        await this.page.goto(ExploreRunner.FLYOUT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(3500, 6000))

        const findFlyout = (): Frame | null => this.page.frames().find(f => f.url().includes('/rewards/panelflyout')) ?? null

        // rwAutoFlyout=exb opens the panel by itself in some sessions; otherwise open it from the
        // points medallion like a visitor would (clicking when it is already open would close it).
        let flyout = findFlyout()
        if (!flyout) {
            const medallion = await this.page.waitForSelector('#rh_rwm, #id_rh_w', { state: 'visible', timeout: 10000 }).catch(() => null)
            if (!medallion) return null
            await medallion.click().catch(() => {})
            for (let i = 0; i < 20 && !flyout; i++) {
                await this.bot.utils.wait(500)
                flyout = findFlyout()
            }
        }
        if (!flyout) return null

        // The panel renders its sections client-side; give the checklist time to appear.
        const checklist = await flyout.waitForSelector(ExploreRunner.CHECKLIST, { state: 'attached', timeout: 12000 }).catch(() => null)
        this.flyout = flyout
        if (!checklist) return []

        const cards = await flyout.evaluate((selector: string) => {
            const out: { title: string, description: string, points: number, locked: boolean, complete: boolean }[] = []
            document.querySelectorAll(`${selector} a.block`).forEach(card => {
                const text = (query: string): string => (card.querySelector(query)?.textContent || '').replace(/\u200b/g, '').trim()
                out.push({
                    title: text('.promo-title'),
                    description: text('.promo-desc'),
                    points: parseInt(text('.point_cont .point'), 10) || 0,
                    locked: !!card.querySelector('.locked_overlay, .locked_level_required_text') || (card.getAttribute('href') || '').startsWith('javascript'),
                    // a finished card keeps its place but loses its description and gains this marker
                    complete: !!card.querySelector('.pc.complete')
                })
            })
            return out
        }, ExploreRunner.CHECKLIST).catch(() => [])

        return cards.filter(c => c.title)
    }

    /** Click the card in the open flyout (activates the offer), then search its topic in this tab. */
    private async activateAndSearch(card: ExploreCard): Promise<void> {
        const query = this.queryFor(card)
        if (!this.flyout || !query) {
            throw new Error('no panel or no search topic for this card')
        }

        const cardLink = this.flyout.locator(`${ExploreRunner.CHECKLIST} a.block`).filter({ hasText: card.title }).first()
        const activation = this.page.waitForResponse(
            response => response.url().includes('/msrewards/api/v1/reportactivity') && (response.request().postData() || '').includes('exploreonbing'),
            { timeout: 10000 }
        ).catch(() => null)
        // The card opens the Bing homepage in a new tab; the search is done in this one instead.
        const newTab = this.page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null)

        await cardLink.scrollIntoViewIfNeeded().catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(600, 1800))
        // The pointer click is sometimes swallowed inside the panel's frame; the DOM click runs the
        // same handler.
        await cardLink.click({ timeout: 4000 }).catch(() => cardLink.evaluate(element => (element as HTMLElement).click()))

        if (!(await activation)) {
            this.log(`"${card.title}": no activation request seen after clicking its card`, 'warn')
        }
        const opened = await newTab
        if (opened) await opened.close().catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4500))

        await this.searchInTab(query)
    }

    /** The card says what to search: "Search on Bing to compare checking and savings account options". */
    private queryFor(card: ExploreCard): string {
        return card.description.replace(/^search (on|with) bing\s+(to|for)\s+/i, '').replace(/[.!]+$/, '').trim()
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
            await this.page.waitForURL(/\/search\?/, { timeout: 15000 }).catch(() => {})
        }
        if (!this.page.url().includes('/search?')) {
            // The box was missing or covered: run the same query by address instead.
            await this.page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&form=QBLH`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        }
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
        await this.human.humanScroll(this.page, 'down').catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(2500, 5000))
    }
}
