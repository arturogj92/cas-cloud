import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  PanResponder,
  Platform,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import Svg, { G, Image as SvgImage, Path, Rect, Text as SvgText } from 'react-native-svg';
import { createMobileAttachment, type MobileAttachment } from './mobile-attachments';
import {
  arrowPath,
  editorGestureMode,
  imagePointFromStage,
  zoomFromPinch,
  type EditorTool,
  type EditorViewport,
} from './mobile-image-editor-geometry';

type Palette = {
  background: string;
  surface: string;
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  secondary: string;
  muted: string;
  accent: string;
  accentText: string;
  danger: string;
};

type Point = { x: number; y: number };
type Stroke = { kind: 'stroke'; color: string; width: number; points: Point[] };
type Arrow = { kind: 'arrow'; color: string; width: number; from: Point; to: Point };
type Label = { kind: 'text'; color: string; text: string; x: number; y: number; size: number };
type Operation = Stroke | Arrow | Label;
type GestureMode = 'draw' | 'arrow' | 'pan' | 'text' | 'zoom' | null;

const COLORS = ['#fbbf24', '#ef4444', '#ffffff'];
let labelMeasureContext: CanvasRenderingContext2D | null = null;
const COMMON_NATIVE_GRAPHEME = /^(?:[\u0000-\u024F]|\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u;

function imageSize(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(dataUrl, (width, height) => resolve({ width, height }), reject);
  });
}

