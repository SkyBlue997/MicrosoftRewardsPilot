import { Page } from 'rebrowser-playwright'

import { RewardsApi, ApiPromotion } from './RewardsApi'
import { MicrosoftRewardsBot } from '../index'

/**
 * Earns the Bing visual-search offer (e.g. `WW_Bing_App_VisualSearch_..._Activation`, +10). Not
 * claimable via the activities API. Verified mechanism (reverse-engineered from the iOS Bing app
 * traffic):
 *   1. POST a JPEG as multipart field `imageBin` (base64) to
 *      https://www.bing.com/images/detail/upload?FORM=SBICAM&sbisrc=Hotspot  (anonymous) → returns
 *      {"url":"https://www.bing.com/images/search?...&insightsToken=...&FORM=SBICAM&iss=SBIUPLOADGET"}
 *   2. Navigate the SIGNED-IN browser to that url → the visual search registers server-side.
 * Doing this a few times (the daily cap is small — 3) completes the activation offer.
 *
 * The image is just a screenshot of the current page (a real photo from the Bing homepage), so no
 * asset needs to be bundled. There is no crypto/attestation on the upload — only the signed-in GET
 * needs the session, which the bot already has.
 */
export class VisualSearchRunner {
    private static readonly UPLOAD_URL = 'https://www.bing.com/images/detail/upload?FORM=SBICAM&sbisrc=Hotspot'
    private static readonly MAX_SEARCHES = 5

    constructor(private bot: MicrosoftRewardsBot, private api: RewardsApi, private page: Page) {}

    private log(message: string, type: 'log' | 'warn' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'VISUAL-SEARCH', message, type, color)
    }

    /** Earn the visual-search activation offer if one is currently available. */
    async run(): Promise<{ earned: number }> {
        let offer: ApiPromotion | undefined
        try {
            offer = await this.findOffer()
        } catch (error) {
            this.log(`Failed to fetch data: ${error}`, 'warn')
            return { earned: 0 }
        }
        if (!offer) {
            this.log('No earnable visual-search offer right now')
            return { earned: 0 }
        }
        this.log(`Earning "${offer.title}" (+${offer.max}) via visual search`)

        for (let i = 0; i < VisualSearchRunner.MAX_SEARCHES; i++) {
            const ok = await this.visualSearchOnce().catch(() => false)
            this.log(`Visual search ${i + 1}: ${ok ? 'done' : 'failed'}`)
            await this.bot.utils.wait(this.bot.utils.randomNumber(5000, 12000))

            const updated = await this.findOffer(offer.offerId)
            if (!updated || updated.complete) {
                this.log(`✅ "${offer.title}" (+${offer.max})`, 'log', 'green')
                return { earned: offer.max }
            }
        }
        this.log('Visual search did not complete the offer (cap reached)', 'warn')
        return { earned: 0 }
    }

    /** One visual search: screenshot the page → upload → navigate to the returned insightsToken URL. */
    private async visualSearchOnce(): Promise<boolean> {
        // Land on a page with a real photo (the Bing homepage daily image) and grab it as a JPEG.
        await this.page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))
        const imageBin = (await this.page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64')

        // Anonymous upload → returns the insightsToken search URL.
        const url = await this.page.evaluate(async ([uploadUrl, b64]) => {
            const boundary = '----vs' + Date.now() + Math.floor(Math.random() * 1e6)
            const body = `--${boundary}\r\nContent-Disposition: form-data; charset=utf-8; name="imageBin"\r\n\r\n${b64}\r\n--${boundary}--\r\n`
            const resp = await fetch(uploadUrl, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Search-UILang': 'en' },
                body
            })
            const json = await resp.json().catch(() => ({}))
            return (json && json.url) || ''
        }, [VisualSearchRunner.UPLOAD_URL, imageBin] as [string, string])

        if (!url || !url.startsWith('http')) return false

        // Signed-in navigation = the step that registers the visual search.
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        await this.bot.utils.wait(this.bot.utils.randomNumber(2500, 5000))
        return true
    }

    private async findOffer(offerId?: string): Promise<ApiPromotion | undefined> {
        const data = await this.api.getData()
        if (offerId) return data.promotions.find(p => p.offerId === offerId)
        return data.promotions.find(p => /visualsearch/i.test(p.offerId) && !p.complete && p.max > 0)
    }
}
