/**
 * 耗材上色自动算法（类 HueForge 风格的光刻图）
 *
 * 本模块基于比尔-朗伯定律，为多耗材光刻图打印实现了
 * 一套在物理上精确的光学仿真。
 *
 * 核心概念：
 * 1. 过渡区（TRANSITION ZONES）：每种耗材都需要足够的垂直空间，
 *    才能从前一种颜色完全过渡到其纯色。
 * 2. 累积高度（CUMULATIVE HEIGHT）：总高度 = 所有过渡区之和。
 * 3. 压缩（COMPRESSION）：如果用户设置的最大高度低于理想高度，
 *    则压缩各过渡区。
 * 4. 亮度映射（LUMINANCE MAPPING）：图像像素亮度映射到过渡区内的位置。
 * 5. 增强颜色匹配（ENHANCED COLOR MATCHING）：通过评估所有排列组合
 *    来优化耗材顺序，以获得最佳颜色还原（基于 DeltaE）。
 * 6. 重复换料（REPEATED SWAPS）：允许同一耗材在栈中多次出现，
 *    以产生中间混合色（例如：红色上覆盖薄白色 = 粉色）。
 */

import type { Filament } from '../types';
import {
    optimizeFilamentOrder,
    type OptimizerOptions,
    type OptimizerResult,
    type ScoringContext,
} from './optimizer';
import { generateCenterWeightedMapSimple, generateEdgeWeightedMapSimple } from './regionWeighting';
import { computeProfileConfidence } from './calibration';
import { debugLog } from './debugLog';

/** RGB 颜色表示（0-255 范围） */
export interface RGB {
    r: number;
    g: number;
    b: number;
}

/** Lab 颜色表示，用于感知颜色差异 */
export interface Lab {
    L: number;
    a: number;
    b: number;
}

/** 带频率权重的 Lab 颜色（0-1，已归一化） */
interface WeightedLab extends Lab {
    weight: number;
}

/** 两种耗材之间的过渡区 */
export interface TransitionZone {
    filamentId: string;
    filamentColor: string;
    filamentTd: number; // 该耗材的透射距离 (TD)
    startHeight: number; // 距 Z=0 的毫米数
    endHeight: number; // 距 Z=0 的毫米数
    idealThickness: number; // 未压缩的区域厚度
    actualThickness: number; // 压缩后的厚度
}

/** 自动上色算法生成的层段 */
export interface AutoPaintLayer {
    filamentId: string;
    filamentColor: string;
    startHeight: number; // 距 Z=0 的毫米数
    endHeight: number; // 距 Z=0 的毫米数
}

/** 自动上色生成器的结果 */
export interface AutoPaintResult {
    layers: AutoPaintLayer[];
    totalHeight: number;
    idealHeight: number; // 不进行压缩时的理想高度
    autoHeight: number; // 用户未设置最大高度时使用的默认高度
    compressionRatio: number; // 1.0 = 无压缩，0.5 = 压缩 50%
    filamentOrder: string[]; // 耗材 ID 顺序（由暗到亮）
    transitionZones: TransitionZone[]; // 详细的过渡区信息
    // 置信度指标
    confidence: number; // 总体置信度评分（0-1）
    confidenceFactors: {
        calibrationQuality: number; // 0-1：耗材标定质量
        filamentCoverage: number; // 0-1：耗材覆盖图像颜色的程度
        compressionImpact: number; // 0-1：高度压缩的影响
    };
    // 优化器元数据（仅适用于高级优化器）
    optimizerMetadata?: {
        algorithm: string; // 'exhaustive' | 'simulated-annealing' | 'genetic'
        score: number; // 取得的质量评分
        iterations: number; // 执行的迭代次数
        converged: boolean; // 算法是否收敛
        cacheHit: boolean; // 结果是否来自缓存
    };
}

// =============================================================================
// 颜色转换工具
// =============================================================================

/**
 * 将十六进制颜色转换为 RGB
 */
