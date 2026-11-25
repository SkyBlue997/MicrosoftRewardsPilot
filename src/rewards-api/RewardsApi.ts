import { randomUUID } from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { GeoLanguageDetector } from '../../utils/GeoLanguage'
import { getEdgeVersions } from '../../utils/UserAgent'
import { MicrosoftRewardsBot } from '../index'

const DAPI_BASE = 'https://prod.rewardsplatform.microsoft.com/dapi'

// This API (channel SAAndroid) is the Bing mobile app's. These requests used to go out as a bare
// Node client — `User-Agent: axios/1.9.0`, no app headers — on every read and every claim. The header
// set below is the one a capture of the real app's dapi requests shows (iOS build 33.5.440612003:
// X-Rewards-AppId "SAIOS/<version>", X-Rewards-PartnerId "startapp", X-Rewards-Flights "rwgobig", an
// EMPTY X-Rewards-IsMobile, Accept "*/*", a plain mobile-browser User-Agent, UUID activity ids),
// transposed to the Android app the OAuth token belongs to. No Android capture exists, so the
// Android specifics (the "SAAndroid/<version>" form, the Chrome-on-Android UA) are by analogy.
//
// The version is a real Play Store release of com.microsoft.bing (arm64 build of 2026-11-19); the app
// ships about weekly, so override it with REWARDS_APP_VERSION instead of letting it age for months.
const APP_VERSION = process.env.REWARDS_APP_VERSION || '34.5.441112006'

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
    private userAgent: string | null = null

    constructor(private bot: MicrosoftRewardsBot, private accessToken: string, private country: string = 'us') {}

    private async headers(json = false): Promise<Record<string, string>> {
        if (!this.userAgent) {
            // Chrome on Android at the current stable major (Edge and Chrome share it), UA-reduced.
            const major = (await getEdgeVersions(true)).android.split('.')[0]
            this.userAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
        }
        // Match the account's real market instead of always claiming English (country said jp while
        // language said en). Verified safe: en/ja/ja-JP all return identical promotions — only the
        // response titles localize. getLanguageFromCountry falls back to 'en' for unknown markets.
        const language = GeoLanguageDetector.getLanguageFromCountry((this.country || 'us').toUpperCase())
        const h: Record<string, string> = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': '*/*',
            'Accept-Language': language === 'en' ? 'en-US,en;q=0.9' : `${language},en-US;q=0.8,en;q=0.7`,
            'User-Agent': this.userAgent,
            'X-Rewards-AppId': `SAAndroid/${APP_VERSION}`,
            'X-Rewards-Country': this.country,
            'X-Rewards-Flights': 'rwgobig',
            'X-Rewards-IsMobile': '',
            'X-Rewards-Language': language,
            'X-Rewards-PartnerId': 'startapp'
        }
        if (json) h['Content-Type'] = 'application/json'
        return h
    }

    /** Fetch balance + the full promotions list (replaces the old `var dashboard` scrape). */
    async getData(): Promise<RewardsData> {
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me?channel=SAAndroid&options=511`,
            method: 'GET',
            headers: await this.headers()
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
            id: randomUUID(), // the app's activity ids are UUIDs (this used to be 64 hex characters)
            type: 101,
            attributes: { offerid: offerId }
        }
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me/activities`,
            method: 'POST',
            headers: await this.headers(true),
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
            id: randomUUID(),
            type: 103,
            channel: 'SAAndroid',
            attributes: {},
            risk_context: {}
        }
        const req: AxiosRequestConfig = {
            url: `${DAPI_BASE}/me/activities`,
            method: 'POST',
            headers: await this.headers(true),
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
