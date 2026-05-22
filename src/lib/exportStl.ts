// Three.js 对象的二进制 STL 导出器（Kromacut）
// 将对象的几何体（考虑世界变换）导出为二进制 STL Blob。
// 将所有 Mesh 后代合并到单个 STL 文件中。
import * as THREE from 'three';

export async function exportObjectToStlBlob(
    root: THREE.Object3D,
    onProgress?: (p: number) => void
): Promise<Blob>
{
    // 1. 收集所有网格
    const meshes: THREE.Mesh[] = [];
    root.updateMatrixWorld(true);
    root.traverse((obj) =>
    {
        if ((obj as THREE.Mesh).isMesh)
        {
            const m = obj as THREE.Mesh;
            if (m.geometry && m.visible)
            {
                meshes.push(m);
            }
        }
    });

    if (meshes.length === 0) throw new Error('No meshes found to export');

    // 2. 计算总大小
    let totalTris = 0;
    for (const mesh of meshes)
    {
        const geom = mesh.geometry;
        if (geom.index)
        {
            totalTris += geom.index.count / 3;
        }
        else if (geom.attributes.position)
        {
            totalTris += geom.attributes.position.count / 3;
        }
    }

    const headerBytes = 80;
    const triSize = 50;
    const totalBytes = headerBytes + 4 + totalTris * triSize;
    let buffer: ArrayBuffer;
    try
    {
        buffer = new ArrayBuffer(totalBytes);
    }
    catch
    {
        throw new Error('Allocation failed for binary STL buffer');
    }
    const view = new DataView(buffer);
    const headerStr = 'Kromacut Binary STL';
    for (let i = 0; i < headerStr.length && i < 80; i++) view.setUint8(i, headerStr.charCodeAt(i));
    view.setUint32(headerBytes, totalTris, true);

    const CHUNK = 5000; // 分块处理以让出 UI
    let offset = headerBytes + 4;
    let processedTris = 0;

    // 用于变换的辅助向量
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const n = new THREE.Vector3();
    const vAB = new THREE.Vector3();
    const vAC = new THREE.Vector3();

    // 3. 写入三角形
    for (const mesh of meshes)
    {
        const geom = mesh.geometry;
        const pos = geom.getAttribute('position');
        const index = geom.getIndex();
        const matrix = mesh.matrixWorld;

        // 如果需要光照则确保有法线，但 STL 通常会忽略它们或使用计算出的面法线
        // 我们在下面为 STL 文件即时计算面法线

        const count = index ? index.count : pos.count;

        for (let i = 0; i < count; i += 3)
        {
            // 获取索引
            let a, b, c;
            if (index)
            {
                a = index.getX(i);
                b = index.getX(i + 1);
                c = index.getX(i + 2);
            }
            else
            {
                a = i;
                b = i + 1;
                c = i + 2;
            }

            // 获取顶点并变换到世界空间
            vA.fromBufferAttribute(pos, a).applyMatrix4(matrix);
            vB.fromBufferAttribute(pos, b).applyMatrix4(matrix);
            vC.fromBufferAttribute(pos, c).applyMatrix4(matrix);

            // 计算法线
            vAB.subVectors(vB, vA);
            vAC.subVectors(vC, vA);
            n.crossVectors(vAB, vAC).normalize();

            // 写入缓冲区
            view.setFloat32(offset + 0, n.x, true);
            view.setFloat32(offset + 4, n.y, true);
            view.setFloat32(offset + 8, n.z, true);
            view.setFloat32(offset + 12, vA.x, true);
            view.setFloat32(offset + 16, vA.y, true);
            view.setFloat32(offset + 20, vA.z, true);
            view.setFloat32(offset + 24, vB.x, true);
            view.setFloat32(offset + 28, vB.y, true);
            view.setFloat32(offset + 32, vB.z, true);
            view.setFloat32(offset + 36, vC.x, true);
            view.setFloat32(offset + 40, vC.y, true);
            view.setFloat32(offset + 44, vC.z, true);
            view.setUint16(offset + 48, 0, true);
            offset += triSize;

            processedTris++;
            if (processedTris % CHUNK === 0 && onProgress)
            {
                onProgress(processedTris / totalTris);
                await new Promise((r) => setTimeout(r, 0));
            }
        }
    }

    if (onProgress) onProgress(1);
    return new Blob([buffer], { type: 'model/stl' });
}

export default exportObjectToStlBlob;
