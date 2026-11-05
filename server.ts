// Local-plugin entry point for OpenCode 2.x: configured local plugin
// directories are resolved by their root `server.*` file. Re-exporting the
// bundled plugin lets a plain checkout of this repo be loaded directly
// (plugins: ["/path/to/opencode-supertask"]) without npm.
export { default } from './dist/plugin/supertask.js';
