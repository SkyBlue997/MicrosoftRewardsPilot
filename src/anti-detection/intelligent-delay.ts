/**
 * 智能延迟系统
 * 基于真实用户行为模式的非模式化延迟生成
 */
export class IntelligentDelaySystem {
    // 单次延迟上限，避免生活中断与多个倍率叠加后出现 >1 小时的极端等待
    private static readonly MAX_SEARCH_DELAY_MS = 10 * 60_000
    private recentDelays: number[] = []
    private suspicionLevel: number = 0
    private lastActivityTime: number = 0
    private sessionStartTime: number = Date.now()
    private consecutiveFailures: number = 0
    
    /**
     * 计算搜索延迟
     */
    calculateSearchDelay(searchIndex: number, isMobile: boolean, hasFailures: boolean = false): number {
        const now = Date.now()
        
        // 更新怀疑级别
        this.updateSuspicionLevel()
        
        // 如果有失败，增加谨慎度
        if (hasFailures) {
            this.consecutiveFailures++
        } else {
            this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1)
        }
        
        // 基础延迟范围（基于真实用户行为统计）
        const baseRanges = {
            mobile: { min: 18000, max: 95000 },    // 18秒-95秒
            desktop: { min: 25000, max: 140000 }   // 25秒-140秒
        }
        
        const range = isMobile ? baseRanges.mobile : baseRanges.desktop
        
        // 生成非模式化延迟
        let delay = this.generateHumanLikeDelay(range.min, range.max, searchIndex)
        
        // 应用谨慎模式
        if (this.suspicionLevel > 0.5 || this.consecutiveFailures > 0) {
            const cautionMultiplier = 1.3 + (this.suspicionLevel * 0.7) + (this.consecutiveFailures * 0.2)
            delay *= cautionMultiplier
        }
        
        // 添加生活中断模拟
        delay = this.addLifeInterruptions(delay)
        
        // 时间感知调整
        delay = this.applyTimeAwareAdjustment(delay)
        
        // 会话疲劳效应
        delay = this.applySessionFatigue(delay, searchIndex)
        
        // 封顶单次延迟，避免极端等待拖垮运行时间预算
        delay = Math.min(delay, IntelligentDelaySystem.MAX_SEARCH_DELAY_MS)

        this.recordDelay(delay)
        this.lastActivityTime = now
        
