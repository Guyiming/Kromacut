import JSZip from 'jszip';
import * as THREE from 'three';
import { MINIMAL_PROJECT_SETTINGS, KROMACUT_CONFIG } from './slicerDefaults';

export interface Export3MFOptions {
    layerHeight?: number;
    firstLayerHeight?: number;
    layerFilamentColors?: string[]; // 可选的每层耗材颜色（十六进制），用于导出
    onProgress?: (progress: number) => void;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0,
            v = c == 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function exportObjectTo3MFBlob(
    root: THREE.Object3D,
    options?: Export3MFOptions
): Promise<Blob> {
    const zip = new JSZip();

    // [Content_Types].xml
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="config" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
    zip.file('[Content_Types].xml', contentTypes);

    // _rels/.rels
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Metadata/model_settings.config" Id="rel1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    zip.folder('_rels')?.file('.rels', rels);

    // 收集网格
    const meshes: THREE.Mesh[] = [];
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            if (m.geometry && m.visible) {
                meshes.push(m);
            }
        }
    });

    if (meshes.length === 0) throw new Error('No meshes to export');

    // 收集材质（颜色）
    // 我们将十六进制字符串映射到 basematerials 中的索引
    const colorMap = new Map<string, number>();
    const colors: string[] = [];

    const normalizeHex = (hex?: string): string | null => {
        if (!hex) return null;
        const cleaned = hex.replace('#', '').toUpperCase();
        return cleaned.length === 6 ? cleaned : null;
    };

    const getMaterialIndex = (
        material: THREE.Material | THREE.Material[],
        overrideHex?: string
    ): number => {
        const mat = Array.isArray(material) ? material[0] : material;
        let hex = normalizeHex(overrideHex) || 'FFFFFF';
        if (!overrideHex && 'color' in mat && (mat as THREE.MeshStandardMaterial).color) {
            hex = (mat as THREE.MeshStandardMaterial).color.getHexString().toUpperCase();
        }
        if (!colorMap.has(hex)) {
            colorMap.set(hex, colors.length);
            colors.push(hex);
        }
        return colorMap.get(hex)!;
    };

    // 预先计算所有材质，以便正确写入头部
    for (let i = 0; i < meshes.length; i++) {
        const overrideHex = options?.layerFilamentColors?.[i];
        getMaterialIndex(meshes[i].material, overrideHex);
    }

    // 准备项目设置（最小化）
    const projectSettings = { ...MINIMAL_PROJECT_SETTINGS };

    // 应用用户选项
    if (options?.layerHeight) {
        projectSettings.layer_height = options.layerHeight.toString();
    }
    if (options?.firstLayerHeight) {
        projectSettings.initial_layer_print_height = options.firstLayerHeight.toString();
    }

    // 应用颜色 / 耗材
    // 如果未找到颜色则确保至少有一种（回退到白色）
    const exportColors = colors.length > 0 ? colors : ['FFFFFF'];

    // 用于扩展数组以匹配颜色数量的辅助函数
    const expand = (val: string, count: number) => Array(count).fill(val);

    projectSettings.filament_colour = exportColors.map((c) => '#' + c);

    projectSettings.filament_type = expand('PLA', exportColors.length);

    projectSettings.filament_settings_id = expand(
        'Generic PLA @Kromacut 0.4 nozzle',
        exportColors.length
    );

    projectSettings.filament_vendor = expand('Generic', exportColors.length);

    // 使用分块写入器构建对象资源，以避免在处理大型数组时出现 OOM
    const xmlParts: string[] = [];
    let currentChunk = '';
    // 将块大小减小到 10MB，以更安全地处理字符串拼接限制和内存压力
    const CHUNK_SIZE = 10 * 1024 * 1024;

    const write = (str: string) => {
        currentChunk += str;
        if (currentChunk.length > CHUNK_SIZE) {
            xmlParts.push(currentChunk);
            currentChunk = '';
        }
    };

    // ID：1 = BaseMaterials，2..N = Objects
    const baseMatId = 1;
    let nextId = 2;

    // 浮点数格式化辅助函数 — 优化以避免字符串分配（toFixed/replace）
    const f = (n: number) => {
        // 四舍五入到 5 位小数
        return (Math.round(n * 100000) / 100000).toString();
    };

    // 向量辅助变量
    const v = new THREE.Vector3();

    // 存储已生成的网格对象的 ID，以便稍后将它们分组
    const componentIds: number[] = [];
    // 为 model_settings.config 存储元数据
    const componentMeta: { id: number; name: string; colorIdx: number }[] = [];

    // 头部和 BaseMaterials
    let header = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Application">Kromacut_Print</metadata>
