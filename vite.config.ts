import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import os from 'os';
import fs from 'fs';

function devFileLogger(): Plugin {
    return {
        name: 'kromacut-dev-file-logger',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/__log', (req, res) => {
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
                        const filePath = path.join(os.homedir(), 'Documents', 'ts_log.txt');
                        fs.appendFileSync(filePath, body + '\n', 'utf-8');
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
    plugins: [react(), tailwindcss(), devFileLogger()],
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
