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
            const agent = this.getAgentForProxy(this.account)
            this.instance.defaults.httpAgent = agent
            this.instance.defaults.httpsAgent = agent
        }
    }

    private getAgentForProxy(proxyConfig: AccountProxy): HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent {
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

        switch (true) {
            case proxyConfig.url.startsWith('http://'):
                return new HttpProxyAgent(proxyUrl)
            case proxyConfig.url.startsWith('https://'):
                return new HttpsProxyAgent(proxyUrl)
            case proxyConfig.url.startsWith('socks'):
                return new SocksProxyAgent(proxyUrl)
            default:
                // 默认使用 HTTP 代理
                return new HttpProxyAgent(proxyUrl)
        }
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