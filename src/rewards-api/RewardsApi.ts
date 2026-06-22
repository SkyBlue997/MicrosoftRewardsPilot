import { randomBytes } from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { GeoLanguageDetector } from '../../utils/GeoLanguage'
import { MicrosoftRewardsBot } from '../index'

const DAPI_BASE = 'https://prod.rewardsplatform.microsoft.com/dapi'

/**
 * A single Rewards promotion/activity from the new (2026) rewards.bing.com API.
 */
export interface ApiPromotion {
    offerId: string
    name: string
    type: string          // attributes.type, lowercased: urlreward | msnreadearn | checkin | search | streak | ...
    title: string
    complete: boolean
    progress: number
    max: number
    hidden: boolean
    dailySetDate: string | null
    classificationTag: string  // e.g. PCSearch / MobileSearch (for search promotions)
    destination: string
    attributes: Record<string, string>
}

export interface RewardsData {
    balance: number
    country: string
    promotions: ApiPromotion[]
}

/**
 * Client for the new Microsoft Rewards backend (prod.rewardsplatform.microsoft.com/dapi).
 *
 * The legacy rewards.bing.com UI (server-rendered `var dashboard` + data-bi-id cards) was
 * replaced by a Next.js SPA, so the old DOM-scraping/clicking no longer works. This talks to
 * the same dapi backend the SPA/apps use:
 *   - GET  /dapi/me?channel=SAAndroid&options=511  -> balance + promotions (the task list) + counters
 *   - POST /dapi/me/activities {type:101, attributes:{offerid}} -> claim/complete an activity
 * Auth is the OAuth access token (scope service::prod.rewardsplatform.microsoft.com::MBI_SSL)
 * obtained by Login.getMobileAccessToken().
 */
export class RewardsApi {
    constructor(private bot: MicrosoftRewardsBot, private accessToken: string, private country: string = 'us') {}

    private headers(json = false): Record<string, string> {
        const h: Record<string, string> = {
            'Authorization': `Bearer ${this.accessToken}`,
            'X-Rewards-Country': this.country,
            // Match the account's real market instead of always claiming English (country said jp while
            // language said en). Verified safe: en/ja/ja-JP all return identical promotions — only the
            // response titles localize. getLanguageFromCountry falls back to 'en' for unknown markets.
            'X-Rewards-Language': GeoLanguageDetector.getLanguageFromCountry((this.country || 'us').toUpperCase())
        }
        if (json) h['Content-Type'] = 'application/json'
        return h
    }

    /** Fetch balance + the full promotions list (replaces the old `var dashboard` scrape). */
    async getData(): Promise<RewardsData> {
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me?channel=SAAndroid&options=511`,
            method: 'GET',
            headers: this.headers()
        }
        const response = await this.bot.axios.request(req)
        const r = (response.data && response.data.response) || {}
        const country = r.profile?.attributes?.country || this.country
        this.country = country
        const promotions: ApiPromotion[] = (Array.isArray(r.promotions) ? r.promotions : []).map((p: unknown) => this.mapPromotion(p))
        return { balance: Number(r.balance) || 0, country, promotions }
    }

    private mapPromotion(p: unknown): ApiPromotion {
        const pr = (p ?? {}) as Record<string, unknown>
        const a = (pr.attributes ?? {}) as Record<string, string>
        const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
        const bool = (v: unknown): boolean => String(v).toLowerCase() === 'true'
        return {
            offerId: a.offerid || String(pr.name || ''),
            name: String(pr.name || ''),
            type: String(a.type || '').toLowerCase(),
            title: a.title || String(pr.name || ''),
            complete: bool(a.complete),
            progress: num(a.progress ?? a.activityprogress),
            max: num(a.max ?? a.activitymax),
            hidden: bool(a.hidden),
            dailySetDate: a.daily_set_date || null,
            classificationTag: a['Classification.Tag'] || a['AnswerScenario.Tag'] || '',
            destination: a.destination || '',
            attributes: a
        }
    }

    /**
     * Claim/complete an activity via the generic activities endpoint.
     * Works for urlreward (daily set, daily offers, explore-on-Bing, monthly topics), checkin and
     * msnreadearn (read-to-earn) offers. Search points are NOT claimable this way (require real searches).
     */
    async claim(offerId: string): Promise<{ points: number, balance: number, duplicate: boolean }> {
        const payload = {
            amount: 1,
            country: this.country,
            id: randomBytes(32).toString('hex'),
            type: 101,
            attributes: { offerid: offerId }
        }
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me/activities`,
            method: 'POST',
            headers: this.headers(true),
            data: JSON.stringify(payload)
        }
        const response = await this.bot.axios.request(req)
        const r = (response.data && response.data.response) || {}
        return { points: Number(r.activity?.p) || 0, balance: Number(r.balance) || 0, duplicate: !!r.isDuplicate }
    }

    /**
     * The Bing-app daily check-in (the "必应应用连签" streak): a `type:103` activity with no offerid.
     * Distinct from the web daily check-in (type:101 + Gamification_Sapphire_DailyCheckIn offerid).
     * Reverse-engineered from iOS Bing-app traffic; verified live to credit (+15 on a fresh day) with
     * our own token — `channel` must match the token's context (SAAndroid), not the iOS app's SAIOS.
     * Returns 0/duplicate once the day's check-in is already done.
     */
    async appCheckIn(): Promise<{ points: number, balance: number, duplicate: boolean }> {
        const payload = {
            amount: 1,
            country: this.country,
            id: randomBytes(32).toString('hex'),
            type: 103,
            channel: 'SAAndroid',
            attributes: {},
            risk_context: {}
        }
        const headers = { ...this.headers(true), 'X-Rewards-AppId': 'SAAndroid', 'X-Rewards-PartnerId': 'startapp' }
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me/activities`,
            method: 'POST',
            headers,
            data: JSON.stringify(payload)
        }
        const response = await this.bot.axios.request(req)
        const r = (response.data && response.data.response) || {}
        return { points: Number(r.activity?.p) || 0, balance: Number(r.balance) || 0, duplicate: !!r.isDuplicate }
    }

    /** Promotions that can be completed by a single claim (not search, not info/sweepstakes). */
    static isClaimable(p: ApiPromotion): boolean {
        if (p.complete) return false
        // Daily check-in is flagged hidden (it renders in a dedicated widget) but is genuinely claimable.
        if (p.type === 'checkin') return true
        if (p.hidden) return false
        return p.type === 'urlreward' || p.type === 'msnreadearn'
    }
}
