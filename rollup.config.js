import typescript from 'rollup-plugin-typescript2';

/**
 * @external RollupConfig
 * @type {PlainObject}
 * @see {@link https://rollupjs.org/guide/en#big-list-of-options}
 */

/**
 * @param {PlainObject} config
 * @param {string} config.input
 * @returns {external:RollupConfig}
 */
function getRollupObject ({input} = {}) {
    return {
        external: ['fs', 'events', 'http', 'path', 'mime', 'minimatch', 'event-stream', 'lodash.debounce'],
        input,
        output: {
            format: 'cjs',
            file: input.replace(/^.\/lib\//u, './dist/').replace(/\.ts$/u, '.cjs')
        },
        plugins: [
            typescript({
                tsconfigDefaults: {
                    compilerOptions: {
                        allowSyntheticDefaultImports: true,
                        module: 'ESNext',
                        declaration: true,
                        outDir: 'dist'
                    }
                }                
            })
        ],        
    };
}

export default [
    getRollupObject({
        input: './lib/reload-static.ts', minifying: true
    })
];
