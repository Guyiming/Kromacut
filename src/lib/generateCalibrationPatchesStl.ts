/**
 * 生成包含一行平面方形测试色块的二进制 STL blob，
 * 每个层数对应一个色块。每个色块为 20×20mm，高度 = layerCount × layerHeight。
 * 色块沿 X 轴排列，间隔为 5mm。
 *
 * 不依赖 Three.js — 直接写入二进制 STL。
 */

const PATCH_SIZE = 20; // 毫米

/** 在指定字节偏移处以小端方式写入 float32 */
function setF32(view: DataView, offset: number, value: number) {
    view.setFloat32(offset, value, true);
}

/** 写入一个 STL 三角形（50 字节） */
function writeTriangle(
    view: DataView,
    offset: number,
    nx: number, ny: number, nz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
) {
    setF32(view, offset,      nx); setF32(view, offset + 4,  ny); setF32(view, offset + 8,  nz);
    setF32(view, offset + 12, ax); setF32(view, offset + 16, ay); setF32(view, offset + 20, az);
    setF32(view, offset + 24, bx); setF32(view, offset + 28, by); setF32(view, offset + 32, bz);
    setF32(view, offset + 36, cx); setF32(view, offset + 40, cy); setF32(view, offset + 44, cz);
    view.setUint16(offset + 48, 0, true);
}

/**
 * 写入一个长方体的全部 12 个三角形。
 * 角点位于 (x0, 0, z0)，尺寸为 (w, d, h)。Z 为构建方向。
 */
function writeBox(view: DataView, offset: number, x0: number, w: number, h: number, d: number, z0 = 0): number {
    const x1 = x0 + w, y1 = d, z1 = z0 + h;

    // 底面（Z=z0，法线 -Z）
    offset = writeFace(view, offset,  0,  0, -1,   x0,0,z0,  x1,y1,z0, x1,0,z0);
    offset = writeFace(view, offset,  0,  0, -1,   x0,0,z0,  x0,y1,z0, x1,y1,z0);
    // 顶面（Z=z1，法线 +Z）
    offset = writeFace(view, offset,  0,  0,  1,   x0,0,z1,  x1,0,z1,  x1,y1,z1);
    offset = writeFace(view, offset,  0,  0,  1,   x0,0,z1,  x1,y1,z1, x0,y1,z1);
    // 前面（Y=0，法线 -Y）
    offset = writeFace(view, offset,  0, -1,  0,   x0,0,z0,  x1,0,z0,  x1,0,z1);
    offset = writeFace(view, offset,  0, -1,  0,   x0,0,z0,  x1,0,z1,  x0,0,z1);
    // 后面（Y=d，法线 +Y）
    offset = writeFace(view, offset,  0,  1,  0,   x0,y1,z0, x1,y1,z1, x1,y1,z0);
    offset = writeFace(view, offset,  0,  1,  0,   x0,y1,z0, x0,y1,z1, x1,y1,z1);
    // 左面（X=x0，法线 -X）
    offset = writeFace(view, offset, -1,  0,  0,   x0,0,z0,  x0,0,z1,  x0,y1,z1);
    offset = writeFace(view, offset, -1,  0,  0,   x0,0,z0,  x0,y1,z1, x0,y1,z0);
    // 右面（X=x1，法线 +X）
    offset = writeFace(view, offset,  1,  0,  0,   x1,0,z0,  x1,y1,z0, x1,y1,z1);
    offset = writeFace(view, offset,  1,  0,  0,   x1,0,z0,  x1,y1,z1, x1,0,z1);

    return offset;
}

function writeFace(
    view: DataView, offset: number,
    nx: number, ny: number, nz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): number {
    writeTriangle(view, offset, nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz);
    return offset + 50;
}

export function generateCalibrationPatchesStl(
    layerCounts: number[],
    layerHeight: number,
): Blob {
    const TRIS_PER_BOX = 12;
    const totalTris = layerCounts.length * TRIS_PER_BOX;
    const buffer = new ArrayBuffer(80 + 4 + totalTris * 50);
    const view = new DataView(buffer);

    const header = 'Kromacut Calibration Patches';
    for (let i = 0; i < header.length && i < 80; i++) view.setUint8(i, header.charCodeAt(i));
    view.setUint32(80, totalTris, true);

    let offset = 84;
    layerCounts.forEach((count, i) => {
        const x0 = i * PATCH_SIZE;
        const patchHeight = count * layerHeight;
        offset = writeBox(view, offset, x0, PATCH_SIZE, patchHeight, PATCH_SIZE);
    });

    return new Blob([buffer], { type: 'model/stl' });
}
