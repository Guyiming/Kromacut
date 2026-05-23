import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

const DEBUG_LOG_PATH = 'D:/CODE/HueRelief/HueRelief/Dist/logs/tslog.txt';

function devDebugLogWriter(): Plugin {
    return {
        name: 'kromacut-dev-debug-log-writer',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__write-debug-log', (req, res) => {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                const chunks: Buffer[] = [];
                req.on('data', (c) => chunks.push(Buffer.from(c)));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf-8');
                        fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
                        fs.writeFileSync(DEBUG_LOG_PATH, body, 'utf-8');
                        res.statusCode = 204;
                        res.end();
                    } catch (e) {
                        res.statusCode = 500;
                        res.end(String(e));
                    }
                });
            });
        },
    };
}

// https://vite.dev/config/
export default defineConfig({
    base: '/',
    plugins: [react(), tailwindcss(), devDebugLogWriter()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    optimizeDeps: {
        include: ['three'],
        // Treat three example controls as source to avoid stale optimized deps
        exclude: [
            'three/examples/jsm/controls/OrbitControls',
            'three/examples/jsm/controls/OrbitControls.js',
        ],
    },
});
