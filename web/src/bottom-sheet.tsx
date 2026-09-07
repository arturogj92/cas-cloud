import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { shouldDismissSheet } from './sheet-dismiss';

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  accessibilityLabel?: string;
  reduceMotion?: boolean;
  testID?: string;
  handleTestID?: string;
  sheetStyle: StyleProp<ViewStyle>;
  backdropStyle: StyleProp<ViewStyle>;
  layoutStyle: StyleProp<ViewStyle>;
  handleStyle: StyleProp<ViewStyle>;
  dragAreaStyle: StyleProp<ViewStyle>;
  avoidKeyboard?: boolean;
  keyboardBehavior?: 'height' | 'padding';
  keyboardVerticalOffset?: number;
  onDismiss?: () => void;
  children: ReactNode;
};

const WEB_HOST = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 99999,
} as unknown as ViewStyle;

function webPortal(node: ReactNode) {
  if (typeof document === 'undefined') return node;
  const { createPortal } = require('react-dom');
  return createPortal(node, document.body);
}

export function BottomSheet({
  open,
  onClose,
  closeLabel,
  accessibilityLabel,
  reduceMotion = false,
  testID,
  handleTestID,
  sheetStyle,
  backdropStyle,
  layoutStyle,
  handleStyle,
  dragAreaStyle,
  avoidKeyboard = false,
  keyboardBehavior,
  keyboardVerticalOffset = 0,
  onDismiss,
  children,
}: BottomSheetProps) {
  const height = useRef(Dimensions.get('window').height);
  const translateY = useRef(new Animated.Value(height.current)).current;
  const startY = useRef(0);
  const lastY = useRef(0);
  const lastAt = useRef(0);
  const velocity = useRef(0);
  const wasOpen = useRef(false);
  const sheetRef = useRef<View>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const animateClosed = useCallback(() => {
    if (reduceMotion) {
      onClose();
      return;
    }
    Animated.timing(translateY, {
      toValue: height.current,
      duration: 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) onClose(); });
  }, [onClose, reduceMotion, translateY]);
  const settleOpen = useCallback(() => {
    if (reduceMotion) {
      translateY.setValue(0);
      return;
    }
    Animated.spring(translateY, {
      toValue: 0,
      speed: 20,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [reduceMotion, translateY]);
  useEffect(() => {
    translateY.stopAnimation();
    translateY.setValue(reduceMotion ? 0 : height.current);
    if (open && !reduceMotion) settleOpen();
  }, [open, reduceMotion, settleOpen, translateY]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (wasOpen.current && !open) onDismiss?.();
    wasOpen.current = open;
  }, [open, onDismiss]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !open || typeof document === 'undefined') return undefined;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      (sheetRef.current as unknown as HTMLElement | null)?.focus?.();
    });
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const node = sheetRef.current as unknown as HTMLElement | null;
      if (!node?.querySelectorAll) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) {
        event.preventDefault();
        node.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === node || active === focusable[0] || !node.contains(active))) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && active === focusable[focusable.length - 1]) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', keepFocusInside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keepFocusInside);
      previousFocus.current?.focus?.();
      previousFocus.current = null;
    };
  }, [open]);
  const grant = (event: GestureResponderEvent) => {
    startY.current = event.nativeEvent.pageY;
    lastY.current = event.nativeEvent.pageY;
    lastAt.current = Date.now();
    velocity.current = 0;
  };
  const move = (event: GestureResponderEvent) => {
    const y = event.nativeEvent.pageY;
    const now = Date.now();
    velocity.current = (y - lastY.current) / Math.max(1, now - lastAt.current);
    lastY.current = y;
    lastAt.current = now;
    translateY.setValue(Math.max(0, y - startY.current));
  };
  const release = () => {
    if (shouldDismissSheet(lastY.current - startY.current, velocity.current)) animateClosed();
    else settleOpen();
  };
  const sheet = (
    <Animated.View
      ref={sheetRef}
      testID={testID}
      role="dialog"
      aria-modal
      accessibilityViewIsModal
      accessibilityLabel={accessibilityLabel}
      tabIndex={-1}
      onLayout={({ nativeEvent }) => { height.current = nativeEvent.layout.height; }}
      style={[sheetStyle, { transform: [{ translateY }] }]}
    >
      <View
        testID={handleTestID}
        accessibilityRole="adjustable"
        accessibilityLabel="Drag to close"
        style={dragAreaStyle}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={grant}
        onResponderMove={move}
        onResponderRelease={release}
        onResponderTerminate={settleOpen}
      >
        <View pointerEvents="none" style={handleStyle} />
      </View>
      {children}
    </Animated.View>
  );
  const body = (
    <>
      <Pressable style={styles.backdropHit} onPress={animateClosed} accessibilityLabel={closeLabel}>
        <Animated.View pointerEvents="none" style={[backdropStyle, { opacity: translateY.interpolate({
          inputRange: [0, 420],
          outputRange: [1, 0],
          extrapolate: 'clamp',
        }) }]} />
      </Pressable>
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          pointerEvents="box-none"
          style={layoutStyle}
          behavior={keyboardBehavior || (Platform.OS === 'ios' ? 'padding' : undefined)}
          keyboardVerticalOffset={keyboardVerticalOffset}
        >
          {sheet}
        </KeyboardAvoidingView>
      ) : (
        <View pointerEvents="box-none" style={layoutStyle}>
          {sheet}
        </View>
      )}
    </>
  );
  if (Platform.OS === 'web') {
    if (!open) return null;
    return webPortal(
      <View pointerEvents="box-none" style={WEB_HOST}>
        {body}
      </View>,
    );
  }
  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={animateClosed} onDismiss={onDismiss}>
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropHit: {
    ...StyleSheet.absoluteFillObject,
  },
});
