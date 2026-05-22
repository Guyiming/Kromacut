import type { CustomPalette } from '@/types';

export const CURRENT_PALETTE_VERSION = 1;

const PALETTES_STORAGE_KEY = 'kromacut.palettes';
const LAST_PALETTE_KEY = 'kromacut.palettes.lastId';
const SELECTED_PALETTE_KEY = 'kromacut.palettes.selected';

/* ---------------------------------------------------------------------------
 * localStorage 辅助函数
 * --------------------------------------------------------------------------- */

export function loadCustomPalettes(): CustomPalette[]
{
    try
    {
        const raw = localStorage.getItem(PALETTES_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as CustomPalette[];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p) => typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.colors)
        );
    }
    catch
    {
        return [];
    }
}

export function saveCustomPalettes(palettes: CustomPalette[])
{
    try
    {
        localStorage.setItem(PALETTES_STORAGE_KEY, JSON.stringify(palettes));
    }
    catch
    {
        // 忽略存储错误
    }
}

export function loadLastCustomPaletteId(): string | null
{
    try
    {
        return localStorage.getItem(LAST_PALETTE_KEY);
    }
    catch
    {
        return null;
    }
}

export function saveLastCustomPaletteId(id: string | null)
{
    try
    {
        if (id)
        {
            localStorage.setItem(LAST_PALETTE_KEY, id);
        }
        else
        {
            localStorage.removeItem(LAST_PALETTE_KEY);
        }
    }
    catch
    {
        // 忽略
    }
}

export function loadSelectedPalette(): string | null
{
    try
    {
        return localStorage.getItem(SELECTED_PALETTE_KEY);
    }
    catch
    {
        return null;
    }
}

export function saveSelectedPalette(id: string)
{
    try
    {
        localStorage.setItem(SELECTED_PALETTE_KEY, id);
    }
    catch
    {
        // 忽略
    }
}

/* ---------------------------------------------------------------------------
 * CRUD
 * --------------------------------------------------------------------------- */

export function createCustomPalette(name: string, colors: string[]): CustomPalette
{
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        name: name.trim(),
        version: CURRENT_PALETTE_VERSION,
        colors: [...colors],
        createdAt: now,
        updatedAt: now,
    };
}

export function updateCustomPalette(
    palettes: CustomPalette[],
    id: string,
    patch: { name?: string; colors?: string[] }
): CustomPalette[]
{
    return palettes.map((p) =>
        p.id === id
            ? {
                  ...p,
                  ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
                  ...(patch.colors !== undefined ? { colors: [...patch.colors] } : {}),
                  updatedAt: Date.now(),
              }
            : p
    );
}

export function deleteCustomPalette(palettes: CustomPalette[], id: string): CustomPalette[]
{
    return palettes.filter((p) => p.id !== id);
}

/* ---------------------------------------------------------------------------
 * 导入 / 导出
 * --------------------------------------------------------------------------- */

/** 检查两个颜色数组是否相同（顺序敏感）。 */
function colorsEqual(a: string[], b: string[]): boolean
{
    if (a.length !== b.length) return false;
    return a.every((c, i) => c.toLowerCase() === b[i].toLowerCase());
}

/** 如果名称已存在，则通过追加数字后缀派生唯一名称。 */
function deduplicateName(name: string, existing: CustomPalette[]): string
{
    const names = new Set(existing.map((p) => p.name));
    if (!names.has(name)) return name;
    let suffix = 2;
    while (names.has(`${name} (${suffix})`)) suffix++;
    return `${name} (${suffix})`;
}

export interface ImportPaletteResult
{
    palettes: CustomPalette[];
    imported: CustomPalette[];
    skipped: string[];
    overwritten: string[];
    renamed: string[];
}

/**
 * 导入调色板，并防止重复：
 * - ID 匹配：覆盖
 * - 内容匹配（颜色相同）：跳过
 * - 名称匹配（内容不同）：使用数字后缀重命名
 */
export function importCustomPalettes(
    existing: CustomPalette[],
    incoming: CustomPalette[]
): ImportPaletteResult
{
    const result: ImportPaletteResult = {
        palettes: [...existing],
        imported: [],
        skipped: [],
        overwritten: [],
        renamed: [],
    };

    for (const raw of incoming)
    {
        if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.colors)) continue;

        const validColors = raw.colors.filter((c) => typeof c === 'string');

        const now = Date.now();
        const palette: CustomPalette = {
            id: raw.id && typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
            name: raw.name,
            version: typeof raw.version === 'number' ? raw.version : CURRENT_PALETTE_VERSION,
            colors: validColors,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: now,
        };

        // 1. ID 匹配 → 覆盖
        const idMatch = result.palettes.findIndex((p) => p.id === palette.id);
        if (idMatch !== -1)
        {
            result.palettes[idMatch] = { ...palette, updatedAt: now };
            result.overwritten.push(palette.name);
            result.imported.push(result.palettes[idMatch]);
            continue;
        }

        // 2. 内容匹配（颜色相同）→ 跳过
        const contentMatch = result.palettes.find((p) => colorsEqual(p.colors, validColors));
        if (contentMatch)
        {
            result.skipped.push(`${palette.name} (matches "${contentMatch.name}")`);
            continue;
        }

        // 3. 名称匹配 → 重命名
        const nameMatch = result.palettes.some((p) => p.name === palette.name);
        if (nameMatch)
        {
            palette.name = deduplicateName(palette.name, result.palettes);
            result.renamed.push(palette.name);
        }

        result.palettes.push(palette);
        result.imported.push(palette);
    }

    return result;
}

/**
 * 将 JSON 字符串解析为自定义调色板数组。
 * 接受单个调色板对象或数组。
 */
export function parseCustomPaletteFile(json: string): CustomPalette[] | null
{
    try
    {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.colors))
        {
            return [parsed as CustomPalette];
        }
        return null;
    }
    catch
    {
        return null;
    }
}

/** 为自定义调色板构建导出 blob。 */
export function exportCustomPaletteBlob(palette: CustomPalette): Blob
{
    return new Blob([JSON.stringify(palette, null, 2)], {
        type: 'application/json',
    });
}

/** 清理名称以便用作文件名。 */
export function customPaletteFileName(name: string): string
{
    return `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.kpal`;
}
