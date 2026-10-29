// Serialized into wrapper documents before AMPP initializes its authentication.
function isolateWrapperRedirects(workloadId: string): void {
  try {
    if (
      !/^\/api\/ampp-proxy\/ui\/gvui-[0-9a-f-]{36}\//i.test(
        window.top.location.pathname,
      )
    )
      return;
    const storage = window.sessionStorage;
    for (const operation of ['getItem', 'setItem', 'removeItem'] as const) {
      const native = Storage.prototype[operation];
      Object.defineProperty(Storage.prototype, operation, {
        ...Object.getOwnPropertyDescriptor(Storage.prototype, operation),
        value: function (this: Storage, ...args: unknown[]): unknown {
          const clientId = (
            window as Window & { __GVCONFIG__?: { clientId?: string } }
          ).__GVCONFIG__?.clientId;
          const key = args[0];
          if (
            this === storage &&
            typeof clientId === 'string' &&
            (key === `gv_redirect_${clientId}` ||
              key === `gv_redirect_fallback_${clientId}`)
          ) {
            // Sibling wrappers share tokens, but must restore their own route.
            args[0] = `ampp-proxy:${workloadId}:${key}`;
          }
          return Reflect.apply(native, this, args);
        },
      });
    }
  } catch {
    // Inaccessible parent/storage must not prevent the existing UI bootstrap.
  }
}

export function createAmppRedirectStorageScript(
  workloadId: string,
  path: string,
): string {
  if (
    !/^\/app\/wrapper\//i.test(path) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workloadId)
  )
    return '';
  return `<script data-ampp-proxy-redirect-storage>(${isolateWrapperRedirects.toString()})(${JSON.stringify(workloadId.toLowerCase())});</script>`;
}
