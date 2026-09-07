export function cameraZoomFromPinch(startZoom: number, startDistance: number, distance: number) {
  if (startDistance <= 0) return startZoom;
  return Math.max(0, Math.min(0.7, startZoom + (distance - startDistance) / 250));
}
