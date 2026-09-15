/**
 * Pure geometry for the document editor. Boxes are PDF points from the
 * top-left of the page; `scale` is screen pixels per point. Kept out of the
 * React component so the drag/resize maths is unit-tested.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export const MIN_BOX = 8;

/** Half-point precision is plenty for placement and keeps saved JSON tidy. */
const snap = (n: number) => Math.round(n * 2) / 2;

export function clampBox(box: Box, page: PageSize, min = MIN_BOX): Box {
  const width = Math.min(Math.max(box.width, min), page.width);
  const height = Math.min(Math.max(box.height, min), page.height);
  const x = Math.min(Math.max(box.x, 0), page.width - width);
  const y = Math.min(Math.max(box.y, 0), page.height - height);
  return { x: snap(x), y: snap(y), width: snap(width), height: snap(height) };
}

export function moveBox(box: Box, dxPx: number, dyPx: number, scale: number, page: PageSize): Box {
  return clampBox({ ...box, x: box.x + dxPx / scale, y: box.y + dyPx / scale }, page);
}

/** Resizes from the bottom-right corner; the top-left stays put. */
export function resizeBox(box: Box, dxPx: number, dyPx: number, scale: number, page: PageSize, min = MIN_BOX): Box {
  const width = Math.min(Math.max(box.width + dxPx / scale, min), page.width - box.x);
  const height = Math.min(Math.max(box.height + dyPx / scale, min), page.height - box.y);
  return { x: snap(box.x), y: snap(box.y), width: snap(width), height: snap(height) };
}

/** A new box centred on a clicked point. */
export function boxAtPoint(xPt: number, yPt: number, page: PageSize, size: { width: number; height: number } = { width: 180, height: 20 }): Box {
  return clampBox({ x: xPt - size.width / 2, y: yPt - size.height / 2, width: size.width, height: size.height }, page);
}

export function toPixels(box: Box, scale: number): { left: number; top: number; width: number; height: number } {
  return { left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale };
}

/** Converts a click offset inside a rendered page to points. */
export function pointFromClick(offsetX: number, offsetY: number, scale: number): { x: number; y: number } {
  return { x: offsetX / scale, y: offsetY / scale };
}

export function nextFieldId(existing: string[]): string {
  let n = existing.length + 1;
  while (existing.includes(`f${n}`)) n += 1;
  return `f${n}`;
}
