// Bundles the built Action (dist/action/main.js) and its dependencies into the one
// committed file action/main.mjs, as GitHub's JavaScript action tutorial does.
// Run it with `npm run bundle:action`.
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
  input: "dist/action/main.js",
  output: {
    file: "action/main.mjs",
    format: "es",
    // One file: no code-split chunks, since only main.mjs is committed.
    inlineDynamicImports: true,
  },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs()],
};
