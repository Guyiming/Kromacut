import { ShapeUtils, Vector2 } from 'three';

export interface MeshData {
    positions: Float32Array;
    indices: number[];
}

// ============================================================================
// 平滑轮廓网格化
// ============================================================================

const SMOOTH_SIMPLIFY_EPSILON = 0.75;
const SMOOTH_CHAIKIN_ITERATIONS = 2;
const SMOOTH_CHAIKIN_WEIGHT = 0.2;
const LOOP_EPSILON = 1e-6;

const pointDistanceSq = (a: Vector2, b: Vector2) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
};

function simplifyLoop(loop: Vector2[]): Vector2[] {
    let points = loop.filter(
        (point, index) =>
            index === 0 || pointDistanceSq(point, loop[index - 1]) > LOOP_EPSILON * LOOP_EPSILON
    );

    if (
        points.length > 1 &&
        pointDistanceSq(points[0], points[points.length - 1]) <= LOOP_EPSILON * LOOP_EPSILON
    ) {
        points = points.slice(0, -1);
    }

    let changed = true;
    while (changed && points.length >= 3) {
        changed = false;
        const nextPoints: Vector2[] = [];

        for (let i = 0; i < points.length; i++) {
            const prev = points[(i - 1 + points.length) % points.length];
            const curr = points[i];
            const next = points[(i + 1) % points.length];

            const ax = curr.x - prev.x;
            const ay = curr.y - prev.y;
            const bx = next.x - curr.x;
            const by = next.y - curr.y;
            const cross = ax * by - ay * bx;
            const dot = ax * bx + ay * by;

            if (Math.abs(cross) <= LOOP_EPSILON && dot >= 0) {
                changed = true;
                continue;
            }

            nextPoints.push(curr);
        }

        if (nextPoints.length >= 3) {
            points = nextPoints;
        } else {
            break;
        }
    }

    return points;
}

const perpendicularDistanceToLine = (point: Vector2, start: Vector2, end: Vector2) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq <= LOOP_EPSILON * LOOP_EPSILON) {
        return Math.sqrt(pointDistanceSq(point, start));
    }

    return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.sqrt(lenSq);
};

function ramerDouglasPeucker(points: Vector2[], epsilon: number): Vector2[] {
    if (points.length <= 2) return points.map((point) => point.clone());

    let maxDistance = -1;
    let splitIndex = -1;

    for (let i = 1; i < points.length - 1; i++) {
        const distance = perpendicularDistanceToLine(points[i], points[0], points[points.length - 1]);
        if (distance > maxDistance) {
            maxDistance = distance;
            splitIndex = i;
        }
    }

    if (maxDistance <= epsilon || splitIndex === -1) {
        return [points[0].clone(), points[points.length - 1].clone()];
    }

    const left = ramerDouglasPeucker(points.slice(0, splitIndex + 1), epsilon);
    const right = ramerDouglasPeucker(points.slice(splitIndex), epsilon);
    return [...left.slice(0, -1), ...right];
}

function selectLoopAnchor(loop: Vector2[]): number {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < loop.length; i++) {
        const prev = loop[(i - 1 + loop.length) % loop.length];
        const curr = loop[i];
        const next = loop[(i + 1) % loop.length];

        const ax = curr.x - prev.x;
        const ay = curr.y - prev.y;
        const bx = next.x - curr.x;
        const by = next.y - curr.y;
        const turn = Math.abs(ax * by - ay * bx);
        const span = Math.hypot(ax, ay) + Math.hypot(bx, by);
        const score = turn * 10 + span;

        if (
            score > bestScore ||
            (Math.abs(score - bestScore) <= LOOP_EPSILON &&
                (curr.y < loop[bestIndex].y ||
                    (curr.y === loop[bestIndex].y && curr.x < loop[bestIndex].x)))
        ) {
            bestScore = score;
            bestIndex = i;
        }
    }

    return bestIndex;
}

function simplifyAliasedLoop(loop: Vector2[]): Vector2[] {
    if (loop.length < 5) return loop.map((point) => point.clone());

    const anchor = selectLoopAnchor(loop);
    const rotated = [...loop.slice(anchor), ...loop.slice(0, anchor)];
    const simplified = ramerDouglasPeucker([...rotated, rotated[0]], SMOOTH_SIMPLIFY_EPSILON)
        .slice(0, -1);

    return simplified.length >= 3 ? simplifyLoop(simplified) : loop.map((point) => point.clone());
}

