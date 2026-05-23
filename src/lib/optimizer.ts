/**
 * 高级耗材顺序优化器
 *
 * 实现一系列复杂的优化算法，用于为多材料光刻画寻找最佳耗材排序。
 * 支持：
 * - 模拟退火（Simulated Annealing）：带温度调度的概率性全局优化
 * - 遗传算法（Genetic Algorithm）：基于种群的进化式优化
 * - 区域权重（Region Weighting）：优先考虑图像中的重要区域（如人脸、焦点）
 * - 确定性种子（Deterministic Seeding）：用于 A/B 测试的可复现结果
 * - 结果缓存（Result Caching）：跳过冗余计算
 */

import type { Filament } from '@/types';
import { rgbToLab, deltaELab, hexToRgb, blendColors, type RGB, type Lab } from './autoPaint';
// import { debugLog } from './debugLog';

// ============================================================================
// 类型定义
// ============================================================================

export interface OptimizerOptions
{
    algorithm: 'exhaustive' | 'simulated-annealing' | 'genetic' | 'auto';
    seed?: number; // 用于确定性结果
    maxIterations?: number; // 算法相关的迭代次数上限
    temperature?: number; // 模拟退火的初始温度
    coolingRate?: number; // 模拟退火的温度衰减率
    populationSize?: number; // 遗传算法的种群规模
    mutationRate?: number; // 遗传算法的变异概率
    eliteCount?: number; // 遗传算法中保留的精英个体数量
    regionWeights?: Float32Array; // 每像素重要性权重（0-1）
    cachingEnabled?: boolean; // 启用结果缓存
}

export interface OptimizerResult
{
    order: Filament[]; // 找到的最佳耗材排序
    score: number; // 质量分数（越低越好，基于 deltaE）
    iterations: number; // 已执行的迭代次数
    converged: boolean; // 算法是否已收敛
    cacheHit?: boolean; // 结果是否来自缓存
    resolvedAlgorithm?: string; // 实际使用的算法（'auto' 解析后的结果）
}

export interface ScoringContext
{
    imageColors: Array<Lab & { weight: number }>; // 来自图像的带权 Lab 颜色
    layerHeight: number;
    firstLayerHeight: number;
    regionWeights?: Float32Array; // 每像素重要性
}

// ============================================================================
// 确定性随机数生成器
// ============================================================================

/**
 * LCG（线性同余生成器），用于生成确定性的随机数。
 * 使用《Numerical Recipes》中的参数（a=1664525, c=1013904223, m=2^32）。
 */
class SeededRandom
{
    private state: number;

    constructor(seed: number = Date.now())
    {
        this.state = seed >>> 0; // 确保为无符号 32 位
    }

    /** 生成 [0, 1) 范围内的随机浮点数 */
    next(): number
    {
        this.state = (this.state * 1664525 + 1013904223) >>> 0;
        return this.state / 0x100000000;
    }

    /** 生成 [min, max) 范围内的随机整数 */
    nextInt(min: number, max: number): number
    {
        return Math.floor(this.next() * (max - min)) + min;
    }

    /** 使用 Fisher-Yates 算法对数组进行原地洗牌 */
    shuffle<T>(array: T[]): T[]
    {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--)
        {
            const j = this.nextInt(0, i + 1);
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
}

// ============================================================================
// 结果缓存
// ============================================================================

class OptimizerCache
{
    private cache = new Map<string, OptimizerResult>();
    private maxSize = 100;

    private getCacheKey(
        filaments: Filament[],
        context: ScoringContext,
        algorithm?: string,
        seed?: number
    ): string
    {
        // 根据耗材和上下文创建稳定的键
        const filamentKey = filaments
            .map((f) => `${f.color}:${f.td.toFixed(2)}`)
            .sort()
            .join('|');

        const imageKey = context.imageColors
            .slice(0, 20) // 抽取前 20 个颜色用于哈希
            .map((c) => `${c.L.toFixed(1)},${c.a.toFixed(1)},${c.b.toFixed(1)}`)
            .join('|');

        const algoKey = algorithm ?? 'auto';
        const seedKey = seed ?? 0;

        return `${filamentKey}__${imageKey}__${context.layerHeight}__${context.firstLayerHeight}__${algoKey}__${seedKey}`;
    }