export function hexToRgb(hex: string): RGB {
    const h = hex.replace(/^#/, '');
    return {
        r: parseInt(h.slice(0, 2), 16) || 0,
        g: parseInt(h.slice(2, 4), 16) || 0,
        b: parseInt(h.slice(4, 6), 16) || 0,
    };
}

/**
 * 将 RGB 转换为十六进制
 */
export function rgbToHex(rgb: RGB): string {
    const toHex = (n: number) =>
        Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * 将 RGB（0-255）转换到 Lab 色彩空间，用于感知颜色差异计算
 */
export function rgbToLab(rgb: RGB): Lab {
    // 首先将 RGB 转换为 XYZ
    let r = rgb.r / 255;
    let g = rgb.g / 255;
    let b = rgb.b / 255;

    // sRGB 伽马校正
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    r *= 100;
    g *= 100;
    b *= 100;

    // RGB 转 XYZ（D65 光源）
    const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

    // XYZ 转 Lab（D65 参考白）
    const refX = 95.047;
    const refY = 100.0;
    const refZ = 108.883;

    let xr = x / refX;
    let yr = y / refY;
    let zr = z / refZ;

    const epsilon = 0.008856;
    const kappa = 903.3;

    xr = xr > epsilon ? Math.cbrt(xr) : (kappa * xr + 16) / 116;
    yr = yr > epsilon ? Math.cbrt(yr) : (kappa * yr + 16) / 116;
    zr = zr > epsilon ? Math.cbrt(zr) : (kappa * zr + 16) / 116;

    return {
        L: 116 * yr - 16,
        a: 500 * (xr - yr),
        b: 200 * (yr - zr),
    };
}

/**
 * 计算 Delta E（CIE76）—— 感知颜色差异。
 * DeltaE < 1 通常人眼难以察觉。
 * DeltaE < 2.3 被认为是"刚好可察觉的差异"。
 */
export function deltaE(color1: RGB, color2: RGB): number {
    const lab1 = rgbToLab(color1);
    const lab2 = rgbToLab(color2);

    return deltaELab(lab1, lab2);
}

/**
 * 直接根据 Lab 值计算 Delta E（CIE76）
 */
export function deltaELab(lab1: Lab, lab2: Lab): number {
    return Math.sqrt(
        Math.pow(lab1.L - lab2.L, 2) + Math.pow(lab1.a - lab2.a, 2) + Math.pow(lab1.b - lab2.b, 2)
    );
}

/**
 * 根据 RGB 值计算感知亮度。
 * 使用标准的 sRGB 亮度系数。
 *
 * @param color - RGB 颜色（0-255 范围）
 * @returns 亮度值（0-255 范围）
 */
export function getLuminance(color: RGB): number {
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

// =============================================================================
// 光学混合（比尔-朗伯定律）
// =============================================================================

/**
 * 使用比尔-朗伯定律，计算在已有背景颜色上叠加一层
 * 半透明耗材后所产生的颜色。
 *
 * 透射率公式为：T = 0.1^(thickness/TD)
 * 当 thickness == TD 时，透射率为 10%（这是耗材 TD 的定义）。
 *
 * @param backgroundColor - 已有叠层的颜色
 * @param filamentColor - 正在添加的耗材颜色
 * @param filamentTD - 耗材的透射距离（毫米）
 * @param layerThickness - 该耗材层的厚度（毫米）
 * @returns 混合后的最终颜色
 */
export function blendColors(
    backgroundColor: RGB,
    filamentColor: RGB,
    filamentTD: number,
    layerThickness: number
): RGB {
    // 防止除零或非法 TD 值
    if (filamentTD <= 0 || layerThickness <= 0) {
        return filamentColor;
    }

    // 比尔-朗伯定律：transmission = 10^(-thickness/TD)
    // 当 thickness == TD 时，transmission = 10^(-1) = 0.1（10%）
    const transmission = Math.pow(0.1, layerThickness / filamentTD);

    // 不透明度是透射率的反值
    const opacity = 1 - transmission;

    // 线性插值（简单的 RGB 混合）
    return {
        r: filamentColor.r * opacity + backgroundColor.r * transmission,
        g: filamentColor.g * opacity + backgroundColor.g * transmission,
        b: filamentColor.b * opacity + backgroundColor.b * transmission,
    };
}

/**
 * 计算给定厚度下耗材层的不透明度。
 *
 * @param filamentTD - 透射距离（毫米）
 * @param thickness - 层厚（毫米）
 * @returns 不透明度（0-1）
 */
export function getOpacity(filamentTD: number, thickness: number): number {
    if (filamentTD <= 0 || thickness <= 0) return 0;
    const transmission = Math.pow(0.1, thickness / filamentTD);
    return 1 - transmission;
}

// =============================================================================
// 过渡区计算
// =============================================================================

/**
 * 判定颜色过渡"完成"的 DeltaE 阈值。
 * 低于该值时，混合后的颜色与目标纯耗材色
 * 在感知上无法区分。
 */
const DELTA_E_THRESHOLD = 2.3; // "刚好可察觉的差异"

/**
 * 前光照明的打印件在光学上等效于一个更小的有效 TD。
 * 在内部仿真时将用户输入的 TD 值按比例缩小。
 */
const FRONTLIT_TD_SCALE = 0.1;

/**
 * 模拟逐层添加耗材，直到混合后的颜色与目标纯耗材色相匹配
 * （DeltaE < 阈值），或耗材已基本不透明（达到不透明度阈值）。
 *
 * @param backgroundColor - 起始背景颜色
 * @param filamentColor - 目标耗材颜色
 * @param filamentTD - 耗材的透射距离
 * @param layerHeight - 物理层高增量
 * @returns 完成过渡所需的厚度
 */
export function calculateTransitionThickness(
    backgroundColor: RGB,
    filamentColor: RGB,
    filamentTD: number,
    layerHeight: number
): number {
    // 如果颜色已经足够接近，则提前退出
    if (deltaE(backgroundColor, filamentColor) < DELTA_E_THRESHOLD) {
        return layerHeight; // 仍然至少需要一层
    }

    let thickness = 0;
    let currentColor = backgroundColor;

    // 该上限决定了过渡区的最大厚度。
    // 在 0.7×TD 处，不透明度约为 80%；在 1×TD 处，不透明度约为 90%。
    // 在排序后的栈中，相邻颜色之间的过渡通常远在该上限之前
    // 就会达到 DeltaE 收敛。
    // 我们使用 0.7×TD —— 如果颜色在约 80% 不透明度时仍未收敛，
    // 再增加厚度对视觉效果的提升也越来越有限。
    const OPACITY_CAP = 0.7;
    const maxThickness = Math.max(layerHeight, filamentTD * OPACITY_CAP);

    // 模拟逐层添加，直到颜色收敛或达到上限
    while (thickness < maxThickness) {
        thickness += layerHeight;
        currentColor = blendColors(backgroundColor, filamentColor, filamentTD, thickness);

        // 如果混合颜色已感知接近目标色，则停止
        if (deltaE(currentColor, filamentColor) < DELTA_E_THRESHOLD) {
            break;
        }

        // 如果不透明度已经很高，也停止 —— 收益递减
        if (getOpacity(filamentTD, thickness) > 0.85) {
            break;
        }
    }

    // 对齐到 layerHeight 网格
    return Math.min(thickness, maxThickness);
}

/**
 * 基于累积过渡区计算理想模型高度。
 *
 * 该函数模拟从最暗到最亮耗材的整个堆栈，
 * 计算每次过渡所需的垂直空间。
 *
 * @param sortedFilaments - 已按由暗到亮排序的耗材
 * @param layerHeight - 物理层高
 * @param baseThickness - 第一层（最暗层）的最小厚度
 * @returns 包含理想高度和分区明细的对象
 */
export function calculateIdealHeight(
    sortedFilaments: Array<{ id: string; color: string; td: number }>,
    layerHeight: number,
    baseThickness: number = 0.6
): { idealHeight: number; zones: TransitionZone[] } {
    if (sortedFilaments.length === 0) {
        return { idealHeight: baseThickness, zones: [] };
    }

    const zones: TransitionZone[] = [];
    let currentHeight = 0;
    let currentBackgroundColor = hexToRgb(sortedFilaments[0].color);

    // 区域 1：基础层（最暗的耗材）
    // 必须足够不透明以阻挡背光。
    // 由比尔-朗伯定律：要 95% 不透明度 → 透射率 = 5%
    //   0.05 = 10^(-thickness/TD)  →  thickness = TD × log10(20) ≈ TD × 1.3
    // 暗色耗材 TD 较低（如 0.5mm）→ 基础层 ≈ 0.65mm
    const firstFilament = sortedFilaments[0];
    const opacityThickness = firstFilament.td * 1.3; // 95% 不透明
    // 至少保证基础厚度（避免不必要的额外层）
    const foundationThickness = Math.max(baseThickness, opacityThickness);

    zones.push({
        filamentId: firstFilament.id,
        filamentColor: firstFilament.color,
        filamentTd: firstFilament.td,
        startHeight: 0,
        endHeight: foundationThickness,
        idealThickness: foundationThickness,
        actualThickness: foundationThickness,
    });
    currentHeight = foundationThickness;

    // 后续区域：每种耗材都从前一种过渡而来
    for (let i = 1; i < sortedFilaments.length; i++) {
        const filament = sortedFilaments[i];
        const filamentRgb = hexToRgb(filament.color);

        // 计算该区域所需的厚度
        const transitionThickness = calculateTransitionThickness(
            currentBackgroundColor,
            filamentRgb,
            filament.td,
            layerHeight
        );

        zones.push({
            filamentId: filament.id,
            filamentColor: filament.color,
            filamentTd: filament.td,
            startHeight: currentHeight,
            endHeight: currentHeight + transitionThickness,
            idealThickness: transitionThickness,
            actualThickness: transitionThickness,
        });

        // 更新下次迭代所需的背景信息
        currentBackgroundColor = filamentRgb;
        currentHeight += transitionThickness;
    }

    return { idealHeight: currentHeight, zones };
}

/**
 * 当超过最大高度时，对过渡区进行压缩。
 *
 * @param zones - 原始的过渡区数组
 * @param maxHeight - 用户的最大高度约束
 * @returns 压缩后的过渡区及压缩比
 */
export function compressZones(
    zones: TransitionZone[],
    maxHeight: number
): { compressedZones: TransitionZone[]; compressionRatio: number } {
    if (zones.length === 0) {
        return { compressedZones: [], compressionRatio: 1 };
    }

    const idealHeight = zones[zones.length - 1].endHeight;

    if (idealHeight <= maxHeight) {
        // 无需压缩
        return { compressedZones: zones, compressionRatio: 1 };
    }

    const compressionRatio = maxHeight / idealHeight;

    // 对所有区域应用统一压缩
    const compressedZones: TransitionZone[] = [];
    let currentHeight = 0;

    for (const zone of zones) {
        const compressedThickness = zone.idealThickness * compressionRatio;
        compressedZones.push({
            ...zone,
            startHeight: currentHeight,
            endHeight: currentHeight + compressedThickness,
            actualThickness: compressedThickness,
        });
        currentHeight += compressedThickness;
    }

    return { compressedZones, compressionRatio };
}

// =============================================================================
// 图像颜色分析
// =============================================================================

/**
 * 将图像色块聚合为更小的一组带权代表色。
 *
 * 在 Lab 空间中使用贪心层次聚类：
 * 1. 将所有色块转为 Lab，按频率降序排列
 * 2. 对每个色块，若 DeltaE < 阈值，则合并到最近的现有簇中；
 *    否则新建一个簇
 * 3. 簇心是其成员的加权平均
 * 4. 归一化权重，使其总和为 1.0
 *
 * 这能将数千种独特的图像颜色压缩为约 20-40 个代表性目标，
 * 并按图像中各颜色区域的覆盖比例进行加权。
 * 这样既加快了评分速度，又使优化更智能 ——
 * 主要的图像颜色权重更高，从而主导耗材选择。
 *
 * @param swatches - 图像颜色及可选的像素计数
 * @param maxClusters - 产生的最大簇数（默认为 32）
 * @param threshold - DeltaE 合并阈值（默认为 5.0）
 * @returns 带权 Lab 目标色，权重之和归一化为 1.0
 */
function clusterImageColors(
    swatches: Array<{ hex: string; count?: number }>,
    maxClusters: number = 32,
    threshold: number = 5.0
): WeightedLab[] {
    if (swatches.length === 0) return [];

    // 转换为带计数的 Lab
    const items = swatches.map((s) => ({
        hex: s.hex.toLowerCase(),
        lab: rgbToLab(hexToRgb(s.hex)),
        count: s.count ?? 1,
    }));

    {
        // 诊断日志：输出每个 swatch 的 hex → Lab 转换结果，按 hex 字典序排列以便和 CPP 对齐 diff
        // if (import.meta.env.DEV) {
        //     debugLog('---->打印rgbToLab转换');
        //     const lines = [...items]
        //         .sort((a, b) => a.hex.localeCompare(b.hex))
        //         .map(
        //             (x) =>
        //                 `---->${x.hex} -> L=${x.lab.L.toFixed(6)}, a=${x.lab.a.toFixed(6)}, b=${x.lab.b.toFixed(6)}, count=${x.count}`
        //         )
        //         .join('\n');
        //     debugLog(`---->lab count=${items.length}\n${lines}`);
        // }
    }

    // 按 (count 降序, hex 升序) 排序 —— 与 CPP 端一致以确保聚类合并路径 deterministic
    items.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0;
    });

    // 贪心聚类
    const clusters: Array<{
        L: number;
        a: number;
        b: number;
        totalCount: number;
    }> = [];

    const thresholdSq = threshold * threshold;

    for (const item of items) {
        // 找到最近的已有簇
        let bestIdx = -1;
        let bestDeSq = Infinity;

        for (let ci = 0; ci < clusters.length; ci++) {
            const c = clusters[ci];
            const deSq =
                (item.lab.L - c.L) ** 2 + (item.lab.a - c.a) ** 2 + (item.lab.b - c.b) ** 2;
            if (deSq < bestDeSq) {
                bestDeSq = deSq;
                bestIdx = ci;
            }
        }

        if (bestIdx >= 0 && bestDeSq < thresholdSq) {
            // 并入已有簇（加权更新簇心）
            const c = clusters[bestIdx];
            const total = c.totalCount + item.count;
            const w1 = c.totalCount / total;
            const w2 = item.count / total;
            c.L = c.L * w1 + item.lab.L * w2;
            c.a = c.a * w1 + item.lab.a * w2;
            c.b = c.b * w1 + item.lab.b * w2;
            c.totalCount = total;
        }
        else if (clusters.length < maxClusters) {
            // 新建簇
            clusters.push({
                L: item.lab.L,
                a: item.lab.a,
                b: item.lab.b,
                totalCount: item.count,
            });
        }
        else {
            // 已达到最大簇数 —— 强制并入最近的簇
            if (bestIdx >= 0) {
                const c = clusters[bestIdx];
                const total = c.totalCount + item.count;
                const w1 = c.totalCount / total;
                const w2 = item.count / total;
                c.L = c.L * w1 + item.lab.L * w2;
                c.a = c.a * w1 + item.lab.a * w2;
                c.b = c.b * w1 + item.lab.b * w2;
                c.totalCount = total;
            }
        }
    }

    // 将权重归一化为总和 1.0
    const totalPixels = clusters.reduce((s, c) => s + c.totalCount, 0);
    if (totalPixels === 0) return [];

    return clusters.map((c) => ({
        L: c.L,
        a: c.a,
        b: c.b,
        weight: c.totalCount / totalPixels,
    }));
}

// =============================================================================
// 增强颜色匹配 —— 排序优化
// =============================================================================

/**
 * 生成数组的所有非空子集。
 * 对于 N 个元素，会产生 2^N - 1 个子集。
 */
function nonEmptySubsets<T>(arr: T[]): T[][] {
    const result: T[][] = [];
    const n = arr.length;
    for (let mask = 1; mask < 1 << n; mask++) {
        const subset: T[] = [];
        for (let i = 0; i < n; i++) {
            if (mask & (1 << i)) subset.push(arr[i]);
        }
        result.push(subset);
    }
    return result;
}

/**
 * 生成数组的所有排列。
 * 仅当 array.length <= 7（最多 5040 种排列）时使用。
 */
function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const perm of permutations(rest)) {
            result.push([arr[i], ...perm]);
        }
    }
    return result;
}