function chaikinSmoothLoop(loop: Vector2[]): Vector2[] {
    let points = loop.map((point) => point.clone());

    for (let iteration = 0; iteration < SMOOTH_CHAIKIN_ITERATIONS; iteration++) {
        if (points.length < 3) break;

        const next: Vector2[] = [];
        for (let i = 0; i < points.length; i++) {
            const current = points[i];
            const following = points[(i + 1) % points.length];
            const q = current.clone().lerp(following, SMOOTH_CHAIKIN_WEIGHT);
            const r = current.clone().lerp(following, 1 - SMOOTH_CHAIKIN_WEIGHT);

            if (
                next.length === 0 ||
                pointDistanceSq(q, next[next.length - 1]) > LOOP_EPSILON * LOOP_EPSILON
            ) {
                next.push(q);
            }
            if (
                next.length === 0 ||
                pointDistanceSq(r, next[next.length - 1]) > LOOP_EPSILON * LOOP_EPSILON
            ) {
                next.push(r);
            }
        }

        points = simplifyLoop(next);
    }

    return points.length >= 3 ? points : loop.map((point) => point.clone());
}

function smoothLoop(loop: Vector2[]): Vector2[] {
    const simplified = simplifyAliasedLoop(loop);
    return chaikinSmoothLoop(simplified);
}

function traceComponentLoops(
    componentCells: number[],
    activePixels: Uint8Array | Uint8ClampedArray | boolean[],
    width: number,
    height: number
): Vector2[][] {
    const stride = width + 1;

    interface BoundaryEdge {
        id: number;
        start: number;
        end: number;
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        direction: number;
    }

    const edges: BoundaryEdge[] = [];
    const edgesByStart = new Map<number, BoundaryEdge[]>();
    const addEdge = (sx: number, sy: number, ex: number, ey: number) => {
        const id = edges.length;
        const edge = {
            id,
            start: sy * stride + sx,
            end: ey * stride + ex,
            startX: sx,
            startY: sy,
            endX: ex,
            endY: ey,
            direction: ex > sx ? 0 : ey > sy ? 1 : ex < sx ? 2 : 3,
        };

        edges.push(edge);
        const outgoing = edgesByStart.get(edge.start);
        if (outgoing) {
            outgoing.push(edge);
        } else {
            edgesByStart.set(edge.start, [edge]);
        }
    };

    for (const cell of componentCells) {
        const x = cell % width;
        const y = Math.floor(cell / width);

        if (y === 0 || !activePixels[(y - 1) * width + x]) {
            addEdge(x, y, x + 1, y);
        }
        if (x === width - 1 || !activePixels[y * width + (x + 1)]) {
            addEdge(x + 1, y, x + 1, y + 1);
        }
        if (y === height - 1 || !activePixels[(y + 1) * width + x]) {
            addEdge(x + 1, y + 1, x, y + 1);
        }
        if (x === 0 || !activePixels[y * width + (x - 1)]) {
            addEdge(x, y + 1, x, y);
        }
    }

    const visitedEdges = new Uint8Array(edges.length);
    const loops: Vector2[][] = [];
    const turnPriority = [3, 0, 1, 2]; // 左转、直行、右转，最后回头

    const selectNextEdge = (edge: BoundaryEdge): BoundaryEdge | undefined => {
        const outgoing = edgesByStart.get(edge.end);
        if (!outgoing) return undefined;

        for (const turn of turnPriority) {
            const wantedDirection = (edge.direction + turn) & 3;
            const next = outgoing.find(
                (candidate) =>
                    !visitedEdges[candidate.id] && candidate.direction === wantedDirection
            );
            if (next) return next;
        }

        return undefined;
    };

    for (const startEdge of edges) {
        if (visitedEdges[startEdge.id]) continue;

        const loop: Vector2[] = [];
        let current = startEdge;
        let closed = false;
        let guard = 0;

        while (!visitedEdges[current.id] && guard <= edges.length) {
            visitedEdges[current.id] = 1;
            loop.push(new Vector2(current.startX, current.startY));

            if (current.end === startEdge.start) {
                closed = true;
                break;
            }

            const next = selectNextEdge(current);
            if (!next) break;
            current = next;
            guard++;
        }

        if (closed && loop.length >= 3) {
            loops.push(simplifyLoop(loop));
        }
    }

    return loops;
}