        return Math.floor(delay)
    }
    
    /**
     * 生成类人延迟模式
     */
    private generateHumanLikeDelay(min: number, max: number, searchIndex: number): number {
        // 真实用户行为的多种模式
        const behaviorPatterns = [
            { weight: 0.35, generator: () => this.quickUserPattern(min, max) },      // 快速用户
            { weight: 0.30, generator: () => this.normalUserPattern(min, max) },     // 普通用户
            { weight: 0.20, generator: () => this.thoughtfulUserPattern(min, max) }, // 深思用户
            { weight: 0.10, generator: () => this.distractedUserPattern(min, max) }, // 分心用户
            { weight: 0.05, generator: () => this.multitaskingPattern(min, max) }    // 多任务用户
        ]
        
        // 根据搜索序号调整模式（用户会逐渐疲劳）
        if (searchIndex > 15) {
            // 后期搜索，用户更可能分心或疲劳
            if (behaviorPatterns[3]) behaviorPatterns[3].weight += 0.1 // 增加分心概率
            if (behaviorPatterns[4]) behaviorPatterns[4].weight += 0.05 // 增加多任务概率
        }
        
        const selectedPattern = this.selectWeightedRandom(behaviorPatterns)
        return selectedPattern()
    }
    
    /**
     * 快速用户模式
     */
    private quickUserPattern(min: number, max: number): number {
        // 偏向较短延迟，但仍有变化
        const range = max - min
        return min + Math.pow(Math.random(), 1.5) * range * 0.6
    }
    
    /**
     * 普通用户模式
     */
    private normalUserPattern(min: number, max: number): number {
        // 正态分布，中等延迟
        const mean = (min + max) / 2
        const stdDev = (max - min) / 6
        return Math.max(min, Math.min(max, this.normalRandom(mean, stdDev)))
    }
    
    /**
     * 深思用户模式
     */
    private thoughtfulUserPattern(min: number, max: number): number {
        // 偏向较长延迟
        const range = max - min
        return min + Math.pow(Math.random(), 0.7) * range
    }
    
    /**
     * 分心用户模式
     */
    private distractedUserPattern(min: number, max: number): number {
        // 有时很快，有时很慢
        if (Math.random() < 0.3) {
            return min + Math.random() * (max - min) * 0.3 // 快速
        } else {
            return min + (max - min) * 0.7 + Math.random() * (max - min) * 0.3 // 慢速
        }
    }
    
    /**
     * 多任务用户模式
     */
    private multitaskingPattern(min: number, max: number): number {
        // 不规律的延迟模式
        const patterns = [
            min + Math.random() * (max - min) * 0.4,
            min + (max - min) * 0.6 + Math.random() * (max - min) * 0.4,
            min + Math.random() * (max - min)
        ]
        return patterns[Math.floor(Math.random() * patterns.length)] || 1000
    }
    
    /**
     * 添加生活中断模拟
     */
    private addLifeInterruptions(baseDelay: number): number {
        const random = Math.random()
        
        // 5%概率的长时间中断（接电话、上厕所、吃东西等）
        if (random < 0.05) {
            const interruptionTypes = [
                { min: 120000, max: 300000 },  // 2-5分钟：短暂离开
                { min: 300000, max: 900000 },  // 5-15分钟：接电话
                { min: 600000, max: 1800000 }  // 10-30分钟：吃饭/休息
            ]
            const interruption = interruptionTypes[Math.floor(Math.random() * interruptionTypes.length)]
            const interruptionTime = (interruption?.min || 100) + Math.random() * ((interruption?.max || 500) - (interruption?.min || 100))
            return baseDelay + interruptionTime
        }
        
        // 15%概率的短时间中断（查看通知、回复消息等）
        if (random < 0.20) {
            const shortInterruption = 8000 + Math.random() * 25000 // 8-33秒
            return baseDelay + shortInterruption
        }
        
        // 10%概率的微中断（思考、阅读等）
        if (random < 0.30) {
            const microInterruption = 3000 + Math.random() * 8000 // 3-11秒
            return baseDelay + microInterruption
        }
        
        return baseDelay
    }
    
    /**
     * 时间感知调整
     */
    private applyTimeAwareAdjustment(delay: number): number {
        const hour = new Date().getHours()
        const dayOfWeek = new Date().getDay()
        
        let multiplier = 1.0
        
        // 深夜时间（1-6点）- 用户更慢更谨慎
        if (hour >= 1 && hour <= 6) {
            multiplier *= 1.6 + Math.random() * 0.4
        }
        // 早晨忙碌时间（7-9点）- 用户可能更快
        else if (hour >= 7 && hour <= 9) {
            multiplier *= 0.7 + Math.random() * 0.3
        }
        // 工作时间（9-17点）- 用户可能分心
        else if (hour >= 9 && hour <= 17) {
            multiplier *= 0.8 + Math.random() * 0.4
        }
        // 晚上黄金时间（19-23点）- 正常使用
        else if (hour >= 19 && hour <= 23) {
            multiplier *= 0.9 + Math.random() * 0.3
        }
        
        // 周末调整
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            multiplier *= 1.1 + Math.random() * 0.2 // 周末更悠闲
        }
        
        return delay * multiplier
    }
    
    /**
     * 会话疲劳效应
     */
    private applySessionFatigue(delay: number, searchIndex: number): number {
        const sessionDuration = Date.now() - this.sessionStartTime
        const sessionMinutes = sessionDuration / 60000
        
        // 会话时间越长，用户越疲劳
        let fatigueMultiplier = 1.0
        
        if (sessionMinutes > 10) {
            fatigueMultiplier += (sessionMinutes - 10) * 0.02 // 每分钟增加2%延迟
        }
        
        // 搜索次数疲劳
        if (searchIndex > 10) {
            fatigueMultiplier += (searchIndex - 10) * 0.01 // 每次搜索增加1%延迟
        }
        
        return delay * Math.min(fatigueMultiplier, 2.0) // 最多2倍延迟
    }
    
    /**
     * 更新怀疑级别
     */
    private updateSuspicionLevel(): void {
        if (this.recentDelays.length >= 5) {
            const variance = this.calculateVariance(this.recentDelays)
            const mean = this.recentDelays.reduce((a, b) => a + b) / this.recentDelays.length
            const coefficientOfVariation = Math.sqrt(variance) / mean
            
            // 如果延迟过于规律（变异系数小），增加怀疑级别
            if (coefficientOfVariation < 0.3) {
                this.suspicionLevel = Math.min(1.0, this.suspicionLevel + 0.1)
            } else {
                this.suspicionLevel = Math.max(0.0, this.suspicionLevel - 0.05)
            }
        }
    }
    
    /**
     * 权重随机选择
     */
    private selectWeightedRandom<T>(items: Array<{ weight: number; generator: T }>): T {
        const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
        let randomWeight = Math.random() * totalWeight
        
        for (const item of items) {
            randomWeight -= item.weight
            if (randomWeight <= 0) {
                return item.generator
            }
        }
        
        return (items[0]?.generator || (() => 1000)) as T // fallback with type assertion
    }
    
    /**
     * 正态分布随机数
     */
    private normalRandom(mean: number, stdDev: number): number {
        // Box-Muller变换
        const u1 = Math.random()
        const u2 = Math.random()
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        return mean + z0 * stdDev
    }
    
    /**
     * 计算方差
     */
    private calculateVariance(numbers: number[]): number {
        const mean = numbers.reduce((a, b) => a + b) / numbers.length
        const squaredDiffs = numbers.map(n => Math.pow(n - mean, 2))
        return squaredDiffs.reduce((a, b) => a + b) / numbers.length
    }
    
    /**
     * 记录延迟
     */
    private recordDelay(delay: number): void {
        this.recentDelays.push(delay)
        if (this.recentDelays.length > 10) {
            this.recentDelays.shift()
        }
    }
    
    /**
     * 重置会话
     */
    resetSession(): void {
        this.sessionStartTime = Date.now()
        this.consecutiveFailures = 0
        this.suspicionLevel = Math.max(0, this.suspicionLevel - 0.2)
    }
    
    /**
     * 获取当前状态
     */
    getStatus(): { suspicionLevel: number; consecutiveFailures: number; sessionDuration: number; lastActivityTime: number } {
        return {
            suspicionLevel: this.suspicionLevel,
            consecutiveFailures: this.consecutiveFailures,
            sessionDuration: Date.now() - this.sessionStartTime,
            lastActivityTime: this.lastActivityTime
        }
    }
}
