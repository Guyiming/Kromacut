import React, { useEffect, useRef, useState } from 'react';
import ThreeDControls from './components/ThreeDControls';
import type { ThreeDControlsStateShape } from './types';
import ThreeDView from './components/ThreeDView';
import logo from './assets/logo.png';
import tdTestImg from './assets/tdTest.png';
import CanvasPreview from './components/CanvasPreview';
import type { CanvasPreviewHandle } from './components/CanvasPreview';
import { SwatchesPanel } from './components/SwatchesPanel';
import AdjustmentsPanel from './components/AdjustmentsPanel';
import DeditherPanel from './components/DeditherPanel';
import { ADJUSTMENT_DEFAULTS } from './lib/applyAdjustments';
import SLIDER_DEFS from './components/sliderDefs';
import { useSwatches } from './hooks/useSwatches';
import type { SwatchEntry } from './hooks/useSwatches';
import { useImageHistory } from './hooks/useImageHistory';
import { useQuantize } from './hooks/useQuantize';
import Header from './components/Header';
import ModeTabs from './components/ModeTabs';
import PreviewActions from './components/PreviewActions';
import { useDropzone } from './hooks/useDropzone';
import { exportObjectToStlBlob } from './lib/exportStl';
import { exportObjectTo3MFBlob } from './lib/export3mf';
import { useAppHandlers } from './hooks/useAppHandlers';
import { useProcessingState } from './hooks/useProcessingState';
import { useBuildWarning } from './hooks/useBuildWarning';
import ResizableSplitter from './components/ResizableSplitter';
import { ControlsPanel } from './components/ControlsPanel';
import { usePaletteManager } from './hooks/usePaletteManager';
import { UpdateChecker } from './components/UpdateChecker';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogAction,
    AlertDialogCancel,
} from './components/ui/alert-dialog';
import { Card } from './components/ui/card';
import { Switch } from './components/ui/switch';
// ...existing imports

const AUTOPAINT_STORAGE_KEY = 'kromacut.autopaint.v1';

type AutoPaintPersisted = Pick<
    ThreeDControlsStateShape,
    | 'filaments'
    | 'paintMode'
    | 'optimizerAlgorithm'
    | 'optimizerSeed'
    | 'regionWeightingMode'
    | 'enhancedColorMatch'
    | 'allowRepeatedSwaps'
    | 'heightDithering'
    | 'ditherLineWidth'
>;

const loadAutoPaintPersisted = (): AutoPaintPersisted | null => {
    try {
        const raw = localStorage.getItem(AUTOPAINT_STORAGE_KEY);
        if (!raw) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(raw) as any;
        if (!parsed || !Array.isArray(parsed.filaments)) return null;
        // Migrate legacy `autoPaintEnabled` boolean → `paintMode`
        const paintMode: 'manual' | 'autopaint' =
            parsed.paintMode === 'autopaint' || parsed.paintMode === 'manual'
                ? parsed.paintMode
                : parsed.autoPaintEnabled
                  ? 'autopaint'
                  : 'manual';
        return {
            filaments: parsed.filaments,
            paintMode,
            optimizerAlgorithm: parsed.optimizerAlgorithm,
            optimizerSeed: parsed.optimizerSeed,
            regionWeightingMode: parsed.regionWeightingMode,
            enhancedColorMatch: parsed.enhancedColorMatch ?? false,
            allowRepeatedSwaps: parsed.allowRepeatedSwaps ?? false,
            heightDithering: parsed.heightDithering ?? false,
            ditherLineWidth: parsed.ditherLineWidth,
        };
    } catch {
        return null;
    }
};

const saveAutoPaintPersisted = (value: AutoPaintPersisted) => {
    try {
        localStorage.setItem(AUTOPAINT_STORAGE_KEY, JSON.stringify(value));
    } catch {
        // ignore storage errors
    }
};