/**
 * 为给定的耗材序列构建可达颜色调色板。
 *
 * 沿堆栈在每个层高步进处模拟比尔-朗伯混合后的颜色，
 * 并返回 { height, color } 数组。
 *
 * @param sequence - 有序的耗材序列（可包含重复）
 * @param layerHeight - 物理层高
 * @param firstLayerHeight - 首层层高
 * @returns 每个层步对应的 { height, lab, rgb } 数组
 */
function buildAchievableColorPalette(
    sequence: Array<{ id: string; color: string; td: number }>,
    layerHeight: number,
    firstLayerHeight: number
): Array<{ height: number; lab: Lab; rgb: RGB }> {
    if (sequence.length === 0) return [];

    // 计算该序列对应的过渡区
    const { zones } = calculateIdealHeight(
        sequence.map((f) => ({ id: f.id, color: f.color, td: f.td })),
        layerHeight,
        Math.max(firstLayerHeight, layerHeight)
    );

    if (zones.length === 0) return [];

    const totalHeight = zones[zones.length - 1].endHeight;
    const palette: Array<{ height: number; lab: Lab; rgb: RGB }> = [];

    let currentZ = 0;
    let layerIndex = 0;
    let prevZoneIndex = 0;
    let thicknessInCurrentZone = 0;

    while (currentZ < totalHeight + layerHeight * 0.5) {
        const thickness = layerIndex === 0 ? Math.max(firstLayerHeight, layerHeight) : layerHeight;

        // 找出当前活动的过渡区
        let activeZoneIndex = 0;
        for (let zi = 0; zi < zones.length; zi++) {
            if (currentZ >= zones[zi].startHeight && currentZ < zones[zi].endHeight) {
                activeZoneIndex = zi;
                break;
            }
            if (currentZ >= zones[zi].startHeight) {
                activeZoneIndex = zi;
            }
        }

        if (activeZoneIndex !== prevZoneIndex) {
            thicknessInCurrentZone = currentZ - zones[activeZoneIndex].startHeight + thickness;
            prevZoneIndex = activeZoneIndex;
        }
        else {
            thicknessInCurrentZone += thickness;
        }

        const zone = zones[activeZoneIndex];
        const filamentColor = hexToRgb(zone.filamentColor);

        let blendedColor: RGB;
        if (activeZoneIndex === 0) {
            blendedColor = filamentColor;
        }
        else {
            const bgColor = hexToRgb(zones[activeZoneIndex - 1].filamentColor);
            blendedColor = blendColors(
                bgColor,
                filamentColor,
                zone.filamentTd,
                thicknessInCurrentZone
            );
        }

        palette.push({
            height: currentZ + thickness,
            lab: rgbToLab(blendedColor),
            rgb: blendedColor,
        });

        currentZ += thickness;
        layerIndex++;

        if (layerIndex > 500) break;
    }

    return palette;
}

/**
 * 通过将 DeltaE 阈值范围内连续的颜色项折叠合并，
 * 对调色板进行去重。每个簇用其中点高度表示，
 * 从而获得最佳的高度分布。
 */
function deduplicatePalette(
    palette: Array<{ height: number; lab: Lab; rgb: RGB }>,
    threshold: number = 3.0
): Array<{ height: number; lab: Lab; rgb: RGB }> {
    if (palette.length === 0) return [];

    const result: Array<{ height: number; lab: Lab; rgb: RGB }> = [];
    let clusterStart = 0;

    for (let i = 1; i <= palette.length; i++) {
        const prev = palette[i - 1];
        const curr = i < palette.length ? palette[i] : null;

        const shouldBreak =
            !curr ||
            Math.sqrt(
                (curr.lab.L - prev.lab.L) ** 2 +
                (curr.lab.a - prev.lab.a) ** 2 +
                (curr.lab.b - prev.lab.b) ** 2
            ) >= threshold;

        if (shouldBreak) {
            // 使用该簇的中点项
            const midIdx = Math.floor((clusterStart + (i - 1)) / 2);
            result.push(palette[midIdx]);
            clusterStart = i;
        }
    }

    return result;
}

/**
 * 根据带权图像目标颜色对耗材序列进行评分。
 *
 * 评分综合考虑：
 * 1. 加权颜色精度 —— 对每个目标取最小 DeltaE × 权重。
 *    主要图像颜色对评分贡献更大，因此优化器会优先选择
 *    能最准确还原最常见颜色的耗材排序。
 * 2. 高度分布 —— 当不同图像颜色被压缩到同一高度
 *    （导致表面平坦）时进行惩罚。
 * 3. 总层数 —— 对调色板的原始层数进行惩罚。
 *    这会惩罚在差异较大颜色之间存在昂贵过渡的序列
 *    （例如 黄→紫 需要很多层过渡，而 黄→橙 则很快）。
 *    层数越多 = 模型越高。
 * 4. 过渡浪费 —— 对那些不能很好匹配任何目标色的调色板项进行惩罚。
 *    这些是"浪费"的中间过渡层，仅作为过渡存在，
 *    对图像本身没有贡献有用的颜色。
 */
function scoreSequenceAgainstImage(
    palette: Array<{ height: number; lab: Lab; rgb: RGB }>,
    imageTargets: WeightedLab[]
): number {
    if (palette.length === 0) return Infinity;

    // 去重：折叠连续的几乎相同的颜色
    const reduced = deduplicatePalette(palette, 3.0);
    if (reduced.length === 0) return Infinity;

    // 1. 加权颜色精度：对每个目标计算 (最小 DeltaE × 权重) 之和
    let weightedDeltaE = 0;
    const bestMatchHeights: number[] = [];

    // 同时跟踪哪些去重后的调色板项被某个目标使用了（"有用的"）
    const usedPaletteEntries = new Set<number>();

    for (const target of imageTargets) {
        let minDE = Infinity;
        let bestHeight = reduced[0].height;
        let bestIdx = 0;
        for (let ri = 0; ri < reduced.length; ri++) {
            const entry = reduced[ri];
            const de = Math.sqrt(
                (entry.lab.L - target.L) ** 2 +
                (entry.lab.a - target.a) ** 2 +
                (entry.lab.b - target.b) ** 2
            );
            if (de < minDE) {
                minDE = de;
                bestHeight = entry.height;
                bestIdx = ri;
                if (de < 0.5) break;
            }
        }
        weightedDeltaE += minDE * target.weight;
        bestMatchHeights.push(bestHeight);
        // 如果匹配较好，则将该调色板项标记为有用
        if (minDE < 15) usedPaletteEntries.add(bestIdx);
    }

    // 放大一下，使数值量级与未加权前的评分相当
    weightedDeltaE *= imageTargets.length;

    // 2. 高度分布惩罚：当不同的图像颜色被映射到
    //    同一高度（导致表面平坦）时进行惩罚
    if (bestMatchHeights.length > 1 && reduced.length > 1) {
        const totalModelHeight = reduced[reduced.length - 1].height - reduced[0].height;
        if (totalModelHeight > 0) {
            const uniqueHeights = new Set(bestMatchHeights.map((h) => Math.round(h * 100)));
            const spreadRatio = uniqueHeights.size / imageTargets.length;
            const spreadPenalty = (1 - spreadRatio) * imageTargets.length * 5;
            weightedDeltaE += spreadPenalty;
        }
    }

    // 3. 总层数惩罚：原始调色板大小反映了模型的实际高度。
    //    带有昂贵过渡（颜色差异大）的序列会产生很多层；
    //    平滑过渡（相似色）则只产生很少的层。
    //    每层惩罚 0.5 —— 单层很小，但对浪费型序列累计起来会很显著
    //    （例如 40 层 vs 15 层 = +12.5 惩罚）
    weightedDeltaE += palette.length * 0.5;

    // 4. 过渡浪费惩罚：未被任何目标匹配的调色板项。
    //    如果某个去重后的调色板项不是任何图像目标的最佳匹配，
    //    则产生它的过渡高度就属于浪费的模型空间。
    if (reduced.length > 1) {
        const wastedEntries = reduced.length - usedPaletteEntries.size;
        weightedDeltaE += wastedEntries * 1.5;
    }

    return weightedDeltaE;
}

