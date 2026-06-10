import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { AccountProxy } from '../interfaces/Account'

class AxiosClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account
        this.instance = axios.create()

        // If a proxy configuration is provided, set up the agent
        if (this.account.url && this.account.proxyAxios) {
            const proxyUrl = this.buildProxyUrl(this.account)
            if (this.account.url.startsWith('socks')) {
                const agent = new SocksProxyAgent(proxyUrl)
                this.instance.defaults.httpAgent = agent
                this.instance.defaults.httpsAgent = agent
            } else {
                // Pick the agent by TARGET scheme, not proxy scheme: an http:// proxy still needs an
                // HttpsProxyAgent (CONNECT tunnel) to reach https:// targets, which is nearly all of them.
                this.instance.defaults.httpAgent = new HttpProxyAgent(proxyUrl)
                this.instance.defaults.httpsAgent = new HttpsProxyAgent(proxyUrl)
            }
        }
    }

    private buildProxyUrl(proxyConfig: AccountProxy): string {
        const { url, port, username, password } = proxyConfig

        // 构建代理URL，包含认证信息（如果提供的话）
        let proxyUrl = `${url}:${port}`
        if (username && password) {
            // 提取协议
            const urlParts = url.split('://')
            if (urlParts.length === 2) {
                const protocol = urlParts[0]
                const hostPart = urlParts[1]
                proxyUrl = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostPart}:${port}`
            } else {
                // 如果没有协议，默认使用 http
                proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${url}:${port}`
            }
        }

        return proxyUrl
    }

    // Generic method to make any Axios request.
    // `useProxy` controls whether the configured account proxy is used (default: true).
    // Passing `false` sends the request directly, bypassing the proxy.
    public async request(config: AxiosRequestConfig, useProxy = true): Promise<AxiosResponse> {
        if (!useProxy) {
            const directInstance = axios.create()
            return directInstance.request(config)
        }

        return this.instance.request(config)
    }
}

export default AxiosClient