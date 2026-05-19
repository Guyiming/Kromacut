/**
 * 区域权重工具
 *
 * 提供创建重要性遮罩的工具，可在优化过程中优先考虑特定的图像区域。
 * 常见用例：
 * - 聚焦于人像中的人脸
 * - 强调前景主体
 * - 优先考虑中心区域（三分法构图）
 * - 基于手动笔刷的重要性绘制
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface RegionWeightOptions {
    method: 'uniform' | 'center-weighted' | 'edge-detection' | 'face-detection' | 'custom';
    centerStrength?: number; // 0-1，中心偏向的强度
    edgeThreshold?: number; // 0-255，边缘检测的阈值
    customMask?: Float32Array; // 用户提供的权重
}

// ============================================================================
// 权重图生成
// ============================================================================

/**
 * 为图像生成权重图。
 * 返回的 Float32Array 中每个值为 0-1 的重要性权重。
 */
export function generateWeightMap(
    imageData: ImageData,
    options: RegionWeightOptions
): Float32Array {
    const { width, height } = imageData;
    const weights = new Float32Array(width * height);

    switch (options.method) {
        case 'uniform':
            weights.fill(1.0);
            break;

        case 'center-weighted':
            generateCenterWeightedMap(width, height, weights, options.centerStrength ?? 0.5);
            break;

        case 'edge-detection':
            generateEdgeWeightedMap(imageData, weights, options.edgeThreshold ?? 30);
            break;

        case 'custom':
            if (options.customMask) {
                weights.set(options.customMask);
            } else {
                weights.fill(1.0);
            }
            break;

        default:
            weights.fill(1.0);
    }

    // 归一化到 0-1 范围
    normalizeWeights(weights);

    return weights;
}

/**
 * 使用高斯衰减生成中心加权的重要性图。
 * 图像中心权重为 1.0，边缘根据 strength 参数衰减。
 */
export function generateCenterWeightedMapSimple(
    width: number,
    height: number,
    strength: number = 0.5
): Float32Array {
    const weights = new Float32Array(width * height);
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const normalizedDist = dist / maxDist;

            // 高斯衰减：在中心处权重为 1，随距离减小
            // strength 控制权重衰减的速度
            const weight = Math.exp(-((normalizedDist * normalizedDist) / (2 * (1 - strength))));

            weights[y * width + x] = weight;
        }
    }

    normalizeWeights(weights);
    return weights;
}

/**
 * 仅依据几何信息生成简单的边缘优先权重图。
 * 权重朝向图像边界递增，并归一化到 0-1。
 */
export function generateEdgeWeightedMapSimple(width: number, height: number): Float32Array {
    const weights = new Float32Array(width * height);
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const normalizedDist = maxDist > 0 ? dist / maxDist : 0;

            // 中心低，朝向边界递增
            weights[y * width + x] = Math.pow(normalizedDist, 1.35);
        }
    }

    normalizeWeights(weights);
    return weights;
}

/**
 * 使用高斯衰减生成中心加权的重要性图。
 * 图像中心权重为 1.0，边缘根据 strength 参数衰减。
 */
function generateCenterWeightedMap(
    width: number,
    height: number,
    weights: Float32Array,
    strength: number
): void {
    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const normalizedDist = dist / maxDist;

            // 高斯衰减：在中心处权重为 1，随距离减小
            // strength 控制权重衰减的速度
            const weight = Math.exp(-((normalizedDist * normalizedDist) / (2 * (1 - strength))));

            weights[y * width + x] = weight;
        }
    }
}

/**
 * 使用 Sobel 边缘检测生成基于边缘的重要性图。
 * 边缘密度高的区域获得更高权重（细节保留更多）。
 */
function generateEdgeWeightedMap(
    imageData: ImageData,
    weights: Float32Array,
    threshold: number
): void {
    const { width, height, data } = imageData;

    // Sobel 卷积核
    const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let gx = 0;
            let gy = 0;

            // 在 3x3 窗口内应用 Sobel 算子
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const px = x + kx;
                    const py = y + ky;
                    const idx = (py * width + px) * 4;

                    // 灰度图使用亮度值
                    const luminance =
                        0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

                    const kernelIdx = (ky + 1) * 3 + (kx + 1);
                    gx += luminance * sobelX[kernelIdx];
                    gy += luminance * sobelY[kernelIdx];
                }
            }

            const magnitude = Math.sqrt(gx * gx + gy * gy);

            // 权重与边缘强度成正比
            weights[y * width + x] = magnitude > threshold ? 1.0 : 0.5;
        }
    }

    // 边界以 0.5 填充（无法计算边缘）
    for (let x = 0; x < width; x++) {
        weights[x] = 0.5;
        weights[(height - 1) * width + x] = 0.5;
    }
    for (let y = 0; y < height; y++) {
        weights[y * width] = 0.5;
        weights[y * width + (width - 1)] = 0.5;
    }
}

/**
 * 在保留相对差异的前提下，将权重归一化到 0-1 范围。
 */