async function nativeImageUri(dataUrl: string) {
  if (Platform.OS === 'web') return dataUrl;
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
  if (!match || !FileSystem.cacheDirectory) throw new Error('Could not prepare this image');
  const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const uri = `${FileSystem.cacheDirectory}image-editor-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  await FileSystem.writeAsStringAsync(uri, match[2], { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

function pathFor(points: Point[]) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
}

function editedName(name: string) {
  return `${name.replace(/\.[^.]+$/, '') || 'image'}-edited.png`;
}

function touchDistance(event: GestureResponderEvent) {
  const [first, second] = event.nativeEvent.touches;
  if (!first || !second) return 0;
  return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
}

function graphemes(text: string) {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (...args: never[]) => { segment: (value: string) => Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter
    ? Array.from(new Segmenter().segment(text), (entry) => entry.segment)
    : Array.from(text);
}

function labelLineMetrics(line: string, size: number) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    labelMeasureContext ||= document.createElement('canvas').getContext('2d');
    if (labelMeasureContext) {
      labelMeasureContext.font = `800 ${size}px sans-serif`;
      const metrics = labelMeasureContext.measureText(line);
      const left = Math.min(0, -(metrics.actualBoundingBoxLeft || 0));
      const right = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0, 0);
      return {
        left,
        right,
        width: right - left,
        ascent: metrics.actualBoundingBoxAscent || size,
        descent: metrics.actualBoundingBoxDescent || size * .3,
      };
    }
  }
  const glyphs = graphemes(line);
  const uncommon = glyphs.some((glyph) => !COMMON_NATIVE_GRAPHEME.test(glyph));
  const width = glyphs.reduce((total, glyph) => total + size * (COMMON_NATIVE_GRAPHEME.test(glyph) ? 1.2 : 7), 0);
  return {
    left: 0,
    right: width,
    width,
    ascent: size * (uncommon ? 2 : 1.1),
    descent: size * (uncommon ? 1 : .35),
  };
}

function labelLineWidth(line: string, size: number) {
  return labelLineMetrics(line, size).width;
}

function labelLines(label: Label, image: { width: number }) {
  const maxWidth = image.width * .82;
  const words = label.text.trim().split(/\s+/).flatMap((word) => {
    if (labelLineWidth(word, label.size) <= maxWidth) return [word];
    return graphemes(word).reduce<string[]>((chunks, glyph) => {
      const index = chunks.length - 1;
      if (index >= 0 && labelLineWidth(chunks[index] + glyph, label.size) <= maxWidth) chunks[index] += glyph;
      else chunks.push(glyph);
      return chunks;
    }, []);
  });
  return words.reduce<string[]>((lines, word) => {
    const index = lines.length - 1;
    if (index >= 0 && labelLineWidth(`${lines[index]} ${word}`, label.size) <= maxWidth) lines[index] += ` ${word}`;
    else lines.push(word);
    return lines;
  }, []);
}

function labelBounds(label: Label, image: { width: number }) {
  const lines = labelLines(label, image);
  const metrics = lines.map((line) => labelLineMetrics(line, label.size));
  const left = Math.min(...metrics.map((line) => label.x + line.left)) - label.size * .3;
  const right = Math.max(...metrics.map((line) => label.x + line.right)) + label.size * .3;
  const top = Math.min(...metrics.map((line, index) => label.y + index * label.size * 1.2 - line.ascent)) - label.size * .2;
  const bottom = Math.max(...metrics.map((line, index) => label.y + index * label.size * 1.2 + line.descent)) + label.size * .2;
  return {
    left,
    top,
    width: Math.max(label.size * 1.8, right - left),
    height: bottom - top,
  };
}

function clampLabel(label: Label, image: { width: number; height: number }): Label {
  let fitted = { ...label };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bounds = labelBounds(fitted, image);
    if (bounds.width <= image.width && bounds.height <= image.height) break;
    fitted = {
      ...fitted,
      size: fitted.size * Math.min(image.width / bounds.width, image.height / bounds.height) * .96,
    };
  }
  const bounds = labelBounds(fitted, image);
  const leftOffset = fitted.x - bounds.left;
  const rightOffset = bounds.left + bounds.width - fitted.x;
  const topOffset = fitted.y - bounds.top;
  const bottomOffset = bounds.top + bounds.height - fitted.y;
  return {
    ...fitted,
    x: Math.max(leftOffset, Math.min(image.width - rightOffset, fitted.x)),
    y: Math.max(topOffset, Math.min(image.height - bottomOffset, fitted.y)),
  };
}

function RangeControl({
  label,
  min,
  max,
  step,
  value,
  colors,
  styles,
  setValue,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  setValue: (value: number) => void;
}) {
  const [width, setWidth] = useState(1);
  const update = (event: GestureResponderEvent) => {
    const target = event.currentTarget as unknown as { getBoundingClientRect?: () => { left: number } };
    const pageX = (event.nativeEvent as unknown as { pageX?: number }).pageX;
    const x = Platform.OS === 'web' && target.getBoundingClientRect && Number.isFinite(pageX)
      ? (pageX as number) - target.getBoundingClientRect().left
      : event.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, x / width));
    setValue(Math.round((min + ratio * (max - min)) / step) * step);
  };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: update,
    onPanResponderMove: update,
  }), [max, min, step, width]);
  const ratio = (value - min) / (max - min);
  return (
    <View style={styles.rangeWrap}>
      <Text style={[styles.rangeLabel, { color: colors.secondary }]}>{label}</Text>
      <Pressable
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: Math.round(value) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent }) => setValue(Math.max(min, Math.min(max, value + (nativeEvent.actionName === 'decrement' ? -step : step))))}
        onLayout={({ nativeEvent }) => setWidth(Math.max(1, nativeEvent.layout.width))}
        onPress={update}
        {...responder.panHandlers}
        style={[styles.rangeTrack, { backgroundColor: colors.raised }]}
      >
        <View style={[styles.rangeFill, { width: `${ratio * 100}%`, backgroundColor: colors.accent }]} />
        <View style={[styles.rangeThumb, { left: `${ratio * 100}%`, backgroundColor: colors.text, borderColor: colors.background }]} />
      </Pressable>
      <Text style={[styles.rangeValue, { color: colors.text }]}>{Math.round(value)}</Text>
    </View>
  );
}

type EditorIconName = 'arrow' | 'check' | 'close' | 'draw' | 'move' | 'text' | 'trash' | 'undo';

const EDITOR_ICON_PATHS: Record<EditorIconName, string[]> = {
  arrow: ['M5 19 19 5M11 5h8v8'],
  check: ['m5 12 4 4L19 6'],
  close: ['m6 6 12 12M18 6 6 18'],
  draw: ['m4 20 4.5-1 10-10a2.8 2.8 0 0 0-4-4l-10 10L4 20Z', 'm13 6 5 5'],
  move: ['M12 2v20M2 12h20M12 2 9 5m3-3 3 3M12 22l-3-3m3 3 3-3M2 12l3-3m-3 3 3 3M22 12l-3-3m3 3-3 3'],
  text: ['M5 4h14M12 4v16M8 20h8'],
  trash: ['M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5'],
  undo: ['M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v1'],
};

function EditorIcon({ name, color, size = 20 }: { name: EditorIconName; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {EDITOR_ICON_PATHS[name].map((path) => (
        <Path key={path} d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

export function MobileImageEditor({
  attachment,
  colors,
  close,
  save,
  onDismiss,
}: {
  attachment: MobileAttachment | null;
  colors: Palette;
  close: () => void;
  save: (attachment: MobileAttachment) => void;
  onDismiss: () => void;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { width: viewportWidth } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && viewportWidth >= 900;
  const svgRef = useRef<Svg>(null);
  const [imageUri, setImageUri] = useState('');
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [operations, setOperations] = useState<Operation[]>([]);
  const [activeStroke, setActiveStroke] = useState<Stroke | Arrow | null>(null);
  const [tool, setTool] = useState<EditorTool>('move');
  const [color, setColor] = useState(COLORS[0]);
  const [brush, setBrush] = useState(6);
  const [label, setLabel] = useState('');
  const [selectedLabel, setSelectedLabel] = useState<number | null>(null);
  const [viewport, setViewport] = useState<EditorViewport>({ x: 0, y: 0, scale: 1 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const operationsRef = useRef(operations);
  const wasOpen = useRef(false);
  const viewportRef = useRef(viewport);
  const interactionRef = useRef<{
    mode: GestureMode;
    labelIndex: number | null;
    startDistance: number;
    startViewport: EditorViewport;
  }>({ mode: null, labelIndex: null, startDistance: 0, startViewport: viewport });
  operationsRef.current = operations;
  viewportRef.current = viewport;

  useEffect(() => {
    // Android removes Modal on the closing commit; only iOS/web emit onDismiss.
    const closed = wasOpen.current && !attachment;
    wasOpen.current = Boolean(attachment);
    if (Platform.OS !== 'android' || !closed) return;
    const frame = requestAnimationFrame(onDismiss);
    return () => cancelAnimationFrame(frame);
  }, [attachment, onDismiss]);

  const undo = useCallback(() => {
    setOperations((items) => items.slice(0, -1));
    setSelectedLabel(null);
  }, []);

  useEffect(() => {
    setOperations([]);
    setActiveStroke(null);
    setSelectedLabel(null);
    setViewport({ x: 0, y: 0, scale: 1 });
    setTool('move');
    setLabel('');
    setError('');
    setImageUri('');
    if (!attachment?.dataUrl) return;
    let disposed = false;
    let temporaryUri = '';
    void nativeImageUri(attachment.dataUrl).then(async (uri) => {
      temporaryUri = uri === attachment.dataUrl ? '' : uri;
      const dimensions = await imageSize(uri);
      if (!disposed) {
        setImageUri(uri);
        setSize(dimensions);
      }
    }).catch(() => {
      if (!disposed) setError('Could not prepare this image');
    });
    return () => {
      disposed = true;
      if (temporaryUri) void FileSystem.deleteAsync(temporaryUri, { idempotent: true });
    };
  }, [attachment]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !attachment || typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z'
        || event.shiftKey
        || event.altKey
        || (!event.metaKey && !event.ctrlKey)
        || !operationsRef.current.length) return;
      const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (target?.value) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [attachment, undo]);

  const fitted = useMemo(() => {
    const scale = Math.min(
      Math.max(1, stage.width - (desktopWeb ? 64 : 24)) / size.width,
      Math.max(1, stage.height - (desktopWeb ? 148 : 24)) / size.height,
    );
    return {
      width: Math.max(1, size.width * scale),
      height: Math.max(1, size.height * scale),
    };
  }, [desktopWeb, size, stage]);

  const pan = useMemo(() => {
    const pointFrom = (event: GestureResponderEvent): Point => imagePointFromStage({
      point: { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      stage,
      fitted,
      image: size,
      viewport: viewportRef.current,
    });
    const nearestLabel = (point: Point) => {
      for (let index = operationsRef.current.length - 1; index >= 0; index -= 1) {
        const operation = operationsRef.current[index];
        if (!operation || operation.kind !== 'text') continue;
        const bounds = labelBounds(operation, size);
        if (point.x >= bounds.left && point.x <= bounds.left + bounds.width
          && point.y >= bounds.top && point.y <= bounds.top + bounds.height) return index;
      }
      return null;
    };
    const beginZoom = (event: GestureResponderEvent) => {
      setActiveStroke(null);
      interactionRef.current = {
        mode: 'zoom',
        labelIndex: null,
        startDistance: touchDistance(event),
        startViewport: viewportRef.current,
      };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !saving,
      onMoveShouldSetPanResponder: () => !saving,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const mode = editorGestureMode(tool, event.nativeEvent.touches.length);
        if (mode === 'zoom') return beginZoom(event);
        if (mode === 'draw' || mode === 'arrow') {
          const point = pointFrom(event);
          interactionRef.current = { mode, labelIndex: null, startDistance: 0, startViewport: viewportRef.current };
          const width = brush * size.width / (fitted.width * viewportRef.current.scale);
          setActiveStroke(mode === 'arrow'
            ? { kind: 'arrow', color, width, from: point, to: point }
            : { kind: 'stroke', color, width, points: [point] });
          return;
        }
        if (mode === 'pan') {
          interactionRef.current = { mode, labelIndex: null, startDistance: 0, startViewport: viewportRef.current };
          return;
        }
        const labelIndex = nearestLabel(pointFrom(event));
        setSelectedLabel(labelIndex);
        interactionRef.current = { mode: labelIndex === null ? null : 'text', labelIndex, startDistance: 0, startViewport: viewportRef.current };
      },
      onPanResponderMove: (event, gesture) => {
        if (event.nativeEvent.touches.length >= 2) {
          if (interactionRef.current.mode !== 'zoom') beginZoom(event);
          const current = interactionRef.current;
          setViewport({
            ...current.startViewport,
            scale: zoomFromPinch(current.startViewport.scale, current.startDistance, touchDistance(event)),
          });
          return;
        }
        const current = interactionRef.current;
        if (current.mode === 'draw') {
          const point = pointFrom(event);
          setActiveStroke((stroke) => stroke?.kind === 'stroke' ? { ...stroke, points: [...stroke.points, point] } : stroke);
        } else if (current.mode === 'arrow') {
          const point = pointFrom(event);
          setActiveStroke((stroke) => stroke?.kind === 'arrow' ? { ...stroke, to: point } : stroke);
        } else if (current.mode === 'pan') {
          setViewport({ ...current.startViewport, x: current.startViewport.x + gesture.dx, y: current.startViewport.y + gesture.dy });
        } else if (current.mode === 'text' && current.labelIndex !== null) {
          const point = pointFrom(event);
          setOperations((items) => items.map((operation, index) => (
            index === current.labelIndex && operation.kind === 'text'
              ? clampLabel({ ...operation, x: point.x, y: point.y }, size)
              : operation
          )));
        }
      },
      onPanResponderRelease: () => {
        if (interactionRef.current.mode === 'draw' || interactionRef.current.mode === 'arrow') {
          setActiveStroke((stroke) => {
            if (stroke) setOperations((items) => [...items, stroke]);
            return null;
          });
        }
        interactionRef.current.mode = null;
      },
      onPanResponderTerminate: () => {
        interactionRef.current.mode = null;
        setActiveStroke(null);
      },
    });
  }, [brush, color, fitted, saving, size, stage, tool]);

  const addText = () => {
    const text = label.trim().slice(0, 80);
    if (!text) return;
    setOperations((items) => {
      setSelectedLabel(items.length);
      const textSize = size.width * .055;
      const next = clampLabel({
        kind: 'text',
        color,
        text,
        x: size.width / 2 - (text.length * textSize * .62) / 2,
        y: size.height * .55,
        size: textSize,
      }, size);
      return [...items, next];
    });
    setLabel('');
  };

  const finish = async () => {
    if (!attachment?.dataUrl) return;
    if (!operations.length) {
      save(attachment);
      close();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Saving the edit took too long')), 15_000);
        if (!svgRef.current) {
          clearTimeout(timer);
          reject(new Error('The image editor is not ready'));
          return;
        }
        svgRef.current.toDataURL((value) => {
          clearTimeout(timer);
          value ? resolve(value) : reject(new Error('Could not save the edit'));
        }, Platform.OS === 'ios' ? {
          width: Math.max(1, Math.round(size.width / PixelRatio.get())),
          height: Math.max(1, Math.round(size.height / PixelRatio.get())),
        } : undefined);
      });
      save(createMobileAttachment({
        type: 'image',
        name: editedName(attachment.name),
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${base64}`,
      }));
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the edit');
    } finally {
      setSaving(false);
    }
  };

  const renderedOperations = activeStroke ? [...operations, activeStroke] : operations;
  const renderOperation = (operation: Operation, index: number, showSelection = false) => {
    if (operation.kind === 'stroke' || operation.kind === 'arrow') return (
      <Path
        key={`${operation.kind}-${index}`}
        d={operation.kind === 'arrow' ? arrowPath(operation.from, operation.to, operation.width * 4) : pathFor(operation.points)}
        fill="none"
        stroke={operation.color}
        strokeWidth={operation.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
    if (!operation.text.trim()) return null;
    const bounds = labelBounds(operation, size);
    const lines = labelLines(operation, size);
    return (
      <G key={`text-${index}`}>
        <Rect
          x={bounds.left}
          y={bounds.top}
          width={bounds.width}
          height={bounds.height}
          rx={operation.size * .24}
          fill="rgba(0,0,0,.74)"
        />
        {showSelection && selectedLabel === index ? (
          <Rect
            testID={`image-label-selection-${index}`}
            x={bounds.left}
            y={bounds.top}
            width={bounds.width}
            height={bounds.height}
            rx={operation.size * .24}
            fill="none"
            stroke={colors.accent}
            strokeWidth={Math.max(2, size.width * .003)}
          />
        ) : null}
        {lines.map((line, lineIndex) => (
          <SvgText
            key={`${index}-${lineIndex}`}
            testID={`image-label-${index}-${lineIndex}`}
            x={operation.x}
            y={operation.y + lineIndex * operation.size * 1.2}
            fill={operation.color}
            fontFamily="sans-serif"
            fontSize={operation.size}
            fontWeight="800"
          >
            {line}
          </SvgText>
        ))}
      </G>
    );
  };
  const selectedText = selectedLabel === null ? null : operations[selectedLabel]?.kind === 'text'
    ? operations[selectedLabel] as Label
    : null;
  const setSelectedTextSize = (value: number) => {
    if (selectedLabel === null) return;
    setOperations((items) => items.map((operation, index) => (
      index === selectedLabel && operation.kind === 'text'
        ? clampLabel({ ...operation, size: value }, size)
        : operation
    )));
  };
  const setSelectedText = (text: string) => {
    if (selectedLabel === null) return;
    setOperations((items) => items.map((operation, index) => (
      index === selectedLabel && operation.kind === 'text'
        ? clampLabel({ ...operation, text }, size)
        : operation
    )));
  };
  const setSelectedTextColor = (value: string) => {
    setColor(value);
    if (selectedLabel === null) return;
    setOperations((items) => items.map((operation, index) => (
      index === selectedLabel && operation.kind === 'text' ? { ...operation, color: value } : operation
    )));
  };
  const deleteSelectedText = () => {
    if (selectedLabel === null) return;
    setOperations((items) => items.filter((_, index) => index !== selectedLabel));
    setSelectedLabel(null);
    setLabel('');
  };
  const textCount = operations.filter((operation) => operation.kind === 'text').length;
  const selectedTextNumber = selectedLabel === null ? 0 : operations
    .slice(0, selectedLabel + 1)
    .filter((operation) => operation.kind === 'text').length;
  const selectedTextActions = () => (
    <View style={styles.selectedTextActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Start a new text" onPress={() => { setSelectedLabel(null); setLabel(''); }} style={styles.textAction}>
        <Text style={styles.textActionLabel}>+ New</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Delete selected text" onPress={deleteSelectedText} style={[styles.textAction, styles.deleteText]}>
        <EditorIcon name="trash" color={colors.danger} size={15} />
        <Text style={styles.deleteTextLabel}>Delete</Text>
      </Pressable>
    </View>
  );
  const changeZoom = (scale: number) => setViewport((current) => ({
    ...current,
    scale: Math.max(1, Math.min(4, scale)),
    ...(scale <= 1 ? { x: 0, y: 0 } : {}),
  }));
  return (
    <Modal
      visible={Boolean(attachment)}
      animationType={Platform.OS === 'web' ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      onRequestClose={close}
      onDismiss={onDismiss}
    >
      <View style={[
        styles.root,
        desktopWeb && styles.rootDesktop,
        desktopWeb
          ? styles.desktopPadding
          : { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left },
      ]}>
        <View testID="image-editor-frame" style={[styles.frame, desktopWeb && styles.frameDesktop]}>
          <View testID="image-editor-header" style={[styles.header, desktopWeb && styles.headerDesktop]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel image edit" onPress={close} style={[styles.headerAction, desktopWeb && styles.headerActionDesktop]}>
              <EditorIcon name="close" color={colors.secondary} size={17} />
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>Edit image</Text>
              {desktopWeb ? <Text numberOfLines={1} style={styles.subtitle}>{attachment?.name}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Use edited image" disabled={saving} onPress={() => void finish()} style={[styles.headerAction, desktopWeb && styles.headerActionDesktop, styles.headerActionPrimary, saving && styles.disabled]}>
              <EditorIcon name="check" color={colors.accentText} size={17} />
              <Text style={styles.done}>{saving ? 'Saving…' : 'Done'}</Text>
            </Pressable>
          </View>

          <View onLayout={({ nativeEvent }) => setStage(nativeEvent.layout)} style={styles.stage}>
            {imageUri && stage.width > 1 && stage.height > 1 ? (
              <View accessibilityLabel="Editable image" testID="image-editor-canvas" {...pan.panHandlers} style={styles.gestureSurface}>
                <View pointerEvents="none" testID="image-editor-image" style={[styles.imageFrame, { width: fitted.width, height: fitted.height, transform: [{ translateX: viewport.x }, { translateY: viewport.y }, { scale: viewport.scale }] }]}>
                  <Image testID="image-editor-preview" source={{ uri: imageUri }} resizeMode="contain" style={StyleSheet.absoluteFill} />
                  {renderedOperations.length ? (
                    <Svg width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} style={styles.previewEdits}>
                      {renderedOperations.map((operation, index) => renderOperation(operation, index, true))}
                    </Svg>
                  ) : null}
                </View>
              </View>
            ) : null}
            {imageUri && operations.length ? (
              <View aria-hidden pointerEvents="none" style={[styles.exportFrame, { width: Math.max(1, size.width), height: Math.max(1, size.height) }]}>
                <Svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`}>
                  <SvgImage href={{ uri: imageUri, width: size.width, height: size.height }} width={size.width} height={size.height} preserveAspectRatio="xMidYMid meet" />
                  {renderedOperations.map((operation, index) => renderOperation(operation, index))}
                </Svg>
              </View>
            ) : null}
            <View style={styles.zoomControls}>
              <Pressable accessibilityRole="button" accessibilityLabel="Zoom out" disabled={viewport.scale <= 1} onPress={() => changeZoom(viewport.scale - .25)} style={[styles.zoomButton, viewport.scale <= 1 && styles.disabled]}><Text style={styles.zoomButtonText}>−</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Zoom level" onPress={() => setViewport({ x: 0, y: 0, scale: 1 })} style={styles.zoomLevel}><Text style={styles.zoomLevelText}>{Math.round(viewport.scale * 100)}%</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Zoom in" disabled={viewport.scale >= 4} onPress={() => changeZoom(viewport.scale + .25)} style={[styles.zoomButton, viewport.scale >= 4 && styles.disabled]}><Text style={styles.zoomButtonText}>+</Text></Pressable>
            </View>
            {error ? <View style={styles.errorCard}><Text style={styles.errorTitle}>Could not save the edit</Text><Text style={styles.errorText}>{error}. Your original image is untouched.</Text></View> : null}
          </View>

          <View testID="image-editor-toolbar" style={[styles.toolbar, desktopWeb && styles.toolbarDesktop]}>
            <View style={[styles.toolRow, desktopWeb && styles.toolRowDesktop]}>
              <Pressable accessibilityRole="button" accessibilityLabel="Move image" accessibilityState={{ selected: tool === 'move' }} onPress={() => setTool('move')} style={[styles.tool, desktopWeb && styles.toolDesktop, tool === 'move' && styles.toolSelected]}>
                <EditorIcon name="move" color={tool === 'move' ? colors.accent : colors.secondary} /><Text style={[styles.toolText, tool === 'move' && styles.toolTextSelected]}>Move</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Draw on image" accessibilityState={{ selected: tool === 'draw' }} onPress={() => setTool('draw')} style={[styles.tool, desktopWeb && styles.toolDesktop, tool === 'draw' && styles.toolSelected]}>
                <EditorIcon name="draw" color={tool === 'draw' ? colors.accent : colors.secondary} /><Text style={[styles.toolText, tool === 'draw' && styles.toolTextSelected]}>Draw</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Draw arrow on image" accessibilityState={{ selected: tool === 'arrow' }} onPress={() => setTool('arrow')} style={[styles.tool, desktopWeb && styles.toolDesktop, tool === 'arrow' && styles.toolSelected]}>
                <EditorIcon name="arrow" color={tool === 'arrow' ? colors.accent : colors.secondary} /><Text style={[styles.toolText, tool === 'arrow' && styles.toolTextSelected]}>Arrow</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Add text to image" accessibilityState={{ selected: tool === 'text' }} onPress={() => setTool('text')} style={[styles.tool, desktopWeb && styles.toolDesktop, tool === 'text' && styles.toolSelected]}>
                <EditorIcon name="text" color={tool === 'text' ? colors.accent : colors.secondary} /><Text style={[styles.toolText, tool === 'text' && styles.toolTextSelected]}>Text</Text>
              </Pressable>
              {desktopWeb ? <View style={styles.toolDivider} /> : null}
              <Pressable accessibilityRole="button" accessibilityLabel="Undo image edit" disabled={!operations.length} onPress={undo} style={[styles.tool, desktopWeb && styles.toolDesktop, !operations.length && styles.disabled]}>
                <EditorIcon name="undo" color={operations.length ? colors.secondary : colors.muted} /><Text style={styles.toolText}>Undo</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Clear image edits" disabled={!operations.length} onPress={() => { setOperations([]); setSelectedLabel(null); }} style={[styles.tool, desktopWeb && styles.toolDesktop, !operations.length && styles.disabled]}>
                <EditorIcon name="trash" color={operations.length ? colors.secondary : colors.muted} /><Text style={styles.toolText}>Clear</Text>
              </Pressable>
            </View>
            {tool === 'draw' || tool === 'arrow' ? (
              <View style={[styles.optionRow, desktopWeb && styles.contextRowDesktop]}>
                <View style={styles.colorRow}>{COLORS.map((value) => (
                  <Pressable key={value} accessibilityRole="radio" accessibilityLabel={value === COLORS[0] ? 'Amber' : value === COLORS[1] ? 'Red' : 'White'} accessibilityState={{ checked: color === value }} onPress={() => setColor(value)} style={[styles.color, { backgroundColor: value }, color === value && styles.colorSelected]} />
                ))}</View>
                <RangeControl label={tool === 'arrow' ? 'Arrow size' : 'Brush size'} min={4} max={48} step={1} value={brush} colors={colors} styles={styles} setValue={setBrush} />
              </View>
            ) : tool === 'text' ? (
              selectedText ? (
                <View style={[styles.selectedTextPanel, desktopWeb && styles.selectedTextPanelDesktop]}>
                  <View style={[styles.selectedTextHeader, desktopWeb && styles.selectedTextHeaderDesktop]}>
                    <View>
                      <Text style={styles.selectedTextTitle}>Selected text</Text>
                      <Text style={styles.selectedTextCount}>{selectedTextNumber} of {textCount}</Text>
                    </View>
                    {desktopWeb ? null : selectedTextActions()}
                  </View>
                  <TextInput accessibilityLabel="Selected text" maxLength={80} onChangeText={setSelectedText} placeholder="Type a label" placeholderTextColor={colors.muted} style={[styles.input, desktopWeb && styles.selectedTextInputDesktop]} value={selectedText.text} />
                  <View style={[styles.textOptions, !desktopWeb && styles.selectedTextOptionsMobile, desktopWeb && styles.selectedTextOptionsDesktop]}>
                    <View style={styles.colorRow}>{COLORS.map((value) => (
                      <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Text ${value === COLORS[0] ? 'amber' : value === COLORS[1] ? 'red' : 'white'}`} accessibilityState={{ checked: selectedText.color === value }} onPress={() => setSelectedTextColor(value)} style={[styles.smallColor, { backgroundColor: value }, selectedText.color === value && styles.colorSelected]} />
                    ))}</View>
                    <RangeControl label="Text size" min={size.width * .025} max={size.width * .14} step={Math.max(.001, size.width * .005)} value={selectedText.size} colors={colors} styles={styles} setValue={setSelectedTextSize} />
                  </View>
                  {desktopWeb ? selectedTextActions() : null}
                </View>
              ) : (
                <View style={[styles.textPanel, desktopWeb && styles.textPanelDesktop]}>
                  <View style={styles.textRow}>
                    <TextInput accessibilityLabel="Image label" autoFocus maxLength={80} onChangeText={setLabel} onSubmitEditing={addText} placeholder="Type a label" placeholderTextColor={colors.muted} returnKeyType="done" style={styles.input} value={label} />
                    <Pressable accessibilityRole="button" accessibilityLabel="Place text on image" disabled={!label.trim()} onPress={addText} style={[styles.addText, !label.trim() && styles.disabled]}><Text style={styles.addTextLabel}>Add</Text></Pressable>
                  </View>
                  <View style={styles.textOptions}>
                    <View style={styles.colorRow}>{COLORS.map((value) => (
                      <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Text ${value === COLORS[0] ? 'amber' : value === COLORS[1] ? 'red' : 'white'}`} accessibilityState={{ checked: color === value }} onPress={() => setColor(value)} style={[styles.smallColor, { backgroundColor: value }, color === value && styles.colorSelected]} />
                    ))}</View>
                    <Text style={styles.textHint}>Add text, then tap it to edit or move it.</Text>
                  </View>
                </View>
              )
            ) : (
              <Text style={[styles.moveHint, desktopWeb && styles.moveHintDesktop]}>Drag to move · Pinch with two fingers to zoom</Text>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    rootDesktop: { alignItems: 'center', justifyContent: 'center' },
    desktopPadding: { padding: 24 },
    frame: { flex: 1, width: '100%', overflow: 'hidden', backgroundColor: colors.background },
    frameDesktop: { maxWidth: 1360, maxHeight: 860, borderWidth: 1, borderColor: colors.border, borderRadius: 20 },
    header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: 6 },
    headerDesktop: { minHeight: 66, paddingHorizontal: 16 },
    headerAction: { width: 92, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: 'transparent', borderRadius: 10 },
    headerActionDesktop: { width: 128, borderColor: colors.border, borderRadius: 11 },
    headerActionPrimary: { borderColor: colors.accent, backgroundColor: colors.accent },
    cancel: { color: colors.secondary, fontSize: 12, fontWeight: '800' },
    done: { color: colors.accentText, fontSize: 12, fontWeight: '800' },
    heading: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
    title: { color: colors.text, textAlign: 'center', fontSize: 15, fontWeight: '800' },
    subtitle: { maxWidth: '78%', marginTop: 2, color: colors.muted, textAlign: 'center', fontSize: 10 },
    stage: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: '#05060a' },
    imageFrame: { overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,.12)', borderRadius: 10, backgroundColor: '#11131a' },
    previewEdits: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
    exportFrame: { position: 'absolute', left: -10000, top: -10000 },
    gestureSurface: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      ...(Platform.OS === 'web' ? { touchAction: 'none' as any } : {}),
    },
    zoomControls: { position: 'absolute', top: 12, right: 12, flexDirection: 'row', alignItems: 'center', padding: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,.12)', borderRadius: 12, backgroundColor: 'rgba(0,0,0,.78)' },
    zoomButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    zoomButtonText: { color: '#ffffff', fontSize: 22, lineHeight: 24, fontWeight: '500' },
    zoomLevel: { minWidth: 52, height: 34, alignItems: 'center', justifyContent: 'center' },
    zoomLevelText: { color: '#ffffff', fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
    errorCard: { position: 'absolute', left: 22, right: 22, bottom: 18, padding: 14, borderRadius: 13, borderWidth: 1, borderColor: `${colors.danger}88`, backgroundColor: colors.surface },
    errorTitle: { color: colors.danger, fontSize: 13, fontWeight: '800' },
    errorText: { color: colors.secondary, fontSize: 11, lineHeight: 16, marginTop: 4 },
    toolbar: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 12 : 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.background },
    toolbarDesktop: { minHeight: 54, justifyContent: 'center', paddingHorizontal: 18, paddingTop: 0, paddingBottom: 0 },
    toolRow: { flexDirection: 'row', gap: 6 },
    toolRowDesktop: { position: 'absolute', top: -74, left: '50%', width: 520, marginLeft: -260, gap: 4, padding: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 15, backgroundColor: colors.surface },
    tool: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 11, borderWidth: 1, borderColor: 'transparent' },
    toolDesktop: { flexGrow: 0, flexShrink: 0, flexBasis: 78, minHeight: 54, borderRadius: 10 },
    toolDivider: { width: 1, height: 34, alignSelf: 'center', marginHorizontal: 2, backgroundColor: colors.border },
    toolSelected: { borderColor: `${colors.accent}88`, backgroundColor: `${colors.accent}18` },
    toolText: { color: colors.secondary, fontSize: 10, fontWeight: '700' },
    toolTextSelected: { color: colors.accent },
    optionRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 7 },
    contextRowDesktop: { minHeight: 54, justifyContent: 'center', paddingTop: 0 },
    colorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    color: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: colors.borderStrong },
    smallColor: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: colors.borderStrong },
    colorSelected: { borderWidth: 4, borderColor: colors.accent },
    rangeWrap: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
    rangeLabel: { fontSize: 10, fontWeight: '700' },
    rangeTrack: { flex: 1, height: 26, justifyContent: 'center', borderRadius: 13, overflow: 'hidden' },
    rangeFill: { height: 4, borderRadius: 2 },
    rangeThumb: { position: 'absolute', width: 20, height: 20, marginLeft: -10, borderRadius: 10, borderWidth: 2 },
    rangeValue: { width: 28, fontSize: 11, fontWeight: '800', textAlign: 'right', fontVariant: ['tabular-nums'] },
    textPanel: { gap: 7, paddingTop: 7 },
    textPanelDesktop: { minHeight: 54, justifyContent: 'center', paddingTop: 0 },
    textRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8 },
    textOptions: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 12 },
    textHint: { flex: 1, color: colors.secondary, fontSize: 10, lineHeight: 14 },
    selectedTextPanel: { gap: 8, paddingTop: 7 },
    selectedTextPanelDesktop: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 0 },
    selectedTextHeader: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    selectedTextHeaderDesktop: { width: 92, minHeight: 0, flexShrink: 0 },
    selectedTextTitle: { color: colors.text, fontSize: 11, fontWeight: '800' },
    selectedTextCount: { marginTop: 2, color: colors.muted, fontSize: 9 },
    selectedTextInputDesktop: { minHeight: 38, maxWidth: 360 },
    selectedTextOptionsMobile: { gap: 6 },
    selectedTextOptionsDesktop: { flex: 1, minWidth: 250 },
    selectedTextActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    textAction: { minHeight: 38, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 9 },
    textActionLabel: { color: colors.secondary, fontSize: 11, fontWeight: '800' },
    deleteText: { borderColor: colors.border },
    deleteTextLabel: { color: colors.danger, fontSize: 11, fontWeight: '800' },
    moveHint: { minHeight: 48, color: colors.secondary, fontSize: 11, fontWeight: '700', textAlign: 'center', paddingTop: 16 },
    moveHintDesktop: { minHeight: 54, paddingTop: 19 },
    input: { flex: 1, minHeight: 46, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
    addText: { minWidth: 64, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.accent },
    addTextLabel: { color: colors.accentText, fontSize: 13, fontWeight: '800' },
    disabled: { opacity: .38 },
  });
}
