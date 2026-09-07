import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View, type ViewStyle } from 'react-native';
import { Canvas, PaintStyle, Picture, Skia, createPicture, type SkPicture } from '@shopify/react-native-skia';
import { MODE_FRAMES, resolvePreset, type OrbState } from 'thinking-orbs/engine';

const LABELS: Record<OrbState, string> = {
  working: 'Working',
  searching: 'Searching',
  solving: 'Solving',
  listening: 'Listening',
  connecting: 'Connecting',
  weaving: 'Weaving',
  composing: 'Composing',
  breathing: 'Thinking',
  shaping: 'Shaping',
};

type Props = {
  state: OrbState;
  dark: boolean;
  reduceMotion?: boolean;
  size?: 20 | 64;
  style?: ViewStyle;
  testID?: string;
};

export function ThinkingOrb({ state, dark, reduceMotion = false, size = 20, style, testID }: Props) {
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const paints = useMemo(() => ({ fill: Skia.Paint(), stroke: Skia.Paint() }), []);
  const rgba = useRef(new Float32Array(4)).current;
  const preset = useMemo(() => resolvePreset(state, size), [state, size]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const { fill, stroke } = paints;
    fill.setAntiAlias(true);
    stroke.setAntiAlias(true);
    stroke.setStyle(PaintStyle.Stroke);
    const build = MODE_FRAMES[preset.mode];
    const setInk = (paint: typeof fill, white: number, alpha: number) => {
      const shade = Math.round((dark ? 1 - white : white) * 255) / 255;
      rgba[0] = shade;
      rgba[1] = shade;
      rgba[2] = shade;
      rgba[3] = alpha;
      paint.setColor(rgba);
    };
    const draw = (seconds: number) => setPicture(createPicture((canvas) => {
      const frame = build(size, seconds, preset.opts);
      for (const line of frame.lines) {
        setInk(stroke, line.white, line.a ?? 1);
        stroke.setStrokeWidth(line.w);
        canvas.drawLine(line.x1, line.y1, line.x2, line.y2, stroke);
      }
      for (const dot of frame.dots) {
        setInk(fill, dot.white, dot.a ?? 1);
        canvas.drawCircle(dot.x, dot.y, dot.r, fill);
      }
    }, Skia.XYWHRect(0, 0, size, size)));

    if (reduceMotion || !active) {
      draw(0.6 * preset.speed);
      return undefined;
    }
    let animationFrame = 0;
    const tick = (now: number) => {
      draw((now / 1000) * preset.speed);
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [active, dark, paints, preset, reduceMotion, rgba, size]);

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={LABELS[state]}
      style={[{ width: size, height: size }, style]}
    >
      <Canvas style={{ width: size, height: size }}>{picture ? <Picture picture={picture} /> : null}</Canvas>
    </View>
  );
}
