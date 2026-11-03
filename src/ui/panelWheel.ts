/**
 * Mouse-wheel policy for the editor panels.
 *
 * - The wheel scrolls the panel under the cursor (each side panel scrolls on its
 *   own; `overscroll-behavior: contain` in CSS keeps the page from scrolling).
 * - Over a slider or a number field the wheel scrolls the panel too — it never
 *   changes a value by accident. A focused number field is blurred first, because
 *   browsers step focused number inputs on wheel.
 * - Explicit modifier: Alt + wheel over a slider or number field steps its value.
 *
 * Returns a function that removes the listener.
 */
export function installPanelWheel(): () => void {
  const onWheel = (e: WheelEvent) => {
    const el = e.target as HTMLElement | null;
    const input = el?.closest?.('input') as HTMLInputElement | null;
    if (!input || (input.type !== 'range' && input.type !== 'number')) return;
    if (e.altKey) {
      e.preventDefault();
      const step = Number(input.step) || 1;
      const min = input.min === '' ? -Infinity : Number(input.min);
      const max = input.max === '' ? Infinity : Number(input.max);
      const dir = e.deltaY < 0 || e.deltaX < 0 ? 1 : -1;
      const v = Math.min(max, Math.max(min, Number(input.value) + dir * step));
      const decimals = (String(input.step).split('.')[1] ?? '').length;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v.toFixed(decimals));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (input.type === 'number' && document.activeElement === input) input.blur();
  };
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => window.removeEventListener('wheel', onWheel, { capture: true } as any);
}
