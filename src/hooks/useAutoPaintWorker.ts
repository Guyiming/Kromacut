/**
 * Hook that runs the auto-paint algorithm in a Web Worker.
 *
 * Replaces the previous synchronous `useMemo` approach, ensuring the
 * optimizer (exhaustive / SA / GA) never blocks the main thread.
 *
 * Features:
 * - Automatic cancellation: a new request obsoletes any in-flight one.
 * - Loading state for UI feedback.
 * - Lazy worker instantiation (created on first real request).
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import type { AutoPaintResult } from '../lib/autoPaint';
import type { Filament } from '../types';
import type {
    AutoPaintWorkerRequest,
    AutoPaintWorkerResponse,
} from '../workers/autoPaint.worker';

async function writeDebugLogsToFile(content: string): Promise<void> {
    try {
        const res = await fetch('/__write-debug-log', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: content,
        });
        if (!res.ok) {
            console.error('[autoPaintWorker] debug log write failed:', res.status, await res.text());
        }
    } catch (err) {
        console.error('[autoPaintWorker] failed to write debug logs:', err);
    }
}

export interface UseAutoPaintWorkerOptions {
    paintMode: 'manual' | 'autopaint';
    filaments: Filament[];
    filtered: Array<{ hex: string; a: number } & Record<string, unknown>>;
    layerHeight: number;
    slicerFirstLayerHeight: number;
    autoPaintMaxHeight?: number;
    enhancedColorMatch: boolean;
    allowRepeatedSwaps: boolean;
    optimizerAlgorithm: 'exhaustive' | 'simulated-annealing' | 'genetic' | 'auto';
    optimizerSeed?: number;
    regionWeightingMode: 'uniform' | 'center' | 'edge';
    imageDimensions?: { width: number; height: number } | null;
}

export interface UseAutoPaintWorkerResult {
    autoPaintResult: AutoPaintResult | undefined;
    isComputing: boolean;
}

let nextRequestId = 1;

export function useAutoPaintWorker(
    opts: UseAutoPaintWorkerOptions
): UseAutoPaintWorkerResult {
    const {
        paintMode,
        filaments,
        filtered,
        layerHeight,
        slicerFirstLayerHeight,
        autoPaintMaxHeight,
        enhancedColorMatch,
        allowRepeatedSwaps,
        optimizerAlgorithm,
        optimizerSeed,
        regionWeightingMode,
        imageDimensions,
    } = opts;

    const [autoPaintResult, setAutoPaintResult] = useState<AutoPaintResult | undefined>(undefined);
    const [isComputing, setIsComputing] = useState(false);

    const workerRef = useRef<Worker | null>(null);
    const activeRequestIdRef = useRef<number>(0);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Stabilize filaments and filtered with content-based keys
    const filamentsKey = useMemo(() => {
        return filaments
            .map(
                (f) =>
                    `${f.id}:${f.color}:${f.td}:${JSON.stringify(f.calibration ?? null)}`
            )
            .join(';');
    }, [filaments]);

    const filteredKey = useMemo(() => {
        return filtered.map((s) => `${s.hex}:${(s.count as number | undefined) ?? 0}`).join(';');
    }, [filtered]);

    // Keep stable references when only array identity changes but content does not.
    const stableFilaments = useMemo(() => filaments, [filamentsKey]);

    const stableImageSwatches = useMemo(
        () =>
            filtered.map((s) => ({
                hex: s.hex,
                count: s.count as number | undefined,
            })),
        [filteredKey]
    );

    // Create the worker lazily on first need.
    const getWorker = useCallback(() => {
        if (!workerRef.current) {
            workerRef.current = new Worker(
                new URL('../workers/autoPaint.worker.ts', import.meta.url),
                { type: 'module' }
            );
            workerRef.current.onmessage = (e: MessageEvent<AutoPaintWorkerResponse>) => {
                const resp = e.data;
                // Ignore stale responses from obsoleted requests.
                if (resp.id !== activeRequestIdRef.current) return;

                if (resp.error) {
                    console.error('[autoPaintWorker] error:', resp.error);
                } else {
                    setAutoPaintResult(resp.result);
                }
                setIsComputing(false);

                if (import.meta.env.DEV && resp.debugLogs && resp.debugLogs.length > 0) {
                    void writeDebugLogsToFile(resp.debugLogs);
                }
            };
            workerRef.current.onerror = (err) => {
                console.error('[autoPaintWorker] worker error:', err);
                setIsComputing(false);
            };
        }
        return workerRef.current;
    }, []);

    // Terminate worker on unmount.
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            workerRef.current?.terminate();
            workerRef.current = null;
        };
    }, []);

    // Dispatch computation whenever inputs change (with debouncing).
    useEffect(() => {
        // Clear any pending computation
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }

        // Not in autopaint mode — clear result.
        if (paintMode !== 'autopaint' || filaments.length === 0 || filtered.length === 0) {
            setAutoPaintResult(undefined);
            setIsComputing(false);
            return;
        }

        // Debounce computation by 250ms to avoid hammering the worker during slider drags
        debounceTimerRef.current = setTimeout(() => {
            const id = nextRequestId++;
            activeRequestIdRef.current = id;
            setIsComputing(true);

            const worker = getWorker();

            const request: AutoPaintWorkerRequest = {
                id,
                filaments: stableFilaments,
                imageSwatches: stableImageSwatches,
                layerHeight,
                firstLayerHeight: slicerFirstLayerHeight,
                maxHeight: autoPaintMaxHeight,
                enhancedColorMatch,
                allowRepeatedSwaps,
                optimizerOptions: {
                    algorithm: optimizerAlgorithm,
                    ...(optimizerSeed !== undefined && { seed: optimizerSeed }),
                },
                regionWeightingMode,
                imageDimensions: imageDimensions ?? undefined,
            };

            worker.postMessage(request);
        }, 250);

        // Cleanup function clears pending timeout
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
        };
    }, [
        paintMode,
        filamentsKey, // Use stable key instead of filaments
        filteredKey, // Use stable key instead of filtered
        layerHeight,
        slicerFirstLayerHeight,
        autoPaintMaxHeight,
        enhancedColorMatch,
        allowRepeatedSwaps,
        optimizerAlgorithm,
        optimizerSeed,
        regionWeightingMode,
        imageDimensions,
        getWorker,
        stableFilaments,
        stableImageSwatches,
    ]);

    return { autoPaintResult, isComputing };
}
