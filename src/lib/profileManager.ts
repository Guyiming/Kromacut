import type { Filament } from '@/types';

export interface AutoPaintProfile {
    id: string;
    name: string;
    version: number;
    filaments: Filament[];
    createdAt: number;
    updatedAt: number;
}

export const CURRENT_PROFILE_VERSION = 1;

const PROFILES_STORAGE_KEY = 'kromacut.autopaint.profiles';
const LAST_PROFILE_KEY = 'kromacut.autopaint.lastProfileId';

export function loadProfiles(): AutoPaintProfile[] {
    try {
        const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as AutoPaintProfile[];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p) =>
                typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.filaments)
        );
    } catch {
        return [];
    }
}

export function loadLastProfileId(): string | null {
    try {
        return localStorage.getItem(LAST_PROFILE_KEY);
    } catch {
        return null;
    }
}

export function saveLastProfileId(id: string | null) {
    try {
        if (id) {
            localStorage.setItem(LAST_PROFILE_KEY, id);
        } else {
            localStorage.removeItem(LAST_PROFILE_KEY);
        }
    } catch {
        // 忽略
    }
}

export function saveProfilesToStorage(profiles: AutoPaintProfile[]) {
    try {
        localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
    } catch {
        // 忽略存储错误
    }
}

export function createProfile(name: string, filaments: Filament[]): AutoPaintProfile {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        name: name.trim(),
        version: CURRENT_PROFILE_VERSION,
        filaments: filaments.map((f) => ({ ...f })),
        createdAt: now,
        updatedAt: now,
    };
}

export function overwriteProfile(
    profiles: AutoPaintProfile[],
    id: string,
    filaments: Filament[]
): AutoPaintProfile[] {
    return profiles.map((p) =>
        p.id === id
            ? {
                  ...p,
                  filaments: filaments.map((f) => ({ ...f })),
                  updatedAt: Date.now(),
              }
            : p
    );
}

export function deleteProfile(profiles: AutoPaintProfile[], id: string): AutoPaintProfile[] {
    return profiles.filter((p) => p.id !== id);
}

/** 通过 color+td 检查两个耗材数组是否相同（顺序敏感）。 */
const filamentCalibrationSignature = (filament: Filament) =>
    JSON.stringify(filament.calibration ?? null);

function filamentsEqual(a: Filament[], b: Filament[]): boolean {
    if (a.length !== b.length) return false;
    return a.every(
        (af, i) =>
            af.color === b[i].color &&
            af.td === b[i].td &&
            (af.name ?? '') === (b[i].name ?? '') &&
            filamentCalibrationSignature(af) === filamentCalibrationSignature(b[i])
    );
}

/** 如果名称已存在，则通过追加数字后缀派生唯一名称。 */
function deduplicateName(name: string, existing: AutoPaintProfile[]): string {
    const names = new Set(existing.map((p) => p.name));
    if (!names.has(name)) return name;
    let suffix = 2;
    while (names.has(`${name} (${suffix})`)) suffix++;
    return `${name} (${suffix})`;
}

export interface ImportResult {
    profiles: AutoPaintProfile[];
    imported: AutoPaintProfile[];
    skipped: string[];
    overwritten: string[];
    renamed: string[];
}

/**
 * 导入一个或多个配置文件，并防止重复：
 * - ID 匹配：覆盖已有的配置文件
 * - 内容匹配（不同 ID）：跳过
 * - 名称匹配（不同 ID，不同内容）：使用数字后缀重命名
 */
export function importProfiles(
    existing: AutoPaintProfile[],
    incoming: AutoPaintProfile[]
): ImportResult {
    const result: ImportResult = {
        profiles: [...existing],
        imported: [],
        skipped: [],
        overwritten: [],
        renamed: [],
    };

    for (const raw of incoming) {
        // 验证必需字段
        if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.filaments)) continue;

        const validFilaments = raw.filaments.filter(
            (f) =>
                typeof f.id === 'string' && typeof f.color === 'string' && typeof f.td === 'number'
        );

        const now = Date.now();
        const profile: AutoPaintProfile = {
            id: raw.id && typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
            name: raw.name,
            version: typeof raw.version === 'number' ? raw.version : CURRENT_PROFILE_VERSION,
            filaments: validFilaments,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: now,
        };

        // 1. ID 匹配 → 覆盖
        const idMatch = result.profiles.findIndex((p) => p.id === profile.id);
        if (idMatch !== -1) {
            result.profiles[idMatch] = { ...profile, updatedAt: now };
            result.overwritten.push(profile.name);
            result.imported.push(result.profiles[idMatch]);
            continue;
        }

        // 2. 内容匹配（耗材相同）→ 跳过
        const contentMatch = result.profiles.find((p) =>
            filamentsEqual(p.filaments, validFilaments)
        );
        if (contentMatch) {
            result.skipped.push(`${profile.name} (matches "${contentMatch.name}")`);
            continue;
        }

        // 3. 名称匹配 → 重命名
        const nameMatch = result.profiles.some((p) => p.name === profile.name);
        if (nameMatch) {
            profile.name = deduplicateName(profile.name, result.profiles);
            result.renamed.push(profile.name);
        }

        result.profiles.push(profile);
        result.imported.push(profile);
    }

    return result;
}

/**
 * 将文件的 JSON 内容解析为待导入的配置文件数组。
 * 支持单个配置文件对象和配置文件数组。
 */
export function parseProfileFile(json: string): AutoPaintProfile[] | null {
    try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.filaments)) {
            return [parsed as AutoPaintProfile];
        }
        return null;
    } catch {
        return null;
    }
}

/** 为配置文件构建导出 blob。 */
export function exportProfileBlob(profile: AutoPaintProfile): Blob {
    return new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
}

/** 清理名称以便用作文件名。 */
export function profileFileName(name: string): string {
    return `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.kapp`;
}