/**
 * 为图像颜色寻找最佳的耗材排序。
 *
 * 如果提供了优化器选项，将使用高级优化器（模拟退火、遗传算法）。
 * 否则，回退到传统的穷举/贪心搜索。
 *
 * 并非所有耗材都必须使用 —— 算法会评估各个子集，
 * 只保留能改善颜色还原的耗材。
 *
 * 对于 ≤6 种耗材，尝试所有非空子集的所有排列。
 * 对于 >6 种耗材，使用贪心构建：每次添加一种耗材，
 * 当再加入任何耗材都不能改善评分时停止。
 *
 * @returns 最优的耗材排序（可能是输入的子集）以及优化器结果
 */
function findBestFilamentOrder(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    layerHeight: number,
    firstLayerHeight: number,
    optimizerOptions?: Partial<OptimizerOptions>
): { sortedFilaments: Filament[]; result?: OptimizerResult } {
    if (filaments.length <= 1) {
        return { sortedFilaments: [...filaments] };
    }

    // 如果提供了选项，使用高级优化器
    if (optimizerOptions) {
        return findBestFilamentOrderWithOptimizer(
            filaments,
            imageSwatches,
            layerHeight,
            firstLayerHeight,
            optimizerOptions
        );
    }

    // 旧版实现
    return {
        sortedFilaments: findBestFilamentOrderLegacy(
            filaments,
            imageSwatches,
            layerHeight,
            firstLayerHeight
        ),
    };
}

/**
 * 对聚类后的颜色应用区域加权启发式。
 *
 * 由于在聚类过程中空间信息已经丢失，这只是一个近似处理。
 * 我们分析区域权重的分布，并相应地调整簇的权重：
 * - 高权重区域（中心或边缘）会提升常出现于这些区域的颜色
 * - 使用亮度作为空间分布的近似（中心通常更亮，边缘更暗）
 *
 * @param clusters 带权 Lab 颜色簇
 * @param regionWeights 每像素的区域重要性权重
 * @returns 调整后的颜色簇（权重已修改）
 */
function applyRegionWeightHeuristic(
    clusters: WeightedLab[],
    regionWeights: Float32Array
): WeightedLab[] {
    if (clusters.length === 0 || regionWeights.length === 0) return clusters;

    // 计算平均区域权重，用以决定模式强度
    let sumWeight = 0;
    for (let i = 0; i < regionWeights.length; i++) {
        sumWeight += regionWeights[i];
    }
    const avgWeight = sumWeight / regionWeights.length;

    // 计算亮度方差以检测对比度分布
    // 高对比度（边缘模式）vs 较为均匀（中心模式）
    let sumSqDiff = 0;
    for (let i = 0; i < regionWeights.length; i++) {
        const diff = regionWeights[i] - avgWeight;
        sumSqDiff += diff * diff;
    }
    const variance = sumSqDiff / regionWeights.length;
    const isHighContrast = variance > 0.05; // 边缘加权模式的阈值

    // 应用启发式调整
    let totalAdjustedWeight = 0;
    const adjustedClusters = clusters.map((cluster) => {
        let modifier = 1.0;

        if (isHighContrast) {
            // 边缘加权模式：提升高对比度颜色（很亮或很暗）
            const isHighContrast = cluster.L < 30 || cluster.L > 70;
            modifier = isHighContrast ? 1.3 : 0.85;
        }
        else {
            // 中心加权模式：提升中等亮度颜色（中心区域常见）
            const isMidLuminance = cluster.L >= 35 && cluster.L <= 65;
            modifier = isMidLuminance ? 1.2 : 0.9;
        }

        const adjustedWeight = cluster.weight * modifier;
        totalAdjustedWeight += adjustedWeight;

        return {
            ...cluster,
            weight: adjustedWeight,
        };
    });

    // 重新归一化使权重之和为 1.0
    if (totalAdjustedWeight > 0) {
        return adjustedClusters.map((c) => ({
            ...c,
            weight: c.weight / totalAdjustedWeight,
        }));
    }

    return clusters;
}

/**
 * 从 inventory 中按"代表性 deltaE"挑出 top-N 个最相关的耗材，作为 GA 的候选池。
 *
 * 评分逻辑（每个 filament 独立评分，无堆叠仿真）：
 *   score(f) = sum over targets of ( deltaE(rgbToLab(hex(f.color)), target.lab) * target.weight )
 * 分数越低 = 该 filament 单层颜色越能"覆盖"图像中的高权重 target。
 *
 * 与堆叠仿真打分的区别：堆叠是 GA 的职责，预筛选只看"颜色本身的代表性"，
 * 这样：(1) CPP 端对齐路径短（只依赖 hexToRgb / rgbToLab / deltaELab）；
 *       (2) 评分独立、可解释；(3) 比 N 次堆叠仿真快很多。
 */
function selectTopRelevantFilaments(
    filaments: Filament[],
    imageTargets: WeightedLab[],
    topN: number
): { selected: Filament[]; scored: Array<{ filament: Filament; score: number }> } {
    if (filaments.length <= topN) {
        return {
            selected: [...filaments],
            scored: filaments.map((f) => ({ filament: f, score: 0 })),
        };
    }
    if (imageTargets.length === 0) {
        return {
            selected: filaments.slice(0, topN),
            scored: filaments.map((f) => ({ filament: f, score: 0 })),
        };
    }

    const scored = filaments.map((f) => {
        const lab = rgbToLab(hexToRgb(f.color));
        let score = 0;
        for (const t of imageTargets) {
            score += deltaELab(lab, t) * t.weight;
        }
        return { filament: f, score };
    });

    // 按 score 升序排序（越低越好）。同分时保持 inventory 原顺序（V8 sort 稳定）。
    const sorted = [...scored].sort((a, b) => a.score - b.score);

    return {
        selected: sorted.slice(0, topN).map((s) => s.filament),
        scored: sorted,
    };
}

/**
 * 高级优化器路径：使用模拟退火 / 遗传算法
 */