    get(filaments: Filament[], context: ScoringContext, algorithm?: string, seed?: number): OptimizerResult | null
    {
        const key = this.getCacheKey(filaments, context, algorithm, seed);
        return this.cache.get(key) || null;
    }

    set(
        filaments: Filament[],
        context: ScoringContext,
        result: OptimizerResult,
        algorithm?: string,
        seed?: number
    ): void
    {
        const key = this.getCacheKey(filaments, context, algorithm, seed);

        // 容量已满时驱逐最旧的项
        if (this.cache.size >= this.maxSize)
        {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(key, result);
    }

    clear(): void
    {
        this.cache.clear();
    }

    get size(): number
    {
        return this.cache.size;
    }
}

const globalCache = new OptimizerCache();

// ============================================================================
// 评分函数
// ============================================================================

/**
 * 计算耗材排序的质量分数。
 * 分数越低 = 颜色还原效果越好。
 *
 * 分数为图像颜色与可达成混合颜色之间的加权 deltaE。
 */
function scoreFilamentOrder(
    filaments: Filament[],
    context: ScoringContext
): number
{
    if (filaments.length === 0) return Infinity;

    let totalError = 0;
    let totalWeight = 0;

    // 对每个图像颜色，使用此耗材堆栈寻找最佳可达成的匹配
    for (const targetColor of context.imageColors)
    {
        const achievableColor = findBestAchievableColor(targetColor, filaments, context);
        const error = deltaELab(targetColor, achievableColor);

        // 如有提供则应用区域权重
        totalError += error * targetColor.weight;
        totalWeight += targetColor.weight;
    }

    return totalWeight > 0 ? totalError / totalWeight : Infinity;
}

/**
 * 查找将耗材堆叠到某一高度时可达成的最佳颜色。
 * 使用 Beer-Lambert 模拟来预测不同高度下的混合颜色。
 * 
 * 此函数被foreach, 每个像素都调用一次
 */
function findBestAchievableColor(
    targetLab: Lab,
    filaments: Filament[],
    context: ScoringContext
): Lab
{
    if (filaments.length === 0) return { L: 0, a: 0, b: 0 };
    if (filaments.length === 1)
    {
        return rgbToLab(hexToRgb(filaments[0].color));
    }

    // 从底部到完整堆栈采样高度
    const maxHeight = filaments.reduce((sum, f) => sum + f.td * 3, 0); // 每种耗材约 3 倍 TD
    const steps = 20;
    let bestLab = rgbToLab(hexToRgb(filaments[0].color));
    let bestDelta = deltaELab(targetLab, bestLab);

    for (let i = 0; i <= steps; i++)
    {
        const height = (i / steps) * maxHeight;
        const blendedColor = simulateStackAtHeight(filaments, height, context);
        const blendedLab = rgbToLab(blendedColor);
        const delta = deltaELab(targetLab, blendedLab);

        if (delta < bestDelta)
        {
            bestDelta = delta;
            bestLab = blendedLab;
        }
    }

    return bestLab;
}

/**
 * 在给定高度模拟堆叠耗材的混合颜色。
 */
function simulateStackAtHeight(
    filaments: Filament[],
    targetHeight: number,
    _context: ScoringContext
): RGB
{
    let currentHeight = 0;
    let blendedColor = hexToRgb(filaments[0].color);

    for (let i = 1; i < filaments.length && currentHeight < targetHeight; i++)
    {
        const prevFilament = filaments[i - 1];
        const currentFilament = filaments[i];
        const transitionHeight = Math.min(prevFilament.td * 3, targetHeight - currentHeight);

        if (transitionHeight <= 0) break;

        const bgColor = blendedColor;
        const fgColor = hexToRgb(currentFilament.color);
        blendedColor = blendColors(bgColor, fgColor, currentFilament.td, transitionHeight);

        currentHeight += transitionHeight;
    }

    return blendedColor;
}

// ============================================================================
// 穷举搜索（最优解，但耗材数 > 8 时较慢）
// ============================================================================

function optimizeExhaustive(
    filaments: Filament[],
    context: ScoringContext
): OptimizerResult
{
    if (filaments.length === 0)
    {
        return {
            order: [],
            score: Infinity,
            iterations: 0,
            converged: true,
        };
    }

    if (filaments.length === 1)
    {
        return {
            order: [filaments[0]],
            score: scoreFilamentOrder(filaments, context),
            iterations: 1,
            converged: true,
        };
    }

    let bestOrder = filaments;
    let bestScore = scoreFilamentOrder(filaments, context);
    let iterations = 0;

    // 生成所有排列
    const permute = (arr: Filament[], start = 0): void =>
    {
        if (start === arr.length - 1)
        {
            iterations++;
            const score = scoreFilamentOrder(arr, context);
            if (score < bestScore)
            {
                bestScore = score;
                bestOrder = [...arr];
            }
            return;
        }

        for (let i = start; i < arr.length; i++)
        {
            [arr[start], arr[i]] = [arr[i], arr[start]];
            permute(arr, start + 1);
            [arr[start], arr[i]] = [arr[i], arr[start]];
        }
    };

    permute([...filaments]);

    return {
        order: bestOrder,
        score: bestScore,
        iterations,
        converged: true,
    };
}

// ============================================================================
// 模拟退火（在质量与速度之间取得良好平衡）
// ============================================================================

/**
 * 使用几何冷却调度的模拟退火优化器。
 *
 * 模拟退火是一种概率性技术，能够通过以概率 exp(-ΔE/T) 接受较差解（其中
 * T 随时间下降）来逃离局部最小值。
 */
function optimizeSimulatedAnnealing(
    filaments: Filament[],
    context: ScoringContext,
    options: OptimizerOptions
): OptimizerResult
{
    if (filaments.length <= 1)
    {
        return optimizeExhaustive(filaments, context);
    }

    const rng = new SeededRandom(options.seed);
    const maxIterations = options.maxIterations ?? Math.max(1000, filaments.length * 100);
    const initialTemp = options.temperature ?? 100.0;
    const coolingRate = options.coolingRate ?? 0.995;
    const minTemp = 0.01;

    let currentOrder = rng.shuffle(filaments);
    let currentScore = scoreFilamentOrder(currentOrder, context);
    let bestOrder = [...currentOrder];
    let bestScore = currentScore;
    let temperature = initialTemp;
    let iterations = 0;

    while (iterations < maxIterations && temperature > minTemp)
    {
        iterations++;

        // 通过交换两个随机耗材生成邻居
        const newOrder = [...currentOrder];
        const i = rng.nextInt(0, newOrder.length);
        const j = rng.nextInt(0, newOrder.length);
        [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];

        const newScore = scoreFilamentOrder(newOrder, context);
        const deltaE = newScore - currentScore;

        // 如果更优则接受，否则以 exp(-ΔE/T) 的概率接受
        const acceptProbability = deltaE < 0 ? 1.0 : Math.exp(-deltaE / temperature);

        if (rng.next() < acceptProbability)
        {
            currentOrder = newOrder;
            currentScore = newScore;

            if (currentScore < bestScore)
            {
                bestScore = currentScore;
                bestOrder = [...currentOrder];
            }
        }

        temperature *= coolingRate;
    }

    // 收敛检查：是否已稳定？
    const converged = temperature <= minTemp || iterations >= maxIterations;

    return {
        order: bestOrder,
        score: bestScore,
        iterations,
        converged,
    };
}

// ============================================================================
// 遗传算法（适用于大规模搜索空间）
// ============================================================================

/**
 * 带精英保留和锦标赛选择的遗传算法优化器。
 *
 * 维护一个候选解种群，通过选择、交叉和变异使其进化。
 */
function optimizeGenetic(
    filaments: Filament[],
    context: ScoringContext,
    options: OptimizerOptions
): OptimizerResult
{
    if (filaments.length <= 1)
    {
        return optimizeExhaustive(filaments, context);
    }

    //options.seed
    const tmpseed: number = 123456; //临时hack
    const rng = new SeededRandom(tmpseed);
    const populationSize = options.populationSize ?? Math.max(50, filaments.length * 10);
    const maxGenerations = options.maxIterations ?? 100; // 每代评估的总迭代次数上限
    const mutationRate = options.mutationRate ?? 0.1;
    const eliteCount = options.eliteCount ?? Math.max(2, Math.floor(populationSize * 0.1)); // 保留10%的精英

    // 诊断：打印 GA 入口的 inventory 顺序与配置（用于和 CPP 端对齐 diff）
    // if (import.meta.env.DEV) {
    //     debugLog('---->打印GA-inventory');
    //     const invLines = filaments
    //         .map((f, i) => `---->[${i}] color=${f.color.toLowerCase()}, td=${f.td.toFixed(6)}`)
    //         .join('\n');
    //     debugLog(`---->GA inventory count=${filaments.length}\n${invLines}`);
    //     debugLog('---->打印GA-config');
    //     debugLog(
    //         `---->GA config populationSize=${populationSize}, maxGenerations=${maxGenerations}, mutationRate=${mutationRate.toFixed(6)}, eliteCount=${eliteCount}`
    //     );
    // }

    // 使用随机排序初始化种群
    let population: Array<{ order: Filament[]; score: number }> = [];
    for (let i = 0; i < populationSize; i++)
    {
        const order = rng.shuffle(filaments);
        const score = scoreFilamentOrder(order, context);
        population.push({ order, score });
    }

    // 诊断：打印初始种群前 5 个个体（order 用 inventory 索引序列）
    // if (import.meta.env.DEV) {
    //     debugLog('---->打印GA-init-pop');
    //     const dump = Math.min(population.length, 5);
    //     const lines: string[] = [`---->GA init pop dump=${dump}/${population.length}`];
    //     for (let i = 0; i < dump; i++) {
    //         const ind = population[i];
    //         const idx = ind.order.map((f) => filaments.indexOf(f)).join(',');
    //         lines.push(`---->[${i}] order=${idx}, score=${ind.score.toFixed(6)}`);
    //     }
    //     debugLog(lines.join('\n'));
    // }

    let bestEver = { ...population[0] };
    let generations = 0;
    let stagnantGenerations = 0;
    const maxStagnant = 20; // 如果连续 20 代没有改进则认为收敛

    // 诊断：累积每代的最优 score（用于和 CPP 端对齐 diff，定位分叉代）
    // const genTrace: string[] = [];

    while (generations < maxGenerations && stagnantGenerations < maxStagnant)
    {
        generations++;

        // 按分数排序（越低越好）
        population.sort((a, b) => a.score - b.score);

        // 检查是否有改进
        if (population[0].score < bestEver.score)
        {
            bestEver = { order: [...population[0].order], score: population[0].score };
            stagnantGenerations = 0;
        }
        else
        {
            stagnantGenerations++;
        }

        // 诊断：记录本代最优 score 与历史最优 score
        // if (import.meta.env.DEV) {
        //     genTrace.push(
        //         `---->[gen=${generations}] sortedBest=${population[0].score.toFixed(6)}, bestEver=${bestEver.score.toFixed(6)}, stagnant=${stagnantGenerations}`
        //     );
        // }

        // 精英保留：保留最优个体
        const nextGeneration = population.slice(0, eliteCount).map((ind) => ({
            order: [...ind.order],
            score: ind.score,
        }));

        // 生成后代
        while (nextGeneration.length < populationSize)
        {
            // 锦标赛选择：随机选 3 个，挑选最优者
            const parent1 = tournamentSelect(population, 3, rng);
            const parent2 = tournamentSelect(population, 3, rng);

            // 顺序交叉（OX）
            const child = orderCrossover(parent1.order, parent2.order, rng);

            // 变异：以一定概率交换两个位置
            if (rng.next() < mutationRate)
            {
                const i = rng.nextInt(0, child.length);
                const j = rng.nextInt(0, child.length);
                [child[i], child[j]] = [child[j], child[i]];
            }

            const score = scoreFilamentOrder(child, context);
            nextGeneration.push({ order: child, score });
        }

        population = nextGeneration;
    }

    // 诊断：一次性 flush 每代轨迹（避免每代 fetch 一次写文件）
    // if (import.meta.env.DEV) {
    //     debugLog('---->打印GA-gen-trace');
    //     debugLog(`---->GA gen-trace count=${genTrace.length}\n${genTrace.join('\n')}`);
    // }

    return {
        order: bestEver.order,
        score: bestEver.score,
        iterations: generations,
        converged: stagnantGenerations >= maxStagnant,
    };
}

/**
 * 锦标赛选择：随机选取 k 个个体，返回其中最优者
 */
function tournamentSelect(
    population: Array<{ order: Filament[]; score: number }>,
    tournamentSize: number,
    rng: SeededRandom
): { order: Filament[]; score: number }
{
    let best = population[rng.nextInt(0, population.length)];

    for (let i = 1; i < tournamentSize; i++)
    {
        const candidate = population[rng.nextInt(0, population.length)];
        if (candidate.score < best.score)
        {
            best = candidate;
        }
    }

    return { order: [...best.order], score: best.score };
}

/**
 * 顺序交叉（OX）：保留来自双亲的相对顺序
 */
function orderCrossover(
    parent1: Filament[],
    parent2: Filament[],
    rng: SeededRandom
): Filament[]
{
    const length = parent1.length;
    const start = rng.nextInt(0, length);
    const end = rng.nextInt(start + 1, length + 1);

    // 从 parent1 复制片段
    const child: (Filament | null)[] = new Array(length).fill(null);
    for (let i = start; i < end; i++)
    {
        child[i] = parent1[i];
    }

    // 从 parent2 填充其余部分，保留顺序
    const remaining = parent2.filter((f) => !child.includes(f));
    let remainingIdx = 0;

    for (let i = 0; i < length; i++)
    {
        if (child[i] === null)
        {
            child[i] = remaining[remainingIdx++];
        }
    }

    return child as Filament[];
}

// ============================================================================
// 主优化器接口
// ============================================================================

/**
 * 使用指定算法优化耗材排序。
 *
 * @param filaments - 待排序的耗材
 * @param context - 评分上下文（图像颜色、层高）
 * @param options - 优化器配置
 * @returns 找到的最佳排序及其质量分数
 */
export function optimizeFilamentOrder(
    filaments: Filament[],
    context: ScoringContext,
    options: Partial<OptimizerOptions> = {}
): OptimizerResult
{
    // 判断用户是否提供了显式种子（用于缓存目的）
    const hasExplicitSeed = options.seed !== undefined;

    const opts: OptimizerOptions = {
        algorithm: 'auto',
        seed: Date.now(),
        cachingEnabled: true,
        ...options,
    };

    // 根据问题规模自动选择算法（在缓存检查之前）
    let algorithm = opts.algorithm;
    if (algorithm === 'auto')
    {
        if (filaments.length <= 6)
        {
            algorithm = 'exhaustive';
        }
        else if (filaments.length <= 10)
        {
            algorithm = 'simulated-annealing';
        }
        else
        {
            algorithm = 'genetic';
        }
    }

    // 仅当用户提供了显式种子时才检查缓存（随机种子不应被缓存）
    if (opts.cachingEnabled && hasExplicitSeed)
    {
        const cached = globalCache.get(filaments, context, algorithm, opts.seed);
        if (cached)
        {
            return { ...cached, cacheHit: true };
        }
    }

    let result: OptimizerResult;

    switch (algorithm)
    {
        case 'exhaustive':
            result = optimizeExhaustive(filaments, context);
            break;
        case 'simulated-annealing':
            result = optimizeSimulatedAnnealing(filaments, context, opts);
            break;
        case 'genetic':
            result = optimizeGenetic(filaments, context, opts);
            break;
        default:
            throw new Error(`Unknown algorithm: ${algorithm}`);
    }

    // 用解析后的算法标记结果
    result.resolvedAlgorithm = algorithm;

    // 仅当用户提供了显式种子时才缓存（不缓存随机结果）
    if (opts.cachingEnabled && hasExplicitSeed)
    {
        globalCache.set(filaments, context, result, algorithm, opts.seed);
    }

    return result;
}

/**
 * 清空优化器缓存
 */
export function clearOptimizerCache(): void
{
    globalCache.clear();
}

/**
 * 获取优化器缓存的统计信息
 */
export function getOptimizerCacheStats(): { size: number; maxSize: number }
{
    return {
        size: globalCache.size,
        maxSize: 100,
    };
}
