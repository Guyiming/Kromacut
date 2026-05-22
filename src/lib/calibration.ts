import { estimateTDFromColor } from './colorUtils';

/**
 * 耗材校准系统
 *
 * 实现透射距离 (TD) 校准工作流，用户通过测量穿过堆叠耗材层的光透射，
 * 推导出准确的 TD 值。
 *
 * 校准过程：
 * 1. 用户打印不同层数的测试色块（例如 2、4、6、8、10 层）
 * 2. 用户在背光表面拍摄色块并采样 RGB 值
 * 3. 算法拟合比尔-朗伯定律曲线以推导每个颜色通道的 TD
 * 4. 基于拟合质量和测量一致性计算置信度分数
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 单个测量点：层数和测得的透射率
 */
export type CalibrationRgb = [number, number, number];

export interface CalibrationMeasurement
{
    layers: number; // 打印的层数
    rgb: CalibrationRgb; // 测得的 RGB 值 (0-255)
    transmission: CalibrationRgb; // 归一化的透射率 (0-1)
}

/**
 * 耗材的完整校准结果
 */
export interface CalibrationResult
{
    color: string; // 十六进制颜色
    measurements: CalibrationMeasurement[];
    whiteReference?: CalibrationRgb; // 测得的背光 RGB，用于归一化透射率
    td: CalibrationRgb; // 拟合得到的 R、G、B 通道 TD（毫米）
    tdSingleValue: number; // 由测量样本推导出的自动上色工作 TD（毫米）
    confidence: number; // 0-1 分数，基于拟合质量
    calibrationDate: string; // ISO 时间戳
    notes?: string; // 可选的用户备注
}

/**
 * 校准向导状态
 */
export interface CalibrationState
{
    filamentColor: string;
    measurements: CalibrationMeasurement[];
    whiteReference: CalibrationRgb;
    currentStep: 'intro' | 'print' | 'measure' | 'results';
    layerHeight: number; // 每层的毫米数
}

// ============================================================================
// 常量
// ============================================================================

export const RECOMMENDED_LAYER_COUNTS = [2, 4, 6, 8, 10];
export const DEFAULT_WHITE_REFERENCE: CalibrationRgb = [255, 255, 255];
const MIN_MEASUREMENTS = 3;
const CONFIDENCE_THRESHOLD_EXCELLENT = 0.9;
const CONFIDENCE_THRESHOLD_GOOD = 0.7;
const WORKING_TD_MIN = 0.4;
const WORKING_TD_MAX = 12.0;
const WORKING_TD_GRID_STEPS = 240;
const MIN_CHANNEL_CONTRAST = 12;

const clampRgbChannel = (value: number, min: number) =>
{
    if (!Number.isFinite(value)) return min;
    return Math.min(255, Math.max(min, Math.round(value)));
};

function sanitizeWhiteReference(
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): CalibrationRgb
{
    return [
        clampRgbChannel(whiteReference[0], 1),
        clampRgbChannel(whiteReference[1], 1),
        clampRgbChannel(whiteReference[2], 1),
    ];
}

export function validateWhiteReference(whiteReference: CalibrationRgb): {
    valid: boolean;
    error?: string;
}
{
    const [r, g, b] = whiteReference;
    if (r < 1 || r > 255 || g < 1 || g > 255 || b < 1 || b > 255)
    {
        return {
            valid: false,
            error: 'White reference RGB values must be between 1 and 255',
        };
    }
    return { valid: true };
}