function findBestFilamentOrderWithOptimizer(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    layerHeight: number,
    firstLayerHeight: number,
    optimizerOptions: Partial<OptimizerOptions>
): { sortedFilaments: Filament[]; result: OptimizerResult } {
    // 将图像颜色聚类成带权 Lab 目标
    let imageTargets = clusterImageColors(imageSwatches, 32, 5.0);

    {
        // debugLog('---->打印imageTargets');
        // if (import.meta.env.DEV) {
        //     const lines = [...imageTargets]
        //         .sort((a, b) => {
        //             if (a.L !== b.L) return a.L - b.L;
        //             if (a.a !== b.a) return a.a - b.a;
        //             return a.b - b.b;
        //         })
        //         .map(
        //             (t) =>
        //                 `---->L=${t.L.toFixed(6)}, a=${t.a.toFixed(6)}, b=${t.b.toFixed(6)}, weight=${t.weight.toFixed(6)}`
        //         )
        //         .join('\n');
        //     debugLog(
        //         `---->imageTargets count=${imageTargets.length}\n${lines}`
        //     );
        // }
    }

    // 如果提供了区域权重，则应用区域权重启发式
    // 注意：这只是近似，因为我们在聚类时已经丢失了像素位置。
    // 真正的实现需要在聚合之前对像素加权。
    if (optimizerOptions.regionWeights) {
        imageTargets = applyRegionWeightHeuristic(imageTargets, optimizerOptions.regionWeights);
        {
            // debugLog('---->打印启用regionWeights后的imageTargets');
            // if (import.meta.env.DEV) {
            //     const lines = [...imageTargets]
            //         .sort((a, b) => {
            //             if (a.L !== b.L) return a.L - b.L;
            //             if (a.a !== b.a) return a.a - b.a;
            //             return a.b - b.b;
            //         })
            //         .map(
            //             (t) =>
            //                 `---->L=${t.L.toFixed(6)}, a=${t.a.toFixed(6)}, b=${t.b.toFixed(6)}, weight=${t.weight.toFixed(6)}`
            //         )
            //         .join('\n');
            //     debugLog(
            //         `---->imageTargets(adjusted) count=${imageTargets.length}\n${lines}`
            //     );
            // }
        }
    }

    // 构建评分上下文
    const context: ScoringContext = {
        imageColors: imageTargets,
        layerHeight,
        firstLayerHeight,
        regionWeights: optimizerOptions.regionWeights,
    };

    // --- 预筛选：从 inventory 中挑 top-N 最相关的耗材，再交给 GA ---
    // 当 inventory 较大时，N! 搜索空间会让 GA 在有限代数内无法收敛；
    // 先按"代表性 deltaE"筛到 topN（默认 20）个，把搜索空间降到 20! 以内。
    const TOP_N = optimizerOptions.maxFilamentCount ?? 20;
    const { selected: filteredFilaments, scored: prefilterScored } = selectTopRelevantFilaments(
        filaments,
        imageTargets,
        TOP_N
    );

    {
        debugLog('---->打印预筛选耗材');
        if (import.meta.env.DEV) {
            const lines = prefilterScored
                .map(
                    (s, i) =>
                        `---->[${i}]${i < TOP_N ? '*' : ' '} color=${s.filament.color.toLowerCase()}, td=${s.filament.td.toFixed(6)}, score=${s.score.toFixed(6)}`
                )
                .join('\n');
            debugLog(
                `---->prefilter inventory=${filaments.length}, topN=${TOP_N}, selected=${filteredFilaments.length}\n${lines}`
            );
        }
    }

    // 应用前光 TD 缩放（基于筛选后的耗材）
    const scaledFilaments = filteredFilaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    // 运行初次优化器
    const result = optimizeFilamentOrder(scaledFilaments, context, optimizerOptions);
    {
        debugLog('---->打印初次结果');
        if (import.meta.env.DEV) {
            const orderLines = result.order
                .map((f, i) => `---->[${i}] id=${f.id}, color=${f.color}, td=${f.td.toFixed(6)}`)
                .join('\n');
            debugLog(
                `[${new Date().toISOString()}] optimizer result\n` +
                `---->algorithm=${result.resolvedAlgorithm ?? 'unknown'}\n` +
                `---->score=${result.score.toFixed(6)}\n` +
                `---->iterations=${result.iterations}\n` +
                `---->converged=${result.converged}\n` +
                `---->order count=${result.order.length}\n` +
                orderLines
            );
        }
    }
    // 映射回原始耗材（未缩放的 TD）。注意：predictor 只筛了 TOP_N 个，
    // 但反查仍在完整 filaments 里查 id —— 这样下游拿到的是带原始 TD 的 Filament 引用。
    const sortedFilaments = result.order.map((sf) =>
        filaments.find((f) => f.id === sf.id)
    ).filter((f): f is Filament => f !== undefined);

    return { sortedFilaments, result };
}

/**
 * 旧版优化器路径（≤6 个时穷举，>6 个时贪心）
 */
function findBestFilamentOrderLegacy(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    layerHeight: number,
    firstLayerHeight: number
): Filament[] {
    if (filaments.length <= 1) return [...filaments];

    // 将图像颜色聚类成带权代表目标
    const imageTargets = clusterImageColors(imageSwatches, 32, 5.0);
    if (imageTargets.length === 0) return [...filaments];

    // 应用前光 TD 缩放
    const scaledFilaments = filaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    if (filaments.length <= 6) {
        // 穷举搜索 —— 尝试所有非空子集的所有排列
        // N=6 时：sum of k! * C(6,k) for k=1..6 = 1957 种排列
        const subsets = nonEmptySubsets(scaledFilaments);
        let bestScore = Infinity;
        let bestPerm = scaledFilaments;

        for (const subset of subsets) {
            const perms = permutations(subset);
            for (const perm of perms) {
                const palette = buildAchievableColorPalette(perm, layerHeight, firstLayerHeight);
                const score = scoreSequenceAgainstImage(palette, imageTargets);
                if (score < bestScore) {
                    bestScore = score;
                    bestPerm = perm;
                }
            }
        }

        // 按最佳顺序返回原始耗材（未缩放的 TD）
        return bestPerm.map((sf) => filaments.find((f) => f.id === sf.id)!);
    }

    // 大集合的贪心启发式：
    // 一次添加一种耗材构建序列，当无法再改善时停止。
    // 将每种耗材都尝试作为可能的起始点。
    const allStarts = scaledFilaments.map((f, idx) => ({ f, idx }));
    let globalBestSequence: typeof scaledFilaments = [];
    let globalBestScore = Infinity;

    for (const { f: startFilament } of allStarts) {
        const remaining = scaledFilaments.filter((sf) => sf.id !== startFilament.id);
        const sequence = [startFilament];

        let palette = buildAchievableColorPalette(sequence, layerHeight, firstLayerHeight);
        let currentScore = scoreSequenceAgainstImage(palette, imageTargets);
        const pool = [...remaining];

        while (pool.length > 0) {
            let bestIdx = -1;
            let bestScore = currentScore;

            for (let i = 0; i < pool.length; i++) {
                const candidate = [...sequence, pool[i]];
                const candidatePalette = buildAchievableColorPalette(
                    candidate,
                    layerHeight,
                    firstLayerHeight
                );
                const candidateScore = scoreSequenceAgainstImage(candidatePalette, imageTargets);
                if (candidateScore < bestScore) {
                    bestScore = candidateScore;
                    bestIdx = i;
                }
            }

            // 如果没有耗材能改善评分，则停止
            if (bestIdx < 0 || currentScore - bestScore < 0.5) break;

            sequence.push(pool.splice(bestIdx, 1)[0]);
            palette = buildAchievableColorPalette(sequence, layerHeight, firstLayerHeight);
            currentScore = bestScore;
        }

        if (currentScore < globalBestScore) {
            globalBestScore = currentScore;
            globalBestSequence = [...sequence];
        }
    }

    return globalBestSequence.map((sf) => filaments.find((f) => f.id === sf.id)!);
}

// =============================================================================
// 重复换料 —— 序列扩展
// =============================================================================

/**
 * 构建允许耗材重复出现的扩展耗材序列。
 *
 * 使用贪心策略：从基础排序开始，反复尝试在栈顶
 * 插入每个可用的耗材。
 * 当任何插入都无法改善调色板覆盖时停止，
 * 或达到最大序列长度时停止。
 *
 * 注意：候选耗材来自所有原始耗材，并不仅限于
 * 基础排序中的耗材 —— 一个被基础排序排除的耗材
 * 仍可能作为混合层发挥作用。
 *
 * @param baseFilaments - 初始耗材排序（已优化，可能是子集）
 * @param allFilaments - 所有可用的耗材
 * @param imageSwatches - 来自图像的目标颜色
 * @param layerHeight - 物理层高
 * @param firstLayerHeight - 首层层高
 * @returns 可能含重复耗材的扩展耗材序列
 */
function buildRepeatedSwapSequence(
    baseFilaments: Filament[],
    allFilaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    layerHeight: number,
    firstLayerHeight: number
): Filament[] {
    if (baseFilaments.length === 0) return [];

    // 将图像颜色聚类成带权代表目标
    const imageTargets = clusterImageColors(imageSwatches, 32, 5.0);
    {
        debugLog('---->打印repeatimageTargets');
        if (import.meta.env.DEV) {
            const lines = [...imageTargets]
                .sort((a, b) => {
                    if (a.L !== b.L) return a.L - b.L;
                    if (a.a !== b.a) return a.a - b.a;
                    return a.b - b.b;
                })
                .map(
                    (t) =>
                        `---->L=${t.L.toFixed(6)}, a=${t.a.toFixed(6)}, b=${t.b.toFixed(6)}, weight=${t.weight.toFixed(6)}`
                )
                .join('\n');
            debugLog(`---->imageTargets(swap) count=${imageTargets.length}\n${lines}`);
        }
    }
    if (imageTargets.length === 0) return [...baseFilaments];

    // 从基础序列开始
    let currentSequence = baseFilaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    let currentPalette = buildAchievableColorPalette(
        currentSequence,
        layerHeight,
        firstLayerHeight
    );
    let currentScore = scoreSequenceAgainstImage(currentPalette, imageTargets);

    // 使用所有耗材作为插入候选（已缩放）
    const candidates = allFilaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    // 最多尝试的额外换料次数（避免序列失控膨胀）
    const MAX_EXTRA_SWAPS = Math.min(4, allFilaments.length);
    // 最小改进阈值 —— 收益不足时停止
    const MIN_IMPROVEMENT = 2.0;

    for (let iter = 0; iter < MAX_EXTRA_SWAPS; iter++) {
        let bestCandidate: (typeof candidates)[0] | null = null;
        let bestInsertPos = -1;
        let bestScore = currentScore;

        for (const candidate of candidates) {
            // 尝试在序列中的每个位置插入（不仅是追加到末尾）。
            // 较早插入可让后续耗材自然地叠加在其上，
            // 可能复用现有的过渡，而不必新建昂贵的过渡。
            // 位置 0 = 新基础层，位置 len = 追加到栈顶。
            // 如果会产生连续相同的耗材，则跳过。
            for (let pos = 1; pos <= currentSequence.length; pos++) {
                // 跳过连续重复
                if (pos > 0 && currentSequence[pos - 1].id === candidate.id) continue;
                if (pos < currentSequence.length && currentSequence[pos].id === candidate.id)
                    continue;

                const trial = [
                    ...currentSequence.slice(0, pos),
                    candidate,
                    ...currentSequence.slice(pos),
                ];
                const trialPalette = buildAchievableColorPalette(
                    trial,
                    layerHeight,
                    firstLayerHeight
                );
                const trialScore = scoreSequenceAgainstImage(trialPalette, imageTargets);

                if (trialScore < bestScore) {
                    bestScore = trialScore;
                    bestCandidate = candidate;
                    bestInsertPos = pos;
                }
            }
        }

        if (!bestCandidate || bestInsertPos < 0 || currentScore - bestScore < MIN_IMPROVEMENT) {
            break; // 没有有意义的改善
        }

        currentSequence = [
            ...currentSequence.slice(0, bestInsertPos),
            bestCandidate,
            ...currentSequence.slice(bestInsertPos),
        ];
        currentPalette = buildAchievableColorPalette(
            currentSequence,
            layerHeight,
            firstLayerHeight
        );
        currentScore = bestScore;
    }

    // 映射回原始（未缩放）耗材，保留含重复的序列
    return currentSequence.map((sf) => {
        const orig = allFilaments.find((f) => f.id === sf.id)!;
        return { ...orig }; // 返回保留原始 TD 的副本
    });
}