function App(): React.ReactElement | null {
    // dropzone state managed by hook below
    // `weight` is the algorithm parameter; `finalColors` is the postprocess target
    const [weight, setWeight] = useState<number>(128);
    const [finalColors, setFinalColors] = useState<number>(16);
    const [algorithm, setAlgorithm] = useState<string>('kmeans');
    const SWATCH_CAP = 2 ** 10;
    // Palette manager: custom palettes CRUD + merged palette list + selected palette
    const {
        customPalettes,
        allPalettes,
        selectedPalette,
        setSelectedPalette,
        importFeedback: paletteImportFeedback,
        importInputRef: paletteImportInputRef,
        handleCreatePalette,
        handleUpdatePalette,
        handleDeletePalette,
        handleExportPalette,
        handleImportFile: handleImportPaletteFile,
    } = usePaletteManager();
    const { imageSrc, setImage, clearCurrent, undo, redo, canUndo, canRedo } = useImageHistory(
        logo,
        undefined
    );
    const { swatches, swatchesLoading, imageDimensions, invalidate, immediateOverride } = useSwatches(imageSrc);
    // adjustments managed locally inside AdjustmentsPanel now
    // initial selectedPalette derived from initial weight above
    const inputRef = useRef<HTMLInputElement | null>(null);
    const canvasPreviewRef = useRef<CanvasPreviewHandle | null>(null);
    const [showCheckerboard, setShowCheckerboard] = useState<boolean>(false);
    const [isCropMode, setIsCropMode] = useState(false);
    const [hasValidCropSelection, setHasValidCropSelection] = useState(false);
    const [quantizeEnabled, setQuantizeEnabled] = useState<boolean>(false);
    const {
        isQuantizing,
        setIsQuantizing,
        isDedithering,
        setIsDedithering,
        processingLabel,
        setProcessingLabel,
        processingProgress,
        setProcessingProgress,
        processingIndeterminate,
        setProcessingIndeterminate,
    } = useProcessingState();
    const { applyQuantize } = useQuantize({
        algorithm,
        weight,
        finalColors,
        selectedPalette,
        customPalettes,
        imageSrc,
        quantizeEnabled,
        setImage: (u, push = true) => {
            invalidate();
            setImage(u, push);
        },
        onImmediateSwatches: (colors: SwatchEntry[]) => immediateOverride(colors),
        onProgress: (value) => {
            setProcessingProgress((prev) => (value > prev ? value : prev));
        },
        onStage: (stage) => {
            if (stage === 'final') {
                setProcessingIndeterminate(false);
            }
        },
    });

    // persistent (committed) adjustments applied on redraw. Key/value map.
    const [adjustments, setAdjustments] = useState<Record<string, number>>(ADJUSTMENT_DEFAULTS);
    // epoch counter to force remount of AdjustmentsPanel when we bake & reset
    const [adjustmentsEpoch, setAdjustmentsEpoch] = useState(0);
    // UI mode toggles (2D / 3D) - UI only for now
    const [mode, setMode] = useState<'2d' | '3d'>('2d');
    const [exportingSTL, setExportingSTL] = useState(false);
    const [exportProgress, setExportProgress] = useState(0); // 0..1
    // 3D printing shared state
    const {
        threeDState,
        setThreeDState,
        threeDBuildSignal,
        buildWarning,
        handleThreeDStateChange,
        confirmBuild,
        cancelBuild,
    } = useBuildWarning({ imageSrc });

    // Hydrate threeDState once with persisted autopaint data
    const [autopaintHydrated] = useState(() => {
        const persisted = loadAutoPaintPersisted();
        return persisted;
    });
    useEffect(() => {
        if (autopaintHydrated) {
            setThreeDState((prev) => ({
                ...prev,
                filaments: autopaintHydrated.filaments ?? prev.filaments,
                paintMode: autopaintHydrated.paintMode ?? prev.paintMode,
                optimizerAlgorithm: autopaintHydrated.optimizerAlgorithm ?? prev.optimizerAlgorithm,
                optimizerSeed: autopaintHydrated.optimizerSeed ?? prev.optimizerSeed,
                regionWeightingMode: autopaintHydrated.regionWeightingMode ?? prev.regionWeightingMode,
                enhancedColorMatch: autopaintHydrated.enhancedColorMatch ?? prev.enhancedColorMatch,
                allowRepeatedSwaps: autopaintHydrated.allowRepeatedSwaps ?? prev.allowRepeatedSwaps,
                heightDithering: autopaintHydrated.heightDithering ?? prev.heightDithering,
                ditherLineWidth: autopaintHydrated.ditherLineWidth ?? prev.ditherLineWidth,
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const prevModeRef = useRef<typeof mode>(mode);

    useEffect(() => {
        saveAutoPaintPersisted({
            filaments: threeDState.filaments,
            paintMode: threeDState.paintMode ?? 'manual',
            optimizerAlgorithm: threeDState.optimizerAlgorithm,
            optimizerSeed: threeDState.optimizerSeed,
            regionWeightingMode: threeDState.regionWeightingMode,
            enhancedColorMatch: threeDState.enhancedColorMatch,
            allowRepeatedSwaps: threeDState.allowRepeatedSwaps,
            heightDithering: threeDState.heightDithering,
            ditherLineWidth: threeDState.ditherLineWidth,
        });
    }, [
        threeDState.filaments,
        threeDState.paintMode,
        threeDState.optimizerAlgorithm,
        threeDState.optimizerSeed,
        threeDState.regionWeightingMode,
        threeDState.enhancedColorMatch,
        threeDState.allowRepeatedSwaps,
        threeDState.heightDithering,
        threeDState.ditherLineWidth,
    ]);

    // No auto-build on tab switch — the user must click "Build 3D Model" / "Apply Changes".
    useEffect(() => {
        prevModeRef.current = mode;
    }, [mode]);

    // removed duplicate syncing: manual changes to the numeric input should set Auto via onWeightChange
    // redraw when image changes
    useEffect(() => {
        canvasPreviewRef.current?.redraw();
    }, [imageSrc]);

    const handleFiles = (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Please upload an image file');
            return;
        }
        const url = URL.createObjectURL(file);
        invalidate();
        setImage(url, true);
    };

    // removed unused handlers (inline handlers used instead)

    const clear = () => {
        clearCurrent();
        if (inputRef.current) inputRef.current.value = '';
    };

    // splitter & layout management preserved below

    // wheel/pan handled in CanvasPreview
    // startPan handled in CanvasPreview
    // resize observer handled by CanvasPreview; keep for layout redraw hook
    // Layout splitter state
    const layoutRef = useRef<HTMLDivElement | null>(null);

    const dropzone = useDropzone({ enabled: mode === '2d', onFile: handleFiles });
    const { onExportImage, onExportStl, onExport3MF, onSwatchApply, onSwatchDelete } =
        useAppHandlers({
            canvasPreviewRef,
            imageSrc,
            invalidate,
            setImage,
            setExportingSTL,
            setExportProgress,
            exportingSTL,
            exportObjectToStlBlob,
            exportObjectTo3MFBlob: (obj, onProgress) =>
                exportObjectTo3MFBlob(obj, {
                    layerHeight: threeDState.layerHeight,
                    firstLayerHeight: threeDState.slicerFirstLayerHeight,
                    layerFilamentColors:
                        threeDState.paintMode === 'autopaint'
                            ? threeDState.autoPaintFilamentSwatches?.map((s) => s.hex)
                            : undefined,
                    onProgress,
                }),
            applyQuantize,
            swatches,
        });

    const processingActive = mode === '2d' && (isQuantizing || isDedithering);

    return (
        <div className="box-border text-inherit font-sans flex flex-col flex-1 min-w-0 max-w-full min-h-0 h-screen w-full">
            <Header
                onLoadTest={() => {
                    invalidate();
                    setImage(tdTestImg, true);
                }}
            />
            <div className="flex flex-1 min-h-0 w-full" ref={layoutRef}>
                <ResizableSplitter defaultSize={30} minSize={20} maxSize={50}>
                    <aside className="w-full bg-card border-r border-border flex flex-col min-h-0">
                        <ModeTabs mode={mode} onChange={setMode} />
                        <div className="flex-1 overflow-y-auto overflow-x-auto p-4">
                            {mode === '2d' ? (
                                <>
                                    <input
                                        ref={inputRef}
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => {
                                            if (e.target.files && e.target.files[0])
                                                handleFiles(e.target.files[0]);
                                        }}
                                        className="hidden-file-input"
                                    />
                                    {/* file input stays here (hidden); uploader buttons moved to preview actions */}
                                    <div className="space-y-4">
                                        <Card className="p-4 border border-border/50">
                                            <div className="flex items-center justify-between gap-2">
                                                <div>
                                                    <span className="font-semibold text-foreground">
                                                        启用量化
                                                    </span>
                                                    <p className="text-xs text-muted-foreground">
                                                        关闭时，量化结果不会覆盖原始图像（保留原始 PNG 像素以保证 swatches 一致性）
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={quantizeEnabled}
                                                    onCheckedChange={setQuantizeEnabled}
                                                />
                                            </div>
                                        </Card>
                                        <AdjustmentsPanel
                                            key={adjustmentsEpoch}
                                            defs={SLIDER_DEFS}
                                            initial={ADJUSTMENT_DEFAULTS}
                                            onCommit={(vals) => {
                                                setAdjustments(vals);
                                                // schedule a redraw
                                                requestAnimationFrame(() =>
                                                    canvasPreviewRef.current?.redraw()
                                                );
                                            }}
                                            onBake={async () => {
                                                if (!canvasPreviewRef.current) return;
                                                try {
                                                    const blob =
                                                        await canvasPreviewRef.current.exportAdjustedImageBlob?.();
                                                    if (!blob) return;
                                                    const url = URL.createObjectURL(blob);
                                                    invalidate();
                                                    setImage(url, true);
                                                    // After baking, reset adjustments state to defaults
                                                    setAdjustments(ADJUSTMENT_DEFAULTS);
                                                    setAdjustmentsEpoch((e) => e + 1);
                                                } catch (e) {
                                                    console.warn('Bake adjustments failed', e);
                                                }
                                            }}
                                        />
                                        <DeditherPanel
                                            canvasRef={canvasPreviewRef}
                                            onApplyResult={(url) => {
                                                invalidate();
                                                setImage(url, true);
                                            }}
                                            onWorkingChange={(working) => {
                                                setIsDedithering(working);
                                                if (working) {
                                                    setProcessingLabel('Dedithering...');
                                                    setProcessingProgress(0);
                                                    setProcessingIndeterminate(false);
                                                }
                                            }}
                                            onProgress={(value) => {
                                                setProcessingProgress((prev) =>
                                                    value > prev ? value : prev
                                                );
                                            }}
                                        />
                                        <ControlsPanel
                                            // finalColors controls postprocessing result count
                                            finalColors={finalColors}
                                            onFinalColorsChange={(n) => {
                                                setFinalColors(n);
                                                // changing the final colors should switch to auto palette
                                                setSelectedPalette('auto');
                                            }}
                                            // weight remains the algorithm parameter
                                            weight={weight}
                                            onWeightChange={(n) => {
                                                setWeight(n);
                                            }}
                                            algorithm={algorithm}
                                            setAlgorithm={setAlgorithm}
                                            onApply={async () => {
                                                if (isQuantizing) return;
                                                setIsQuantizing(true);
                                                setProcessingLabel('Quantizing...');
                                                setProcessingProgress(0);
                                                setProcessingIndeterminate(false);
                                                await new Promise((r) => requestAnimationFrame(r));
                                                try {
                                                    await applyQuantize(canvasPreviewRef);
                                                } finally {
                                                    setIsQuantizing(false);
                                                    setProcessingProgress(1);
                                                    setProcessingIndeterminate(false);
                                                }
                                            }}
                                            disabled={!imageSrc || isCropMode}
                                            applying={isQuantizing}
                                            weightDisabled={algorithm === 'none'}
                                            selectedPalette={selectedPalette}
                                            onPaletteSelect={(id, size) => {
                                                setSelectedPalette(id);
                                                // set the postprocess target to the palette size, but do not lock it
                                                if (id !== 'auto') setFinalColors(size);
                                            }}
                                            onReset={() => {
                                                setFinalColors(16);
                                                setWeight(128);
                                                setAlgorithm('kmeans');
                                                setSelectedPalette('auto');
                                            }}
                                            allPalettes={allPalettes}
                                            customPalettes={customPalettes}
                                            importFeedback={paletteImportFeedback}
                                            importInputRef={paletteImportInputRef}
                                            onCreatePalette={handleCreatePalette}
                                            onUpdatePalette={handleUpdatePalette}
                                            onDeletePalette={handleDeletePalette}
                                            onExportPalette={handleExportPalette}
                                            onImportPaletteFile={handleImportPaletteFile}
                                        />
                                        <SwatchesPanel
                                            swatches={swatches}
                                            loading={swatchesLoading}
                                            cap={SWATCH_CAP}
                                            onSwatchDelete={onSwatchDelete}
                                            onSwatchApply={onSwatchApply}
                                        />
                                    </div>
                                </>
                            ) : (
                                <ThreeDControls
                                    swatches={swatches}
                                    imageDimensions={imageDimensions}
                                    onChange={handleThreeDStateChange}
                                    onSettingsChange={(partial) =>
                                        setThreeDState((prev) => ({ ...prev, ...partial }))
                                    }
                                    persisted={threeDState}
                                />
                            )}
                        </div>
                    </aside>
                    <main className="h-full w-full bg-background flex flex-col min-h-0">
                        <div
                            className={`flex-1 relative min-h-0 w-full ${dropzone.dragOver ? 'bg-primary/20' : ''}`}
                            onDrop={dropzone.onDrop}
                            onDragOver={dropzone.onDragOver}
                            onDragLeave={dropzone.onDragLeave}
                        >
                            {mode === '2d' ? (
                                <>
                                    <CanvasPreview
                                        ref={canvasPreviewRef}
                                        imageSrc={imageSrc}
                                        isCropMode={isCropMode}
                                        showCheckerboard={showCheckerboard}
                                        adjustments={adjustments}
                                        onCropSelectionChange={setHasValidCropSelection}
                                    />
                                    {processingActive &&
                                        (() => {
                                            const progressPct = Math.max(
                                                0,
                                                Math.min(100, Math.round(processingProgress * 100))
                                            );
                                            const showPercent = !processingIndeterminate;
                                            const barWidth = showPercent
                                                ? `${progressPct}%`
                                                : '100%';
                                            return (
                                                <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm cursor-wait">
                                                    <div className="w-[260px] rounded-xl border border-border/60 bg-background/90 shadow-lg px-4 py-3">
                                                        <div className="text-sm font-semibold text-foreground">
                                                            {processingLabel || 'Processing...'}
                                                        </div>
                                                        <div className="mt-1 text-xs text-muted-foreground">
                                                            {showPercent
                                                                ? `${progressPct}%`
                                                                : 'Working...'}
                                                        </div>
                                                        <div className="mt-3 h-2 w-full rounded-full bg-muted">
                                                            <div
                                                                className={`h-2 rounded-full bg-primary ${
                                                                    showPercent
                                                                        ? 'transition-[width] duration-150'
                                                                        : 'animate-pulse'
                                                                }`}
                                                                style={{
                                                                    width: barWidth,
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                </>
                            ) : (
                                <>
                                    <ThreeDView
                                        imageSrc={imageSrc}
                                        baseSliceHeight={0}
                                        layerHeight={threeDState.layerHeight}
                                        slicerFirstLayerHeight={threeDState.slicerFirstLayerHeight}
                                        colorSliceHeights={threeDState.colorSliceHeights}
                                        colorOrder={threeDState.colorOrder}
                                        swatches={threeDState.filteredSwatches}
                                        pixelSize={threeDState.pixelSize}
                                        rebuildSignal={threeDBuildSignal}
                                        autoPaintEnabled={threeDState.paintMode === 'autopaint'}
                                        autoPaintTotalHeight={
                                            threeDState.autoPaintResult?.totalHeight
                                        }
                                        autoPaintFilamentOrder={
                                            threeDState.autoPaintResult?.filamentOrder
                                        }
                                        enhancedColorMatch={threeDState.enhancedColorMatch}
                                        heightDithering={threeDState.heightDithering}
                                        ditherLineWidth={threeDState.ditherLineWidth}
                                        smoothMeshing={threeDState.smoothMeshing}
                                    />
                                    {exportingSTL &&
                                        (() => {
                                            const pct = Math.max(
                                                0,
                                                Math.min(100, Math.round(exportProgress * 100))
                                            );
                                            const hasProgress = exportProgress > 0;
                                            return (
                                                <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm cursor-wait">
                                                    <div className="w-[260px] rounded-xl border border-border/60 bg-background/90 shadow-lg px-4 py-3">
                                                        <div className="text-sm font-semibold text-foreground">
                                                            Exporting model...
                                                        </div>
                                                        <div className="mt-1 text-xs text-muted-foreground">
                                                            {hasProgress ? `${pct}%` : 'Working...'}
                                                        </div>
                                                        <div className="mt-3 h-2 w-full rounded-full bg-muted">
                                                            <div
                                                                className={`h-2 rounded-full bg-primary ${hasProgress ? 'transition-[width] duration-150' : 'animate-pulse'}`}
                                                                style={{
                                                                    width: hasProgress
                                                                        ? `${pct}%`
                                                                        : '100%',
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                </>
                            )}
                            <PreviewActions
                                mode={mode}
                                canUndo={canUndo}
                                canRedo={canRedo}
                                isCropMode={isCropMode}
                                imageAvailable={!!imageSrc}
                                hasValidCropSelection={hasValidCropSelection}
                                exportingSTL={exportingSTL}
                                exportProgress={exportProgress}
                                onUndo={undo}
                                onRedo={redo}
                                onEnterCrop={() => imageSrc && setIsCropMode(true)}
                                onSaveCrop={async () => {
                                    if (!canvasPreviewRef.current) return;
                                    const blob =
                                        await canvasPreviewRef.current.exportCroppedImage();
                                    if (!blob) return;
                                    const url = URL.createObjectURL(blob);
                                    invalidate();
                                    setImage(url, true);
                                    setIsCropMode(false);
                                }}
                                onCancelCrop={() => setIsCropMode(false)}
                                onToggleCheckerboard={() => setShowCheckerboard((s) => !s)}
                                onPickFile={() => inputRef.current?.click()}
                                onClear={clear}
                                onExportImage={onExportImage}
                                onExportStl={onExportStl}
                                onExport3MF={onExport3MF}
                            />
                        </div>
                    </main>
                </ResizableSplitter>
            </div>

            {/* Build warning dialog */}
            <AlertDialog
                open={buildWarning !== null}
                onOpenChange={(open) => !open && cancelBuild()}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Performance Warning</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2">
                                <p>Building the 3D model may be slow due to:</p>
                                <ul className="list-disc pl-5 space-y-1">
                                    {buildWarning?.warnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                                <p>Do you want to continue?</p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmBuild}>Build Anyway</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Update checker for Tauri desktop app */}
            <UpdateChecker />
        </div>
    );
}

export default App;
