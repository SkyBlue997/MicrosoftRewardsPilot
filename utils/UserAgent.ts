import axios from 'axios'
import { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import { log } from './Logger'

import { ChromeMilestoneVersions, EdgeVersion } from '../interfaces/UserAgentUtil'

const NOT_A_BRAND_VERSION = '99'
// GREASE brand string — MUST be byte-identical everywhere it appears (navigator.userAgentData AND
// the sec-ch-ua* HTTP headers). A real browser derives both from one value; emitting two different
// GREASE spellings for one client (this code used 'Not/A)Brand' in JS but 'Not=A?Brand' in headers)
// is impossible on a genuine browser and a clean automation tell.
const GREASE_BRAND = 'Not/A)Brand'

export async function getUserAgent(isMobile: boolean) {
    const system = getSystemComponents(isMobile)
    const app = await getAppComponents(isMobile)
    // Mobile: the real OS version/model live only in the client hints, and must agree with each other.
    const device = isMobile ? getMobileDevice() : null

    // UA reduction: the UA string carries only <major>.0.0.0 for BOTH Chrome and Edg/EdgA; the full
    // builds are exposed solely through sec-ch-ua-full-version-list (fullVersionList below).
    const uaTemplate = isMobile ?
        `Mozilla/5.0 (Linux; ${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Mobile Safari/537.36 EdgA/${app.edge_reduced_version}` :
        `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Safari/537.36 Edg/${app.edge_reduced_version}`

    const platformVersion = device ? `${device.androidMajorVersion}.0.0` : `${Math.floor(Math.random() * 15) + 1}.0.0`

    const uaMetadata = {
        isMobile,
        platform: isMobile ? 'Android' : 'Windows',
        // Order mirrors a real Edge client (Edge, GREASE, Chromium); the sec-ch-ua* headers are
        // derived from these same arrays in updateFingerprintUserAgent so JS and headers always agree.
        fullVersionList: [
            { brand: 'Microsoft Edge', version: app['edge_version'] },
            { brand: GREASE_BRAND, version: `${NOT_A_BRAND_VERSION}.0.0.0` },
            { brand: 'Chromium', version: app['chrome_version'] }
        ],
        brands: [
            { brand: 'Microsoft Edge', version: app['edge_major_version'] },
            { brand: GREASE_BRAND, version: NOT_A_BRAND_VERSION },
            { brand: 'Chromium', version: app['chrome_major_version'] }
        ],
        platformVersion,
        architecture: isMobile ? '' : 'x86',
        bitness: isMobile ? '' : '64',
        model: device ? device.model : ''
    }

    return { userAgent: uaTemplate, userAgentMetadata: uaMetadata }
}

// Pairs with FALLBACK_EDGE_VERSIONS below (same major), so the all-offline path is still consistent.
const FALLBACK_CHROMIUM_VERSION = '131.0.6778.86'

/**
 * The Chromium build a real Edge reports is always on Edge's OWN major (Edge 154 ships on Chromium
 * 154). This used to look up the latest *Google Chrome* stable instead, which runs ahead of Edge and
 * produced impossible pairs such as "Chrome/150.0.0.0 ... Edg/149". Resolve the Chromium build for
 * Edge's milestone; it only surfaces in sec-ch-ua-full-version-list.
 */
export async function getChromiumVersion(major: string, isMobile: boolean): Promise<string> {
    // Official endpoint first, then the regional mirror; never let a third-party outage block the run.
    const urls = [
        'https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone.json',
        'https://ghproxy.monkeyray.net/https://raw.githubusercontent.com/GoogleChromeLabs/chrome-for-testing/main/data/latest-versions-per-milestone.json'
    ]
    for (const url of urls) {
        try {
            const response = await axios({ url, method: 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 10000 })
            const data: ChromeMilestoneVersions = response.data
            const version = data?.milestones?.[major]?.version
            if (version) {
                return version
            }
        } catch (error) {
            log(isMobile, 'USERAGENT-CHROMIUM-VERSION', `Failed to fetch Chromium versions from ${url}: ${error}`, 'warn')
        }
    }
    if (FALLBACK_CHROMIUM_VERSION.split('.')[0] === major) {
        return FALLBACK_CHROMIUM_VERSION
    }
    // A placeholder build is still better than a Chromium major that contradicts Edge's.
    log(isMobile, 'USERAGENT-CHROMIUM-VERSION', `No Chromium build found for milestone ${major}; using ${major}.0.0.0`, 'warn')
    return `${major}.0.0.0`
}

const FALLBACK_EDGE_VERSIONS = { android: '131.0.2903.87', windows: '131.0.2903.86' }

export async function getEdgeVersions(isMobile: boolean) {
    try {
        const response = await axios({
            url: 'https://edgeupdates.microsoft.com/api/products',
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        })
        const data: EdgeVersion[] = response.data
        const stable = data.find(x => x.Product == 'Stable')
        if (stable) {
            return {
                android: stable.Releases.find(x => x.Platform == 'Android')?.ProductVersion ?? FALLBACK_EDGE_VERSIONS.android,
                windows: stable.Releases.find(x => (x.Platform == 'Windows' && x.Architecture == 'x64'))?.ProductVersion ?? FALLBACK_EDGE_VERSIONS.windows
            }
        }
    } catch (error) {
        log(isMobile, 'USERAGENT-EDGE-VERSION', `Failed to fetch Edge versions: ${error}`, 'warn')
    }
    log(isMobile, 'USERAGENT-EDGE-VERSION', 'Falling back to pinned Edge versions', 'warn')
    return FALLBACK_EDGE_VERSIONS
}

// Chromium User-Agent reduction (shipped in Chrome/Edge for Android since ~v110) freezes the UA's OS
// token to "Android 10; K" on EVERY device: the real Android version and device model are only
// exposed via the high-entropy client hints (navigator.userAgentData.getHighEntropyValues /
// sec-ch-ua-platform-version / sec-ch-ua-model). A Chrome 13x+ UA carrying a real version/model,
// a WebView "; wv" marker, or the legacy "Linux; U" token is something a real Edge for Android
// never sends.
const REDUCED_ANDROID_SYSTEM = 'Android 10; K'

export interface MobileDevice {
    androidMajorVersion: number
    model: string
}

/** Picks a realistic Android version/device pair; surfaced only via userAgentData (client hints). */
export function getMobileDevice(): MobileDevice {
    // 更真实的Android版本分布（基于实际市场占有率）
    const androidDistribution = [
        { version: 12, weight: 15 },
        { version: 13, weight: 30 },
        { version: 14, weight: 40 },
        { version: 15, weight: 15 }
    ]

    // 更全面的设备型号（包含主流品牌）
    const deviceModels = [
        // Samsung Galaxy系列
        'SM-G991B', 'SM-G998B', 'SM-S918B', 'SM-S928B', 'SM-A525F', 'SM-A736B', 'SM-A546B',
        // Google Pixel系列
        'Pixel 6', 'Pixel 6 Pro', 'Pixel 7', 'Pixel 7 Pro', 'Pixel 8', 'Pixel 8 Pro', 'Pixel 9',
        // OnePlus系列
        'ONEPLUS A6000', 'ONEPLUS GM1913', 'ONEPLUS KB2000', 'ONEPLUS PJZ110',
        // LG系列
        'LM-G900', 'LM-V600', 'LM-Q730', 'LM-G850',
        // Xiaomi系列
        'M2012K11AG', 'M2101K6G', 'M2103K19G', 'M2007J20CG', 'M2211K2C',
        // Huawei系列
        'ELS-NX9', 'LYA-L29', 'VOG-L29', 'ANA-NX9',
        // Oppo系列
        'CPH2025', 'CPH2207', 'CPH2413', 'CPH2239'
    ]

    // 权重随机选择Android版本
    const totalWeight = androidDistribution.reduce((sum, item) => sum + item.weight, 0)
    let randomWeight = Math.random() * totalWeight
    let androidMajorVersion = 13

    for (const item of androidDistribution) {
        randomWeight -= item.weight
        if (randomWeight <= 0) {
            androidMajorVersion = item.version
            break
        }
    }

    const model = deviceModels[Math.floor(Math.random() * deviceModels.length)] as string

    return { androidMajorVersion, model }
}

export function getSystemComponents(mobile: boolean): string {
    // Mobile: the UA-reduced OS token, identical on every real Edge for Android (see above).
    // Desktop: 保持桌面端简洁
    return mobile ? REDUCED_ANDROID_SYSTEM : 'Windows NT 10.0; Win64; x64'
}

/**
 * True when a saved mobile UA has a single clean "(Linux; Android <ver>; <model>)" system token —
 * i.e. no WebView "wv" marker, no empty "; ;" token, no duplicate "Linux"/legacy "U" token.
 * Used to detect fingerprints persisted by older builds that generated malformed UAs.
 */
export function isWellFormedMobileUserAgent(userAgent: string | undefined): boolean {
    if (!userAgent) return false
    const match = /^Mozilla\/5\.0 \(Linux; Android (\d+); ([^;()]+)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Mobile Safari\/537\.36 EdgA\/[\d.]+$/.exec(userAgent)
    if (!match) return false
    const model = (match[2] as string).trim()
    return model.length > 0 && model !== 'wv' && model !== 'U' && model !== 'Linux'
}

export async function getAppComponents(isMobile: boolean) {
    const versions = await getEdgeVersions(isMobile)
    const edgeVersion = isMobile ? versions.android : versions.windows
    const edgeMajorVersion = edgeVersion.split('.')[0] as string
    // Edge's major decides everything: Chromium is looked up for that milestone, and both UA tokens
    // are reduced to <major>.0.0.0.
    const chromiumVersion = await getChromiumVersion(edgeMajorVersion, isMobile)
    const reducedVersion = `${edgeMajorVersion}.0.0.0`

    return {
        not_a_brand_version: `${NOT_A_BRAND_VERSION}.0.0.0`,
        not_a_brand_major_version: NOT_A_BRAND_VERSION,
        edge_version: edgeVersion,
        edge_major_version: edgeMajorVersion,
        edge_reduced_version: reducedVersion,
        chrome_version: chromiumVersion,
        chrome_major_version: edgeMajorVersion,
        chrome_reduced_version: reducedVersion
    }
}

/** Edge major from a UA's trailing Edg/EdgA token (0 if absent). */
export function edgeMajorFromUserAgent(userAgent: string | undefined): number {
    return Number(/\bEdgA?\/(\d+)\./.exec(userAgent ?? '')?.[1] ?? 0)
}

/**
 * Why a SAVED User-Agent must be regenerated, or null if it's one a real Edge could send. Fingerprints
 * are persisted and reused indefinitely, so a fix to UA generation only reaches existing accounts if
 * inconsistent saved UAs are detected on load (see utils/Load.ts loadSessionData).
 */
export function userAgentRefreshReason(userAgent: string | undefined, isMobile: boolean): string | null {
    if (!userAgent) return 'missing User-Agent'
    if (isMobile && !isWellFormedMobileUserAgent(userAgent)) return 'malformed mobile system token'
    const edge = /\bEdgA?\/(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(userAgent)
    if (!edge) return 'no Edge version token'
    if (edge[2] !== '0' || edge[3] !== '0' || edge[4] !== '0') return 'Edge version not UA-reduced'
    const chrome = /\bChrome\/(\d+)\./.exec(userAgent)
    if (chrome?.[1] !== edge[1]) return 'Chromium and Edge major versions differ'
    return null
}

export async function updateFingerprintUserAgent(fingerprint: BrowserFingerprintWithHeaders, isMobile: boolean): Promise<BrowserFingerprintWithHeaders> {
    try {
        const userAgentData = await getUserAgent(isMobile)

        //@ts-expect-error Errors due it not exactly matching
        fingerprint.fingerprint.navigator.userAgentData = userAgentData.userAgentMetadata
        fingerprint.fingerprint.navigator.userAgent = userAgentData.userAgent
        fingerprint.fingerprint.navigator.appVersion = userAgentData.userAgent.replace(`${fingerprint.fingerprint.navigator.appCodeName}/`, '')

        // Derive the client-hint headers from the SAME brand arrays used for navigator.userAgentData,
        // so the GREASE brand string, versions and ordering are guaranteed identical across JS + HTTP.
        const formatBrands = (list: Array<{ brand: string, version: string }>): string =>
            list.map(b => `"${b.brand}";v="${b.version}"`).join(', ')

        fingerprint.headers['user-agent'] = userAgentData.userAgent
        fingerprint.headers['sec-ch-ua'] = formatBrands(userAgentData.userAgentMetadata.brands)
        fingerprint.headers['sec-ch-ua-full-version-list'] = formatBrands(userAgentData.userAgentMetadata.fullVersionList)

        /*
        Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0
        sec-ch-ua-full-version-list: "Microsoft Edge";v="129.0.2792.84", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
        sec-ch-ua: "Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"

        Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36
        "Google Chrome";v="129.0.6668.90", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
        */

        return fingerprint
    } catch (error) {
        log(isMobile, 'USER-AGENT-UPDATE', 'An error occurred:' + error, 'error')
        throw new Error('An error occurred:' + error)
    }
}