function normalizeWeights(weights: Float32Array): void {
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < weights.length; i++) {
        if (weights[i] < min) min = weights[i];
        if (weights[i] > max) max = weights[i];
    }

    const range = max - min;
    if (range > 0) {
        for (let i = 0; i < weights.length; i++) {
            weights[i] = (weights[i] - min) / range;
        }
    } else {
        weights.fill(1.0);
    }
}

// ============================================================================
// 权重图操作
// ============================================================================

/**
 * 对权重图应用高斯模糊以实现平滑过渡。
 */
export function blurWeightMap(
    weights: Float32Array,
    width: number,
    height: number,
    radius: number = 5
): Float32Array {
    const blurred = new Float32Array(weights.length);
    const kernel = createGaussianKernel(radius);
    const kernelSize = kernel.length;
    const halfSize = Math.floor(kernelSize / 2);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let weightSum = 0;

            for (let ky = 0; ky < kernelSize; ky++) {
                for (let kx = 0; kx < kernelSize; kx++) {
                    const px = x + kx - halfSize;
                    const py = y + ky - halfSize;

                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        const kernelWeight = kernel[ky * kernelSize + kx];
                        sum += weights[py * width + px] * kernelWeight;
                        weightSum += kernelWeight;
                    }
                }
            }

            blurred[y * width + x] = weightSum > 0 ? sum / weightSum : 0;
        }
    }

    return blurred;
}

/**
 * 创建用于模糊的二维高斯卷积核。
 */
function createGaussianKernel(radius: number): Float32Array {
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size * size);
    const sigma = radius / 3;
    const twoSigmaSq = 2 * sigma * sigma;
    let sum = 0;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - radius;
            const dy = y - radius;
            const value = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
            kernel[y * size + x] = value;
            sum += value;
        }
    }

    // 归一化
    for (let i = 0; i < kernel.length; i++) {
        kernel[i] /= sum;
    }

    return kernel;
}

/**
 * 使用指定的混合模式合并多个权重图。
 */
export function combineWeightMaps(
    maps: Float32Array[],
    mode: 'max' | 'min' | 'multiply' | 'average' = 'multiply'
): Float32Array {
    if (maps.length === 0) {
        return new Float32Array(0);
    }

    if (maps.length === 1) {
        return new Float32Array(maps[0]);
    }

    const length = maps[0].length;
    const combined = new Float32Array(length);

    for (let i = 0; i < length; i++) {
        const values = maps.map((m) => m[i]);

        switch (mode) {
            case 'max':
                combined[i] = Math.max(...values);
                break;
            case 'min':
                combined[i] = Math.min(...values);
                break;
            case 'multiply':
                combined[i] = values.reduce((prod, v) => prod * v, 1);
                break;
            case 'average':
                combined[i] = values.reduce((sum, v) => sum + v, 0) / values.length;
                break;
        }
    }

    return combined;
}

/**
 * 反转权重图（高重要性变低，反之亦然）。
 */
export function invertWeightMap(weights: Float32Array): Float32Array {
    const inverted = new Float32Array(weights.length);
    for (let i = 0; i < weights.length; i++) {
        inverted[i] = 1.0 - weights[i];
    }
    return inverted;
}

/**
 * 对权重图应用阈值（二值遮罩）。
 */
export function thresholdWeightMap(
    weights: Float32Array,
    threshold: number = 0.5,
    aboveValue: number = 1.0,
    belowValue: number = 0.0
): Float32Array {
    const thresholded = new Float32Array(weights.length);
    for (let i = 0; i < weights.length; i++) {
        thresholded[i] = weights[i] >= threshold ? aboveValue : belowValue;
    }
    return thresholded;
}

// ============================================================================
// 可视化辅助
// ============================================================================

/**
 * 将权重图转换为 RGBA ImageData 用于可视化。
 * 使用热力图配色方案（蓝色=低，红色=高）。
 */
export function weightMapToImageData(
    weights: Float32Array,
    width: number,
    height: number
): ImageData {
    const imageData = new ImageData(width, height);
    const data = imageData.data;

    for (let i = 0; i < weights.length; i++) {
        const weight = weights[i];
        const color = heatmapColor(weight);

        data[i * 4] = color.r;
        data[i * 4 + 1] = color.g;
        data[i * 4 + 2] = color.b;
        data[i * 4 + 3] = 255;
    }

    return imageData;
}

/**
 * 为 [0, 1] 范围内的值生成热力图颜色。
 * 蓝色（冷）→ 绿色 → 黄色 → 红色（热）
 */
function heatmapColor(value: number): { r: number; g: number; b: number } {
    const v = Math.max(0, Math.min(1, value));

    let r, g, b;

    if (v < 0.25) {
        // 蓝到青
        const t = v / 0.25;
        r = 0;
        g = Math.round(t * 255);
        b = 255;
    } else if (v < 0.5) {
        // 青到绿
        const t = (v - 0.25) / 0.25;
        r = 0;
        g = 255;
        b = Math.round((1 - t) * 255);
    } else if (v < 0.75) {
        // 绿到黄
        const t = (v - 0.5) / 0.25;
        r = Math.round(t * 255);
        g = 255;
        b = 0;
    } else {
        // 黄到红
        const t = (v - 0.75) / 0.25;
        r = 255;
        g = Math.round((1 - t) * 255);
        b = 0;
    }

    return { r, g, b };
}