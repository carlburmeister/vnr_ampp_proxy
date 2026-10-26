import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Execute real component state/effects and handlers without a renderer dependency.
// This checks UI behavior and contracts; browser layout still needs local testing.
export function componentHarness(file, name, initialProps, globals = {}) {
  const slots = [], effects = [], cache = new Map();
  let cursor = 0, dirty = false, tree, props = initialProps;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++; slots[i] ??= { value: initial };
      return [slots[i].value, (value) => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useCallback(fn, deps) {
      const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn }; return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        const cleanup = slots[i]?.cleanup; slots[i] = { deps };
        effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const shared = { window: { confirm: () => true }, console, Error, AbortController, URL, URLSearchParams, setTimeout, clearTimeout, ...globals };
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const module = { exports: {} }; cache.set(path, module.exports);
    const require = (specifier) => {
      if (specifier === 'react') return react;
      if (specifier === 'react/jsx-runtime') return jsx;
      if (specifier.endsWith('.css')) return {};
      if (!specifier.startsWith('.')) throw new Error(`Unexpected import: ${specifier}`);
      const target = resolve(dirname(path), specifier);
      const filename = [target, target + '.ts', target + '.tsx'].find(existsSync);
      if (!filename) throw new Error(`Missing import: ${specifier}`);
      return load(filename);
    };
    const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    });
    vm.runInNewContext(outputText, { ...shared, module, exports: module.exports, require });
    return module.exports;
  }
  const root = load(new URL(file, new URL('../../src/', import.meta.url)).pathname)[name];
  function render() { cursor = 0; dirty = false; tree = root(props); for (const effect of effects.splice(0)) effect(); }
  function all(predicate, node) {
    if (arguments.length < 2) node = tree;
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap((child) => all(predicate, child))];
  }
  function text(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || typeof node !== 'object') return '';
    return [node?.props?.children].flat(Infinity).map(text).join('');
  }
  render();
  return { all, text, tree: () => tree,
    async flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (dirty) render(); } },
    update(next) { props = next; render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
