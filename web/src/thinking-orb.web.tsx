import { ThinkingOrb as WebThinkingOrb, type OrbState } from 'thinking-orbs';
import type { CSSProperties } from 'react';

type Props = {
  state: OrbState;
  dark: boolean;
  reduceMotion?: boolean;
  size?: 20 | 64;
  style?: CSSProperties;
  testID?: string;
};

export function ThinkingOrb({ state, dark, reduceMotion = false, size = 20, style, testID }: Props) {
  return (
    <WebThinkingOrb
      state={state}
      size={size}
      theme={dark ? 'dark' : 'light'}
      paused={reduceMotion}
      aria-label={`${state[0].toUpperCase()}${state.slice(1)}`}
      data-testid={testID}
      style={style}
    />
  );
}