// =============================================================================
// 自动上色主算法   main entry point
// =============================================================================

/**
 * 基于耗材、图像数据和约束生成自动上色层。
 *
 * 算法：
 * 1. 按亮度排序耗材（由暗到亮）
 * 2. 使用 DeltaE 仿真计算理想过渡区
 * 3. 如果超过最大高度，则进行压缩
 * 4. 为 3D 模型生成层段
 *
 * @param filaments - 用户的耗材列表，包含颜色和 TD
 * @param imageSwatches - 图像中的不同颜色（用于亮度范围）
 * @param layerHeight - 层高（毫米，例如 0.12）
 * @param firstLayerHeight - 首层层高（毫米，例如 0.20）
 * @param maxHeight - 可选的最大高度约束（undefined = 自动）
 * @param enhancedColorMatch - 若为 true，则优化耗材顺序以获得最佳颜色还原
 * @param allowRepeatedSwaps - 若为 true，则允许耗材在栈中多次出现
 * @param optimizerOptions - 高级优化器设置（算法、初始解、区域加权）
 * @param regionWeightingMode - 区域加权策略：uniform、center 或 edge
 * @param imageDimensions - 图像宽高，用于生成区域权重图
 * @returns 包含分区信息的层段
 */
export function generateAutoLayers(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    layerHeight: number,
    firstLayerHeight: number,
    maxHeight?: number,
    enhancedColorMatch?: boolean,
    allowRepeatedSwaps?: boolean,
    optimizerOptions?: Partial<OptimizerOptions>,
    regionWeightingMode: 'uniform' | 'center' | 'edge' = 'uniform',
    imageDimensions?: { width: number; height: number } | null
): AutoPaintResult {
    // --- 步骤 1：参数校验 ---
    if (filaments.length === 0) {
        return {
            layers: [],
            totalHeight: 0,
            idealHeight: 0,
            autoHeight: 0,
            compressionRatio: 1,
            filamentOrder: [],
            transitionZones: [],
            confidence: 0,
            confidenceFactors: {
                calibrationQuality: 0,
                filamentCoverage: 0,
                compressionImpact: 1,
            },
        };
    }

    if (imageSwatches.length === 0) {
        return {
            layers: [],
            totalHeight: 0,
            idealHeight: 0,
            autoHeight: 0,
            compressionRatio: 1,
            filamentOrder: [],
            transitionZones: [],
            confidence: 0,
            confidenceFactors: {
                calibrationQuality: 0,
                filamentCoverage: 0,
                compressionImpact: 1,
            },
        };
    }

    {
        // debugLog("---->打印直方图")
        // if (import.meta.env.DEV) {
        //     const lines = [...imageSwatches]
        //         .sort((a, b) => a.hex.localeCompare(b.hex))
        //         .map((s) => `---->color="${s.hex}", count="${s.count ?? ''}"`)
        //         .join('\n');
        //     debugLog(`[${new Date().toISOString()}]\n${lines}`);
        // }
    }

    // --- 步骤 2：决定耗材排序 ---
    let sortedFilaments: Filament[];
    let optimizerResult: OptimizerResult | undefined;

    // 如果提供了图像尺寸且模式不是 uniform，则生成区域权重图
    let regionWeights: Float32Array | undefined;
    if (imageDimensions && regionWeightingMode !== 'uniform') {
        if (regionWeightingMode === 'center') {
            // 中心加权：优先关注图像中心
            regionWeights = generateCenterWeightedMapSimple(
                imageDimensions.width,
                imageDimensions.height,
                0.5 // 强度参数
            );
            {
                // debugLog("---->打印regionWeights")
                // if (import.meta.env.DEV) {
                //     const w = imageDimensions.width;
                //     const h = imageDimensions.height;
                //     const lines: string[] = [];
                //     for (let y = 0; y < h; y++) {
                //         for (let x = 0; x < w; x++) {
                //             const idx = y * w + x;
                //             lines.push(
                //                 `---->x=${x},y=${y},weight=${regionWeights[idx].toFixed(6)}`
                //             );
                //         }
                //     }
                //     debugLog(
                //         `[${new Date().toISOString()}] regionWeights ${w}x${h}\n${lines.join('\n')}`
                //     );
                // }
            }
        }
        else if (regionWeightingMode === 'edge') {
            // 边缘加权（基于几何）：优先关注边界区域。
            regionWeights = generateEdgeWeightedMapSimple(
                imageDimensions.width,
                imageDimensions.height
            );
        }
    }

    // 将区域权重合并到优化器选项中
    const mergedOptimizerOptions: Partial<OptimizerOptions> | undefined = optimizerOptions
        ? {
            ...optimizerOptions,
            regionWeights: regionWeights ?? optimizerOptions.regionWeights,
        }
        : regionWeights
            ? { regionWeights }
            : undefined;

    if (enhancedColorMatch) {
        // 增强：寻找最能覆盖图像调色板的排序
        const orderingResult = findBestFilamentOrder(
            filaments,
            imageSwatches,
            layerHeight,
            firstLayerHeight,
            mergedOptimizerOptions
        );

        sortedFilaments = orderingResult.sortedFilaments;
        optimizerResult = orderingResult.result;

        // 如果同时启用了重复换料，则扩展该序列
        if (allowRepeatedSwaps) {
            sortedFilaments = buildRepeatedSwapSequence(
                sortedFilaments,
                filaments,
                imageSwatches,
                layerHeight,
                firstLayerHeight
            );
            {
                debugLog('---->打印repeatedsortedFilaments');
                if (import.meta.env.DEV) {
                    const lines = sortedFilaments
                        .map(
                            (f, i) =>
                                `---->[${i}] color=${f.color.toLowerCase()}, td=${f.td.toFixed(6)}`
                        )
                        .join('\n');
                    debugLog(
                        `---->sortedFilaments count=${sortedFilaments.length}\n${lines}`
                    );
                }
            }
            // {
            //     // hack调试用：用 CPP 端 buildRepeatedSwapSequence 的输出覆盖 sortedFilaments，
            //     // 便于在下游（calculateIdealHeight / compressZones / 层段生成）做 bit-by-bit 对齐。
            //     // 数据来自 D:\CODE\HueRelief\HueRelief\Dist\logs\cpp.txt 的 "打印sortedFilaments" 段。
            //     const cppSortedFilaments: Array<{ color: string; td: number }> = [
            //         { color: '#00ae42', td: 2.0 },
            //         { color: '#fce300', td: 6.0 },
            //         { color: '#515a6c', td: 1.8 },
            //         { color: '#e4bdd0', td: 3.0 },
            //         { color: '#00358e', td: 4.0 },
            //         { color: '#a6a9aa', td: 0.5 },
            //         { color: '#61c680', td: 2.0 },
            //         { color: '#6667ab', td: 2.0 },
            //         { color: '#b28b33', td: 1.7 },
            //         { color: '#ffffff', td: 3.5 },
            //         { color: '#0069b1', td: 4.0 },
            //         { color: '#d3b7a7', td: 2.0 },
            //         { color: '#7d6556', td: 2.0 },
            //         { color: '#1c254c', td: 1.0 },
            //         { color: '#ff671f', td: 4.5 },
            //         { color: '#9ea2a2', td: 3.0 },
            //         { color: '#4c5f71', td: 3.0 },
            //         { color: '#ffffff', td: 5.0 },
            //         { color: '#c00d1e', td: 4.0 },
            //         { color: '#9d432c', td: 2.0 },
            //         { color: '#000e5b', td: 2.5 },
            //         { color: '#de4343', td: 2.0 },
            //         { color: '#ff6a13', td: 7.0 },
            //         { color: '#b22f18', td: 3.0 },
            //         { color: '#000000', td: 0.6 },
            //         { color: '#9e007e', td: 2.5 },
            //         { color: '#304301', td: 1.0 },
            //         { color: '#0078bf', td: 0.5 },
            //         { color: '#b7db57', td: 2.7 },
            //         { color: '#053633', td: 1.5 },
            //         { color: '#8bd5ee', td: 3.5 },
            //         { color: '#8e9089', td: 2.0 },
            //         { color: '#9b9ea0', td: 1.5 },
            //         { color: '#ffffff', td: 3.5 },
            //         { color: '#dde5ed', td: 10.0 },
            //         { color: '#bb3d43', td: 1.5 },
            //         { color: '#ffe17f', td: 4.0 },
            //         { color: '#515a6c', td: 1.8 },
            //         { color: '#f99963', td: 3.0 },
            //         { color: '#009639', td: 1.7 },
            //         { color: '#7d1112', td: 2.5 },
            //         { color: '#606e81', td: 2.7 },
            //         { color: '#ff5869', td: 8.0 },
            //         { color: '#ae96d4', td: 2.0 },
            //         { color: '#003b3b', td: 2.0 },
            //         { color: '#000000', td: 0.6 },
            //         { color: '#ffffff', td: 50.0 },
            //         { color: '#f2eada', td: 8.0 },
            //         { color: '#e7ceb5', td: 8.0 },
            //         { color: '#000000', td: 0.6 },
            //         { color: '#b22f18', td: 3.0 },
            //         { color: '#fce300', td: 6.0 },
            //         { color: '#304301', td: 1.0 },
            //         { color: '#f2eada', td: 8.0 },
            //     ];

            //     // 在原始 inventory（filaments）中按 (color, td) 查找对应 Filament，保留其 id。
            //     // 同一个 (color, td) 可能被 CPP 序列重复使用 —— 直接复用同一个 Filament 引用即可。
            //     const overridden: Filament[] = [];
            //     const missing: string[] = [];
            //     for (const item of cppSortedFilaments) {
            //         const match = filaments.find(
            //             (f) =>
            //                 f.color.toLowerCase() === item.color.toLowerCase() &&
            //                 Math.abs(f.td - item.td) < 1e-6
            //         );
            //         if (match) {
            //             overridden.push(match);
            //         } else {
            //             missing.push(`${item.color}/td=${item.td}`);
            //         }
            //     }

            //     if (missing.length > 0) {
            //         debugLog(
            //             `---->[CPP-override] 警告：以下 ${missing.length} 项在 inventory 中未找到匹配，已跳过：${missing.join(', ')}`
            //         );
            //     }

            //     debugLog(
            //         `---->[CPP-override] 已用 CPP 端 sortedFilaments 覆盖 TS 端 (count=${overridden.length}/${cppSortedFilaments.length})`
            //     );

            //     sortedFilaments = overridden;

            //     // 覆盖后再打印一次，方便在 tslog.txt 中确认替换生效
            //     if (import.meta.env.DEV) {
            //         const lines2 = sortedFilaments
            //             .map(
            //                 (f, i) =>
            //                     `---->[${i}] color=${f.color.toLowerCase()}, td=${f.td.toFixed(6)}`
            //             )
            //             .join('\n');
            //         debugLog(
            //             `---->sortedFilaments(after CPP-override) count=${sortedFilaments.length}\n${lines2}`
            //         );
            //     }
            // }
        }
    }
    else {
        // 标准：按亮度排序（由暗到亮）
        sortedFilaments = [...filaments].sort((a, b) => {
            const lumA = getLuminance(hexToRgb(a.color));
            const lumB = getLuminance(hexToRgb(b.color));
            return lumA - lumB;
        });
    }

    const filamentOrder = sortedFilaments.map((f) => f.id);

    // 应用前光 TD 缩放用于内部仿真
    const scaledFilaments = sortedFilaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    // --- 步骤 3：基于过渡区计算理想高度 ---
    const { idealHeight, zones } = calculateIdealHeight(
        scaledFilaments.map((f) => ({ id: f.id, color: f.color, td: f.td })),
        layerHeight,
        Math.max(firstLayerHeight, layerHeight)
    );

    // --- 步骤 4：必要时进行压缩 ---
    // autoHeight = idealHeight —— 即由 DeltaE 收敛仿真
    // 推导出的物理值。这是算法判定为
    // 准确还原颜色所需的高度。
    // 没有硬编码的上限 —— 每个过渡区已被
    // 不透明度阈值（85%）和 DeltaE 收敛（< 2.3）所约束。
    const autoHeight = idealHeight;
    maxHeight = 2.24;// 临时hack
    const targetMaxHeight = maxHeight ?? autoHeight;
    const { compressedZones, compressionRatio } = compressZones(zones, targetMaxHeight);

    // --- 步骤 5：根据各区生成层段 ---
    const layers: AutoPaintLayer[] = compressedZones.map((zone) => ({
        filamentId: zone.filamentId,
        filamentColor: zone.filamentColor,
        startHeight: zone.startHeight,
        endHeight: zone.endHeight,
    }));

    const totalHeight =
        compressedZones.length > 0 ? compressedZones[compressedZones.length - 1].endHeight : 0;

    // --- 步骤 6：计算置信度指标 ---
    const confidence = calculateAutoConfidence(
        filaments,
        imageSwatches,
        sortedFilaments,
        compressionRatio
    );

    const result: AutoPaintResult = {
        layers,
        totalHeight,
        idealHeight,
        autoHeight,
        compressionRatio,
        filamentOrder,
        transitionZones: compressedZones,
        ...confidence,
    };

    // 如果可用，添加优化器元数据
    if (optimizerResult) {
        result.optimizerMetadata = {
            algorithm: optimizerResult.resolvedAlgorithm || optimizerOptions?.algorithm || 'auto',
            score: optimizerResult.score,
            iterations: optimizerResult.iterations,
            converged: optimizerResult.converged,
            cacheHit: optimizerResult.cacheHit || false,
        };
    }

    return result;
}

