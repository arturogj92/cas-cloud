export type EditorPoint = { x: number; y: number };
export type EditorSize = { width: number; height: number };
export type EditorViewport = { x: number; y: number; scale: number };
export type EditorTool = 'move' | 'draw' | 'arrow' | 'text';

export function arrowPath(from: EditorPoint, to: EditorPoint, headLength: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  const wings = [-spread, spread].map((offset) => ({
    x: to.x - headLength * Math.cos(angle + offset),
    y: to.y - headLength * Math.sin(angle + offset),
  }));
  const point = ({ x, y }: EditorPoint) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  return `M${point(from)} L${point(to)} M${point(to)} L${point(wings[0])} M${point(to)} L${point(wings[1])}`;
}

export function editorGestureMode(tool: EditorTool, touches: number) {
  if (touches >= 2) return 'zoom' as const;
  if (tool === 'move') return 'pan' as const;
  return tool;
}

export function zoomFromPinch(startScale: number, startDistance: number, currentDistance: number) {
  if (startDistance <= 0) return Math.max(1, Math.min(4, startScale));
  return Math.max(1, Math.min(4, startScale * currentDistance / startDistance));
}

export function viewportFromPinch({
  viewport,
  startDistance,
  currentDistance,
  startCenter,
  currentCenter,
  stage,
}: {
  viewport: EditorViewport;
  startDistance: number;
  currentDistance: number;
  startCenter: EditorPoint;
  currentCenter: EditorPoint;
  stage: EditorSize;
}) {
  const scale = zoomFromPinch(viewport.scale, startDistance, currentDistance);
  const ratio = scale / viewport.scale;
  const originX = stage.width / 2;
  const originY = stage.height / 2;
  return {
    x: currentCenter.x - originX - (startCenter.x - originX - viewport.x) * ratio,
    y: currentCenter.y - originY - (startCenter.y - originY - viewport.y) * ratio,
    scale,
  };
}

export function imagePointFromStage({
  point,
  stage,
  fitted,
  image,
  viewport,
}: {
  point: EditorPoint;
  stage: EditorSize;
  fitted: EditorSize;
  image: EditorSize;
  viewport: EditorViewport;
}) {
  const width = fitted.width * viewport.scale;
  const height = fitted.height * viewport.scale;
  const left = (stage.width - width) / 2 + viewport.x;
  const top = (stage.height - height) / 2 + viewport.y;
  return {
    x: Math.max(0, Math.min(image.width, (point.x - left) * image.width / width)),
    y: Math.max(0, Math.min(image.height, (point.y - top) * image.height / height)),
  };
}
