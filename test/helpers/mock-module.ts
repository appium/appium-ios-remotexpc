import type {TestContext} from 'node:test';

let importCounter = 0;

// Bare specifiers (bare package names, `node:` builtins) resolve the same way
// regardless of the importing file, so leave them as-is; only relative/absolute
// specifiers need to be anchored to the importer's location.
function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
}

function resolveSpecifier(specifier: string, importerUrl: string): string {
  return isRelative(specifier) ? new URL(specifier, importerUrl).href : specifier;
}

/**
 * Imports `targetSpecifier` (resolved relative to `importerUrl`) with some of its
 * dependencies replaced. Each key of `mocks` is a specifier (resolved relative to
 * `importerUrl` as well) whose exports replace that module's exports.
 *
 * For project-relative specifiers, the replacement is overlaid onto the module's real
 * exports first — unlike esmock, `node:test` module mocks replace a resolved module for
 * *every* importer in the process, so any export the mock omits must still fall back to
 * the real implementation or unrelated importers of the same module break. Bare
 * specifiers (npm packages, `node:` builtins) skip this merge: pre-importing a CJS
 * package before mocking it trips a node:test bug ("Cannot redefine property:
 * __esModule") on packages whose compiled output marks that property non-configurable,
 * and none of the mocked packages here are shared with other exports the target needs.
 */
export async function mockImport<T = any>(
  t: TestContext,
  targetSpecifier: string,
  importerUrl: string,
  mocks: Record<string, Record<string, unknown>>,
): Promise<T> {
  const resolvedMocks: Array<[string, Record<string, unknown>]> = [];
  for (const [specifier, overrides] of Object.entries(mocks)) {
    const resolved = resolveSpecifier(specifier, importerUrl);
    if (isRelative(specifier)) {
      const real = (await import(resolved)) as Record<string, unknown>;
      resolvedMocks.push([resolved, {...real, ...overrides}]);
    } else {
      resolvedMocks.push([resolved, overrides]);
    }
  }
  for (const [resolved, exports] of resolvedMocks) {
    const {default: defaultExport, ...namedExports} = exports;
    // Node 22 doesn't understand the unified `exports` option yet (added in Node 23+),
    // only the older `namedExports`/`defaultExport` pair — use those for engine coverage.
    t.mock.module(resolved, 'default' in exports ? {defaultExport, namedExports} : {namedExports});
  }
  const targetUrl = `${resolveSpecifier(targetSpecifier, importerUrl)}?mock=${importCounter++}`;
  return (await import(targetUrl)) as T;
}
