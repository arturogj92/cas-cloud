import { Pressable, type PressableProps } from 'react-native';
import type { ReactNode } from 'react';

export type ComposerButtonProps = PressableProps & {
  dark: boolean;
  reduceMotion: boolean;
};

export function ComposerButton({ dark, reduceMotion, ...props }: ComposerButtonProps) {
  return <Pressable {...props} />;
}

export function ComposerTrailingActions({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
