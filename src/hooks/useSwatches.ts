import { useEffect, useRef, useState } from 'react';
import { decode as decodePng, hasPngSignature, type DecodedPng } from 'fast-png';
import { rgbToHsl } from '../lib/color';

// Manages swatch computation with cancellation & immediate override
export interface SwatchEntry {
    hex: string;
    a: number;
    count: number;
    isTransparent?: boolean;
}

// Decode PNG bytes (any depth/channel layout) into a flat RGBA8 buffer.
// Bypasses canvas to avoid display color management roundtrips.
function normalizePngToRgba8(decoded: DecodedPng): {
    width: number;
    height: number;
    data: Uint8Array;
} {
    const { width, height, channels, depth, data, palette, transparency } = decoded;
    const total = width * height;
    const out = new Uint8Array(total * 4);

    if (palette) {
        for (let i = 0; i < total; i++) {
            const idx = data[i] as number;
            const entry = palette[idx];
            out[i * 4] = entry?.[0] ?? 0;
            out[i * 4 + 1] = entry?.[1] ?? 0;
            out[i * 4 + 2] = entry?.[2] ?? 0;
            out[i * 4 + 3] = transparency?.[idx] ?? 255;
        }
        return { width, height, data: out };
    }

    const get =
        depth === 16
            ? (i: number) => ((data[i] as number) >> 8) & 0xff
            : (i: number) => (data[i] as number) & 0xff;

    if (channels === 1) {
        for (let i = 0; i < total; i++) {
            const v = get(i);
            out[i * 4] = v;
            out[i * 4 + 1] = v;
            out[i * 4 + 2] = v;
            out[i * 4 + 3] = 255;
        }
    } else if (channels === 2) {
        for (let i = 0; i < total; i++) {
            const v = get(i * 2);
            const a = get(i * 2 + 1);
            out[i * 4] = v;
            out[i * 4 + 1] = v;
            out[i * 4 + 2] = v;
            out[i * 4 + 3] = a;
        }
    } else if (channels === 3) {
        for (let i = 0; i < total; i++) {
            out[i * 4] = get(i * 3);
            out[i * 4 + 1] = get(i * 3 + 1);
            out[i * 4 + 2] = get(i * 3 + 2);
            out[i * 4 + 3] = 255;
        }
    } else if (channels === 4) {
        for (let i = 0; i < total; i++) {
            out[i * 4] = get(i * 4);
            out[i * 4 + 1] = get(i * 4 + 1);
            out[i * 4 + 2] = get(i * 4 + 2);
            out[i * 4 + 3] = get(i * 4 + 3);
        }
    }

    return { width, height, data: out };
}