export function normalizeCalibrationMeasurements(
    measurements: CalibrationMeasurement[],
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): CalibrationMeasurement[]
{
    return measurements.map((measurement) => ({
        ...measurement,
        transmission: rgbToTransmission(measurement.rgb, whiteReference),
    }));
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function getBlendChannelWeights(
    filamentRgb: CalibrationRgb,
    whiteReference: CalibrationRgb
): CalibrationRgb
{
    const rawWeights: CalibrationRgb = [0, 1, 2].map((channel) =>
    {
        const contrast = Math.abs(whiteReference[channel] - filamentRgb[channel]);
        return contrast >= MIN_CHANNEL_CONTRAST ? contrast : contrast * 0.25;
    }) as CalibrationRgb;
    const total = rawWeights.reduce((sum, weight) => sum + weight, 0);

    if (total <= 1e-6)
    {
        return [1 / 3, 1 / 3, 1 / 3];
    }

    return rawWeights.map((weight) => weight / total) as CalibrationRgb;
}

function predictWorkingBlendRgb(
    filamentRgb: CalibrationRgb,
    whiteReference: CalibrationRgb,
    td: number,
    thickness: number
): CalibrationRgb
{
    const transmission = Math.pow(10, -thickness / td);
    return [
        Math.round(filamentRgb[0] + (whiteReference[0] - filamentRgb[0]) * transmission),
        Math.round(filamentRgb[1] + (whiteReference[1] - filamentRgb[1]) * transmission),
        Math.round(filamentRgb[2] + (whiteReference[2] - filamentRgb[2]) * transmission),
    ];
}

function evaluateWorkingTdFit(
    measurements: CalibrationMeasurement[],
    layerHeight: number,
    filamentRgb: CalibrationRgb,
    whiteReference: CalibrationRgb,
    channelWeights: CalibrationRgb,
    td: number
): number
{
    let weightedSquaredError = 0;

    for (const measurement of measurements)
    {
        const thickness = measurement.layers * layerHeight;
        const predicted = predictWorkingBlendRgb(filamentRgb, whiteReference, td, thickness);

        weightedSquaredError +=
            channelWeights[0] * Math.pow(predicted[0] - measurement.rgb[0], 2) +
            channelWeights[1] * Math.pow(predicted[1] - measurement.rgb[1], 2) +
            channelWeights[2] * Math.pow(predicted[2] - measurement.rgb[2], 2);
    }

    return weightedSquaredError / measurements.length;
}

function fitWorkingTdFromMeasurements(
    measurements: CalibrationMeasurement[],
    layerHeight: number,
    filamentColor: string,
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): { td: number; confidence: number }
{
    const filamentRgb = hexToRgb(filamentColor);
    if (!filamentRgb)
    {
        return { td: estimateTDFromColor(filamentColor), confidence: 0.1 };
    }

    const reference = sanitizeWhiteReference(whiteReference);
    const channelWeights = getBlendChannelWeights(filamentRgb, reference);
    const heuristicTd = estimateTDFromColor(filamentColor);
    const logMin = Math.log(WORKING_TD_MIN);
    const logMax = Math.log(WORKING_TD_MAX);

    let bestTd = heuristicTd;
    let bestError = Number.POSITIVE_INFINITY;

    for (let i = 0; i < WORKING_TD_GRID_STEPS; i++)
    {
        const t = i / (WORKING_TD_GRID_STEPS - 1);
        const candidateTd = Math.exp(logMin + (logMax - logMin) * t);
        const error = evaluateWorkingTdFit(
            measurements,
            layerHeight,
            filamentRgb,
            reference,
            channelWeights,
            candidateTd
        );

        if (error < bestError)
        {
            bestError = error;
            bestTd = candidateTd;
        }
    }

    let refineMin = Math.max(WORKING_TD_MIN, bestTd / 1.8);
    let refineMax = Math.min(WORKING_TD_MAX, bestTd * 1.8);

    for (let pass = 0; pass < 2; pass++)
    {
        let passBestTd = bestTd;
        let passBestError = bestError;

        for (let i = 0; i < WORKING_TD_GRID_STEPS; i++)
        {
            const t = i / (WORKING_TD_GRID_STEPS - 1);
            const candidateTd = refineMin + (refineMax - refineMin) * t;
            const error = evaluateWorkingTdFit(
                measurements,
                layerHeight,
                filamentRgb,
                reference,
                channelWeights,
                candidateTd
            );

            if (error < passBestError)
            {
                passBestError = error;
                passBestTd = candidateTd;
            }
        }

        bestTd = passBestTd;
        bestError = passBestError;
        refineMin = Math.max(WORKING_TD_MIN, bestTd / 1.35);
        refineMax = Math.min(WORKING_TD_MAX, bestTd * 1.35);
    }

    const weightedRmse = Math.sqrt(bestError);
    const averageContrast =
        (Math.abs(reference[0] - filamentRgb[0]) +
            Math.abs(reference[1] - filamentRgb[1]) +
            Math.abs(reference[2] - filamentRgb[2])) /
        3;
    const contrastStrength = clamp(averageContrast / 255, 0, 1);
    const measurementCoverage = clamp(
        (measurements.length - MIN_MEASUREMENTS) / (RECOMMENDED_LAYER_COUNTS.length - MIN_MEASUREMENTS),
        0,
        1
    );
    const fitConfidence = clamp(1 - weightedRmse / 28, 0, 1);
    const agreement =
        Math.min(bestTd, heuristicTd) / Math.max(bestTd, heuristicTd, WORKING_TD_MIN);
    const measurementInfluence = clamp(
        fitConfidence *
            (0.3 + 0.7 * contrastStrength) *
            (0.6 + 0.4 * measurementCoverage) *
            (0.35 + 0.65 * Math.sqrt(agreement)),
        0,
        0.9
    );

    const blendedTd = clamp(
        heuristicTd + (bestTd - heuristicTd) * measurementInfluence,
        WORKING_TD_MIN,
        WORKING_TD_MAX
    );
    const confidence = clamp(0.25 + 0.75 * Math.max(fitConfidence, measurementInfluence), 0.1, 1);

    return { td: blendedTd, confidence };
}

// ============================================================================
// 核心校准算法
// ============================================================================

/**
 * 使用比尔-朗伯定律从校准测量值计算 TD。
 *
 * 比尔-朗伯定律：T = 10^(-d/TD)
 * 其中 T = 透射率，d = 距离（层数 × 层高），TD = 透射距离
 *
 * 求解 TD：TD = -d / log10(T)
 *
 * 对于每个通道，我们从每对测量值中计算 TD，
 * 然后使用加权最小二乘法拟合一个稳健的平均值。
 */
export function calculateTDFromMeasurements(
    measurements: CalibrationMeasurement[],
    layerHeight: number,
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE,
    filamentColor: string = '#808080'
): { td: [number, number, number]; tdSingleValue: number; confidence: number }
{
    if (measurements.length < MIN_MEASUREMENTS)
    {
        throw new Error(
            `Need at least ${MIN_MEASUREMENTS} measurements, got ${measurements.length}`
        );
    }

    // 按层数对测量值排序
    const normalizedMeasurements = normalizeCalibrationMeasurements(measurements, whiteReference);
    const sorted = normalizedMeasurements.sort((a, b) => a.layers - b.layers);

    // 独立计算每个通道的 TD
    const tdChannels: [number, number, number] = [0, 0, 0];
    const confidences: [number, number, number] = [0, 0, 0];

    for (let channel = 0; channel < 3; channel++)
    {
        const { td, confidence } = fitTDForChannel(sorted, channel, layerHeight);
        tdChannels[channel] = td;
        confidences[channel] = confidence;
    }

    const workingFit = fitWorkingTdFromMeasurements(
        sorted,
        layerHeight,
        filamentColor,
        whiteReference
    );
    const tdSingleValue = workingFit.td;

    // 整体置信度结合了每通道拟合的稳定性
    // 与自动上色使用的工作 TD 拟合质量。
    const confidence = (Math.min(...confidences) + workingFit.confidence) / 2;

    return { td: tdChannels, tdSingleValue, confidence };
}

/**
 * 使用加权最小二乘法为单个颜色通道拟合 TD
 */
function fitTDForChannel(
    measurements: CalibrationMeasurement[],
    channel: number,
    layerHeight: number
): { td: number; confidence: number }
{
    // 从每个测量值计算 TD
    const tdEstimates: Array<{ td: number; thickness: number; transmission: number }> = [];

    for (const measurement of measurements)
    {
        const transmission = measurement.transmission[channel];
        if (transmission <= 0 || transmission >= 1) continue; // 跳过无效测量

        const thickness = measurement.layers * layerHeight;
        const td = -thickness / Math.log10(transmission);

        if (td > 0 && td < 100)
        {
            // 合理性检查：TD 通常应在 0.5-20mm 之间
            tdEstimates.push({ td, thickness, transmission });
        }
    }

    if (tdEstimates.length === 0)
    {
        // 回退：返回默认 TD 和较低的置信度
        return { td: 2.0, confidence: 0.1 };
    }

    // 加权平均：透射率适中 (0.2-0.8) 的测量值获得更高的权重
    let weightedSum = 0;
    let totalWeight = 0;

    for (const { td, transmission } of tdEstimates)
    {
        // 权重函数：在 T=0.5 处达到峰值，在两端下降
        const weight = 1 - Math.abs(transmission - 0.5) * 2; // T=0 或 T=1 时为 0，T=0.5 时为 1
        weightedSum += td * weight;
        totalWeight += weight;
    }

    const tdFitted = weightedSum / totalWeight;

    // 基于估计值的一致性计算置信度
    const variance =
        tdEstimates.reduce((sum, { td }) => sum + Math.pow(td - tdFitted, 2), 0) /
        tdEstimates.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = stdDev / tdFitted;

    // 置信度：CV < 0.1 时为 1.0，CV = 0.4 时线性降至 0.5
    const confidence = Math.max(0.5, 1.0 - coefficientOfVariation * 2.5);

    return { td: tdFitted, confidence };
}

/**
 * 将测得的 RGB 值转换为归一化的透射率值。
 * 使用测得的白色参考来归一化相机和背光的色调。
 */
export function rgbToTransmission(
    rgb: CalibrationRgb,
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): CalibrationRgb
{
    const reference = sanitizeWhiteReference(whiteReference);
    return [
        Math.max(0, Math.min(1, rgb[0] / reference[0])),
        Math.max(0, Math.min(1, rgb[1] / reference[1])),
        Math.max(0, Math.min(1, rgb[2] / reference[2])),
    ];
}

/**
 * 基于当前 TD 估计值，预测给定层数的预期 RGB。
 * 在校准过程中显示预览时很有用。
 */
export function predictTransmission(
    filamentColor: string,
    layers: number,
    layerHeight: number,
    td: [number, number, number],
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): CalibrationRgb
{
    const thickness = layers * layerHeight;

    // 解析耗材颜色
    const rgb = hexToRgb(filamentColor);
    if (!rgb) return [128, 128, 128];

    // 比尔-朗伯定律：T = 10^(-d/TD)
    const transmission: [number, number, number] = [
        Math.pow(10, -thickness / td[0]),
        Math.pow(10, -thickness / td[1]),
        Math.pow(10, -thickness / td[2]),
    ];

    const reference = sanitizeWhiteReference(whiteReference);

    // 用耗材颜色为测得的白色参考背光着色
    return [
        Math.round(transmission[0] * (rgb[0] / 255) * reference[0]),
        Math.round(transmission[1] * (rgb[1] / 255) * reference[1]),
        Math.round(transmission[2] * (rgb[2] / 255) * reference[2]),
    ];
}

// ============================================================================
// 置信度评分
// ============================================================================

/**
 * 计算耗材配置文件的置信度分数。
 * 考虑因素：
 * - 是否存在校准数据
 * - 校准拟合的质量
 * - 校准的时长
 * - 测量的次数
 */
export function computeProfileConfidence(profile: {
    calibration?: CalibrationResult;
    transmissionDistance: number;
}): number
{
    if (!profile.calibration)
    {
        // 无校准数据：基于 TD 值确定置信度
        // TD 越低 = 越适合光刻图 = 置信度越高
        const td = profile.transmissionDistance;
        if (td >= 1.0 && td <= 5.0) return 0.5; // 合理的估计
        if (td >= 0.5 && td <= 10.0) return 0.3; // 可能但不确定
        return 0.1; // 可能是猜测
    }

    const cal = profile.calibration;
    let confidence = cal.confidence;

    // 惩罚旧的校准（>6 个月）
    const ageMs = Date.now() - new Date(cal.calibrationDate).getTime();
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
    if (ageMonths > 6)
    {
        confidence *= Math.max(0.7, 1 - (ageMonths - 6) / 24); // 在 2 年内衰减
    }

    // 测量次数越多奖励越多
    const measurementBonus = Math.min(0.1, cal.measurements.length * 0.02);
    confidence = Math.min(1.0, confidence + measurementBonus);

    return confidence;
}

/**
 * 获取用于 UI 显示的置信度标签
 */
export function getConfidenceLabel(confidence: number): string
{
    if (confidence >= CONFIDENCE_THRESHOLD_EXCELLENT) return 'Excellent';
    if (confidence >= CONFIDENCE_THRESHOLD_GOOD) return 'Good';
    if (confidence >= 0.5) return 'Fair';
    return 'Low';
}

/**
 * 获取用于 UI 显示的置信度颜色（Tailwind 类）
 */
export function getConfidenceColor(confidence: number): string
{
    if (confidence >= CONFIDENCE_THRESHOLD_EXCELLENT) return 'text-green-600';
    if (confidence >= CONFIDENCE_THRESHOLD_GOOD) return 'text-blue-600';
    if (confidence >= 0.5) return 'text-yellow-600';
    return 'text-red-600';
}

// ============================================================================
// 验证辅助函数
// ============================================================================

/**
 * 验证一个校准测量
 */
export function validateMeasurement(
    measurement: CalibrationMeasurement,
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): { valid: boolean; error?: string }
{
    if (measurement.layers < 1 || measurement.layers > 50)
    {
        return { valid: false, error: 'Layer count must be between 1 and 50' };
    }

    const [r, g, b] = measurement.rgb;
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
    {
        return { valid: false, error: 'RGB values must be between 0 and 255' };
    }

    const [tR, tG, tB] = rgbToTransmission(measurement.rgb, whiteReference);
    if (tR < 0 || tR > 1 || tG < 0 || tG > 1 || tB < 0 || tB > 1)
    {
        return { valid: false, error: 'Transmission values must be between 0 and 1' };
    }

    return { valid: true };
}

/**
 * 检查测量值是否已准备好用于 TD 计算
 */
export function canCalculateTD(
    measurements: CalibrationMeasurement[],
    whiteReference: CalibrationRgb = DEFAULT_WHITE_REFERENCE
): {
    ready: boolean;
    reason?: string;
}
{
    const whiteReferenceValidation = validateWhiteReference(whiteReference);
    if (!whiteReferenceValidation.valid)
    {
        return { ready: false, reason: whiteReferenceValidation.error };
    }

    if (measurements.length < MIN_MEASUREMENTS)
    {
        return {
            ready: false,
            reason: `Need at least ${MIN_MEASUREMENTS} measurements (have ${measurements.length})`,
        };
    }

    // 检查是否有重复的层数
    const layerCounts = new Set(measurements.map((m) => m.layers));
    if (layerCounts.size < measurements.length)
    {
        return { ready: false, reason: 'Duplicate layer counts detected' };
    }

    // 验证每个测量
    for (const measurement of measurements)
    {
        const validation = validateMeasurement(measurement, whiteReference);
        if (!validation.valid)
        {
            return { ready: false, reason: validation.error };
        }
    }

    return { ready: true };
}

/**
 * 获取尚未测量的推荐层数
 */
export function getRecommendedLayerCounts(
    existing: CalibrationMeasurement[]
): { recommended: number[]; measured: number[] }
{
    const measured = existing.map((m) => m.layers);
    const recommended = RECOMMENDED_LAYER_COUNTS.filter((count) => !measured.includes(count));
    return { recommended, measured };
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将十六进制颜色解析为 RGB
 */
function hexToRgb(hex: string): [number, number, number] | null
{
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
        : null;
}

/**
 * 为用户生成校准说明
 */
export function getCalibrationInstructions(layerHeight: number): string[]
{
    return [
        `Print test patches with ${RECOMMENDED_LAYER_COUNTS.join(', ')} layers each.`,
        `Use your filament color with 100% infill.`,
        `Layer height: ${layerHeight.toFixed(2)}mm.`,
        `Place patches on a backlit white surface (e.g., phone screen at max brightness).`,
        `Measure the bare backlight first and enter that RGB as the white reference.`,
        `Photograph patches under consistent lighting.`,
        `Use color picker tool to sample RGB values from center of each patch.`,
        `Enter measurements in the calibration wizard.`,
    ];
}

/**
 * 将校准结果导出为 JSON 以便分享
 */
export function exportCalibration(result: CalibrationResult): string
{
    return JSON.stringify(result, null, 2);
}

/**
 * 从 JSON 导入校准结果
 */
export function importCalibration(json: string): CalibrationResult
{
    const parsed = JSON.parse(json);

    // 验证
    if (
        typeof parsed.color !== 'string' ||
        !Array.isArray(parsed.measurements) ||
        !Array.isArray(parsed.td) ||
        typeof parsed.tdSingleValue !== 'number' ||
        typeof parsed.confidence !== 'number'
    )
    {
        throw new Error('Invalid calibration data format');
    }

    if (parsed.whiteReference !== undefined)
    {
        if (
            !Array.isArray(parsed.whiteReference) ||
            parsed.whiteReference.length !== 3 ||
            !validateWhiteReference(parsed.whiteReference as CalibrationRgb).valid
        )
        {
            throw new Error('Invalid calibration white reference');
        }
    }

    const whiteReference = (parsed.whiteReference as CalibrationRgb | undefined) ?? undefined;

    return {
        ...(parsed as CalibrationResult),
        whiteReference,
        measurements: normalizeCalibrationMeasurements(
            parsed.measurements as CalibrationMeasurement[],
            whiteReference ?? DEFAULT_WHITE_REFERENCE
        ),
    };
}
