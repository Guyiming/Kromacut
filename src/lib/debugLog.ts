/**
 * 调试日志缓冲区。
 *
 * 在 Web Worker 内部累积 `---->打印*` 系列日志，
 * 由主线程在收到 worker 响应后通过 Tauri fs 写入文件，
 * 用于和 C++ 参考实现做逐项对比（cpp.txt vs tslog.txt）。
 *
 * - 同时透传到 console.warn，便于实时观察。
 * - consumeDebugLogs() 取出后清空缓冲区。
 */

const buffer: string[] = [];

export function debugLog(text: string): void {
    buffer.push(text);
    console.warn(text);
}

export function consumeDebugLogs(): string {
    if (buffer.length === 0) return '';
    const out = buffer.join('\n') + '\n';
    buffer.length = 0;
    return out;
}
