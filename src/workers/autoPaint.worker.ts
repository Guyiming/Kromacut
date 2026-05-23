/**
 * Web Worker for auto-paint computation.
 *
 * Offloads the heavy `generateAutoLayers` call (which includes the
 * filament-order optimizer) to a background thread so the UI stays
 * responsive while the algorithm runs.
 */

import { generateAutoLayers } from '../lib/autoPaint';
import type { Filament } from '../types';
import type { OptimizerOptions } from '../lib/optimizer';
import type { AutoPaintResult } from '../lib/autoPaint';
import { consumeDebugLogs } from '../lib/debugLog';

export interface AutoPaintWorkerRequest {
    id: number;
    filaments: Filament[];
    imageSwatches: Array<{ hex: string; count?: number }>;
    layerHeight: number;
    firstLayerHeight: number;
    maxHeight?: number;
    enhancedColorMatch?: boolean;
    allowRepeatedSwaps?: boolean;
    optimizerOptions?: Partial<OptimizerOptions>;
    regionWeightingMode: 'uniform' | 'center' | 'edge';
    imageDimensions?: { width: number; height: number } | null;
}

export interface AutoPaintWorkerResponse {
    id: number;
    result?: AutoPaintResult;
    error?: string;
    debugLogs?: string;
}

self.onmessage = (e: MessageEvent<AutoPaintWorkerRequest>) => {
    const req = e.data;

    try {
        const result = generateAutoLayers(
            req.filaments,
            req.imageSwatches,
            req.layerHeight,
            req.firstLayerHeight,
            req.maxHeight,
            req.enhancedColorMatch,
            req.allowRepeatedSwaps,
            req.optimizerOptions,
            req.regionWeightingMode,
            req.imageDimensions
        );

        const debugLogs = consumeDebugLogs();
        const response: AutoPaintWorkerResponse = { id: req.id, result, debugLogs };
        self.postMessage(response);
    } catch (err) {
        const debugLogs = consumeDebugLogs();
        const response: AutoPaintWorkerResponse = {
            id: req.id,
            error: err instanceof Error ? err.message : String(err),
            debugLogs,
        };
        self.postMessage(response);
    }
};