function addExtrudedLoopWalls(
    indices: number[],
    baseVert: number,
    topVertexCount: number,
    loopOffset: number,
    loop: Vector2[]
) {
    const isClockwise = ShapeUtils.isClockWise(loop);

    for (let i = 0; i < loop.length; i++) {
        const topA = baseVert + loopOffset + i;
        const topB = baseVert + loopOffset + ((i + 1) % loop.length);
        const bottomA = baseVert + topVertexCount + loopOffset + i;
        const bottomB = baseVert + topVertexCount + loopOffset + ((i + 1) % loop.length);

        if (isClockwise) {
            indices.push(topA, topB, bottomB);
            indices.push(topA, bottomB, bottomA);
        } else {
            indices.push(topA, bottomB, topB);
            indices.push(topA, bottomA, bottomB);
        }
    }
}

/**
 * 通过提取精确的体素边界并对凸角进行圆滑处理，生成平滑网格。
 * 该方法在保持拓扑结构的同时，比原始体素挤出生成的对角边更干净。
 */
export async function generateSmoothMesh(
    activePixels: Uint8Array | Uint8ClampedArray | boolean[],
    width: number,
    height: number,
    thickness: number,
    zOffset: number,
    pixelSize: number,
    heightScale: number,
    options?: MeshYieldOptions
): Promise<MeshData> {
    const positions: number[] = [];
    const indices: number[] = [];

    const yieldControl =
        options?.onYield ??
        (() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }));
    const yieldIntervalMs = options?.yieldIntervalMs ?? 8;
    let lastYield = performance.now();
    const maybeYield = async () => {
        if (performance.now() - lastYield >= yieldIntervalMs) {
            await yieldControl();
            lastYield = performance.now();
        }
    };

    const scaledThickness = thickness * heightScale;
    const scaledZOffset = zOffset * heightScale;
    const zBottom = scaledZOffset;
    const zTop = scaledZOffset + scaledThickness;

    const visited = new Uint8Array(width * height);
    const queue: number[] = [];

    for (let start = 0; start < activePixels.length; start++) {
        if (!activePixels[start] || visited[start]) continue;

        const componentCells: number[] = [];
        queue.length = 0;
        queue.push(start);
        visited[start] = 1;

        for (let head = 0; head < queue.length; head++) {
            const cell = queue[head];
            componentCells.push(cell);

            const x = cell % width;
            const y = Math.floor(cell / width);
            const north = cell - width;
            const south = cell + width;
            const west = cell - 1;
            const east = cell + 1;

            if (y > 0 && activePixels[north] && !visited[north]) {
                visited[north] = 1;
                queue.push(north);
            }
            if (y + 1 < height && activePixels[south] && !visited[south]) {
                visited[south] = 1;
                queue.push(south);
            }
            if (x > 0 && activePixels[west] && !visited[west]) {
                visited[west] = 1;
                queue.push(west);
            }
            if (x + 1 < width && activePixels[east] && !visited[east]) {
                visited[east] = 1;
                queue.push(east);
            }

            if ((head & 255) === 0) {
                await maybeYield();
            }
        }

        const loops = traceComponentLoops(componentCells, activePixels, width, height)
            .filter((loop) => loop.length >= 3)
            .sort((a, b) => Math.abs(ShapeUtils.area(b)) - Math.abs(ShapeUtils.area(a)));

        if (loops.length === 0) {
            await maybeYield();
            continue;
        }

        const exactOuter = loops[0].map((point) => point.clone());
        if (!ShapeUtils.isClockWise(exactOuter)) {
            exactOuter.reverse();
        }

        const exactHoles = loops.slice(1).map((loop) => {
            const normalized = loop.map((point) => point.clone());
            if (ShapeUtils.isClockWise(normalized)) {
                normalized.reverse();
            }
            return normalized;
        });

        const smoothOuter = smoothLoop(exactOuter);
        const smoothHoles = exactHoles.map(smoothLoop);

        if (!ShapeUtils.isClockWise(smoothOuter)) {
            smoothOuter.reverse();
        }
        for (const hole of smoothHoles) {
            if (ShapeUtils.isClockWise(hole)) {
                hole.reverse();
            }
        }

        let topLoops = [smoothOuter, ...smoothHoles].filter((loop) => loop.length >= 3);
        if (topLoops.length === 0) {
            await maybeYield();
            continue;
        }

        let contour = topLoops[0];
        let holeLoops = topLoops.slice(1);
        let faces = ShapeUtils.triangulateShape(contour, holeLoops);

        if (faces.length === 0) {
            topLoops = [exactOuter, ...exactHoles].filter((loop) => loop.length >= 3);
            contour = topLoops[0];
            holeLoops = topLoops.slice(1);
            faces = contour ? ShapeUtils.triangulateShape(contour, holeLoops) : [];
        }

        if (faces.length === 0) {
            return generateGreedyMesh(
                activePixels,
                width,
                height,
                thickness,
                zOffset,
                pixelSize,
                heightScale,
                options
            );
        }

        const topVertices = [contour, ...holeLoops].flat();
        const topVertexCount = topVertices.length;
        const baseVert = positions.length / 3;

        for (const point of topVertices) {
            positions.push(point.x * pixelSize, point.y * pixelSize, zTop);
        }
        for (const point of topVertices) {
            positions.push(point.x * pixelSize, point.y * pixelSize, zBottom);
        }

        for (const [a, b, c] of faces) {
            indices.push(baseVert + a, baseVert + b, baseVert + c);
            indices.push(
                baseVert + topVertexCount + a,
                baseVert + topVertexCount + c,
                baseVert + topVertexCount + b
            );
        }

        let loopOffset = 0;
        for (const loop of topLoops) {
            addExtrudedLoopWalls(indices, baseVert, topVertexCount, loopOffset, loop);
            loopOffset += loop.length;
        }

        await maybeYield();
    }

    return {
        positions: new Float32Array(positions),
        indices,
    };
}

