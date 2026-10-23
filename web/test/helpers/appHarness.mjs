import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise App's real callbacks/effects without adding a DOM/test-renderer
// dependency. This harness checks state transitions, not browser rendering.
export function appHarness() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let tree;
  const effects = [];
  const requests = [];
  const intervals = new Map();
  const deadlines = new Map();
  let nextTimer = 0;
  let finishLogout;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (value) => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        const cleanup = slots[i]?.cleanup;
        slots[i] = { deps };
        effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), {
    location: { pathname: '/', search: '' },
    setInterval: (fn) => { intervals.set(++nextTimer, fn); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
  });
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    './App.css': {},
    './components/LoginPage': { LoginPage: 'LoginPage' },
    './components/UserHomePage': { UserHomePage: 'UserHomePage' },
    './utils/workloadApplicationRoutes': { renderWorkloadApplicationRoute: () => null },
    './services/authApi': { logoutUser: () => new Promise((resolve) => { finishLogout = resolve; }) },
    './services/amppSessionApi': { getCurrentSession: (signal) => new Promise((resolve, reject) => {
      requests.push({ signal, resolve, reject });
    }) },
  };
  const context = vm.createContext({
    exports: {}, require: (name) => {
      if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
      return modules[name];
    },
    window, document, AbortController, URLSearchParams, Date, console,
    setTimeout: (fn) => { deadlines.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => deadlines.delete(id),
  });
  const { outputText } = ts.transpileModule(readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  vm.runInContext(outputText, context);
  function render() {
    cursor = 0; dirty = false;
    tree = context.exports.default();
    for (const effect of effects.splice(0)) effect();
  }
  function find(type, node, includeHidden = false) {
    if (arguments.length < 2) node = tree;
    if (!node || typeof node !== 'object') return undefined;
    if (!includeHidden && node.props?.hidden) return undefined;
    if (node.type === type) return node;
    return [node.props?.children].flat(Infinity).map((child) => find(type, child, includeHidden)).find(Boolean);
  }
  render();
  return {
    requests, document,
    find,
    findMounted: (type) => find(type, tree, true),
    async flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } },
    poll() { for (const fn of intervals.values()) fn(); },
    resume(event = 'visibilitychange') {
      document.hidden = false;
      (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
    },
    deadline() { for (const fn of [...deadlines.values()]) fn(); },
    finishLogout() { finishLogout(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
