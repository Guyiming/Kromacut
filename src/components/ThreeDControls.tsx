import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import ThreeDColorRow from './ThreeDColorRow';
import { Sortable, SortableContent, SortableOverlay } from '@/components/ui/sortable';
import { Button } from '@/components/ui/button';
import { Check, RotateCcw, Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { autoPaintToSliceHeights } from '../lib/autoPaint';
import {
    loadPrintSettingsFromStorage,
    savePrintSettingsToStorage,
    DEFAULT_PRINT_SETTINGS,
} from '../lib/printSettingsStorage';
import { useFilaments } from '../hooks/useFilaments';
import { useProfileManager } from '../hooks/useProfileManager';
import { useColorSlicing } from '../hooks/useColorSlicing';
import { useSwapPlan } from '../hooks/useSwapPlan';
import { useAutoPaintWorker } from '../hooks/useAutoPaintWorker';
import type { Swatch, ThreeDControlsStateShape } from '../types';
import PrintSettingsCard from './PrintSettingsCard';
import PrintInstructions from './PrintInstructions';
import AutoPaintTab from './AutoPaintTab';

// Re-export types for backward compatibility
export type { Filament, ThreeDControlsStateShape } from '../types';

interface ThreeDControlsProps {
    swatches: Swatch[] | null;
    imageDimensions: { width: number; height: number } | null;
    onChange?: (state: ThreeDControlsStateShape) => void;
    /**
     * Called whenever non-build settings change so the parent can keep
     * its snapshot current without triggering a 3D rebuild.
     */
    onSettingsChange?: (partial: Partial<ThreeDControlsStateShape>) => void;
    /**
     * Persisted state from a previous mount used to hydrate this component
     * when the user switches away from 3D mode and comes back later.
     */
    persisted?: ThreeDControlsStateShape | null;
}

export default function ThreeDControls({ swatches, imageDimensions, onChange, onSettingsChange, persisted }: ThreeDControlsProps) {
    // --- Filaments ---
    const { filaments, setFilaments, addFilament, removeFilament, updateFilament } = useFilaments({
        initial: persisted?.filaments?.length ? persisted.filaments : undefined,
    });

    // --- Profiles ---
    const profileManager = useProfileManager({ filaments, setFilaments });

    // Apply initial filaments from profile if available (one-time)
    const [appliedProfileInit] = useState(() => {
        if (profileManager.initialFilaments && profileManager.initialFilaments.length > 0) {
            return profileManager.initialFilaments;
        }
        return null;
    });
    useEffect(() => {
        if (appliedProfileInit) {
            setFilaments(appliedProfileInit);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- Print Settings ---
    const [initialPrintSettings] = useState(() => {
        const stored = loadPrintSettingsFromStorage();
        return {
            layerHeight:
                stored?.layerHeight ?? persisted?.layerHeight ?? DEFAULT_PRINT_SETTINGS.layerHeight,
            slicerFirstLayerHeight:
                stored?.slicerFirstLayerHeight ??
                persisted?.slicerFirstLayerHeight ??
                DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight,
            pixelSize:
                stored?.pixelSize ?? persisted?.pixelSize ?? DEFAULT_PRINT_SETTINGS.pixelSize,
            smoothMeshing:
                stored?.smoothMeshing ?? persisted?.smoothMeshing ?? DEFAULT_PRINT_SETTINGS.smoothMeshing,
        };
    });

    const [layerHeight, setLayerHeight] = useState<number>(initialPrintSettings.layerHeight);
    const [slicerFirstLayerHeight, setSlicerFirstLayerHeight] = useState<number>(
        initialPrintSettings.slicerFirstLayerHeight
    );
    const [pixelSize, setPixelSize] = useState<number>(initialPrintSettings.pixelSize);
    const [smoothMeshing, setSmoothMeshing] = useState<boolean>(initialPrintSettings.smoothMeshing);
    const [calibrationLayerHeight, setCalibrationLayerHeight] = useState<number>(
        persisted?.calibrationLayerHeight ?? initialPrintSettings.layerHeight
    );
    const [paintMode, setPaintMode] = useState<'manual' | 'autopaint'>(
        persisted?.paintMode ?? 'manual'
    );
    const [autoPaintMaxHeight, setAutoPaintMaxHeight] = useState<number | undefined>(undefined);
    const [enhancedColorMatch, setEnhancedColorMatch] = useState(persisted?.enhancedColorMatch ?? true);
    const [allowRepeatedSwaps, setAllowRepeatedSwaps] = useState(persisted?.allowRepeatedSwaps ?? true);
    const [heightDithering, setHeightDithering] = useState(persisted?.heightDithering ?? false);
    const [ditherLineWidth, setDitherLineWidth] = useState(persisted?.ditherLineWidth ?? 0.42);

    // --- Optimizer Options ---
    const [optimizerAlgorithm, setOptimizerAlgorithm] = useState<'exhaustive' | 'simulated-annealing' | 'genetic' | 'auto'>(
        persisted?.optimizerAlgorithm ?? 'auto'
    );
    const [optimizerSeed, setOptimizerSeed] = useState<number | undefined>(
        persisted?.optimizerSeed
    );
    const [regionWeightingMode, setRegionWeightingMode] = useState<'uniform' | 'center' | 'edge'>(
        persisted?.regionWeightingMode ?? 'center'
    );

    const handleEnhancedColorMatchChange = useCallback((v: boolean) => {
        setEnhancedColorMatch(v);
        if (!v) {
            setAllowRepeatedSwaps(false);
            setHeightDithering(false);
        }
    }, []);

    // Sync non-build settings to parent so persisted stays current across mode switches
    useEffect(() => {
        onSettingsChange?.({
            paintMode,
            filaments,
            enhancedColorMatch,
            allowRepeatedSwaps,
            heightDithering,
            ditherLineWidth,
            optimizerAlgorithm,
            optimizerSeed,
            regionWeightingMode,
            smoothMeshing,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paintMode, filaments, enhancedColorMatch, allowRepeatedSwaps, heightDithering, ditherLineWidth, optimizerAlgorithm, optimizerSeed, regionWeightingMode, smoothMeshing]);

    useEffect(() => {
        savePrintSettingsToStorage({ layerHeight, slicerFirstLayerHeight, pixelSize, smoothMeshing });
    }, [layerHeight, slicerFirstLayerHeight, pixelSize, smoothMeshing]);

    // --- Color Slicing ---
    const {
        filtered,
        colorSliceHeights,
        colorOrder,
        displayOrder,
        onRowChange,
        handleResetHeights,
        resetHeightsToValues,
        handleColorOrderChange,
        isResetState,
    } = useColorSlicing({
        swatches,
        layerHeight,
        slicerFirstLayerHeight,
        persisted,
    });

    const handleResetPrintSettings = useCallback(() => {
        setLayerHeight(DEFAULT_PRINT_SETTINGS.layerHeight);
        setSlicerFirstLayerHeight(DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight);
        setPixelSize(DEFAULT_PRINT_SETTINGS.pixelSize);
        resetHeightsToValues(
            DEFAULT_PRINT_SETTINGS.layerHeight,
            DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight
        );
    }, [resetHeightsToValues]);

    // --- Auto-paint (runs in Web Worker to avoid blocking the UI) ---
    const { autoPaintResult, isComputing: isAutoPaintComputing } = useAutoPaintWorker({
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
    });

    const autoPaintSliceData = useMemo(() => {
        if (!autoPaintResult) return undefined;
        return autoPaintToSliceHeights(autoPaintResult, layerHeight, slicerFirstLayerHeight);
    }, [autoPaintResult, layerHeight, slicerFirstLayerHeight]);

    const instructionColorCount =
        paintMode === 'autopaint'
            ? autoPaintResult?.layers.length ?? 0
            : displayOrder.length;
    const isInstructionOverLimit = instructionColorCount > 64;

    // --- Swap Plan ---
    const { swapPlan, copied, copyToClipboard } = useSwapPlan({
        colorOrder,
        colorSliceHeights,
        filtered,
        layerHeight,
        slicerFirstLayerHeight,
        paintMode,
        autoPaintResult,
        disabled: isInstructionOverLimit,
    });

    // --- Apply handler ---
    const handleApply = useCallback(() => {
        if (!onChange) return;

        if (paintMode === 'autopaint' && autoPaintSliceData && autoPaintResult) {
            onChange({
                layerHeight,
                slicerFirstLayerHeight,
                colorSliceHeights: autoPaintSliceData.colorSliceHeights,
                colorOrder: autoPaintSliceData.colorOrder,
                filteredSwatches: autoPaintSliceData.virtualSwatches,
                pixelSize,
                filaments,
                paintMode,
                enhancedColorMatch,
                allowRepeatedSwaps,
                heightDithering,
                ditherLineWidth,
                optimizerAlgorithm,
                optimizerSeed,
                regionWeightingMode,
                autoPaintResult,
                autoPaintSwatches: autoPaintSliceData.virtualSwatches,
                autoPaintFilamentSwatches: autoPaintSliceData.filamentSwatches,
                calibrationLayerHeight,
                smoothMeshing,
            });
        } else {
            onChange({
                layerHeight,
                slicerFirstLayerHeight,
                colorSliceHeights,
                colorOrder,
                filteredSwatches: filtered,
                pixelSize,
                filaments,
                paintMode,
                optimizerAlgorithm,
                optimizerSeed,
                regionWeightingMode,
                calibrationLayerHeight,
                smoothMeshing,
            });
        }
    }, [
        onChange,
        layerHeight,
        slicerFirstLayerHeight,
        colorSliceHeights,
        colorOrder,
        filtered,
        pixelSize,
        filaments,
        paintMode,
        enhancedColorMatch,
        allowRepeatedSwaps,
        heightDithering,
        ditherLineWidth,
        optimizerAlgorithm,
        optimizerSeed,
        regionWeightingMode,
        calibrationLayerHeight,
        smoothMeshing,
        autoPaintResult,
        autoPaintSliceData,
    ]);

    return (
        <div className="space-y-4">
            {/* Apply button */}
            <div className="sticky -top-4 z-20 -mx-4 -mt-4 px-4 pt-4 pb-2 bg-card border-b border-border flex justify-end">
                <Button
                    onClick={handleApply}
                    disabled={isAutoPaintComputing}
                    className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold transition-all duration-200 shadow-md hover:shadow-lg active:scale-95 gap-1.5 disabled:opacity-60"
                >
                    {isAutoPaintComputing ? (
                        <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Computing...</span>
                        </>
                    ) : (
                        <>
                            <Check className="w-4 h-4" />
                            <span>Build 3D Model</span>
                        </>
                    )}
                </Button>
            </div>

            {/* Printing Parameters Card */}
            <PrintSettingsCard
                layerHeight={layerHeight}
                slicerFirstLayerHeight={slicerFirstLayerHeight}
                pixelSize={pixelSize}
                smoothMeshing={smoothMeshing}
                onLayerHeightChange={setLayerHeight}
                onSlicerFirstLayerHeightChange={setSlicerFirstLayerHeight}
                onPixelSizeChange={setPixelSize}
                onSmoothMeshingChange={setSmoothMeshing}
                onReset={handleResetPrintSettings}
                allDefault={
                    layerHeight === DEFAULT_PRINT_SETTINGS.layerHeight &&
                    slicerFirstLayerHeight === DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight &&
                    pixelSize === DEFAULT_PRINT_SETTINGS.pixelSize
                }
            />

            {/* Paint Mode Tabs */}
            <Tabs
                value={paintMode}
                onValueChange={(v) => setPaintMode(v as 'manual' | 'autopaint')}
            >
                <TabsList className="w-full">
                    <TabsTrigger value="manual" className="flex-1">
                        Manual
                    </TabsTrigger>
                    <TabsTrigger value="autopaint" className="flex-1">
                        Auto-paint
                    </TabsTrigger>
                </TabsList>

                {/* Auto-paint Tab */}
                <AutoPaintTab
                    filaments={filaments}
                    addFilament={addFilament}
                    removeFilament={removeFilament}
                    updateFilament={updateFilament}
                    profiles={profileManager.profiles}
                    activeProfileId={profileManager.activeProfileId}
                    isDirty={profileManager.isDirty}
                    showSaveNewPopover={profileManager.showSaveNewPopover}
                    setShowSaveNewPopover={profileManager.setShowSaveNewPopover}
                    saveProfileName={profileManager.saveProfileName}
                    setSaveProfileName={profileManager.setSaveProfileName}
                    importFeedback={profileManager.importFeedback}
                    importInputRef={profileManager.importInputRef}
                    handleSaveNewProfile={profileManager.handleSaveNewProfile}
                    handleOverwriteProfile={profileManager.handleOverwriteProfile}
                    handleLoadProfile={profileManager.handleLoadProfile}
                    handleDeleteProfile={profileManager.handleDeleteProfile}
                    handleExportProfile={profileManager.handleExportProfile}
                    handleImportFile={profileManager.handleImportFile}
                    autoPaintMaxHeight={autoPaintMaxHeight}
                    setAutoPaintMaxHeight={setAutoPaintMaxHeight}
                    autoPaintResult={autoPaintResult}
                    autoPaintSliceData={autoPaintSliceData}
                    isComputing={isAutoPaintComputing}
                    calibrationLayerHeight={calibrationLayerHeight}
                    setCalibrationLayerHeight={setCalibrationLayerHeight}
                    filteredCount={filtered.length}
                    enhancedColorMatch={enhancedColorMatch}
                    setEnhancedColorMatch={handleEnhancedColorMatchChange}
                    allowRepeatedSwaps={allowRepeatedSwaps}
                    setAllowRepeatedSwaps={setAllowRepeatedSwaps}
                    heightDithering={heightDithering}
                    setHeightDithering={setHeightDithering}
                    ditherLineWidth={ditherLineWidth}
                    setDitherLineWidth={setDitherLineWidth}
                    optimizerAlgorithm={optimizerAlgorithm}
                    setOptimizerAlgorithm={setOptimizerAlgorithm}
                    optimizerSeed={optimizerSeed}
                    setOptimizerSeed={setOptimizerSeed}
                    regionWeightingMode={regionWeightingMode}
                    setRegionWeightingMode={setRegionWeightingMode}
                />

                {/* Manual Tab */}
                <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                    <Card className="p-4 border border-border/50">
                        <div className="flex justify-between items-center mb-4">
                            <div>
                                <h4 className="font-semibold text-foreground">
                                    Color Slice Heights
                                </h4>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Drag to reorder, adjust sliders to customize
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleResetHeights}
                                    disabled={isResetState}
                                    title="Reset all heights and sort by luminance"
                                    aria-label="Reset all heights and sorting"
                                    className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-amber-600 hover:bg-amber-600/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground select-none cursor-pointer"
                                >
                                    <RotateCcw className="w-4 h-4" />
                                </button>
                                <span className="px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
                                    {filtered.length} colors
                                </span>
                            </div>
                        </div>
                        <div className="h-px bg-border/50 mb-4" />
                        <Sortable
                            value={displayOrder.map(String)}
                            onValueChange={handleColorOrderChange}
                            orientation="vertical">
                            <SortableContent asChild>
                                <div className="space-y-2">
                                    {displayOrder.length > 64 ? (
                                        <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive-foreground">
                                            <p className="font-semibold mb-2">Too many colors ({displayOrder.length})</p>
                                            <p>
                                                The image has more than 64 unique colors. Please reduce
                                                the image to fewer colors in 2D mode using the quantization
                                                tools before switching to 3D mode.
                                            </p>
                                        </div>
                                    ) : (
                                        displayOrder.map((fi, idx) => {
                                            const s = filtered[fi];
                                            const val = colorSliceHeights[fi] ?? layerHeight;
                                            const isFirst = idx === 0;
                                            const minForRow = isFirst
                                                ? Math.max(layerHeight, slicerFirstLayerHeight)
                                                : layerHeight;
                                            return (
                                                <ThreeDColorRow
                                                    key={`${s.hex}-${fi}`}
                                                    fi={fi}
                                                    hex={s.hex}
                                                    value={val}
                                                    layerHeight={layerHeight}
                                                    minHeight={minForRow}
                                                    onChange={onRowChange}
                                                />
                                            );
                                        })
                                    )}
                                </div>
                            </SortableContent>
                            <SortableOverlay>
                                <div className="rounded-lg bg-primary/10 h-11" />
                            </SortableOverlay>
                        </Sortable>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Print Instructions */}
            <PrintInstructions
                swapPlan={swapPlan}
                layerHeight={layerHeight}
                slicerFirstLayerHeight={slicerFirstLayerHeight}
                copied={copied}
                onCopy={copyToClipboard}
                tooManyColors={isInstructionOverLimit}
                colorCount={instructionColorCount}
            />
        </div>
    );
}