/**
 * 基于耗材计算推荐的模型高度。
 * 这是在完整分区计算之前的一个快速估算。
 *
 * @param filaments - 耗材数组
 * @returns 推荐模型高度（毫米）
 */
export function calculateRecommendedHeight(
    filaments: Array<{ color: string; td: number }>
): number {
    if (filaments.length === 0) return 2.0;

    // TD 之和大致表示所需的总过渡空间
    const totalTD = filaments.reduce((sum, f) => sum + f.td * FRONTLIT_TD_SCALE, 0);

    // 通常需要 TD 总和的约 0.8 至 1.2 倍
    const estimated = totalTD * 0.9;

    // 限定在合理范围内
    return Math.max(1.0, Math.min(15, estimated));
}

// =============================================================================
// 切片高度转换（用于 ThreeDView）
// =============================================================================

/**
 * 将自动上色层转换为 ThreeDView 期望的格式。
 *
 * 该函数在每个 layerHeight 增量处生成层，
 * 形成一种渐进效果：高层覆盖的像素逐步减少
 * （只覆盖最亮的部分）。
 *
 * ThreeDView 期望：
 * - colorSliceHeights：每个色块索引对应的高度
 * - colorOrder：色块索引的顺序
 * - virtualSwatches：每层对应的颜色
 */