interface MeshYieldOptions {
    yieldIntervalMs?: number;
    onYield?: () => Promise<void>;
}

/**
 * 使用最大矩形贪心网格化算法为体素状像素层生成优化的 3D 网格。
 * 该方法通过将活动区域合并成大矩形来最小化三角形数量。
 *
 * T 形接缝预防：墙体在单独的全局阶段中生成，以确保所有墙体顶点正确对齐，
 * 防止产生非流形边，从而避免切片器伪影。
 *
 * 坐标系：X+ 向右，Y+ 向下（图像坐标），Z+ 向上
 * 当从外部观察时，所有面均使用 CCW（逆时针）绕序（外法线右手定则）
 *
 * @param activePixels 行优先数组，> 0 表示该位置存在像素
 * @param width 像素网格的宽度
 * @param height 像素网格的高度
 * @param thickness 层的厚度（Z 方向高度）
 * @param zOffset 层的基础 Z 高度
 * @param pixelSize XY 缩放因子（通常为每像素的毫米数）
 * @param heightScale Z 方向缩放因子
 */
export async function generateGreedyMesh(
    activePixels: Uint8Array | Uint8ClampedArray | boolean[],
    width: number,
    height: number,
    thickness: number,
    zOffset: number,
    pixelSize: number,
    heightScale: number,
    options?: MeshYieldOptions
): Promise<MeshData> {
    const positions: number[] = [];
    const indices: number[] = [];
    let vertCount = 0;

    const yieldIntervalMs = options?.yieldIntervalMs ?? 8;
    const yieldControl =
        options?.onYield ??
        (() =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            }));
    let lastYield = performance.now();
    const maybeYield = async () => {
        const now = performance.now();
        if (now - lastYield >= yieldIntervalMs) {
            await yieldControl();
            lastYield = performance.now();
        }
    };

    // 顶点焊接表：键 = y * (width + 1) + x
    const topMap = new Map<number, number>();
    const bottomMap = new Map<number, number>();
    const stride = width + 1;

    const scaledThickness = thickness * heightScale;
    const scaledZOffset = zOffset * heightScale;
    const zBottom = scaledZOffset;
    const zTop = scaledZOffset + scaledThickness;

    // --- 辅助函数：顶点焊接 ---
    const getOrAddVertex = (x: number, y: number, isTop: boolean): number => {
        const key = y * stride + x;
        const map = isTop ? topMap : bottomMap;
        let idx = map.get(key);
        if (idx !== undefined) return idx;

        idx = vertCount++;
        map.set(key, idx);
        positions.push(x * pixelSize, y * pixelSize, isTop ? zTop : zBottom);
        return idx;
    };

    // 添加一个 CCW 绕序的四边形（从外部看时 v0 -> v1 -> v2 -> v3 应为 CCW）
    const addQuadCCW = (v0: number, v1: number, v2: number, v3: number) => {
        // 两个三角形：(v0, v1, v2) 和 (v0, v2, v3)
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // --- 首先收集所有贪心矩形 ---
    interface Rect {
        x: number;
        y: number;
        w: number;
        h: number;
    }
    const rectangles: Rect[] = [];
    const visited = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (activePixels[idx] && !visited[idx]) {
                // 1. 寻找最大宽度
                let w = 1;
                while (
                    x + w < width &&
                    activePixels[y * width + (x + w)] &&
                    !visited[y * width + (x + w)]
                ) {
                    w++;
                }

                // 2. 在该宽度下寻找最大高度
                let h = 1;
                let canExpand = true;
                while (y + h < height && canExpand) {
                    for (let k = 0; k < w; k++) {
                        const nextIdx = (y + h) * width + (x + k);
                        if (!activePixels[nextIdx] || visited[nextIdx]) {
                            canExpand = false;
                            break;
                        }
                    }
                    if (canExpand) h++;
                }

                // 3. 标记为已访问
                for (let dy = 0; dy < h; dy++) {
                    const rowOff = (y + dy) * width;
                    for (let dx = 0; dx < w; dx++) {
                        visited[rowOff + x + dx] = 1;
                    }
                }

                rectangles.push({ x, y, w, h });
            }
        }
        await maybeYield();
    }

    // --- 为墙体构建全局顶点需求集合 ---
    // 这些集合追踪每个 y 上水平边所需的所有 x 坐标，
    // 以及每个 x 上垂直边所需的所有 y 坐标
    // 这确保了墙体能在 T 形接缝点处被细分

    // 用于北/南墙：verticesAtY[y] = 该 y 上存在顶点的 x 坐标集合
    const verticesAtY = new Map<number, Set<number>>();
    // 用于西/东墙：verticesAtX[x] = 该 x 上存在顶点的 y 坐标集合
    const verticesAtX = new Map<number, Set<number>>();

    // 第一遍：收集所有矩形的角点顶点
    for (const rect of rectangles) {
        const { x, y, w, h } = rect;

        // 在每个 y 坐标上为四个角添加顶点
        for (const yCoord of [y, y + h]) {
            if (!verticesAtY.has(yCoord)) verticesAtY.set(yCoord, new Set());
            verticesAtY.get(yCoord)!.add(x);
            verticesAtY.get(yCoord)!.add(x + w);
        }

        // 在每个 x 坐标上为四个角添加顶点
        for (const xCoord of [x, x + w]) {
            if (!verticesAtX.has(xCoord)) verticesAtX.set(xCoord, new Set());
            verticesAtX.get(xCoord)!.add(y);
            verticesAtX.get(xCoord)!.add(y + h);
        }

        await maybeYield();
    }

    // --- 为每个矩形生成顶面和底面 ---

    // 预先排序顶点以加快范围查询
    const sortedVerticesAtY = new Map<number, number[]>();
    for (const [y, set] of verticesAtY) {
        sortedVerticesAtY.set(y, Array.from(set).sort((a, b) => a - b));
        await maybeYield();
    }
    const sortedVerticesAtX = new Map<number, number[]>();
    for (const [x, set] of verticesAtX) {
        sortedVerticesAtX.set(x, Array.from(set).sort((a, b) => a - b));
        await maybeYield();
    }

    const lowerBound = (arr: number[], target: number) => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const upperBound = (arr: number[], target: number) => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    for (const rect of rectangles) {
        const { x, y, w, h } = rect;

        const topLine = sortedVerticesAtY.get(y)!;
        const rightLine = sortedVerticesAtX.get(x + w)!;
        const bottomLine = sortedVerticesAtY.get(y + h)!;
        const leftLine = sortedVerticesAtX.get(x)!;

        const topLo = lowerBound(topLine, x);
        const topHi = upperBound(topLine, x + w);
        const rightLo = lowerBound(rightLine, y);
        const rightHi = upperBound(rightLine, y + h);
        const bottomLo = lowerBound(bottomLine, x);
        const bottomHi = upperBound(bottomLine, x + w);
        const leftLo = lowerBound(leftLine, y);
        const leftHi = upperBound(leftLine, y + h);

        const boundary: Array<[number, number]> = [];

        // 顶边：x -> x+w （不含最后一点）
        for (let i = topLo; i < topHi - 1; i++) {
            boundary.push([topLine[i], y]);
        }
        // 右边：y -> y+h （不含最后一点）
        for (let i = rightLo; i < rightHi - 1; i++) {
            boundary.push([x + w, rightLine[i]]);
        }
        // 底边：x+w -> x （不含最后一点）
        for (let i = bottomHi - 1; i > bottomLo; i--) {
            boundary.push([bottomLine[i], y + h]);
        }
        // 左边：y+h -> y （不含最后一点）
        for (let i = leftHi - 1; i > leftLo; i--) {
            boundary.push([x, leftLine[i]]);
        }

        if (boundary.length < 3) continue;

        const topLoop: number[] = new Array(boundary.length);
        const bottomLoop: number[] = new Array(boundary.length);
        for (let i = 0; i < boundary.length; i++) {
            const [vx, vy] = boundary[i];
            topLoop[i] = getOrAddVertex(vx, vy, true);
            bottomLoop[i] = getOrAddVertex(vx, vy, false);
        }

        // 三角化（从第一个顶点扇形展开） - 形状为凸
        // 顶面（法线 +Z，CCW）
        const t0 = topLoop[0];
        for (let i = 1; i < topLoop.length - 1; i++) {
            indices.push(t0, topLoop[i], topLoop[i + 1]);
        }

        // 底面（法线 -Z，从外部观察需要 CW 绕序）
        // 我们使用相同的 CCW 循环，但以 (v0, v2, v1) 的形式压入索引
        const b0 = bottomLoop[0];
        for (let i = 1; i < bottomLoop.length - 1; i++) {
            indices.push(b0, bottomLoop[i + 1], bottomLoop[i]);
        }

        await maybeYield();
    }

    // --- 全局墙体生成 ---
    // 以像素粒度收集所有墙体段，然后在合并时考虑所有顶点

    // 北墙（朝向 -Y）：在 pixel[y] 为活动而 pixel[y-1] 不活动的 y 处
    // Map: y -> 该处需要北墙的 x 坐标排序列表
    const northWalls = new Map<number, number[]>();
    // 南墙（朝向 +Y）：在 pixel[y-1] 为活动而 pixel[y] 不活动的 y 处
    const southWalls = new Map<number, number[]>();
    // 西墙（朝向 -X）：在 pixel[x] 为活动而 pixel[x-1] 不活动的 x 处
    const westWalls = new Map<number, number[]>();
    // 东墙（朝向 +X）：在 pixel[x-1] 为活动而 pixel[x] 不活动的 x 处
    const eastWalls = new Map<number, number[]>();

    // 扫描所有墙体边
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!activePixels[y * width + x]) continue;

            // 上方无邻居时需要北墙
            if (y === 0 || !activePixels[(y - 1) * width + x]) {
                if (!northWalls.has(y)) northWalls.set(y, []);
                northWalls.get(y)!.push(x);
            }

            // 下方无邻居时需要南墙
            if (y === height - 1 || !activePixels[(y + 1) * width + x]) {
                const wallY = y + 1;
                if (!southWalls.has(wallY)) southWalls.set(wallY, []);
                southWalls.get(wallY)!.push(x);
            }

            // 左方无邻居时需要西墙
            if (x === 0 || !activePixels[y * width + (x - 1)]) {
                if (!westWalls.has(x)) westWalls.set(x, []);
                westWalls.get(x)!.push(y);
            }

            // 右方无邻居时需要东墙
            if (x === width - 1 || !activePixels[y * width + (x + 1)]) {
                const wallX = x + 1;
                if (!eastWalls.has(wallX)) eastWalls.set(wallX, []);
                eastWalls.get(wallX)!.push(y);
            }
        }

        await maybeYield();
    }

    // 辅助函数：合并墙体段，同时考虑顶点位置
    const mergeAndEmitHorizontalWalls = (
        wallMap: Map<number, number[]>,
        yCoord: number,
        isSouth: boolean
    ) => {
        const xCoords = wallMap.get(yCoord);
        if (!xCoords || xCoords.length === 0) return;

        xCoords.sort((a, b) => a - b);

        // 获取该 y 上必须存在顶点的所有 x 坐标
        const requiredVertices = verticesAtY.get(yCoord) || new Set<number>();

        let runStart = xCoords[0];
        let runEnd = runStart + 1;

        for (let i = 1; i <= xCoords.length; i++) {
            const nextX = i < xCoords.length ? xCoords[i] : -1;
            const isContiguous = nextX === runEnd;
            const mustSplit = requiredVertices.has(runEnd) && isContiguous;

            if (!isContiguous || mustSplit || i === xCoords.length) {
                // 输出从 runStart 到 runEnd 的墙体段
                if (isSouth) {
                    // 南墙（朝向 +Y）
                    const wTL = getOrAddVertex(runStart, yCoord, true);
                    const wTR = getOrAddVertex(runEnd, yCoord, true);
                    const wBR = getOrAddVertex(runEnd, yCoord, false);
                    const wBL = getOrAddVertex(runStart, yCoord, false);
                    addQuadCCW(wBL, wTL, wTR, wBR);
                } else {
                    // 北墙（朝向 -Y）
                    const wTL = getOrAddVertex(runStart, yCoord, true);
                    const wTR = getOrAddVertex(runEnd, yCoord, true);
                    const wBR = getOrAddVertex(runEnd, yCoord, false);
                    const wBL = getOrAddVertex(runStart, yCoord, false);
                    addQuadCCW(wBR, wTR, wTL, wBL);
                }

                if (mustSplit && isContiguous) {
                    // 从分割点继续
                    runStart = runEnd;
                    runEnd = runStart + 1;
                } else if (i < xCoords.length) {
                    runStart = nextX;
                    runEnd = runStart + 1;
                }
            } else {
                runEnd = nextX + 1;
            }
        }
    };

    const mergeAndEmitVerticalWalls = (
        wallMap: Map<number, number[]>,
        xCoord: number,
        isEast: boolean
    ) => {
        const yCoords = wallMap.get(xCoord);
        if (!yCoords || yCoords.length === 0) return;

        yCoords.sort((a, b) => a - b);

        // 获取该 x 上必须存在顶点的所有 y 坐标
        const requiredVertices = verticesAtX.get(xCoord) || new Set<number>();

        let runStart = yCoords[0];
        let runEnd = runStart + 1;

        for (let i = 1; i <= yCoords.length; i++) {
            const nextY = i < yCoords.length ? yCoords[i] : -1;
            const isContiguous = nextY === runEnd;
            const mustSplit = requiredVertices.has(runEnd) && isContiguous;

            if (!isContiguous || mustSplit || i === yCoords.length) {
                // 输出从 runStart 到 runEnd 的墙体段
                if (isEast) {
                    // 东墙（朝向 +X）
                    const wTL = getOrAddVertex(xCoord, runStart, true);
                    const wTR = getOrAddVertex(xCoord, runEnd, true);
                    const wBR = getOrAddVertex(xCoord, runEnd, false);
                    const wBL = getOrAddVertex(xCoord, runStart, false);
                    addQuadCCW(wBR, wTR, wTL, wBL);
                } else {
                    // 西墙（朝向 -X）
                    const wTL = getOrAddVertex(xCoord, runStart, true);
                    const wTR = getOrAddVertex(xCoord, runEnd, true);
                    const wBR = getOrAddVertex(xCoord, runEnd, false);
                    const wBL = getOrAddVertex(xCoord, runStart, false);
                    addQuadCCW(wBL, wTL, wTR, wBR);
                }

                if (mustSplit && isContiguous) {
                    // 从分割点继续
                    runStart = runEnd;
                    runEnd = runStart + 1;
                } else if (i < yCoords.length) {
                    runStart = nextY;
                    runEnd = runStart + 1;
                }
            } else {
                runEnd = nextY + 1;
            }
        }
    };

    // 输出所有墙体
    for (const [y] of northWalls) {
        mergeAndEmitHorizontalWalls(northWalls, y, false);
        await maybeYield();
    }
    for (const [y] of southWalls) {
        mergeAndEmitHorizontalWalls(southWalls, y, true);
        await maybeYield();
    }
    for (const [x] of westWalls) {
        mergeAndEmitVerticalWalls(westWalls, x, false);
        await maybeYield();
    }
    for (const [x] of eastWalls) {
        mergeAndEmitVerticalWalls(eastWalls, x, true);
        await maybeYield();
    }

    return {
        positions: new Float32Array(positions),
        indices: indices,
    };
}
