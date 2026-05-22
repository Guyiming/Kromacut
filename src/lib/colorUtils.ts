/**
 * 共享的颜色工具函数。
 */

/**
 * 从十六进制颜色字符串计算感知亮度（0–1）。
 * 使用标准的 sRGB 亮度系数。
 */
export function hexLuminance(hex: string): number
{
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 从十六进制颜色估算透射距离（TD）。
 *
 * TD 与光线穿透耗材的程度相关：
 * - 较暗 / 不透明的颜色通常具有较低的 TD
 * - 较亮 / 半透明的颜色通常具有较高的 TD
 * - 饱和度和色相会在亮度基线附近轻微调整 TD
 *
 * 该启发式算法有意保守，应尽可能用实测校准数据替代。
 */
export function estimateTDFromColor(hex: string): number
{
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;

    // 计算亮度（感知明度）
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // 计算饱和度
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // 计算色相（0-360）
    let hue = 0;
    if (max !== min)
    {
        if (max === r)
        {
            hue = ((g - b) / (max - min) + (g < b ? 6 : 0)) * 60;
        }
        else if (max === g)
        {
            hue = ((b - r) / (max - min) + 2) * 60;
        }
        else
        {
            hue = ((r - g) / (max - min) + 4) * 60;
        }
    }

    // TD 基础估算（与亮度直接相关）：
    // - 黑色（lum=0.0）：TD ≈ 1.0mm（不透明）
    // - 中灰（lum=0.5）：TD ≈ 3.9mm
    // - 白色（lum=1.0）：TD ≈ 6.8mm（半透明）
    let estimatedTD = 1.0 + luminance * 5.8;

    // 饱和度调整：
    // 低饱和度颜色通常比相同亮度的高饱和度颜色更不透明。
    // 在中等亮度范围内增强效果。
    if (luminance > 0.2 && luminance < 0.8)
    {
        const desaturation = 1 - saturation;
        estimatedTD -= desaturation * 0.7;
    }

    // 基于典型耗材表现的色相调整：
    // 黄色/橙色（30-90°）：通常更半透明，+0.4mm
    if (hue >= 30 && hue < 90 && saturation > 0.3)
    {
        estimatedTD += 0.4;
    }
    // 蓝色/青色（180-240°）：中等半透明，+0.2mm
    else if (hue >= 180 && hue < 240 && saturation > 0.3)
    {
        estimatedTD += 0.2;
    }
    // 红色/品红：通常更不透明，-0.2mm
    else if ((hue >= 330 || hue < 30 || (hue >= 270 && hue < 330)) && saturation > 0.3)
    {
        estimatedTD -= 0.2;
    }

    // 极浅色（白色）的特殊处理
    if (luminance > 0.95)
    {
        estimatedTD = 6.5 + (luminance - 0.95) * 12; // 范围：约 6.5-7.1mm
    }

    // 极深色（黑色）的特殊处理
    if (luminance < 0.15)
    {
        estimatedTD = 0.8 + luminance * 2.7; // 范围：约 0.8-1.2mm
    }

    // 钳制到 PLA 耗材的实际范围
    estimatedTD = Math.max(0.6, Math.min(8.5, estimatedTD));

    // 四舍五入到 1 位小数
    return Math.round(estimatedTD * 10) / 10;
}