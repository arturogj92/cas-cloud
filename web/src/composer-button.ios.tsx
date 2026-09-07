import { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import type { ComposerButtonProps } from './composer-button';

const glassAvailable = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

export function ComposerButton({ dark, reduceMotion, children, style, ...props }: ComposerButtonProps) {
  const [reduceTransparency, setReduceTransparency] = useState(true);
  useEffect(() => {
    let mounted = true;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency);
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => { if (mounted) setReduceTransparency(value); })
      .catch(() => {}); // Keep the opaque controls if the accessibility query fails.
    return () => { mounted = false; subscription.remove(); };
  }, []);

  if (!glassAvailable || reduceTransparency) {
    return <Pressable {...props} style={style}>{children}</Pressable>;
  }

  const baseStyle = StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style);
  return (
    <GlassView
      key={`${reduceMotion}-${Boolean(props.disabled)}`}
      testID={`liquid-glass-${props.accessibilityLabel}`}
      colorScheme={dark ? 'dark' : 'light'}
      glassEffectStyle="regular"
      isInteractive={!reduceMotion && !props.disabled}
      tintColor={typeof baseStyle?.backgroundColor === 'string' ? baseStyle.backgroundColor : undefined}
      style={[baseStyle, styles.glass]}
    >
      <Pressable {...props} accessibilityState={{ ...props.accessibilityState, disabled: Boolean(props.disabled) }} style={styles.touch}>
        {(state) => {
          const contentStyle = StyleSheet.flatten(typeof style === 'function' ? style(state) : style);
          // UIVisualEffectView and its ancestors must stay opaque; fade only the icon.
          return <View pointerEvents="none" style={{ opacity: contentStyle?.opacity ?? 1 }}>
            {typeof children === 'function' ? children(state) : children}
          </View>;
        }}
      </Pressable>
    </GlassView>
  );
}

export function ComposerTrailingActions({ children }: { children: ReactNode }) {
  return glassAvailable
    ? <GlassContainer spacing={2} style={styles.actions}>{children}</GlassContainer>
    : <View style={styles.actions}>{children}</View>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  glass: { minWidth: 44, minHeight: 44, borderRadius: 22, backgroundColor: 'transparent', borderWidth: 0, opacity: 1 },
  touch: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
});