`;
    if (options?.layerHeight !== undefined) {
        header += ` <metadata name="slic3rpe:layer_height">${options.layerHeight}</metadata>
`;
    }
    if (options?.firstLayerHeight !== undefined) {
        header += ` <metadata name="slic3rpe:first_layer_height">${options.firstLayerHeight}</metadata>
`;
    }
    header += ` <resources>
`;

    // 如果有颜色则写入基础材质
    if (colors.length > 0) {
        header += `  <basematerials id="${baseMatId}">
`;
        for (const hex of colors) {
            header += `   <base name="${hex}" displaycolor="#${hex}FF" />
`;
        }
        header += `  </basematerials>
`;
    }

    write(header);

    // 每 N 个顶点/三角形让出执行权，以便进行 GC 和 UI 更新
    const YIELD_EVERY = 5000;
    let opsSinceYield = 0;

    // 进度跟踪
    const onProgress = options?.onProgress;
    const totalMeshes = meshes.length;
    // 每个网格有两个阶段：顶点（约 40%）和三角形（约 40%），zip 是最后约 20%
    const reportMeshProgress = (
        meshIdx: number,
        phase: 'vertices' | 'triangles',
        phaseFrac: number
    ) => {
        if (!onProgress) return;
        const meshFrac =
            (meshIdx + (phase === 'vertices' ? phaseFrac * 0.5 : 0.5 + phaseFrac * 0.5)) /
            totalMeshes;
        // 网格处理约占总进度的 80%，zip 生成约占 20%
        onProgress(meshFrac * 0.8);
    };

    for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        const overrideHex = options?.layerFilamentColors?.[i];
        const matIdx = getMaterialIndex(mesh.material, overrideHex);
        const objectId = nextId++;
        componentIds.push(objectId);

        let hex = normalizeHex(overrideHex) || 'FFFFFF';
        if (
            !overrideHex &&
            'color' in mesh.material &&
            (mesh.material as THREE.MeshStandardMaterial).color
        ) {
            hex = (mesh.material as THREE.MeshStandardMaterial).color.getHexString().toUpperCase();
        }
        // 颜色/挤出机使用从 1 开始的索引
        componentMeta.push({
            id: objectId,
            name: `Layer ${i + 1} (#${hex})`,
            colorIdx: matIdx + 1,
        });
        const objUuid = generateUUID();

        write(`<object id="${objectId}" p:UUID="${objUuid}" pid="${baseMatId}" pindex="${matIdx}" type="model" name="Layer ${i + 1} (#${hex})">
`);
        write(` <mesh>
`);
        write(`  <vertices>
`);

        const geom = mesh.geometry;
        const pos = geom.getAttribute('position');
        const index = geom.getIndex();

        const count = pos.count;
        for (let j = 0; j < count; j++) {
            v.fromBufferAttribute(pos, j).applyMatrix4(mesh.matrixWorld);
            write(`   <vertex x="${f(v.x)}" y="${f(v.y)}" z="${f(v.z)}" />
`);

            opsSinceYield++;
            if (opsSinceYield > YIELD_EVERY) {
                opsSinceYield = 0;
                reportMeshProgress(i, 'vertices', (j + 1) / count);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
        write(`  </vertices>
`);
        write(`  <triangles>
`);

        if (index) {
            const triCount = index.count;
            for (let j = 0; j < triCount; j += 3) {
                write(`   <triangle v1="${index.getX(j)}" v2="${index.getX(j + 1)}" v3="${index.getX(j + 2)}" />
`);
                opsSinceYield++;
                if (opsSinceYield > YIELD_EVERY) {
                    opsSinceYield = 0;
                    reportMeshProgress(i, 'triangles', (j + 3) / triCount);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        } else {
            for (let j = 0; j < pos.count; j += 3) {
                write(`   <triangle v1="${j}" v2="${j + 1}" v3="${j + 2}" />
`);
                opsSinceYield++;
                if (opsSinceYield > YIELD_EVERY) {
                    opsSinceYield = 0;
                    reportMeshProgress(i, 'triangles', (j + 3) / pos.count);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            }
        }

        write(`  </triangles>
`);
        write(` </mesh>
`);
        write(`</object>
`);
    }

    // 装配对象
    const assemblyId = nextId++;
    const assemblyUuid = generateUUID();
    write(`<object id="${assemblyId}" p:UUID="${assemblyUuid}" type="model" name="Kromacut Model">
`);
    write(` <components>
`);
    for (const id of componentIds) {
        const compUuid = generateUUID();
        write(`  <component objectid="${id}" p:UUID="${compUuid}" />
`);
    }
    write(` </components>
`);
    write(`</object>
`);

    write(` </resources>
`);
    write(` <build p:UUID="${generateUUID()}">
`);
    write(`<item objectid="${assemblyId}" p:UUID="${generateUUID()}" />
`);
    write(` </build>
`);
    write(`</model>`);

    // 刷新剩余的块
    if (currentChunk.length > 0) {
        xmlParts.push(currentChunk);
    }

    const finalBlob = new Blob(xmlParts, { type: 'text/xml' });

    zip.folder('3D')?.file('3dmodel.model', finalBlob);

    // 生成 Metadata/model_settings.config
    // 这是 Bambu Studio / Orca Slicer / Creality Print 正确识别多部件对象结构、
    // 分配名称/设置所必需的，可避免"配置文件选择"提示，
    // 并启用正确的颜色分配可视化。
    let modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="${assemblyId}">
  <metadata key="name" value="Kromacut Model"/>
  <metadata key="extruder" value="1"/>
`;
    for (const comp of componentMeta) {
        const safeName = comp.name
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        modelSettings += `  <part id="${comp.id}" subtype="normal_part">
   <metadata key="name" value="${safeName}"/>
   <metadata key="extruder" value="${comp.colorIdx}"/>
  </part>
`;
    }
    modelSettings += ` </object>
 <plate>
  <metadata key="plater_id" value="1"/>
  <metadata key="plater_name" value=""/>
  <metadata key="locked" value="false"/>
  <model_instance>
   <metadata key="object_id" value="${assemblyId}"/>
   <metadata key="instance_id" value="0"/>
  </model_instance>
 </plate>
 <assemble>
  <assemble_item object_id="${assemblyId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 110 110 0" offset="0 0 0" />
 </assemble>
</config>`;

    zip.folder('Metadata')?.file('model_settings.config', modelSettings);

    zip.folder('Metadata')?.file('kromacut.config', KROMACUT_CONFIG);
    zip.folder('Metadata')?.file(
        'project_settings.config',
        JSON.stringify(projectSettings, null, 4)
    );

    onProgress?.(0.8);

    return await zip.generateAsync(
        { type: 'blob' },
        onProgress
            ? (meta) => {
                  // zip 进度从 80% 到 100%
                  onProgress(0.8 + (meta.percent / 100) * 0.2);
              }
            : undefined
    );
}