export function autoPaintToSliceHeights(
    result: AutoPaintResult,
    layerHeight: number,
    firstLayerHeight: number
): {
    colorSliceHeights: number[];
    colorOrder: number[];
    virtualSwatches: Array<{ hex: string; a: number }>;
    filamentSwatches: Array<{ hex: string; a: number }>;
} {
    if (result.layers.length === 0 || result.totalHeight <= 0) {
        return {
            colorSliceHeights: [],
            colorOrder: [],
            virtualSwatches: [],
            filamentSwatches: [],
        };
    }

    const virtualSwatches: Array<{ hex: string; a: number }> = [];
    const filamentSwatches: Array<{ hex: string; a: number }> = [];
    const colorSliceHeights: number[] = [];
    const colorOrder: number[] = [];

    const zones = result.transitionZones;

    // 在 0 到 totalHeight 之间，按每个 layerHeight 增量生成层。
    // 对每一层，仿真该 Z 高度处的比尔-朗伯混合颜色。
    let currentZ = 0;
    let layerIndex = 0;
    let prevZoneIndex = 0;
    let thicknessInCurrentZone = 0;

    while (currentZ < result.totalHeight) {
        const thickness = layerIndex === 0 ? Math.max(firstLayerHeight, layerHeight) : layerHeight;

        // 找出当前 Z 高度处所属的过渡区
        let activeZoneIndex = 0;
        for (let zi = 0; zi < zones.length; zi++) {
            if (currentZ >= zones[zi].startHeight && currentZ < zones[zi].endHeight) {
                activeZoneIndex = zi;
                break;
            }
            if (currentZ >= zones[zi].startHeight) {
                activeZoneIndex = zi;
            }
        }

        // 跟踪当前过渡区内的累积厚度，用于颜色混合
        if (activeZoneIndex !== prevZoneIndex) {
            thicknessInCurrentZone = currentZ - zones[activeZoneIndex].startHeight + thickness;
            prevZoneIndex = activeZoneIndex;
        }
        else {
            thicknessInCurrentZone += thickness;
        }

        const zone = zones[activeZoneIndex];
        const filamentColor = hexToRgb(zone.filamentColor);

        // 仿真该层的混合颜色：
        // 基础区 → 纯耗材色（不透明的基底）
        // 后续区 → 将耗材叠加到前一区的颜色上
        let blendedColor: RGB;
        if (activeZoneIndex === 0) {
            blendedColor = filamentColor;
        }
        else {
            const bgColor = hexToRgb(zones[activeZoneIndex - 1].filamentColor);
            blendedColor = blendColors(
                bgColor,
                filamentColor,
                zone.filamentTd,
                thicknessInCurrentZone
            );
        }

        virtualSwatches.push({ hex: rgbToHex(blendedColor), a: 255 });
        filamentSwatches.push({ hex: zone.filamentColor, a: 255 });
        colorSliceHeights.push(Number(thickness.toFixed(8)));
        colorOrder.push(layerIndex);

        currentZ += thickness;
        layerIndex++;

        if (layerIndex > 500) {
            console.warn('autoPaintToSliceHeights: too many layers, stopping at 500');
            break;
        }
    }

    return {
        colorSliceHeights,
        colorOrder,
        virtualSwatches,
        filamentSwatches,
    };
}

// =============================================================================
// 亮度到高度的映射
// =============================================================================

/**
 * 将像素亮度映射到过渡区内的目标高度。
 *
 * 这是决定图像亮度如何转换为 3D 模型物理高度
 * 的关键函数。
 *
 * 映射规则如下：
 * - 最暗像素（亮度 = 0）→ 最低高度（仅基础层）
 * - 最亮像素（亮度 = 1）→ 最高高度（所有层）
 * - 中间色调 → 在过渡区内成比例的位置
 *
 * @param normalizedLuminance - 已归一化到 0-1 的像素亮度
 * @param transitionZones - 已计算好的过渡区
 * @param totalHeight - 模型总高度
 * @param firstLayerHeight - 首层层高
 * @returns 目标高度（毫米）
 */
export function luminanceToHeight(
    normalizedLuminance: number,
    transitionZones: TransitionZone[],
    totalHeight: number,
    firstLayerHeight: number
): number {
    if (transitionZones.length === 0) {
        return firstLayerHeight;
    }

    // 基础高度（最暗像素至少获得基础层高度）
    const baseHeight = transitionZones[0].endHeight;

    if (normalizedLuminance <= 0) {
        return baseHeight;
    }

    if (normalizedLuminance >= 1) {
        return totalHeight;
    }

    // 从基础高度到总高度的线性插值
    // 这会形成平滑梯度：亮度 = 高度
    return baseHeight + normalizedLuminance * (totalHeight - baseHeight);
}

// =============================================================================
// 置信度评分
// =============================================================================

/**
 * 计算自动上色结果的置信度指标。
 *
 * 置信度基于三个因素：
 * 1. 标定质量：耗材标定的好坏
 * 2. 耗材覆盖度：耗材颜色对图像调色板的覆盖程度
 * 3. 压缩影响：相对于理想高度被压缩的程度
 *
 * @param filaments - 输入的耗材及其 TD
 * @param imageSwatches - 图像调色板
 * @param sortedFilaments - 已按最优顺序排列的耗材
 * @param compressionRatio - 实际应用的压缩比（1.0 = 无压缩）
 * @returns 置信度评分及详细因素
 */
function calculateAutoConfidence(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string; count?: number }>,
    sortedFilaments: Filament[],
    compressionRatio: number
): {
    confidence: number;
    confidenceFactors: {
        calibrationQuality: number;
        filamentCoverage: number;
        compressionImpact: number;
    };
} {
    // 1. 标定质量
    // 使用实际标定数据，对所有耗材标定置信度求平均
    let calibrationQuality = 0.5; // 未标定耗材的默认基准值

    if (filaments.length > 0) {
        const confidences = filaments.map((f) =>
            computeProfileConfidence({
                calibration: f.calibration,
                transmissionDistance: f.td,
            })
        );
        calibrationQuality = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
    }

    // 2. 耗材覆盖度
    // 耗材颜色对图像色彩空间的覆盖程度如何？
    // 主要指标：图像颜色与最近耗材色之间的实际 deltaE 距离。
    // 次要因素：耗材数量限制了可达到的最大覆盖度。
    let filamentCoverage = 0.5; // 基准值

    if (filaments.length > 0 && imageSwatches.length > 0) {
        const filamentColors = sortedFilaments.map((f) => rgbToLab(hexToRgb(f.color)));

        // 对每个图像颜色，找最近的耗材色（按像素数加权)
        let totalDeltaE = 0;
        let totalWeight = 0;

        for (const imageSwatch of imageSwatches) {
            const imageColor = rgbToLab(hexToRgb(imageSwatch.hex));
            const weight = imageSwatch.count ?? 1;

            let minDeltaE = Infinity;
            for (const filamentColor of filamentColors) {
                const de = deltaELab(imageColor, filamentColor);
                if (de < minDeltaE) minDeltaE = de;
            }

            totalDeltaE += minDeltaE * weight;
            totalWeight += weight;
        }

        const avgDeltaE = totalWeight > 0 ? totalDeltaE / totalWeight : 50;

        // 将 avgDeltaE 映射到 0-1 评分：deltaE 0 = 1.0，deltaE 50+ ≈ 0.2
        // 衰减常数 35 考虑到了比尔-朗伯混合带来的实际效果
        // 通常优于直接看耗材到色块的原始 deltaE。
        filamentCoverage = 0.2 + 0.8 * Math.exp(-avgDeltaE / 35);

        // 按耗材数量上限限制 —— 即使颜色完美匹配，
        // 也受限于可堆叠的不同层数
        const filamentCount = filaments.length;
        let countCap = 1.0;
        if (filamentCount === 1) countCap = 0.5;
        else if (filamentCount === 2) countCap = 0.7;
        else if (filamentCount === 3) countCap = 0.85;

        filamentCoverage = Math.min(filamentCoverage, countCap);
    }

    // 3. 压缩影响
    // 压缩会降低精度，尤其是大幅压缩
    // compressionRatio: 1.0 = 无压缩（完美）
    // compressionRatio: 0.5 = 压缩 50%（质量明显下降）
    let compressionImpact = compressionRatio;

    // 非线性惩罚：轻度压缩（0.9）尚可，重度（<0.7）较差
    if (compressionRatio < 0.9) {
        compressionImpact = 0.9 * Math.pow(compressionRatio / 0.9, 2);
    }

    // 总体置信度
    // 加权平均，重点放在标定上
    const confidence =
        calibrationQuality * 0.5 + // 标定最重要
        filamentCoverage * 0.3 + // 覆盖度次之
        compressionImpact * 0.2; // 压缩权重最低

    return {
        confidence,
        confidenceFactors: {
            calibrationQuality,
            filamentCoverage,
            compressionImpact,
        },
    };
}

// =============================================================================
// 调试工具
// =============================================================================

/**
 * 调试辅助：模拟并打印每层的光学叠加情况
 */
export function debugAutoPaint(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string }>,
    layerHeight: number,
    firstLayerHeight: number,
    maxHeight?: number
): void {
    const result = generateAutoLayers(
        filaments,
        imageSwatches,
        layerHeight,
        firstLayerHeight,
        maxHeight
    );

    console.group('🎨 Auto-Paint Debug');
    console.log('Input filaments:', filaments);
    console.log('Max height constraint:', maxHeight ?? 'auto');
    console.log('---');
    console.log('Ideal height:', result.idealHeight.toFixed(2), 'mm');
    console.log('Actual height:', result.totalHeight.toFixed(2), 'mm');
    console.log(
        'Compression:',
        result.compressionRatio < 1
            ? `${((1 - result.compressionRatio) * 100).toFixed(1)}% compressed`
            : 'None'
    );
    console.log('Filament order (dark→light):', result.filamentOrder);
    console.log('---');
    console.log('Transition Zones:');
    result.transitionZones.forEach((zone, i) => {
        const status = zone.actualThickness < zone.idealThickness ? '⚠️ compressed' : '✓';
        console.log(
            `  ${i + 1}. ${zone.filamentColor} | ${zone.startHeight.toFixed(2)}mm → ${zone.endHeight.toFixed(2)}mm | ` +
            `Ideal: ${zone.idealThickness.toFixed(2)}mm, Actual: ${zone.actualThickness.toFixed(2)}mm ${status}`
        );
    });
    console.groupEnd();
}