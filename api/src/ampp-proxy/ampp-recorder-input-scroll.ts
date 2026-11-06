// Serialized into the Recorder document; keep browser dependencies inside.
function installRecorderInputScroll(): void {
  let input: HTMLInputElement | null = null;
  let value: string | undefined;
  let frame: number | undefined;
  let observer: MutationObserver | undefined;

  function schedule(): void {
    if (!input || document.activeElement === input || frame !== undefined)
      return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      // Never disturb the caret or scrolling while the user is editing.
      if (input?.isConnected && document.activeElement !== input) {
        if (input.scrollLeft !== 0) input.scrollLeft = 0;
      }
    });
  }

  function inspect(): void {
    const next = document.querySelector<HTMLInputElement>(
      'input#root_source[role="combobox"]',
    );
    if (next !== input) {
      input?.removeEventListener('scroll', schedule);
      input = next;
      value = undefined;
      input?.addEventListener('scroll', schedule);
    }
    if (input && input.value !== value) {
      value = input.value;
      schedule();
    }
  }

  function onBlur(event: FocusEvent): void {
    if (event.target === input) schedule();
  }

  function start(): void {
    if (observer) return;
    observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value'],
    });
    document.addEventListener('focusout', onBlur);
    inspect();
  }

  function stop(): void {
    observer?.disconnect();
    observer = undefined;
    input?.removeEventListener('scroll', schedule);
    document.removeEventListener('focusout', onBlur);
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    input = null;
    value = undefined;
  }

  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', start);
  start();
}

export function createAmppRecorderInputScrollScript(): string {
  return `<script data-ampp-recorder-input-scroll>(${installRecorderInputScroll.toString()})();</script>`;
}
