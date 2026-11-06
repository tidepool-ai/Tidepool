/**
 * jsdom has no layout, so ProseMirror's coordinate helpers (used when scrolling the selection into
 * view) would throw. These stubs return empty boxes; the editor's behaviour doesn't depend on them.
 */
export function stubLayoutForProseMirror(): void {
  const emptyRect = () => new DOMRect(0, 0, 0, 0);
  const emptyList = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= emptyRect;
  Range.prototype.getClientRects ??= emptyList;
  Element.prototype.getClientRects ??= emptyList;
  document.elementFromPoint ??= () => null;
}

/** jsdom has no scrolling: CDK scrolls a viewport with `scrollTo`, which here just sets `scrollTop`. */
export function stubScrolling(): void {
  Element.prototype.scrollTo ??= function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
  } as Element['scrollTo'];
}
