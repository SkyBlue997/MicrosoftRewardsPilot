import axios from 'axios'
import { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import { log } from './Logger'

import { ChromeVersion, EdgeVersion } from '../interfaces/UserAgentUtil'

const NOT_A_BRAND_VERSION = '99'

export async function getUserAgent(isMobile: boolean) {
    const system = getSystemComponents(isMobile)
    const app = await getAppComponents(isMobile)

    const uaTemplate = isMobile ?
        `Mozilla/5.0 (Linux; ${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Mobile Safari/537.36 EdgA/${app.edge_version}` :
        `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Safari/537.36 Edg/${app.edge_version}`

    const platformVersion = `${isMobile ? Math.floor(Math.random() * 5) + 9 : Math.floor(Math.random() * 15) + 1}.0.0`

    const uaMetadata = {
        isMobile,
        platform: isMobile ? 'Android' : 'Windows',
        fullVersionList: [
            { brand: 'Not/A)Brand', version: `${NOT_A_BRAND_VERSION}.0.0.0` },
            { brand: 'Microsoft Edge', version: app['edge_version'] },
            { brand: 'Chromium', version: app['chrome_version'] }
        ],
        brands: [
            { brand: 'Not/A)Brand', version: NOT_A_BRAND_VERSION },
            { brand: 'Microsoft Edge', version: app['edge_major_version'] },
            { brand: 'Chromium', version: app['chrome_major_version'] }
        ],
        platformVersion,
        architecture: isMobile ? '' : 'x86',
        bitness: isMobile ? '' : '64',
        model: ''
    }

    return { userAgent: uaTemplate, userAgentMetadata: uaMetadata }
}

export async function getChromeVersion(isMobile: boolean): Promise<string> {
    try {
        const request = {
            // url: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
            url: 'https://ghproxy.monkeyray.net/https://raw.githubusercontent.com/GoogleChromeLabs/chrome-for-testing/main/data/last-known-good-versions.json',
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        }

        const response = await axios(request)
        const data: ChromeVersion = response.data
        return data.channels.Stable.version

    } catch (error) {
        log(isMobile, 'USERAGENT-CHROME-VERSION', 'An error occurred:' + error, 'error')
        throw new Error('An error occurred:' + error)
    }
}

export async function getEdgeVersions(isMobile: boolean) {
    try {
        const request = {
            url: 'https://edgeupdates.microsoft.com/api/products',
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        }

        const response = await axios(request)
        const data: EdgeVersion[] = response.data
        const stable = data.find(x => x.Product == 'Stable') as EdgeVersion
        return {
            android: stable.Releases.find(x => x.Platform == 'Android')?.ProductVersion,
            windows: stable.Releases.find(x => (x.Platform == 'Windows' && x.Architecture == 'x64'))?.ProductVersion
        }


    } catch (error) {
        log(isMobile, 'USERAGENT-EDGE-VERSION', 'An error occurred:' + error, 'error')
        throw new Error('An error occurred:' + error)
    }
}

export function getSystemComponents(mobile: boolean): string {
    if (mobile) {
        // 更真实的Android版本分布（基于实际市场占有率）
        const androidDistribution = [
            { version: 'Android 12', weight: 15 },
            { version: 'Android 13', weight: 30 },
            { version: 'Android 14', weight: 40 },
            { version: 'Android 15', weight: 15 }
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
        let selectedVersion = 'Android 13'
        
        for (const item of androidDistribution) {
            randomWeight -= item.weight
            if (randomWeight <= 0) {
                selectedVersion = item.version
                break
            }
        }
        
        const selectedModel = deviceModels[Math.floor(Math.random() * deviceModels.length)]
        
        // 添加额外的设备特征
        const additionalSpecs = [
            '', // 无额外规格
            '; wv', // WebView标识
            'Linux; U' // 旧版格式
        ]
        const selectedSpec = additionalSpecs[Math.floor(Math.random() * additionalSpecs.length)]
        
        return selectedSpec ? `${selectedVersion}; ${selectedSpec}; ${selectedModel}` : `${selectedVersion}; ${selectedModel}`
    } else {
        // 保持桌面端简洁
        return 'Windows NT 10.0; Win64; x64'
    }
}

export async function getAppComponents(isMobile: boolean) {
    const versions = await getEdgeVersions(isMobile)
    const edgeVersion = isMobile ? versions.android : versions.windows as string
    const edgeMajorVersion = edgeVersion?.split('.')[0]

    const chromeVersion = await getChromeVersion(isMobile)
    const chromeMajorVersion = chromeVersion?.split('.')[0]
    const chromeReducedVersion = `${chromeMajorVersion}.0.0.0`

    return {
        not_a_brand_version: `${NOT_A_BRAND_VERSION}.0.0.0`,
        not_a_brand_major_version: NOT_A_BRAND_VERSION,
        edge_version: edgeVersion as string,
        edge_major_version: edgeMajorVersion as string,
        chrome_version: chromeVersion as string,
        chrome_major_version: chromeMajorVersion as string,
        chrome_reduced_version: chromeReducedVersion as string
    }
}

export async function updateFingerprintUserAgent(fingerprint: BrowserFingerprintWithHeaders, isMobile: boolean): Promise<BrowserFingerprintWithHeaders> {
    try {
        const userAgentData = await getUserAgent(isMobile)
        const componentData = await getAppComponents(isMobile)

        //@ts-expect-error Errors due it not exactly matching
        fingerprint.fingerprint.navigator.userAgentData = userAgentData.userAgentMetadata
        fingerprint.fingerprint.navigator.userAgent = userAgentData.userAgent
        fingerprint.fingerprint.navigator.appVersion = userAgentData.userAgent.replace(`${fingerprint.fingerprint.navigator.appCodeName}/`, '')

        fingerprint.headers['user-agent'] = userAgentData.userAgent
        fingerprint.headers['sec-ch-ua'] = `"Microsoft Edge";v="${componentData.edge_major_version}", "Not=A?Brand";v="${componentData.not_a_brand_major_version}", "Chromium";v="${componentData.chrome_major_version}"`
        fingerprint.headers['sec-ch-ua-full-version-list'] = `"Microsoft Edge";v="${componentData.edge_version}", "Not=A?Brand";v="${componentData.not_a_brand_version}", "Chromium";v="${componentData.chrome_version}"`

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