export function useSwatches(imageSrc: string | null) {
    
    const [swatches, setSwatches] = useState<SwatchEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
    const runRef = useRef(0);
    const SWATCH_CAP = 2 ** 14; // matches previous constant

    const invalidate = () => {
        runRef.current++;
        setLoading(false);
    };

    const immediateOverride = (colors: SwatchEntry[]) => {
        runRef.current++; // cancel any inflight computation
        setSwatches(colors);
        setLoading(false);
    };

    useEffect(() => {
        let cancelled = false;
        const compute = async () => {
            if (!imageSrc) {
                runRef.current++;
                setSwatches([]);
                setImageDimensions(null);
                setLoading(false);
                return;
            }
            const runId = ++runRef.current;
            setSwatches([]);
            setLoading(true);
            try {
                // Try the PNG fast-path first: fetch bytes and decode with fast-png to
                // bypass canvas/display-profile roundtrips. Falls back to <img>+canvas
                // for non-PNG inputs (or if anything goes wrong).
                let pngResult: { width: number; height: number; data: Uint8Array } | null = null;
                try {
                    const buf = await (await fetch(imageSrc)).arrayBuffer();
                    if (runId !== runRef.current || cancelled) return;
                    const bytes = new Uint8Array(buf);
                    if (hasPngSignature(bytes)) {
                        pngResult = normalizePngToRgba8(decodePng(bytes));
                    } else {
                        console.warn(
                            'useSwatches: imageSrc is not a PNG (no PNG signature) — falling back to canvas path',
                            { imageSrc }
                        );
                    }
                } catch {
                    // ignore — fall through to canvas path below
                }

                let w: number;
                let h: number;
                const map = new Map<number, number>();
                let transparentCount = 0;

                if (pngResult) {
                    w = pngResult.width;
                    h = pngResult.height;
                    setImageDimensions({ width: w, height: h });
                    const data = pngResult.data;
                    const YIELD_EVERY = 1024 * 1024; // yield ~once per megapixel
                    for (let i = 0; i < data.length; i += 4) {
                        const a = data[i + 3];
                        if (a === 0) {
                            transparentCount++;
                            continue;
                        }
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];
                        const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
                        map.set(key, (map.get(key) || 0) + 1);
                        if (i % (YIELD_EVERY * 4) === 0 && i > 0) {
                            await new Promise((r) => setTimeout(r, 0));
                            if (runId !== runRef.current || cancelled) return;
                        }
                    }
                } else {
                    // Canvas fallback (non-PNG inputs, e.g. JPEG, WebP, GIF, BMP)
                    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                        const i = new Image();
                        i.onload = () => resolve(i);
                        i.onerror = () => reject(new Error('image load failed'));
                        i.src = imageSrc;
                    });
                    if (runId !== runRef.current || cancelled) return;
                    w = img.naturalWidth;
                    h = img.naturalHeight;
                    setImageDimensions({ width: w, height: h });
                    const TILE = 1024;
                    const tile = document.createElement('canvas');
                    const tctx = tile.getContext('2d', { willReadFrequently: true });
                    if (!tctx) {
                        setLoading(false);
                        return;
                    }
                    for (let y = 0; y < h; y += TILE) {
                        for (let x = 0; x < w; x += TILE) {
                            const sw = Math.min(TILE, w - x);
                            const sh = Math.min(TILE, h - y);
                            tile.width = sw;
                            tile.height = sh;
                            tctx.clearRect(0, 0, sw, sh);
                            tctx.drawImage(img, x, y, sw, sh, 0, 0, sw, sh);
                            const data = tctx.getImageData(0, 0, sw, sh).data;
                            for (let i = 0; i < data.length; i += 4) {
                                const a = data[i + 3];
                                if (a === 0) {
                                    transparentCount++;
                                    continue;
                                }
                                const r = data[i];
                                const g = data[i + 1];
                                const b = data[i + 2];
                                const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
                                map.set(key, (map.get(key) || 0) + 1);
                            }
                        }
                        await new Promise((r) => setTimeout(r, 0));
                        if (runId !== runRef.current || cancelled) return;
                    }
                }

                const top = Array.from(map.entries())
                    .sort((a, b) => {
                        if (b[1] !== a[1]) return b[1] - a[1];
                        // tie-breaker: RGB-only key ascending, must match C++ side
                        const rgbA = (a[0] >>> 8) & 0xffffff;
                        const rgbB = (b[0] >>> 8) & 0xffffff;
                        return rgbA - rgbB;
                    })
                    .slice(0, Math.min(map.size, SWATCH_CAP))
                    .map((entry) => {
                        const key = entry[0];
                        const r = (key >>> 24) & 0xff;
                        const g = (key >>> 16) & 0xff;
                        const b = (key >>> 8) & 0xff;
                        const a = key & 0xff;
                        const hex =
                            '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
                        return {
                            hex,
                            a,
                            hsl: rgbToHsl(r, g, b),
                            freq: entry[1],
                        };
                    });
                top.sort((a, b) => {
                    if (a.hsl.h !== b.hsl.h) return a.hsl.h - b.hsl.h;
                    if (a.hsl.s !== b.hsl.s) return b.hsl.s - a.hsl.s;
                    return b.hsl.l - a.hsl.l;
                });
                top.reverse();
                if (runId === runRef.current && !cancelled) {
                    const result = top.map((t) => ({
                        hex: t.hex,
                        a: typeof t.a === 'number' ? t.a : 255,
                        count: t.freq,
                        isTransparent: typeof t.a === 'number' ? t.a === 0 : false,
                    }));
                    if (transparentCount > 0) {
                        result.push({
                            hex: '#000000',
                            a: 0,
                            count: transparentCount,
                            isTransparent: true,
                        });
                    }
                    setSwatches(result);
                    setLoading(false);
                }
            } catch (err) {
                if (runId === runRef.current && !cancelled) {
                    console.warn('swatches: compute failed', err);
                    setSwatches([]);
                    setLoading(false);
                }
            }
        };
        compute();
        return () => {
            cancelled = true;
        };
    }, [imageSrc, SWATCH_CAP]);

    return {
        swatches,
        swatchesLoading: loading,
        imageDimensions,
        invalidate,
        immediateOverride,
    };
}
