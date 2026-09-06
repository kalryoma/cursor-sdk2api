/**
 * Frozen @cursor/sdk 1.0.31 ESM client-type patch fence.
 * Hashes were taken from the installed 1.0.31 tree. Do not reuse 1.0.30 hashes.
 */

export interface SandPatchSpec {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly expected: number;
}

export interface SandPatchedFileContract {
  readonly file: string;
  readonly originalSha256: string;
  readonly targetSha256: string;
}

export const SAND_SDK_PACKAGE_NAME = "@cursor/sdk";
export const SAND_SDK_VERSION = "1.0.31";

export const SAND_SDK_PATCHES: readonly SandPatchSpec[] = Object.freeze([
  {
    file: "dist/esm/index.js",
    from: '"x-cursor-client-type":"sdk"',
    to: '"x-cursor-client-type":"sand"',
    expected: 1,
  },
  {
    file: "dist/esm/index.js",
    from: 'set("x-cursor-client-type","sdk")',
    to: 'set("x-cursor-client-type","sand")',
    expected: 1,
  },
  {
    file: "dist/esm/357.js",
    from: '"x-cursor-client-type":"sdk"',
    to: '"x-cursor-client-type":"sand"',
    expected: 1,
  },
]);

export const SAND_SDK_PATCH_FILES: readonly SandPatchedFileContract[] = Object.freeze([
  {
    file: "dist/esm/index.js",
    originalSha256: "09d5da1fe1cbba8bcd5af937ddcf6967b6e48170bd52ae744fd0a4b98bcef945",
    targetSha256: "bcd951649fb684a90e192a5e10afc7924a574c3c40dfb82683832160a4dac23e",
  },
  {
    file: "dist/esm/357.js",
    originalSha256: "6db49240bebc1ac114cbfa800810cd19a0b56316922c2219be5c4a72546dca84",
    targetSha256: "0981b1331ee9b91482af44ebea79d8247da115339b23c5132e2a89eb11367702",
  },
]);

const derivedReplacementCount = SAND_SDK_PATCHES.reduce((sum, patch) => sum + patch.expected, 0);
if (derivedReplacementCount !== 3) {
  throw new Error("Sand patch contract must lock exactly 3 replacements for @cursor/sdk 1.0.31");
}

export const sandSdkPatchContract = Object.freeze({
  packageName: SAND_SDK_PACKAGE_NAME,
  sdkVersion: SAND_SDK_VERSION,
  expectedReplacementCount: 3,
  patches: SAND_SDK_PATCHES,
  files: SAND_SDK_PATCH_FILES,
});
