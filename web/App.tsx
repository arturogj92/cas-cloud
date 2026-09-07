import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, memo, useCallback, useContext, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { renderMermaidSVG } from 'beautiful-mermaid';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  ScrollView as GestureScrollView,
  State,
  type PanGestureHandlerProps,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import type { OrbState } from 'thinking-orbs';
import { BottomSheet } from './src/bottom-sheet';
import { ComposerButton, ComposerTrailingActions } from './src/composer-button';
import { connectionNoticeEligible, runtimeActivityForAppState } from './src/app-state-policy';
import { coalesceLatest } from './src/coalesce-latest';
import { featuredQuota } from './src/quota-pick';
import {
  SESSION_ACTIONS_WIDTH,
  SESSION_CLOSE_SWIPE_THRESHOLD,
  isSessionCloseArmed,
  isSessionSwipeGesture,
  shouldOpenSessionAfterScroll,
  shouldOpenSessionActions,
} from './src/session-swipe';
import { isTabSwipeGesture, settledTab, tabDragOffset, type MobileTab } from './src/tab-swipe';
import { WEB_SHORTCUTS, webShortcutAction } from './src/web-shortcuts';
import {
  WEB_HOST_ICON_IDS,
  loadWebHostIcons,
  saveWebHostIcon,
  webHostIcon,
  type WebHostIconId,
  type WebHostIcons,
} from './src/web-host-icons';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type ListRenderItemInfo,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Reanimated, { FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, SvgXml } from 'react-native-svg';
import { cameraZoomFromPinch } from './src/scanner-zoom';
import { orderTimelineItems, retainedTimelineStart } from './src/timeline-order';
import {
  appendMobileAttachment,
  createMobileAttachment,
  extractLocalImageReferences,
  MAX_MOBILE_ATTACHMENTS,
  MAX_MOBILE_FILE_BYTES,
  MOBILE_CAMERA_MAX_EDGE,
  MOBILE_CAMERA_QUALITY,
  MOBILE_IMAGE_MAX_EDGE,
  MOBILE_IMAGE_QUALITY,
  MOBILE_IMAGE_RETRY_QUALITY,
  type MobileAttachment,
} from './src/mobile-attachments';
import { MobileImageEditor } from './src/mobile-image-editor';
import InlineComposer, { type InlineComposerRef } from './src/inline-composer';
import { attachmentMessageParts, attachmentOrdinal, type InlineDraft } from './src/inline-attachments';
import { ProjectsKanbanScreen } from './src/projects-kanban';
import { invalidateTaskCache } from './src/task-cache';
import { viewportFromPinch } from './src/mobile-image-editor-geometry';
import { shouldDismissSheet } from './src/sheet-dismiss';
import { localPreviewUrls } from './src/local-preview';
import { providerLoginDeviceCode } from './src/provider-login';
import { ThinkingOrb } from './src/thinking-orb';
import { completeDemoTurn, createDemoHistory, createDemoRuntimeState, runDemoCommand } from './src/demo-runtime';
import { migratePendingSendSessions, selectNextPendingDrain } from './src/pending-send-queue';
import { pairingInputFromUrl } from './src/protocol';
import {
  WebMultiHostRuntimeClient,
  hostScopedId,
  mergeHostHistory,
  scopeHostHistory,
  splitHostScopedId,
} from './src/web-multi-host-runtime';
import { prepareLocalNotifications, subscribeToNotificationResponses } from './src/push';
import {
  loadWebProjectShortcuts,
  readWebProjectShortcuts,
  saveWebProjectShortcuts,
  type WebProjectShortcut,
} from './src/web-project-shortcuts';
import { watchBridge } from './src/watch-bridge';
import { makeWatchMessages, makeWatchSnapshot, parseWatchEvent } from './src/watch-state';
import {
  loadMobileHistory,
  loadMobileListPreferences,
  loadMobileNotificationsEnabled,
  loadMobileTheme,
  loadMobileWorktreePreference,
  loadPendingSends,
  saveMobileHistory,
  saveMobileListPreferences,
  saveMobileTheme,
  saveMobileWorktreePreference,
  savePendingSends,
  type MobileTheme,
  type PendingSendCache,
  type PersistedPendingSend,
} from './src/storage';

import {
  type MobileRuntimeClient,
  type MobileRuntimeState,
  type RuntimeHistoryConversation,
  type RuntimeHost,
  type RuntimeItem,
  type RuntimeProject,
  type RuntimeQuestion,
  type RuntimeQuotaSnapshot,
  type RuntimeQuotaWindow,
  type RuntimeProvider,
  type RuntimeRequest,
  type RuntimeSession,
  type RuntimeShortcut,
  type RuntimeTerminalStatus,
  normalizeSession,
  normalizeRuntimeProvider,
  sortSessionsByRecentActivity,
  sortSessionsByTerminalOrder,
} from './src/runtime';

if (Platform.OS !== 'web') void SplashScreen.preventAutoHideAsync();

type MarkdownSpan = {
  type: 'text' | 'bold' | 'code' | 'link' | 'image' | 'source' | 'html';
  text: string;
  url?: string;
};

type SessionOpenSource = 'row' | 'notification' | 'history' | 'created' | 'shortcut';
type SessionOpenTrace = {
  navigationId: string;
  sessionId: string;
  source: SessionOpenSource;
  startedAt: number;
  cached: boolean;
};
type MarkdownBlock = {
  type: 'paragraph' | 'images' | 'code' | 'list' | 'heading' | 'table';
  spans?: MarkdownSpan[];
  items?: MarkdownSpan[][];
  ordered?: boolean;
  text?: string;
  language?: string;
  closed?: boolean;
  level?: number;
  headers?: MarkdownSpan[][];
  rows?: MarkdownSpan[][][];
};
const { parseMarkdownBlocks } = require('./shared/chat-markdown.js') as {
  parseMarkdownBlocks: (text: string) => MarkdownBlock[];
};
const { assertMermaidSource, prepareChatMermaidSvg } = require('./shared/chat-mermaid.js') as {
  assertMermaidSource: (source: string) => void;
  prepareChatMermaidSvg: (svg: string, colors: Record<string, string>, idPrefix?: string) => { svg: string; width: number; height: number };
};
const { orbStateForActivities } = require('./shared/chat-orb-state.js') as {
  orbStateForActivities: (activities: RuntimeItem[]) => OrbState;
};
type SessionCoordination = { source: string; agent: string; type: 'request' | 'response' | 'message'; message: string };
const { parseSessionCoordinationPrompt } = require('./shared/session-coordination-message.js') as {
  parseSessionCoordinationPrompt: (text: string) => SessionCoordination | null;
};

const WATCH_WAKE_TIMEOUT_MS = 15_000;
const WATCH_SLEEP_DELAY_MS = 8_000;
const BRAND_ICON = require('./assets/brand/app-icon.png');
const BRAND_MARK = require('./assets/brand/isotipo.png');
const FRESH_MESSAGE_WINDOW_MS = 3_000;
const MESSAGE_ENTRY_DURATION_MS = 260;
const STREAM_HAPTIC_INTERVAL_MS = 320;
const INITIAL_TIMELINE_ITEM_LIMIT = 16;
// ponytail: cap active-turn expansion at 80 items; raise only after physical-device profiling.
const ACTIVE_TURN_ITEM_LIMIT = 80;
const CONNECTION_NOTICE_DELAY_MS = 2_000;
// Runtime envelopes arrive in bursts (replay after resume, hydration, streaming deltas). One React
// render per envelope saturates the JS thread, which is what blocks taps and swipe releases.
const RUNTIME_RENDER_COALESCE_MS = 80;

type UiIconName = 'arrow-down' | 'arrow-up' | 'brain' | 'camera' | 'check-circle' | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'chevron-up'
  | 'clock' | 'close-circle' | 'copy' | 'file' | 'gauge' | 'git-branch' | 'globe' | 'hourglass' | 'image' | 'laptop' | 'list' | 'mic' | 'monitor' | 'panels' | 'paperclip' | 'pause' | 'pie-chart' | 'play' | 'plus' | 'search' | 'server' | 'session-message' | 'shield' | 'sliders' | 'terminal-square' | 'trash';

const UI_ICON_PATHS: Record<UiIconName, string[]> = {
  'arrow-down': ['M12 5v14', 'M19 12l-7 7-7-7'],
  'arrow-up': ['M12 19V5', 'M5 12l7-7 7 7'],
  brain: ['M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-1 5.83V16a4 4 0 0 0 4 4h1V5.5a1 1 0 0 0-.5-1Z', 'M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 1 5.83V16a4 4 0 0 1-4 4h-1V5.5a1 1 0 0 1 .5-1Z', 'M6 9h2', 'M16 9h2', 'M7 15h3', 'M14 15h3'],
  camera: ['M14.5 4H9.5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2Z', 'M15.5 13a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z'],
  'check-circle': ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4 12 14.01l-3-3'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  clock: ['M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Z', 'M12 6v6l4 2'],
  'close-circle': ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'm15 9-6 6', 'm9 9 6 6'],
  copy: ['M8 8h11v11H8z', 'M5 16H4V5h11v1'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6'],
  gauge: ['M4 14a8 8 0 1 1 16 0', 'm12 14 4-4', 'M12 14h.01'],
  'git-branch': ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  globe: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10'],
  hourglass: ['M5 22h14', 'M5 2h14', 'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22', 'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'],
  image: ['M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', 'm21 15-5-5L5 21'],
  laptop: ['M20 16V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11', 'M2 20h20', 'M8 20h8'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  monitor: ['M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z', 'M8 21h8', 'M12 18v3'],
  panels: ['M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M12 3v18', 'M2 12h20'],
  paperclip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  pause: ['M8 5v14', 'M16 5v14'],
  'pie-chart': ['M21 12a9 9 0 1 1-9-9v9h9Z', 'M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z'],
  play: ['m8 5 11 7-11 7V5Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M21 21l-4.35-4.35', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  server: ['M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z', 'M6 6h.01', 'M6 18h.01'],
  'session-message': ['M5.5 7.5h8A2.5 2.5 0 0 1 16 10v3a2.5 2.5 0 0 1-2.5 2.5H10l-3.25 2.25V15.5H5.5A2.5 2.5 0 0 1 3 13v-3a2.5 2.5 0 0 1 2.5-2.5Z', 'M9 4.5h9.5A2.5 2.5 0 0 1 21 7v3a2.5 2.5 0 0 1-2.5 2.5H18', 'm9.5 10.5 2 1.5 2-1.5'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  'terminal-square': ['M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'm8 9 3 3-3 3', 'M13 15h3'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
};

function UiIcon({ name, size, color, strokeWidth = 2 }: { name: UiIconName; size: number; color: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {UI_ICON_PATHS[name].map((path) => (
        <Path key={path} d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

const HOST_ICON_LABELS: Record<WebHostIconId, string> = {
  vps: 'VPS', mac: 'Mac', windows: 'Windows', linux: 'Linux', desktop: 'Desktop',
  laptop: 'Laptop', cloud: 'Cloud', 'mini-pc': 'Mini PC', 'home-lab': 'Home lab', nas: 'NAS',
};
function HostGlyph({ icon, size, color }: { icon: WebHostIconId; size: number; color: string }) {
  if (icon === 'vps') return <UiIcon name="server" size={size} color={color} />;
  if (icon === 'desktop') return <UiIcon name="monitor" size={size} color={color} />;
  if (icon === 'laptop') return <UiIcon name="laptop" size={size} color={color} />;
  if (icon === 'mac') {
    return <Svg width={size} height={size} viewBox="0 0 512 512" accessibilityElementsHidden><Path d="M349.13 136.86c-40.32 0-57.36 19.24-85.44 19.24-28.79 0-50.75-19.1-85.69-19.1-34.2 0-70.67 20.88-93.83 56.45-32.52 50.16-27 144.63 25.67 225.11 18.84 28.81 44 61.12 77 61.47h.6c28.68 0 37.2-18.78 76.67-19h.6c38.88 0 46.68 18.89 75.24 18.89h.6c33-.35 59.51-36.15 78.35-64.85 13.56-20.64 18.6-31 29-54.35-76.19-28.92-88.43-136.93-13.08-178.34-23-28.8-55.32-45.48-85.79-45.48Z" fill={color} /><Path d="M340.25 32c-24 1.63-52 16.91-68.4 36.86-14.88 18.08-27.12 44.9-22.32 70.91h1.92c25.56 0 51.72-15.39 67-35.11C333.17 85.89 344.33 59.29 340.25 32Z" fill={color} /></Svg>;
  }
  if (icon === 'windows') {
    return <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden><Path d="M2 2h9v9H2zM13 2h9v9h-9zM2 13h9v9H2zM13 13h9v9h-9z" fill={color} /></Svg>;
  }
  if (icon === 'linux') {
    return <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden><Path d="M8.5 16.5C7.5 14.5 7 12 7 9c0-4 2-7 5-7s5 3 5 7c0 3-.5 5.5-1.5 7.5" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><Path d="M9.5 10c.6-1 1.5-1.5 2.5-1.5s1.9.5 2.5 1.5c1 1.9 1.5 4.1 1.5 6.5 0 2.5-1.8 4.5-4 4.5s-4-2-4-4.5c0-2.4.5-4.6 1.5-6.5Z" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" /><Circle cx="10.5" cy="6.5" r=".7" fill={color} /><Circle cx="13.5" cy="6.5" r=".7" fill={color} /><Path d="m10.8 8.2 1.2-1 1.2 1L12 9.3l-1.2-1.1ZM9.5 20.5 7 22h4m3.5-1.5L17 22h-4" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Svg>;
  }
  const paths: Record<Exclude<WebHostIconId, 'vps' | 'mac' | 'windows' | 'linux' | 'desktop' | 'laptop'>, string[]> = {
    cloud: ['M17.5 19H7a5 5 0 0 1-.5-9.98A7 7 0 0 1 20 11a4 4 0 0 1-2.5 8Z'],
    'mini-pc': ['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
    'home-lab': ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 7V4m6 3V4M9 20v-3m6 3v-3M7 9H4m3 6H4m16-6h-3m3 6h-3'],
    nas: ['M4 3h16a2 2 0 0 1 2 2v5H2V5a2 2 0 0 1 2-2Z', 'M2 14h20v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5Z', 'M6 6h.01M6 17h.01'],
  };
  return <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>{paths[icon].map((path) => <Path key={path} d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />)}</Svg>;
};

function HostIcon({ host, icons, size, color, testID, style }: {
  host: RuntimeHost;
  icons: WebHostIcons;
  size: number;
  color: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const icon = webHostIcon(host, icons);
  return <View testID={testID} accessibilityRole="image" accessibilityLabel={`${HOST_ICON_LABELS[icon]} icon for ${host.name}`} style={style}><HostGlyph icon={icon} size={size} color={color} /></View>;
}

const AGENTS = [
  { id: 'codex', label: 'Codex', color: '#ffffff', iconBg: '#111111', icon: require('./assets/brand/codex.png') },
  { id: 'claude', label: 'Claude', color: '#d77655', iconBg: '#d77655', icon: require('./assets/brand/claude.png') },
  { id: 'opencode', label: 'OpenCode', color: '#ffffff', iconBg: '#131010', icon: require('./assets/brand/opencode.png') },
  { id: 'kimi', label: 'Kimi', color: '#ffffff', iconBg: '#111111', icon: require('./assets/brand/kimi.png') },
  { id: 'antigravity', label: 'Antigravity', color: '#8b7bff', iconBg: '#111111', icon: require('./assets/brand/antigravity.png') },
  { id: 'grok', label: 'Grok', color: '#ffffff', iconBg: '#050505', icon: require('./assets/brand/grok.png') },
  { id: 'cursor', label: 'Cursor', color: '#ffffff', iconBg: '#111111', icon: require('./assets/cursor-icon.png') },
  { id: 'pi', label: 'Pi (beta)', color: '#ffffff', iconBg: '#111111', icon: require('./assets/brand/pi.png') },
] as const;

const PI_LOGIN_HELP = 'First time using Pi? On the computer running it, open pi and enter /login to connect a model provider, then retry here. Pi uses its own login, separate from Codex and Claude.';

const DARK = {
  background: '#050506',
  surface: '#171719',
  raised: '#202023',
  subtle: '#29292d',
  border: 'rgba(255,255,255,.12)',
  borderStrong: 'rgba(255,255,255,.20)',
  text: '#f7f7f8',
  secondary: '#a4a4aa',
  muted: '#707078',
  accent: '#ffc228',
  accentText: '#171208',
  brand: '#ffc228',
  primary: '#7f5af0',
  danger: '#ef4444',
  success: '#2cb67d',
  warning: '#ff8906',
};

const LIGHT = {
  background: '#f7f3eb',
  surface: '#ffffff',
  raised: '#eee9df',
  subtle: '#e4ded2',
  border: 'rgba(41,34,26,.14)',
  borderStrong: 'rgba(41,34,26,.22)',
  text: '#211e1a',
  secondary: '#6f685f',
  muted: '#91897e',
  accent: '#b87800',
  accentText: '#fff9ed',
  brand: '#b87800',
  primary: '#7c5cd6',
  danger: '#c74e5a',
  success: '#4c9a6c',
  warning: '#c96a10',
};

type Palette = typeof DARK;

const NEON: Palette = {
  background: '#0e0817',
  surface: '#160d24',
  raised: '#201331',
  subtle: '#3a2b55',
  border: 'rgba(190,160,255,.14)',
  borderStrong: 'rgba(190,160,255,.26)',
  text: '#f3edff',
  secondary: '#a795c9',
  muted: '#5f5378',
  accent: '#f472b6',
  accentText: '#140a20',
  brand: '#fbbf24',
  primary: '#a78bfa',
  danger: '#fb7185',
  success: '#34d399',
  warning: '#fbbf24',
};

const SAGE: Palette = {
  background: '#edf3f0',
  surface: '#fbfdfc',
  raised: '#dfe9e5',
  subtle: '#d2dfda',
  border: 'rgba(25,54,47,.14)',
  borderStrong: 'rgba(25,54,47,.24)',
  text: '#19362f',
  secondary: '#536f68',
  muted: '#789089',
  accent: '#28766f',
  accentText: '#f5fffc',
  brand: '#28766f',
  primary: '#28766f',
  danger: '#bc4e5b',
  success: '#3d8d63',
  warning: '#b77019',
};

const MOBILE_PALETTES: Record<MobileTheme, Palette> = { dark: DARK, neon: NEON, white: LIGHT, sage: SAGE };
const MOBILE_THEMES: Array<{ id: MobileTheme; label: string; preview: { background: string; surface: string; border: string; accent: string } }> = [
  { id: 'dark', label: 'Dark', preview: { background: '#050506', surface: '#202023', border: '#3a3a3e', accent: '#ffc228' } },
  { id: 'neon', label: 'Neon', preview: { background: '#0e0817', surface: '#160d24', border: '#3a2b55', accent: '#f472b6' } },
  { id: 'white', label: 'White', preview: { background: '#f7f3eb', surface: '#ffffff', border: '#cfc6b8', accent: '#b87800' } },
  { id: 'sage', label: 'Sage', preview: { background: '#edf3f0', surface: '#fbfdfc', border: '#bdcec8', accent: '#28766f' } },
];
type ConfigId = 'model' | 'effort' | 'thinking' | 'reasoning_effort' | 'serviceTier' | 'permissionMode';
type ConfigSection = ConfigId | 'context';
type WebPopoverAnchor = { left: number; bottom: number };
type WebContextMenuPosition = { left: number; top: number };
type WebContextMenuRequest = WebContextMenuPosition & { sessionId: string };
type ConfigValue = string | boolean;
type PendingSend = PersistedPendingSend;
type CloudProviderLoginFlow = { code?: string; url?: string };
const EMPTY_PENDING_SENDS: PendingSend[] = [];
type StartingSession = {
  agent: string;
  cwd: string;
  clientRequestId?: string;
  sessionId?: string;
  title?: string;
  project?: RuntimeProject | null;
};

function pendingRuntimeSession(session: StartingSession): RuntimeSession {
  return normalizeSession({
    sessionId: session.clientRequestId!,
    clientRequestId: session.clientRequestId!,
    agent: session.agent,
    provider: session.agent,
    cwd: session.cwd,
    title: session.title || 'Starting session…',
    project: session.project || { path: session.cwd, name: projectName(session.cwd) },
    state: 'starting',
  })!;
}
type QuestionDraft = Record<string, { values: string[]; custom: string }>;
type MobileModel = {
  id: string;
  name: string;
  current?: boolean;
  capabilities?: {
    optionDescriptors?: Array<{
      id: string;
      label: string;
      type?: string;
      currentValue?: ConfigValue;
      options?: Array<{ id: string; label: string }>;
    }>;
  };
};
type MobilePermissionMode = { id: string; label: string; description?: string };
type MobileModelCatalog = { models: MobileModel[]; permissionModes: MobilePermissionMode[] };

const VOICE_NOTE_MAX_MS = 5 * 60_000;
const WEB_CAMERA_PERMISSION_KEY = 'cas.mobile.camera-permission.v1';
const WEB_CHAT_HISTORY_KEY = 'casMobileSessionId';
const WEB_SPLIT_BREAKPOINT = 900;
const WEB_SPLIT_SIDEBAR_WIDTH = 390;
const KEYBOARD_DISMISS_MODE = 'on-drag';
const timelineItemKey = (item: RuntimeItem) => item.itemId;
const VOICE_WAVE_BAR_COUNT = 45;
const EMPTY_VOICE_LEVELS = Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => .14 + ((index * 7) % 9) / 30);
const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  android: {
    ...RecordingPresets.LOW_QUALITY.android,
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 16_000,
  },
  isMeteringEnabled: true,
};
const REASONING_CONFIG_IDS = new Set<ConfigId>(['effort', 'thinking', 'reasoning_effort']);

function openExternalUrl(url: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }
  return Linking.openURL(url);
}

function reasoningDescriptor(model?: MobileModel) {
  return model?.capabilities?.optionDescriptors?.find((option) => (
    REASONING_CONFIG_IDS.has(option.id as ConfigId)
  ));
}

function formatDuration(durationMs = 0) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatWorkDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, (seconds || (!hours && !minutes)) && `${seconds}s`].filter(Boolean).join(' ');
}

function formatClock(atMs?: number) {
  if (!Number.isFinite(atMs)) return '';
  const date = new Date(atMs!);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function uriToDataUrl(uri: string, mimeType: string) {
  const blob = await (await fetch(uri)).blob();
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
  const comma = encoded.indexOf(',');
  if (comma < 0) throw new Error('Could not read the recording');
  return `data:${mimeType};base64,${encoded.slice(comma + 1)}`;
}

async function pickedImageAttachment(asset: ImagePicker.ImagePickerAsset, edge = MOBILE_IMAGE_MAX_EDGE, compress = MOBILE_IMAGE_QUALITY, forceCompression = false): Promise<MobileAttachment> {
  const mimeType = asset.mimeType?.toLowerCase() || 'image/jpeg';
  if (!forceCompression && Math.max(asset.width, asset.height) <= edge && /^image\/(?:jpeg|png|webp)$/.test(mimeType)) {
    return createMobileAttachment({
      type: 'image',
      name: asset.fileName || `photo.${mimeType.split('/')[1]}`,
      mimeType,
      dataUrl: await uriToDataUrl(asset.uri, mimeType),
    });
  }
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > edge) {
    context.resize(asset.width >= asset.height ? { width: edge } : { height: edge });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ base64: true, compress, format: SaveFormat.JPEG });
  const baseName = (asset.fileName || 'photo').replace(/\.[^.]+$/, '');
  return createMobileAttachment({
    type: 'image',
    name: `${baseName}.jpg`,
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${saved.base64 || ''}`,
  });
}

function assertMobileFileSize(sizeBytes?: number) {
  if (Number.isFinite(sizeBytes) && sizeBytes! > MAX_MOBILE_FILE_BYTES) {
    throw new Error(`Attachment is too large. Keep it under ${MAX_MOBILE_FILE_BYTES / (1024 * 1024)} MB.`);
  }
}

async function pickedVideoAttachment(asset: ImagePicker.ImagePickerAsset): Promise<MobileAttachment> {
  assertMobileFileSize(asset.fileSize);
  const mimeType = asset.mimeType?.toLowerCase() || 'video/mp4';
  return createMobileAttachment({
    type: 'file',
    name: asset.fileName || 'video.mp4',
    mimeType,
    dataUrl: await uriToDataUrl(asset.uri, mimeType),
  });
}

async function pickedDocumentAttachment(asset: DocumentPicker.DocumentPickerAsset): Promise<MobileAttachment> {
  assertMobileFileSize(asset.size);
  const mimeType = asset.mimeType || 'application/octet-stream';
  return createMobileAttachment({
    type: 'file',
    name: asset.name || 'attachment',
    mimeType,
    dataUrl: await uriToDataUrl(asset.uri, mimeType),
  });
}

function anchorWebFilePicker(target: unknown) {
  if (Platform.OS !== 'web' || !(target instanceof HTMLElement)) return;
  const rect = target.getBoundingClientRect();
  const viewportBottom = window.visualViewport
    ? window.visualViewport.offsetTop + window.visualViewport.height
    : window.innerHeight;
  const style = document.documentElement.style;
  style.setProperty('--file-picker-left', `${rect.left}px`);
  style.setProperty('--file-picker-bottom', `${viewportBottom - rect.bottom}px`);
  style.setProperty('--file-picker-width', `${rect.width}px`);
  style.setProperty('--file-picker-height', `${rect.height}px`);
}

function agentInfo(agent: string | null) {
  return AGENTS.find((entry) => entry.id === agent) || {
    id: agent || 'agent',
    label: agent ? agent[0].toUpperCase() + agent.slice(1) : 'Agent',
    color: '#fbbf24',
    iconBg: '#141414',
    icon: BRAND_MARK,
  };
}

function runtimeHostLabel(runtime: Pick<MobileRuntimeState, 'hostKind'>) {
  return runtime.hostKind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop';
}

function AgentIcon({ agent, size, styles }: {
  agent: string | null;
  size: number;
  styles: ReturnType<typeof createStyles>;
}) {
  const info = agentInfo(agent);
  return (
    <View style={[styles.agentIconFrame, {
      width: size,
      height: size,
      borderRadius: Math.round(size * .28),
      backgroundColor: info.iconBg,
    }]}>
      <Image source={info.icon} resizeMode="contain" style={{ width: Math.round(size * .72), height: Math.round(size * .72) }} />
    </View>
  );
}

function ProjectIcon({ project, size, styles }: {
  project: RuntimeProject | null;
  size: number;
  styles: ReturnType<typeof createStyles>;
}) {
  const emoji = project?.icon?.startsWith('emoji:') ? project.icon.slice(6) : '';
  if (project?.iconDataUrl) {
    return <Image source={{ uri: project.iconDataUrl }} resizeMode="cover" style={{ width: size, height: size, borderRadius: Math.round(size * .25) }} />;
  }
  return (
    <View style={[styles.projectIconFrame, { width: size, height: size, borderRadius: Math.round(size * .25), backgroundColor: project?.color || '#7f5af0' }]}>
      <Text style={[styles.projectIconText, { fontSize: Math.round(emoji ? size * .48 : size * .4) }]}>{emoji || project?.name?.[0]?.toUpperCase() || '?'}</Text>
    </View>
  );
}

/** The desktop merges the project icon into each shortcut, so a chip paints like its navbar twin. */
function shortcutProject(shortcut: RuntimeShortcut): RuntimeProject {
  return {
    name: shortcut.projectName,
    path: shortcut.projectPath,
    ...(shortcut.color ? { color: shortcut.color } : {}),
    ...(shortcut.icon ? { icon: shortcut.icon } : {}),
    ...(shortcut.iconDataUrl ? { iconDataUrl: shortcut.iconDataUrl } : {}),
  };
}

function projectName(path: string | null) {
  if (!path) return 'No project';
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || path;
}

function itemText(item: RuntimeItem) {
  const dataText = typeof item.data?.text === 'string' ? item.data.text : '';
  if (item.itemType === 'user_message') {
    if (dataText) return dataText;
    if (itemAttachments(item).length) return '';
    return item.detail && item.detail !== 'User message' ? item.detail : '';
  }
  return dataText
    || item.content.assistant_text
    || item.content.plan_text
    || item.content.reasoning_summary_text
    || item.content.reasoning_text
    || item.content.command_output
    || item.detail
    || item.title
    || '';
}

function assistantText(item: RuntimeItem) {
  return (typeof item.data?.text === 'string' ? item.data.text : '')
    || item.content.assistant_text
    || '';
}

// Read-only iOS text inputs do not reliably emit blur; the chat owns dismissal.
const MessageSelectionContext = createContext<{ activeId: string | null; activate: (id: string | null) => void } | null>(null);

function MessageText({ children, style, text = typeof children === 'string' ? children : '' }: { children: ReactNode; style?: StyleProp<TextStyle>; text?: string }) {
  const id = useId();
  const selectionContext = useContext(MessageSelectionContext);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const selecting = selectionContext?.activeId === id;
  if (Platform.OS !== 'ios') return <Text selectable style={style}>{children}</Text>;
  return (
    <View onTouchStart={(event) => event.stopPropagation()}>
      <Text onLongPress={() => {
        setSelection({ start: 0, end: text.length });
        selectionContext?.activate(id);
      }} accessibilityElementsHidden={selecting} style={[style, selecting && { opacity: 0 }]}>{children}</Text>
      {selecting ? (
        <TextInput
          testID="inline-message-selection"
          autoFocus
          multiline
          readOnly
          selection={selection}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          showSoftInputOnFocus={false}
          scrollEnabled={false}
          style={[style, StyleSheet.absoluteFillObject, { padding: 0 }]}
        >
          <Text style={style}>{children}</Text>
        </TextInput>
      ) : null}
    </View>
  );
}

function MarkdownInline({ spans, styles, style }: { spans: MarkdownSpan[]; styles: ReturnType<typeof createStyles>; style?: StyleProp<TextStyle> }) {
  return (
    <MessageText text={spans.map((span) => span.text).join('')} style={[styles.assistantText, style]}>
      {spans.map((span, index) => {
        if (span.type === 'bold') return <Text key={index} style={styles.markdownBold}>{span.text}</Text>;
        if (span.type === 'code') return <Text key={index} style={styles.markdownInlineCode}>{span.text}</Text>;
        if (span.type === 'link' && span.url) {
          return <Text accessibilityRole="link" key={index} onPress={() => void openExternalUrl(span.url!).catch(() => undefined)} style={styles.markdownLink}>{span.text}</Text>;
        }
        return <Text key={index}>{span.text}</Text>;
      })}
    </MessageText>
  );
}

function useCopyFeedback(text: string, copiedLabel: string) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = () => {
    void Clipboard.setStringAsync(text).then(() => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      setCopied(true);
      AccessibilityInfo.announceForAccessibility(copiedLabel);
      resetTimer.current = setTimeout(() => setCopied(false), 1_600);
    }).catch(() => AccessibilityInfo.announceForAccessibility('Could not copy'));
  };
  return { copied, copy };
}

function MobileCopyAction({ text, testID, idleLabel, copiedLabel, colors, styles }: { text: string; testID: string; idleLabel: string; copiedLabel: string; colors: Palette; styles: ReturnType<typeof createStyles> }) {
  const { copied, copy } = useCopyFeedback(text, copiedLabel);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? copiedLabel : idleLabel}
      testID={testID}
      onPress={copy}
      style={({ pressed }) => [styles.markdownCodeCopy, copied && styles.markdownCodeCopyDone, pressed && styles.pressed]}
    >
      <UiIcon name={copied ? 'check-circle' : 'copy'} size={16} color={copied ? colors.success : colors.secondary} />
    </Pressable>
  );
}

function MobileCodeBlock({ text, blockIndex, colors, styles, status = '', error = false }: { text: string; blockIndex: number; colors: Palette; styles: ReturnType<typeof createStyles>; status?: string; error?: boolean }) {

  return (
    <View style={[styles.markdownBlock, styles.markdownCode, error && styles.markdownCodeError]}>
      {status ? <Text style={[styles.markdownCodeStatus, error && styles.markdownCodeStatusError]}>{status}</Text> : null}
      <ScrollView horizontal keyboardDismissMode={KEYBOARD_DISMISS_MODE} contentContainerStyle={[styles.markdownCodeScroll, status && styles.markdownCodeScrollWithStatus]}>
        <Text selectable style={styles.markdownCodeText}>{text}</Text>
      </ScrollView>
      <MobileCopyAction
        text={text}
        testID={`markdown-code-copy-${blockIndex}`}
        idleLabel="Copy code"
        copiedLabel="Code copied"
        colors={colors}
        styles={styles}
      />
    </View>
  );
}

function MobileMermaidDiagram({ text, blockIndex, colors, styles }: { text: string; blockIndex: number; colors: Palette; styles: ReturnType<typeof createStyles> }) {
  const { width: viewportWidth } = useWindowDimensions();
  const diagramId = useId();
  const diagram = useMemo(() => {
    try {
      assertMermaidSource(text);
      return prepareChatMermaidSvg(renderMermaidSVG(text, {
        bg: colors.surface,
        fg: colors.text,
        line: colors.muted,
        accent: colors.accent,
        muted: colors.muted,
        surface: colors.raised,
        border: colors.borderStrong,
        font: 'system-ui',
        padding: 32,
        transparent: true,
      }), {
        background: colors.surface,
        text: colors.text,
        muted: colors.muted,
        line: colors.muted,
        accent: colors.accent,
        surface: colors.raised,
        border: colors.borderStrong,
      }, diagramId);
    } catch (_) {
      return null;
    }
  }, [colors.accent, colors.borderStrong, colors.muted, colors.raised, colors.surface, colors.text, diagramId, text]);

  if (!diagram) {
    return <MobileCodeBlock text={text} blockIndex={blockIndex} colors={colors} styles={styles} status="Diagram unavailable · source preserved" error />;
  }

  const availableWidth = Math.max(260, Math.min(viewportWidth - 40, 970));
  const ratio = diagram.width / diagram.height;
  const scale = ratio > 2.4
    ? Math.min(1, 1_200 / diagram.width, 700 / diagram.height)
    : Math.min(1.25, availableWidth / diagram.width, 700 / diagram.height);
  const renderedWidth = diagram.width * scale;
  const renderedHeight = diagram.height * scale;

  return (
    <View testID={`markdown-mermaid-${blockIndex}`} style={[styles.markdownBlock, styles.markdownMermaid]} accessibilityRole="image" accessibilityLabel="Mermaid diagram">
      <Text style={styles.markdownMermaidLabel}>MERMAID</Text>
      <ScrollView horizontal keyboardDismissMode={KEYBOARD_DISMISS_MODE} contentContainerStyle={[styles.markdownMermaidScroll, { minWidth: availableWidth }]}>
        <SvgXml xml={diagram.svg} width={renderedWidth} height={renderedHeight} />
      </ScrollView>
      <MobileCopyAction
        text={text}
        testID={`markdown-mermaid-copy-${blockIndex}`}
        idleLabel="Copy diagram source"
        copiedLabel="Diagram source copied"
        colors={colors}
        styles={styles}
      />
    </View>
  );
}

const MobileMarkdown = memo(function MobileMarkdown({ text, colors, styles }: { text: string; colors: Palette; styles: ReturnType<typeof createStyles> }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <View>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'images') return null;
        if (block.type === 'paragraph') return <View key={blockIndex} style={styles.markdownBlock}><MarkdownInline spans={block.spans || []} styles={styles} /></View>;
        if (block.type === 'heading') {
          return <View key={blockIndex} style={styles.markdownBlock}><MarkdownInline spans={block.spans || []} style={[styles.markdownHeading, block.level === 1 && styles.markdownHeadingLarge]} styles={styles} /></View>;
        }
        if (block.type === 'list') {
          return (
            <View key={blockIndex} style={[styles.markdownBlock, styles.markdownList]}>
              {(block.items || []).map((spans, index) => (
                <View key={index} style={styles.markdownListItem}>
                  <Text style={styles.markdownListMarker}>{block.ordered ? `${index + 1}.` : '•'}</Text>
                  <View style={styles.markdownListCopy}><MarkdownInline spans={spans} styles={styles} /></View>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === 'code') {
          if (block.language?.toLowerCase() === 'mermaid') {
            return block.closed
              ? <MobileMermaidDiagram key={blockIndex} text={block.text || ''} blockIndex={blockIndex} colors={colors} styles={styles} />
              : <MobileCodeBlock key={blockIndex} text={block.text || ''} blockIndex={blockIndex} colors={colors} styles={styles} status="Rendering after the fence closes…" />;
          }
          return <MobileCodeBlock key={blockIndex} text={block.text || ''} blockIndex={blockIndex} colors={colors} styles={styles} />;
        }
        const rows = [block.headers || [], ...(block.rows || [])];
        return (
          <ScrollView horizontal key={blockIndex} keyboardDismissMode={KEYBOARD_DISMISS_MODE} style={[styles.markdownBlock, styles.markdownTable]} contentContainerStyle={styles.markdownTableContent}>
            <View style={styles.markdownTableGrid}>{rows.map((row, rowIndex) => <View key={rowIndex} style={styles.markdownTableRow}>{row.map((spans, cellIndex) => <View key={cellIndex} style={styles.markdownTableCell}><MarkdownInline spans={spans} styles={styles} /></View>)}</View>)}</View>
          </ScrollView>
        );
      })}
    </View>
  );
});

function LocalPreviewCards({ text, online, openPreview, styles }: {
  text: string;
  online: boolean;
  openPreview: (url: string) => Promise<boolean>;
  styles: ReturnType<typeof createStyles>;
}) {
  const { width } = useWindowDimensions();
  const urls = useMemo(() => localPreviewUrls(text), [text]);
  const [states, setStates] = useState<Record<string, 'opening' | 'error'>>({});
  if (!urls.length) return null;
  const open = async (url: string) => {
    setStates((current) => ({ ...current, [url]: 'opening' }));
    const opened = await openPreview(url);
    setStates((current) => {
      const next = { ...current };
      if (opened) delete next[url];
      else next[url] = 'error';
      return next;
    });
  };
  return (
    <View style={styles.localPreviewCards}>
      {urls.map((url) => {
        const state = states[url];
        return (
          <View key={url} testID="local-preview-card" style={styles.localPreviewCard}>
            <View style={styles.localPreviewHeader}>
              <UiIcon name="globe" size={14} color={styles.localPreviewLabel.color} />
              <Text style={styles.localPreviewLabel}>LOCAL PREVIEW</Text>
            </View>
            <Text numberOfLines={2} selectable style={styles.localPreviewUrl}>{url.slice('http://'.length)}</Text>
            <Text style={styles.localPreviewMeta}>Private link · expires in 20 min</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open localhost preview ${url}`}
              disabled={!online || state === 'opening'}
              onPress={() => void open(url)}
              style={({ pressed }) => [styles.localPreviewAction, Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT && styles.localPreviewActionDesktop, (!online || state === 'opening') && styles.localPreviewActionDisabled, pressed && online && styles.localPreviewActionPressed]}
            >
              {state === 'opening' ? <ActivityIndicator size="small" color={styles.localPreviewActionText.color} /> : null}
              <Text style={styles.localPreviewActionText}>{!online ? 'Host offline' : state === 'opening' ? 'Opening…' : 'Open preview'}</Text>
            </Pressable>
            {state === 'error' ? <Text style={styles.localPreviewError}>Could not open this preview. Check that the local server is running.</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function matchingUserMessages(items: RuntimeItem[], text: string) {
  return items.filter((item) => item.itemType === 'user_message' && itemText(item).trim() === text).length;
}

function compactTokens(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

function itemAttachments(item: RuntimeItem): Array<{ type: 'image' | 'audio' | 'file'; name: string; dataUrl: string; durationMs: number; attachmentId: string }> {
  if (!Array.isArray(item.data?.attachments)) return [];
  return item.data.attachments.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const attachment = value as Record<string, unknown>;
    if (attachment.type !== 'image' && attachment.type !== 'audio' && attachment.type !== 'file') return [];
    return [{
      type: attachment.type as 'image' | 'audio' | 'file',
      name: typeof attachment.name === 'string' ? attachment.name : attachment.type,
      dataUrl: typeof attachment.dataUrl === 'string'
        ? attachment.dataUrl
        : typeof attachment.thumbnailDataUrl === 'string'
          ? attachment.thumbnailDataUrl
          : '',
      durationMs: typeof attachment.durationMs === 'number' ? attachment.durationMs : 0,
      attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
    }];
  });
}

type ImagePreview = { name: string; dataUrl?: string; attachmentId?: string };
type ImageGallery = { images: ImagePreview[]; index: number };
type ResolvedImageReference = { path: string; name: string; attachmentId: string; dataUrl?: string };

function latestUserText(session: RuntimeSession) {
  for (let index = session.items.length - 1; index >= 0; index -= 1) {
    const item = session.items[index];
    if (item?.itemType === 'user_message') return itemText(item);
  }
  return '';
}

function sessionTitle(session: RuntimeSession) {
  if (session.title?.trim()) return session.title.trim();
  const prompt = latestUserText(session).replace(/\s+/g, ' ').trim();
  if (prompt) return prompt.length > 54 ? `${prompt.slice(0, 53)}…` : prompt;
  return `${agentInfo(session.agent).label} in ${projectName(session.cwd)}`;
}

function sessionStatus(session: RuntimeSession, catalog: RuntimeTerminalStatus[] = []): { key?: string; label: string; color: string; rank: number } {
  const configured = catalog.find((status) => status.key === session.workStatus);
  if (configured) return { key: configured.key, label: configured.label, color: configured.color, rank: 2 };
  if (session.workStatus === 'needs_input') return { label: 'Needs input', color: '#f97316', rank: 0 };
  if (session.workStatus === 'needs_testing') return { label: 'Needs testing', color: '#3b82f6', rank: 2 };
  if (session.workStatus === 'pushed') return { label: 'Pushed', color: '#67e8f9', rank: 2 };
  if (session.workStatus === 'done') return { label: 'Done', color: '#22c55e', rank: 2 };
  if (session.workStatus === 'working') return { key: 'working', label: 'Working', color: '#fbbf24', rank: 1 };
  if (session.state === 'starting') return { key: 'working', label: 'Starting', color: '#fbbf24', rank: 1 };
  if (session.state === 'stopped') return { label: 'Stopped', color: '#666666', rank: 3 };
  if (session.pendingQuestions.length) return { label: 'Needs input', color: '#fbbf24', rank: 0 };
  if (session.pendingRequests.length) return { label: 'Approval', color: '#ff8906', rank: 0 };
  if (session.currentTurn?.state === 'running' || session.state === 'running') {
    const working = catalog.find((status) => status.key === 'working');
    return { key: 'working', label: working?.label || 'Working', color: working?.color || '#fbbf24', rank: 1 };
  }
  if (session.state === 'error') return { label: 'Error', color: '#ef4444', rank: 0 };
  return { label: 'Ready', color: '#2cb67d', rank: 2 };
}

function commandOptions(request: RuntimeRequest) {
  if (Array.isArray(request.options) && request.options.length) {
    return request.options.slice(0, 3).map((option) => ({
      id: option.id || option.kind || 'cancelled',
      label: option.name || (option.kind?.includes('allow') ? 'Allow' : 'Deny'),
      allow: option.kind?.includes('allow') || option.kind === 'selected',
    }));
  }
  return [
    { id: 'allow_once', label: 'Allow once', allow: true },
    { id: 'reject_once', label: 'Deny', allow: false },
  ];
}

export default function App() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider initialMetrics={initialWindowMetrics}><MobileApp /></SafeAreaProvider></GestureHandlerRootView>;
}

function ProgressRail({ colors, reduceMotion, testID, style }: {
  colors: Palette;
  reduceMotion: boolean;
  testID: string;
  style?: object;
}) {
  const { width } = useWindowDimensions();
  const position = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) return undefined;
    const animation = Animated.loop(Animated.timing(position, {
      toValue: 1,
      duration: 1_100,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [position, reduceMotion]);
  return (
    <View testID={testID} style={[{ overflow: 'hidden' }, style]}>
      <Animated.View style={{
        width: '34%',
        height: '100%',
        borderRadius: 2,
        backgroundColor: colors.accent,
        transform: reduceMotion ? undefined : [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.34, width] }) }],
      }} />
    </View>
  );
}

function MotionRise({ children, reduceMotion, active = true, delay = 0, distance = 12, duration = 360, replayKey, style, testID }: {
  children: ReactNode;
  reduceMotion: boolean;
  active?: boolean;
  delay?: number;
  distance?: number;
  duration?: number;
  replayKey?: unknown;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const progress = useRef(new Animated.Value(active && !reduceMotion ? 0 : 1)).current;
  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion || !active) {
      progress.setValue(1);
      return undefined;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, delay, duration, progress, reduceMotion, replayKey]);
  return (
    <Animated.View testID={testID} style={[style, {
      opacity: progress,
      transform: [
        { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
        { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [.98, 1] }) },
      ],
    }]}>
      {children}
    </Animated.View>
  );
}

function SkeletonPulse({ children, reduceMotion, testID, style, accessibilityLabel, pointerEvents }: {
  children: ReactNode;
  reduceMotion: boolean;
  testID: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  pointerEvents?: 'auto' | 'box-none' | 'box-only' | 'none';
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return undefined;
    }
    pulse.setValue(0);
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 760, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 760, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion]);
  return (
    <Animated.View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      pointerEvents={pointerEvents}
      style={[style, !reduceMotion && { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [.48, 1] }) }]}
    >
      {children}
    </Animated.View>
  );
}

function SessionListSkeleton({ colors, styles, message, reduceMotion }: {
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  message: string;
  reduceMotion: boolean;
}) {
  return (
    <SkeletonPulse testID="session-list-skeleton" style={styles.flex} accessibilityLabel="Loading CodeAgentSwarm" reduceMotion={reduceMotion}>
      <View style={styles.appHeader}>
        <View style={styles.wordmarkRow}><Image source={BRAND_MARK} resizeMode="contain" style={styles.miniMark} /><Text style={styles.wordmark}>Agents</Text></View>
        <View style={styles.headerActions}><View style={styles.settingsButton}><UiIcon name="sliders" size={20} color={colors.muted} /></View><View style={[styles.plusButton, styles.loadingMuted]}>{Platform.OS === 'web' ? <UiIcon name="plus" size={24} color={colors.accentText} /> : <Text style={styles.plusText}>+</Text>}</View></View>
        <ProgressRail colors={colors} reduceMotion={reduceMotion} testID="initial-progress-rail" style={styles.headerProgressRail} />
      </View>
      <View style={styles.searchWrap}><View style={styles.searchIcon}><UiIcon name="search" size={17} color={colors.muted} /></View><View style={[styles.skeleton, styles.loadingSearchLine]} /></View>
      <View style={styles.loadingSessionList}>
        <View style={styles.loadingGroupRow}><View style={[styles.skeleton, styles.loadingGroupLine]} /><View style={styles.loadingGroupDivider} /></View>
        <Text style={styles.loadingListText}>{message}</Text>
        {Array.from({ length: 8 }, (_, index) => (
          <View key={index} testID="session-list-skeleton-row" style={[styles.sessionRow, styles.loadingSessionRow]}>
            <View style={[styles.sessionStatusRail, styles.loadingStatusRail]} />
            <View style={[styles.skeleton, styles.loadingSessionIcon]} />
            <View style={styles.loadingSessionCopy}><View style={[styles.skeleton, { width: index === 1 ? '54%' : '72%' }]} /><View style={[styles.skeleton, styles.loadingSessionMeta]} /></View>
          </View>
        ))}
      </View>
    </SkeletonPulse>
  );
}

function MobileApp() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const screenWidth = Math.max(1, width);
  const webSplit = Platform.OS === 'web' && screenWidth >= WEB_SPLIT_BREAKPOINT;
  const tabViewportWidth = webSplit ? WEB_SPLIT_SIDEBAR_WIDTH : screenWidth;
  const deviceTheme: MobileTheme = useColorScheme() === 'light' ? 'white' : 'dark';
  const [savedTheme, setSavedTheme] = useState<MobileTheme | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(Platform.OS !== 'web');
  const [themeReady, setThemeReady] = useState(false);
  const theme = savedTheme || deviceTheme;
  const dark = theme === 'dark' || theme === 'neon';
  const colors = MOBILE_PALETTES[theme];
  const styles = useMemo(() => createStyles(colors), [colors]);
  const client = useRef(new WebMultiHostRuntimeClient()).current;
  const [liveRuntime, setLiveRuntime] = useState<MobileRuntimeState>(client.getState());
  const [demoRuntime, setDemoRuntime] = useState<MobileRuntimeState | null>(null);
  const [webShortcutState, setWebShortcutState] = useState<{ runtimeId: string; shortcuts: WebProjectShortcut[] } | null>(null);
  const [webHostIcons, setWebHostIcons] = useState<WebHostIcons>(() => (
    Platform.OS === 'web' && typeof localStorage !== 'undefined' ? loadWebHostIcons(localStorage) : {}
  ));
  const demoGeneration = useRef(0);
  const runtime = demoRuntime || liveRuntime;
  const demoMode = Boolean(demoRuntime);
  const webShortcutScope = runtime.hosts?.length ? 'multi-host' : runtime.runtimeId;
  const [cloudProviders, setCloudProviders] = useState<RuntimeProvider[]>([]);
  const [cloudProvidersLoading, setCloudProvidersLoading] = useState(false);
  const [providerLogins, setProviderLogins] = useState<Set<string>>(new Set());
  const [providerLoginFlows, setProviderLoginFlows] = useState<Record<string, CloudProviderLoginFlow>>({});
  const requestedProviderLogins = useRef(new Set<string>());
  const currentRuntimeId = demoMode ? null : liveRuntime.runtimeId;
  const pairedRuntimeId = currentRuntimeId && client instanceof WebMultiHostRuntimeClient ? 'multi-host' : currentRuntimeId;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [webContextMenuRequest, setWebContextMenuRequest] = useState<WebContextMenuRequest | null>(null);
  const closingSessionIds = useRef(new Set<string>());
  const [optimisticallyClosedSessionIds, setOptimisticallyClosedSessionIds] = useState(new Set<string>());
  const [section, setSection] = useState<MobileTab>('sessions');
  const [taskRefreshVersion, setTaskRefreshVersion] = useState(0);
  const [history, setHistory] = useState<RuntimeHistoryConversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpeningId, setHistoryOpeningId] = useState<string | null>(null);
  const [historyReadyRuntimeId, setHistoryReadyRuntimeId] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [addingHost, setAddingHost] = useState(false);
  const [addingHostBaseline, setAddingHostBaseline] = useState(0);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const composerDrafts = useRef(new Map<string, InlineDraft>());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [startingSession, setStartingSession] = useState<StartingSession | null>(null);
  const [newAgent, setNewAgent] = useState('codex');
  const [newHostId, setNewHostId] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newUseWorktree, setNewUseWorktree] = useState<boolean | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend[]>>({});
  const [pendingSendsReady, setPendingSendsReady] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [showConnectionNotice, setShowConnectionNotice] = useState(false);
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  const listRef = useRef<FlatList<RuntimeItem>>(null);
  const visibleSessionIdsRef = useRef<string[]>([]);
  const searchInputRef = useRef<TextInput>(null);
  const dismissComposerRef = useRef<(() => void) | null>(null);
  const shortcutEditorRef = useRef<((shortcut?: RuntimeShortcut) => void) | null>(null);
  const dragX = useRef(new Animated.Value(0)).current;
  const chatEntrance = useRef(new Animated.Value(0)).current;
  const chatWasVisible = useRef(false);
  const sessionOpenTrace = useRef<SessionOpenTrace | null>(null);
  const tabX = useRef(new Animated.Value(0)).current;
  const historyRequest = useRef<Promise<void> | null>(null);
  const historyGeneration = useRef(0);
  const historyResumeGeneration = useRef(0);
  const sendingPending = useRef(new Set<string>());
  const watchEventsInFlight = useRef(new Set<string>());
  const appActive = useRef(AppState.currentState === 'active');
  const recoveredStoppedSessions = useRef(new Set<string>());
  const themeChosen = useRef(false);
  const notificationsChosen = useRef(false);
  const pendingSendsRef = useRef(pendingSends);
  pendingSendsRef.current = pendingSends;

  const connectionIssue = !demoMode && connectionNoticeEligible(runtime.phase, appForeground);
  const connectionNoticeVisible = connectionIssue && showConnectionNotice;
  const historyReady = runtime.phase === 'online' && historyReadyRuntimeId === pairedRuntimeId;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined' || !webShortcutScope) return;
    if (demoMode || !runtime.hosts?.length) {
      const saved = readWebProjectShortcuts(localStorage, webShortcutScope);
      if (saved === null && runtime.phase !== 'online' && !demoMode && !runtime.shortcuts.length) return;
      setWebShortcutState({
        runtimeId: webShortcutScope,
        shortcuts: saved ?? loadWebProjectShortcuts(localStorage, webShortcutScope, runtime.shortcuts),
      });
      return;
    }
    const shortcutScope = 'multi-host';
    const importedHostsKey = 'cas.mobile.web-project-shortcut-hosts.v1';
    const saved = readWebProjectShortcuts(localStorage, shortcutScope);
    if (saved === null && runtime.phase !== 'online' && !demoMode && !runtime.shortcuts.length) return;
    const legacy = saved === null ? runtime.hosts.flatMap((host) => (
      (readWebProjectShortcuts(localStorage, host.runtimeId) || []).map((shortcut) => ({
        ...shortcut,
        shortcutId: hostScopedId(host.runtimeId, shortcut.shortcutId),
        projectPath: hostScopedId(host.runtimeId, shortcut.projectPath),
      }))
    )) : [];
    let importedHosts: string[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(importedHostsKey) || '[]');
      if (Array.isArray(parsed)) importedHosts = parsed.filter((value): value is string => typeof value === 'string');
    } catch { /* A corrupt marker safely re-imports and de-duplicates the catalogue. */ }
    const onlineHostIds = runtime.hosts.filter((host) => host.phase === 'online').map((host) => host.runtimeId);
    const unseenHosts = new Set(onlineHostIds.filter((runtimeId) => !importedHosts.includes(runtimeId)));
    const candidates = [
      ...(saved || legacy),
      ...runtime.shortcuts.filter((shortcut) => shortcut.hostRuntimeId && unseenHosts.has(shortcut.hostRuntimeId)),
    ];
    const unique = [...new Map(candidates.map((shortcut) => [`${shortcut.projectPath}:${shortcut.agent}`, shortcut])).values()];
    const shortcuts = saveWebProjectShortcuts(localStorage, shortcutScope, unique);
    localStorage.setItem(importedHostsKey, JSON.stringify([...new Set([...importedHosts, ...onlineHostIds])]));
    setWebShortcutState({ runtimeId: shortcutScope, shortcuts });
  }, [demoMode, runtime.hosts, runtime.phase, runtime.shortcuts, webShortcutScope]);

  useEffect(() => {
    let active = true;
    void loadMobileTheme().then((storedTheme) => {
      if (active && !themeChosen.current) setSavedTheme(storedTheme);
      if (active) setThemeReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void loadMobileNotificationsEnabled().then((enabled) => {
      const permitted = Platform.OS !== 'web'
        || (typeof Notification !== 'undefined' && Notification.permission === 'granted');
      if (active && !notificationsChosen.current) setNotificationsEnabled(enabled && permitted);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const generation = ++historyGeneration.current;
    const runtimeId = pairedRuntimeId;
    let active = true;
    historyRequest.current = null;
    setHistoryLoading(false);
    setHistoryReadyRuntimeId(null);
    setHistory([]);
    if (!runtimeId) return () => { active = false; };
    void loadMobileHistory(runtimeId).then(async (cached) => {
      const migrationRuntimeId = client.getPairedRuntimeId();
      const migrated = !cached.length && runtimeId === 'multi-host' && migrationRuntimeId
        ? await loadMobileHistory(migrationRuntimeId, true)
        : cached;
      const migrationHost = migrationRuntimeId
        ? client.getState().hosts?.find((host) => host.runtimeId === migrationRuntimeId)
        : null;
      const next = migrated !== cached && migrated.length && migrationRuntimeId
        ? migrated.map((conversation) => scopeHostHistory(conversation, migrationHost || {
          runtimeId: migrationRuntimeId,
          name: client.getState().computerName || 'CAS Desktop',
          kind: client.getState().hostKind,
          phase: client.getState().phase,
        }))
        : migrated;
      if (next !== cached && next.length) void saveMobileHistory(runtimeId, next);
      if (active && generation === historyGeneration.current) setHistory(next);
    });
    return () => { active = false; };
  }, [client, pairedRuntimeId]);

  useEffect(() => {
    if (!connectionIssue) {
      setShowConnectionNotice(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowConnectionNotice(true), CONNECTION_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectionIssue]);

  useEffect(() => {
    if (themeReady && Platform.OS !== 'web') void SplashScreen.hideAsync();
  }, [themeReady]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    document.documentElement.style.setProperty('--cas-scrollbar-thumb', colors.borderStrong);
    document.documentElement.style.setProperty('--cas-scrollbar-thumb-hover', colors.muted);
  }, [colors]);

  const selectTheme = (nextTheme: MobileTheme) => {
    themeChosen.current = true;
    setSavedTheme(nextTheme);
    void saveMobileTheme(nextTheme);
  };

  const selectNotificationsEnabled = (enabled: boolean) => {
    notificationsChosen.current = true;
    if (enabled && Platform.OS === 'web') {
      void prepareLocalNotifications().then((granted) => {
        setNotificationsEnabled(granted);
        void client.setNotificationsEnabled(granted);
      });
      return;
    }
    setNotificationsEnabled(enabled);
    if (enabled) void prepareLocalNotifications();
    void client.setNotificationsEnabled(enabled);
  };

  const openSession = useCallback((sessionId: string, animateEntrance = true, source: SessionOpenSource = 'row') => {
    const resolvedSessionId = client instanceof WebMultiHostRuntimeClient ? client.resolveSessionId(sessionId) : sessionId;
    const target = splitHostScopedId(resolvedSessionId);
    if (target && client instanceof WebMultiHostRuntimeClient) client.setPreferredRuntimeId(target.runtimeId);
    const session = runtime.sessions.find((candidate) => candidate.sessionId === resolvedSessionId);
    const hostPhase = session?.hostPhase
      ?? runtime.hosts?.find((host) => host.runtimeId === target?.runtimeId)?.phase
      ?? runtime.phase;
    const trace = {
      navigationId: Crypto.randomUUID(),
      sessionId: resolvedSessionId,
      source,
      startedAt: Date.now(),
      cached: Boolean(session) && hostPhase !== 'online',
    };
    sessionOpenTrace.current = trace;
    tabX.setValue(0);
    setSection('sessions');
    if (!animateEntrance) {
      chatEntrance.setValue(1);
      chatWasVisible.current = true;
    }
    dragX.setValue(0);
    setSelectedId(resolvedSessionId);
    client.reportSessionOpen(resolvedSessionId, {
      navigationId: trace.navigationId,
      stage: 'requested',
      source,
      platform: Platform.OS,
      totalMs: 0,
      connectionPhase: runtime.phase,
      hostPhase,
      cached: trace.cached,
    });
  }, [chatEntrance, client, dragX, runtime.hosts, runtime.phase, runtime.sessions, tabX]);
  const openSessionContextMenu = useCallback((sessionId: string, position: WebContextMenuPosition) => {
    openSession(sessionId, false);
    setWebContextMenuRequest({ sessionId, ...position });
  }, [openSession]);
  const consumeWebContextMenuRequest = useCallback(() => setWebContextMenuRequest(null), []);
  const openSessionRef = useRef(openSession);
  useEffect(() => {
    openSessionRef.current = openSession;
  }, [openSession]);

  useEffect(() => {
    // Subscribe once. openSession changes identity on every runtime event; re-subscribing on each
    // one re-read the last notification response and could reopen a Chat the user had already left.
    let active = true;
    let unsubscribe = () => {};
    void subscribeToNotificationResponses((sessionId) => openSessionRef.current(sessionId, false, 'notification'), () => historyResumeGeneration.current).then((remove) => {
      if (active) unsubscribe = remove;
      else remove();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!(client instanceof WebMultiHostRuntimeClient) || !runtime.sessions.length || !selectedId || splitHostScopedId(selectedId)) return;
    const resolvedSessionId = client.resolveSessionId(selectedId);
    if (resolvedSessionId === selectedId) return;
    const target = splitHostScopedId(resolvedSessionId);
    if (target) client.setPreferredRuntimeId(target.runtimeId);
    setSelectedId(resolvedSessionId);
  }, [client, runtime.sessions, selectedId]);

  useEffect(() => {
    client.setVisibleSession(selectedId);
  }, [client, selectedId]);

  useEffect(() => {
    const liveRuntimeUpdates = coalesceLatest(setLiveRuntime, RUNTIME_RENDER_COALESCE_MS);
    const unsubscribe = client.subscribe(liveRuntimeUpdates.push);
    let suspendTimer: ReturnType<typeof setTimeout> | null = null;
    const applyAppState = (state: string) => {
      setAppForeground(state === 'active');
      dragX.setValue(0);
      const activity = runtimeActivityForAppState(state, Platform.OS);
      if (!activity) return;
      if (suspendTimer) clearTimeout(suspendTimer);
      suspendTimer = null;
      if (!activity.delayMs) {
        appActive.current = activity.active;
        client.setActive(activity.active);
        return;
      }
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        appActive.current = activity.active;
        client.setActive(activity.active);
      }, activity.delayMs);
    };
    if (AppState.currentState) applyAppState(AppState.currentState);
    void client.start();
    const appState = AppState.addEventListener('change', applyAppState);
    const pageHidden = () => client.setActive(false);
    const pageShown = () => client.setActive(true);
    const networkRestored = () => client.reconnectNow('online');
    if (Platform.OS === 'web') {
      window.addEventListener('pagehide', pageHidden);
      window.addEventListener('pageshow', pageShown);
      window.addEventListener('online', networkRestored);
    }
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      unsubscribe();
      liveRuntimeUpdates.cancel();
      if (suspendTimer) clearTimeout(suspendTimer);
      appState.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('pagehide', pageHidden);
        window.removeEventListener('pageshow', pageShown);
        window.removeEventListener('online', networkRestored);
      }
      motion.remove();
      client.stop();
    };
  }, [client, dragX]);

  useEffect(() => {
    let mounted = true;
    void loadPendingSends().then((cached) => {
      if (!mounted) return;
      const hydrated: PendingSendCache = Object.fromEntries(Object.entries(cached).map(([sessionId, entries]) => [
        sessionId,
        entries.map((entry) => {
          const delivered = entry.delivered === true || entry.confirmed === true;
          const resumable = !delivered && entry.failed !== true && /^[a-f0-9-]{36}$/.test(entry.id);
          return {
            ...entry,
            queued: resumable,
            delivered,
            confirmed: delivered,
            attachments: delivered
              ? entry.attachments.map((attachment) => ({ ...attachment, dataUrl: '' }))
              : entry.attachments,
            progress: delivered ? 1 : undefined,
            failed: !delivered && !resumable,
          };
        }),
      ]));
      setPendingSends((current) => {
        const next = { ...hydrated };
        for (const [sessionId, entries] of Object.entries(current)) {
          const merged = new Map((next[sessionId] || []).map((entry) => [entry.id, entry] as const));
          for (const entry of entries) merged.set(entry.id, entry);
          next[sessionId] = [...merged.values()]
            .sort((left, right) => (left.createdAtMs || 0) - (right.createdAtMs || 0));
        }
        return next;
      });
      setPendingSendsReady(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!pendingSendsReady) return undefined;
    const timer = setTimeout(() => void savePendingSends(pendingSends), 150);
    return () => clearTimeout(timer);
  }, [pendingSends, pendingSendsReady]);

  useEffect(() => {
    if (!pendingSendsReady || newPrompt.trim() || newSessionOpen || startingSession) return;
    const candidate = runtime.sessions
      .filter((session) => session.state === 'stopped' && session.clientRequestId)
      .map((session) => {
        const queueIds = [session.clientRequestId!, session.sessionId];
        const entries = [...new Map(queueIds
          .flatMap((sessionId) => pendingSends[sessionId] || [])
          .filter((entry) => (entry.queued || entry.failed) && !entry.delivered && !entry.confirmed)
          .map((entry) => [entry.id, entry] as const)).values()]
          .sort((left, right) => (left.createdAtMs || 0) - (right.createdAtMs || 0));
        return { session, queueIds, entries };
      })
      .filter(({ entries }) => entries.length)
      .sort((left, right) => (
        (left.entries[0].createdAtMs || 0) - (right.entries[0].createdAtMs || 0)
      ))[0];
    if (!candidate || recoveredStoppedSessions.current.has(candidate.session.sessionId)) return;
    recoveredStoppedSessions.current.add(candidate.session.sessionId);
    const stoppedQueueIds = new Set(candidate.queueIds);
    const next = { ...pendingSends };
    for (const sessionId of stoppedQueueIds) delete next[sessionId];
    setPendingSends(next);
    void savePendingSends(next);
    if (candidate.session.agent) setNewAgent(candidate.session.agent);
    if (candidate.session.cwd) setNewProject(candidate.session.cwd);
    setNewPrompt((current) => [current.trim(), ...candidate.entries.map((entry) => entry.text.trim())]
      .filter(Boolean)
      .join('\n\n'));
    setNewSessionError('The session stopped before sending. Your queued message was restored.');
    setNewSessionOpen(true);
    if (Platform.OS === 'web'
      && typeof window !== 'undefined'
      && stoppedQueueIds.has(window.history.state?.[WEB_CHAT_HISTORY_KEY])) {
      window.history.back();
    } else {
      setSelectedId((current) => current && stoppedQueueIds.has(current) ? null : current);
    }
  }, [newPrompt, newSessionOpen, pendingSends, pendingSendsReady, runtime.sessions, startingSession]);

  useEffect(() => {
    if (runtime.hosts?.some((host) => host.phase === 'booting')) return;
    setPendingSends((current) => {
      const next = migratePendingSendSessions(current, runtime.sessions, (runtime.hosts?.length || 0) <= 1);
      if (next !== current && pendingSendsReady) void savePendingSends(next);
      return next;
    });
  }, [pendingSendsReady, runtime.hosts, runtime.sessions]);

  useEffect(() => {
    if (!pendingSendsReady) return;
    setPendingSends((current) => {
      let changed = false;
      const next = Object.fromEntries(Object.entries(current).map(([sessionId, entries]) => {
        const session = runtime.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!session) return [sessionId, entries];
        return [sessionId, entries.map((entry) => {
          if (entry.failed
            || entry.confirmed
            || !entry.delivered
            || matchingUserMessages(session.items, entry.text) <= entry.baselineMatches) {
            return entry;
          }
          changed = true;
          return {
            ...entry,
            confirmed: true,
            attachments: entry.attachments.map((attachment) => ({ ...attachment, dataUrl: '' })),
          };
        })];
      }));
      return changed ? next : current;
    });
  }, [pendingSendsReady, pendingSends, runtime.sessions]);

  const pair = useCallback(async (url: string) => {
    setPairingBusy(true);
    try {
      setNotice(null);
      const input = pairingInputFromUrl(url);
      if (input) await client.pair(input.uri);
      else await client.pairCode(url);
      setScannerOpen(false);
      setPairingCode('');
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.search) {
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'This pairing link is not valid');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setPairingBusy(false);
    }
  }, [client]);

  const cancelAddingHost = useCallback(() => {
    client.cancelPairing();
    setScannerOpen(false);
    setPairingCode('');
    setPairingBusy(false);
    setAddingHost(false);
  }, [client]);

  useEffect(() => {
    if (addingHost && runtime.phase === 'online' && (runtime.hosts?.length || 0) > addingHostBaseline) {
      setAddingHost(false);
    }
  }, [addingHost, addingHostBaseline, runtime.hosts, runtime.phase]);

  const exitDemo = useCallback(() => {
    demoGeneration.current += 1;
    historyGeneration.current += 1;
    historyRequest.current = null;
    setDemoRuntime(null);
    setSelectedId(null);
    setStartingSession(null);
    setHistoryLoading(false);
    setHistoryReadyRuntimeId(null);
    setHistory([]);
    setSection('sessions');
    tabX.setValue(0);
  }, [tabX]);

  const enterDemo = useCallback(() => {
    demoGeneration.current += 1;
    historyGeneration.current += 1;
    historyRequest.current = null;
    setDemoRuntime(createDemoRuntimeState());
    setSelectedId(null);
    setHistoryLoading(false);
    setHistoryReadyRuntimeId(null);
    setHistory([]);
    setSection('sessions');
    tabX.setValue(0);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, [tabX]);

  const forgetDevice = useCallback(async (runtimeId?: string) => {
    if (demoMode) {
      exitDemo();
      return;
    }
    try {
      await client.forgetDevice(runtimeId);
      if (!runtimeId) setPendingSends({});
      else {
        setPendingSends((current) => Object.fromEntries(Object.entries(current).filter(([sessionId]) => splitHostScopedId(sessionId)?.runtimeId !== runtimeId)));
        setHistory((current) => current.filter((conversation) => conversation.hostRuntimeId !== runtimeId));
        setSelectedId((current) => splitHostScopedId(current)?.runtimeId === runtimeId ? null : current);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not forget this host');
    }
  }, [client, demoMode, exitDemo]);

  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url && pairingInputFromUrl(url)) void pair(url);
    });
    const listener = Linking.addEventListener('url', ({ url }) => {
      if (pairingInputFromUrl(url)) void pair(url);
    });
    return () => listener.remove();
  }, [pair]);

  const selected = runtime.sessions.find((session) => session.sessionId === selectedId) || null;
  const webShortcuts = useMemo(() => {
    if (webShortcutState?.runtimeId !== webShortcutScope) return runtime.shortcuts;
    return webShortcutState.shortcuts.flatMap((shortcut) => {
      const project = runtime.projects.find((candidate) => candidate.path === shortcut.projectPath);
      return project ? [{
        shortcutId: shortcut.shortcutId,
        name: project.name,
        projectPath: project.path,
        projectName: project.name,
        color: project.color,
        icon: project.icon,
        iconDataUrl: project.iconDataUrl,
        agent: shortcut.agent,
        useWorktree: shortcut.useWorktree,
        hostRuntimeId: project.hostRuntimeId,
        hostName: project.hostName,
        hostKind: project.hostKind,
      }] : [];
    });
  }, [runtime.projects, runtime.shortcuts, webShortcutScope, webShortcutState]);
  const replaceWebShortcuts = useCallback((shortcuts: RuntimeShortcut[]) => {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined' || !webShortcutScope) return;
    setWebShortcutState({
      runtimeId: webShortcutScope,
      shortcuts: saveWebProjectShortcuts(localStorage, webShortcutScope, shortcuts),
    });
  }, [webShortcutScope]);
  const selectWebHostIcon = useCallback((runtimeId: string, icon: WebHostIconId) => {
    setWebHostIcons((current) => (
      Platform.OS === 'web' && typeof localStorage !== 'undefined'
        ? saveWebHostIcon(localStorage, current, runtimeId, icon)
        : { ...current, [runtimeId]: icon }
    ));
  }, []);
  const pendingSession = !selected
    && startingSession?.clientRequestId
    && (selectedId === startingSession.clientRequestId || selectedId === startingSession.sessionId)
    ? pendingRuntimeSession(startingSession)
    : null;
  const listedSessions = optimisticallyClosedSessionIds.size
    ? runtime.sessions.filter((session) => !optimisticallyClosedSessionIds.has(session.sessionId))
    : runtime.sessions;
  const listRuntime = pendingSession && !runtime.sessions.some((session) => session.clientRequestId === pendingSession.clientRequestId)
    ? { ...runtime, sessions: [pendingSession, ...listedSessions] }
    : listedSessions === runtime.sessions ? runtime : { ...runtime, sessions: listedSessions };
  useEffect(() => {
    const activeIds = new Set(runtime.sessions.filter((session) => session.state !== 'stopped').map((session) => session.sessionId));
    setOptimisticallyClosedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => activeIds.has(sessionId)));
      return next.size === current.size ? current : next;
    });
  }, [runtime.sessions]);
  const visibleSession = selected || pendingSession;
  const openingSession: StartingSession | null = startingSession || (
    selectedId && !selected
      ? { agent: '', cwd: '', sessionId: selectedId, title: 'Opening conversation…' }
      : null
  );
  const visibleHost = runtime.hosts?.find((host) => host.runtimeId === visibleSession?.hostRuntimeId) || null;
  const visibleHostOffline = visibleSession?.hostPhase === 'offline' || visibleSession?.hostPhase === 'error';
  const chatLayerVisible = Boolean(visibleSession || openingSession);

  useEffect(() => {
    const trace = sessionOpenTrace.current;
    if (!trace || !chatLayerVisible || selectedId !== trace.sessionId) return;
    sessionOpenTrace.current = null;
    const session = runtime.sessions.find((candidate) => candidate.sessionId === trace.sessionId);
    const target = splitHostScopedId(trace.sessionId);
    const hostPhase = session?.hostPhase
      ?? runtime.hosts?.find((host) => host.runtimeId === target?.runtimeId)?.phase
      ?? runtime.phase;
    client.reportSessionOpen(trace.sessionId, {
      navigationId: trace.navigationId,
      stage: 'rendered',
      source: trace.source,
      platform: Platform.OS,
      totalMs: Date.now() - trace.startedAt,
      connectionPhase: runtime.phase,
      hostPhase,
      cached: trace.cached,
    });
  }, [chatLayerVisible, client, runtime.hosts, runtime.phase, runtime.sessions, selectedId]);
  const chatDragX = useMemo(() => dragX.interpolate({
    inputRange: [0, screenWidth],
    outputRange: [0, screenWidth],
    extrapolate: 'clamp',
  }), [dragX, screenWidth]);
  const chatMotion = useMemo(() => {
    if (reduceMotion) {
      return {
        baseStyle: undefined,
        layerStyle: { transform: [{ translateX: chatDragX }] },
        entryStyle: undefined,
      };
    }
    const remainingDrag = chatDragX.interpolate({
      inputRange: [0, screenWidth],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });
    const depth = Animated.multiply(chatEntrance, remainingDrag);
    return {
      baseStyle: {
        opacity: depth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.58] }),
        transform: [
          { translateX: depth.interpolate({ inputRange: [0, 1], outputRange: [0, -screenWidth * 0.3] }) },
          { scale: depth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.985] }) },
        ],
      },
      layerStyle: { transform: [{ translateX: chatDragX }] },
      entryStyle: {
        transform: [
          {
            translateX: chatEntrance.interpolate({
              inputRange: [0, 1],
              outputRange: [screenWidth * 1.02, 0],
            }),
          },
          { scale: depth.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
        ],
      },
    };
  }, [chatDragX, chatEntrance, reduceMotion, screenWidth]);

  useEffect(() => {
    if (!chatLayerVisible) {
      chatWasVisible.current = false;
      chatEntrance.setValue(reduceMotion ? 1 : 0);
      return undefined;
    }
    if (reduceMotion) {
      chatWasVisible.current = true;
      chatEntrance.setValue(1);
      return undefined;
    }
    if (chatWasVisible.current) return undefined;
    chatWasVisible.current = true;
    chatEntrance.setValue(0);
    const animation = Animated.timing(chatEntrance, {
      toValue: 1,
      duration: 320,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      chatWasVisible.current = false;
    };
  }, [chatEntrance, chatLayerVisible, reduceMotion]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    window.history.replaceState({ ...window.history.state, [WEB_CHAT_HISTORY_KEY]: null }, '');
    const onPopState = (event: PopStateEvent) => {
      const sessionId = event.state?.[WEB_CHAT_HISTORY_KEY];
      if (typeof sessionId === 'string') openSessionRef.current(sessionId, true, 'shortcut');
      else setSelectedId(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !selectedId) return;
    if (client instanceof WebMultiHostRuntimeClient && !splitHostScopedId(selectedId)) return;
    if (window.history.state?.[WEB_CHAT_HISTORY_KEY] === selectedId) return;
    window.history.pushState({ ...window.history.state, [WEB_CHAT_HISTORY_KEY]: selectedId }, '');
  }, [client, selectedId]);

  const backToSessions = useCallback(() => {
    dismissComposerRef.current?.();
    void Haptics.selectionAsync().catch(() => {});
    historyResumeGeneration.current += 1;
    setStartingSession(null);
    setHistoryOpeningId(null);
    setSection('sessions');
    tabX.setValue(0);
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history.state?.[WEB_CHAT_HISTORY_KEY]) {
      setSelectedId(null);
      window.history.back();
      return;
    }
    setSelectedId(null);
  }, [tabX]);

  useEffect(() => {
    if (!startingSession?.clientRequestId) return;
    const opened = runtime.sessions.find((session) => (
      session.clientRequestId === startingSession.clientRequestId
    ));
    if (!opened) return;
    if (selectedId === startingSession.clientRequestId || selectedId === opened.sessionId) {
      if (Platform.OS === 'web'
        && typeof window !== 'undefined'
        && window.history.state?.[WEB_CHAT_HISTORY_KEY] === startingSession.clientRequestId) {
        window.history.replaceState({
          ...window.history.state,
          [WEB_CHAT_HISTORY_KEY]: opened.sessionId,
        }, '');
      }
      openSession(opened.sessionId, true, 'created');
    }
    setStartingSession(null);
  }, [openSession, runtime.sessions, selectedId, startingSession]);

  useEffect(() => {
    if (!selected?.needsAttention || (selected.hostPhase ?? runtime.phase) !== 'online') return;
    if (demoMode) {
      setDemoRuntime((current) => current ? runDemoCommand(current, {
        type: 'session.read',
        sessionId: selected.sessionId,
        payload: { attentionVersion: selected.attentionVersion },
      }).state : current);
      return;
    }
    void client.sendCommand({
      type: 'session.read',
      sessionId: selected.sessionId,
      payload: { attentionVersion: selected.attentionVersion },
    }).catch(() => undefined);
  }, [client, demoMode, runtime.phase, selected?.attentionVersion, selected?.hostPhase, selected?.needsAttention, selected?.sessionId]);

  useEffect(() => {
    if (selected && startingSession?.sessionId === selected.sessionId) setStartingSession(null);
  }, [selected, startingSession?.sessionId]);

  useEffect(() => {
    const onBack = () => {
      if (!selectedId && !startingSession) return false;
      backToSessions();
      return true;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, [backToSessions, selectedId, startingSession]);

  const chatGestureEvent = useMemo(() => Animated.event(
    [{ nativeEvent: { translationX: dragX } }],
    { useNativeDriver: true },
  ), [dragX]);
  const settleChatSwipe = useCallback((event: PanGestureHandlerStateChangeEvent) => {
    const { oldState, state, translationX, velocityX } = event.nativeEvent;
    // Blur the WebView editor when the swipe activates, before Chat leaves.
    if (state === State.ACTIVE) dismissComposerRef.current?.();
    if (oldState !== State.ACTIVE) return;
    if (state === State.END && (translationX > 86 || velocityX > 550)) {
      if (reduceMotion) {
        backToSessions();
      } else {
        Animated.spring(dragX, {
          toValue: screenWidth,
          velocity: Math.max(0, velocityX),
          stiffness: 500,
          damping: 40,
          mass: 1,
          overshootClamping: true,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) backToSessions();
        });
      }
    } else {
      Animated.spring(dragX, {
        toValue: 0,
        velocity: velocityX,
        stiffness: 500,
        damping: 40,
        mass: 1,
        overshootClamping: true,
        useNativeDriver: true,
      }).start();
    }
  }, [backToSessions, dragX, reduceMotion, screenWidth]);
  const chatSwipeHandlers = {
    enabled: Platform.OS !== 'web' && appForeground && Boolean(selectedId || startingSession),
    activeOffsetX: 6,
    failOffsetX: -6,
    failOffsetY: [-12, 12] as [number, number],
    onGestureEvent: chatGestureEvent,
    onHandlerStateChange: settleChatSwipe,
  } satisfies PanGestureHandlerProps;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => current === message ? null : current), 3500);
  }, []);

  const cloudProviderRuntimeId = runtime.hostKind === 'cloud'
    && runtime.phase === 'online'
    && runtime.capabilities.includes('providers.list')
    ? runtime.runtimeId
    : runtime.hosts?.find((host) => host.kind === 'cloud' && host.phase === 'online' && host.capabilities.includes('providers.list'))?.runtimeId;
  const loadCloudProviders = useCallback(async () => {
    const cloudHost = cloudProviderRuntimeId;
    if (!cloudHost) return [];
    if (client instanceof WebMultiHostRuntimeClient) client.setPreferredRuntimeId(cloudHost);
    setCloudProvidersLoading(true);
    try {
      const result = await client.sendCommand({ type: 'providers.list' }) as { providers?: unknown[] };
      const providers = (Array.isArray(result?.providers) ? result.providers : [])
        .map(normalizeRuntimeProvider)
        .filter((provider): provider is RuntimeProvider => Boolean(provider));
      setCloudProviders(providers);
      return providers;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not load CAS Cloud agents');
      return [];
    } finally {
      setCloudProvidersLoading(false);
    }
  }, [client, cloudProviderRuntimeId, showNotice]);

  useEffect(() => {
    if (!cloudProviderRuntimeId) return;
    void loadCloudProviders();
  }, [cloudProviderRuntimeId, loadCloudProviders]);

  const startCloudProviderLogin = useCallback(async (agent: string) => {
    const cloudHost = client.getState().hosts?.find((host) => host.kind === 'cloud' && host.phase === 'online')?.runtimeId;
    if (cloudHost && client instanceof WebMultiHostRuntimeClient) client.setPreferredRuntimeId(cloudHost);
    requestedProviderLogins.current.add(agent);
    setProviderLogins((current) => new Set(current).add(agent));
    setProviderLoginFlows((current) => ({ ...current, [agent]: {} }));
    try {
      await client.sendCommand({ type: 'provider.login.start', payload: { agent, replaceAccount: false } });
    } catch (error) {
      requestedProviderLogins.current.delete(agent);
      setProviderLogins((current) => {
        const next = new Set(current);
        next.delete(agent);
        return next;
      });
      setProviderLoginFlows((current) => {
        const next = { ...current };
        delete next[agent];
        return next;
      });
      showNotice(error instanceof Error ? error.message : 'Could not start sign-in');
    }
  }, [client, showNotice]);

  const copyCloudProviderLoginCode = useCallback((agent: string) => {
    const code = providerLoginFlows[agent]?.code;
    if (!code) return;
    void Clipboard.setStringAsync(code)
      .then(() => AccessibilityInfo.announceForAccessibility('Device code copied'))
      .catch(() => showNotice('Could not copy device code'));
  }, [providerLoginFlows, showNotice]);

  const openCloudProviderLogin = useCallback((agent: string) => {
    const flow = providerLoginFlows[agent];
    if (!flow?.url) return;
    if (flow.code) void Clipboard.setStringAsync(flow.code).catch(() => {});
    void openExternalUrl(flow.url).catch(() => showNotice('Could not open provider sign-in'));
  }, [providerLoginFlows, showNotice]);

  useEffect(() => {
    if (runtime.hostKind === 'cloud') return;
    setCloudProviders([]);
    setProviderLogins(new Set());
    setProviderLoginFlows({});
    requestedProviderLogins.current.clear();
  }, [runtime.hostKind, runtime.runtimeId]);

  useEffect(() => client.subscribeEnvelopes((message) => {
    if (message.kind !== 'provider.login.event' || typeof message.agent !== 'string') return;
    const agent = message.agent;
    if (!requestedProviderLogins.current.has(agent)) return;
    const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
      ? message.payload as Record<string, unknown>
      : {};
    if (message.type === 'output') {
      const code = providerLoginDeviceCode(payload.text);
      if (code) {
        void Clipboard.setStringAsync(code).catch(() => {});
        setProviderLoginFlows((current) => ({
          ...current,
          [agent]: {
            ...current[agent],
            code,
          },
        }));
      }
      return;
    }
    if (message.type === 'url' && typeof payload.url === 'string' && /^https:\/\//.test(payload.url)) {
      setProviderLoginFlows((current) => ({
        ...current,
        [agent]: {
          ...current[agent],
          url: payload.url as string,
        },
      }));
      return;
    }
    if (message.type !== 'completed') return;
    const finishLogin = () => {
      requestedProviderLogins.current.delete(agent);
      setProviderLogins((current) => {
        const next = new Set(current);
        next.delete(agent);
        return next;
      });
      setProviderLoginFlows((current) => {
        const next = { ...current };
        delete next[agent];
        return next;
      });
    };
    if (payload.success === true) void loadCloudProviders().finally(finishLogin);
    else {
      finishLogin();
      showNotice(typeof payload.message === 'string' ? payload.message : 'Provider sign-in did not complete');
    }
  }), [client, loadCloudProviders, showNotice]);

  useEffect(() => client.subscribeEnvelopes((message) => {
    if (message.kind === 'tasks.changed') {
      const hostRuntimeId = typeof message.hostRuntimeId === 'string'
        ? message.hostRuntimeId
        : typeof message.runtimeId === 'string' ? message.runtimeId : undefined;
      const projectId = typeof message.projectId === 'string' ? message.projectId : undefined;
      void invalidateTaskCache(hostRuntimeId, projectId).finally(() => {
        setTaskRefreshVersion((version) => version + 1);
      });
    }
    if (message.kind !== 'project.icon.generated') return;
    setTaskRefreshVersion((version) => version + 1);
    showNotice(message.success === true
      ? 'The Codex icon is ready and applied'
      : typeof message.error === 'string' ? message.error : 'Could not generate the project icon');
  }), [client, showNotice]);

  const demoCommand = useCallback((command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => {
    if (!demoRuntime) return undefined;
    const outcome = runDemoCommand(demoRuntime, command);
    setDemoRuntime(outcome.state);
    return outcome.result;
  }, [demoRuntime]);

  const managementCommand = useCallback((command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => (
    demoMode ? Promise.resolve(demoCommand(command)) : client.sendCommand(command)
  ), [client, demoCommand, demoMode]);

  const deliverPending = useCallback(async (sessionId: string, pending: PendingSend) => {
    if (sendingPending.current.has(pending.id)) return false;
    sendingPending.current.add(pending.id);
    setPendingSends((current) => ({
      ...current,
      [sessionId]: (current[sessionId] || []).map((entry) => (
        entry.id === pending.id ? { ...entry, queued: false, progress: 0 } : entry
      )),
    }));
    try {
      await client.sendTurn(sessionId, pending.text, pending.attachments, (progress) => {
        setPendingSends((current) => ({
          ...current,
          [sessionId]: (current[sessionId] || []).map((entry) => (
            entry.id === pending.id ? { ...entry, progress } : entry
          )),
        }));
      }, pending.id);
      setPendingSends((current) => ({
        ...current,
        [sessionId]: (current[sessionId] || []).map((entry) => (
          entry.id === pending.id ? {
            ...entry,
            queued: false,
            delivered: true,
            confirmed: false,
            progress: 1,
            attachments: entry.attachments.map((attachment) => ({ ...attachment, dataUrl: '' })),
          } : entry
        )),
      }));
      return true;
    } catch (error) {
      const currentState = client.getState();
      const currentSession = currentState.sessions.find((candidate) => candidate.sessionId === sessionId);
      const disconnected = currentSession?.hostPhase !== undefined
        ? currentSession.hostPhase !== 'online'
        : currentState.phase !== 'online';
      setPendingSends((current) => {
        const entries = current[sessionId] || [];
        const failedIndex = entries.findIndex((entry) => entry.id === pending.id);
        return {
          ...current,
          [sessionId]: entries.map((entry, index) => {
            if (entry.id === pending.id) return {
              ...entry,
              queued: disconnected,
              failed: !disconnected,
              progress: disconnected ? undefined : entry.progress,
            };
            if (!disconnected && failedIndex >= 0 && index > failedIndex && !entry.confirmed && entry.text === pending.text) {
              return { ...entry, baselineMatches: Math.max(0, entry.baselineMatches - 1) };
            }
            return entry;
          }),
        };
      });
      if (!disconnected) showNotice(error instanceof Error ? error.message : 'Message not sent');
      return false;
    } finally {
      sendingPending.current.delete(pending.id);
    }
  }, [client, showNotice]);

  useEffect(() => {
    if (demoMode || !pendingSendsReady || runtime.phase !== 'online') return;
    const sendableSessionIds = new Set(runtime.sessions
      .filter((session) => (
        session.state !== 'starting'
        && session.state !== 'stopped'
        && (session.hostPhase === undefined || session.hostPhase === 'online')
      ))
      .map((session) => session.sessionId));
    const next = selectNextPendingDrain(pendingSends, sendableSessionIds);
    if (next) void deliverPending(next.sessionId, next.entry);
  }, [deliverPending, demoMode, pendingSends, pendingSendsReady, runtime.phase, runtime.sessions]);

  const queueSessionSend = useCallback(async (
    sessionId: string,
    text: string,
    attachments: MobileAttachment[] = [],
    id = Crypto.randomUUID(),
  ) => {
    const outgoingText = text.trim();
    if (!outgoingText && !attachments.length) return false;
    const current = pendingSendsRef.current;
    const entries = current[sessionId] || [];
    if (entries.some((entry) => entry.id === id)) return true;
    if (entries.filter((entry) => !entry.confirmed).length >= 24) {
      showNotice('Message queue is full. Reconnect before sending more.');
      return false;
    }
    const session = runtime.sessions.find((candidate) => candidate.sessionId === sessionId);
    const pending: PendingSend = {
      id,
      createdAtMs: Date.now(),
      text: outgoingText,
      attachments,
      queued: true,
      failed: false,
      baselineMatches: matchingUserMessages(session?.items || [], outgoingText)
        + entries.filter((entry) => !entry.failed && !entry.confirmed && entry.text === outgoingText).length,
    };
    const next = { ...current, [sessionId]: [...entries.filter((entry) => !entry.confirmed), pending] };
    pendingSendsRef.current = next;
    setPendingSends(next);
    await savePendingSends(next);
    return true;
  }, [runtime.sessions, showNotice]);

  const send = useCallback(async (attachments: MobileAttachment[], explicitText: string) => {
    const sessionId = selected?.sessionId || startingSession?.clientRequestId;
    if (!sessionId) return false;
    const text = explicitText.trim();
    if (!text && !attachments.length) return false;
    if (demoMode) {
      const prompt = text || `Review the ${attachments.length} attached sample ${attachments.length === 1 ? 'file' : 'files'}`;
      const commandId = Crypto.randomUUID();
      const startedAt = Date.now();
      const generation = demoGeneration.current;
      setDemoRuntime((current) => current ? runDemoCommand(current, {
        type: 'turn.send',
        sessionId,
        payload: { text: prompt, attachments, commandId },
      }, startedAt).state : current);
      setTimeout(() => {
        if (demoGeneration.current !== generation) return;
        setDemoRuntime((current) => current ? completeDemoTurn(current, sessionId, prompt, Date.now(), commandId) : current);
      }, 850);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      return true;
    }
    const queued = await queueSessionSend(sessionId, text, attachments);
    if (!queued) return false;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    return true;
  }, [demoMode, queueSessionSend, selected?.sessionId, startingSession?.clientRequestId]);

  const retryPending = useCallback((message: PendingSend) => {
    if (!selected) return;
    setPendingSends((current) => {
      const entries = current[selected.sessionId] || [];
      const next = {
        ...current,
        [selected.sessionId]: entries.map((entry) => entry.id === message.id ? {
          ...entry,
          id: Crypto.randomUUID(),
          createdAtMs: Date.now(),
          queued: true,
          delivered: false,
          confirmed: false,
          failed: false,
          progress: undefined,
          baselineMatches: matchingUserMessages(selected.items, message.text)
            + entries.filter((candidate) => (
              candidate.id !== message.id
              && !candidate.failed
              && !candidate.confirmed
              && candidate.text === message.text
            )).length,
        } : entry),
      };
      void savePendingSends(next);
      return next;
    });
  }, [selected]);

  const run = useCallback(async (command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => {
    if (demoMode) {
      setDemoRuntime((current) => current ? runDemoCommand(current, command).state : current);
      return;
    }
    try {
      await client.sendCommand(command);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Action failed');
    }
  }, [client, demoMode, showNotice]);

  const loadHistory = useCallback(() => {
    if (runtime.phase !== 'online' || !runtime.runtimeId) return Promise.resolve();
    if (demoMode) {
      setHistory(createDemoHistory());
      setHistoryReadyRuntimeId(runtime.runtimeId);
      return Promise.resolve();
    }
    if (!pairedRuntimeId) return Promise.resolve();
    if (historyRequest.current) return historyRequest.current;
    const generation = ++historyGeneration.current;
    const runtimeId = pairedRuntimeId;
    setHistoryReadyRuntimeId(null);
    setHistoryLoading(true);
    const request = (async () => {
      try {
        const result = await client.sendCommand({ type: 'history.list' }) as {
          conversations?: RuntimeHistoryConversation[];
          refreshedHostRuntimeIds?: string[];
        };
        if (generation !== historyGeneration.current) return;
        const refreshed = Array.isArray(result?.conversations) ? result.conversations : [];
        const conversations = runtimeId === 'multi-host'
          ? mergeHostHistory(
            await loadMobileHistory(runtimeId),
            refreshed,
            Array.isArray(result?.refreshedHostRuntimeIds) ? result.refreshedHostRuntimeIds : [],
          )
          : refreshed;
        setHistory(conversations);
        setHistoryReadyRuntimeId(runtimeId);
        void saveMobileHistory(pairedRuntimeId, conversations);
      } catch (error) {
        if (generation === historyGeneration.current) {
          showNotice(error instanceof Error ? error.message : 'Could not load history');
        }
      } finally {
        if (generation === historyGeneration.current) setHistoryLoading(false);
      }
    })();
    historyRequest.current = request;
    void request.finally(() => {
      if (historyRequest.current === request) historyRequest.current = null;
    });
    return request;
  }, [client, demoMode, pairedRuntimeId, runtime.phase, runtime.runtimeId, showNotice]);

  useEffect(() => {
    if (runtime.phase !== 'online') {
      setHistoryReadyRuntimeId(null);
      return;
    }
    if (section === 'history') void loadHistory();
  }, [loadHistory, runtime.phase, section]);

  const settleSection = useCallback((next: MobileTab, velocity = 0) => {
    if (next !== section) void Haptics.selectionAsync().catch(() => {});
    setSection(next);
    const target = next === 'history' ? -tabViewportWidth : 0;
    if (reduceMotion) {
      tabX.setValue(target);
      return;
    }
    Animated.spring(tabX, {
      toValue: target,
      velocity,
      speed: 22,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [reduceMotion, section, tabViewportWidth, tabX]);

  const sectionRef = useRef(section);
  useEffect(() => { sectionRef.current = section; }, [section]);
  useEffect(() => {
    tabX.setValue(sectionRef.current === 'history' ? -tabViewportWidth : 0);
  }, [tabViewportWidth, tabX]);

  useEffect(() => {
    if (!webSplit) return undefined;
    // Settings, session actions, gallery and scanner own their overlays; shortcuts stay out while one is open.
    const overlayOpen = () => Boolean(document.querySelector('[aria-modal="true"], [role="dialog"]'));
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = webShortcutAction(event);
      if (!action) return;
      if (action.type === 'escape') {
        if (newSessionOpen) {
          event.preventDefault();
          setNewSessionError(null);
          setNewSessionOpen(false);
        } else if (!overlayOpen() && selectedId) {
          event.preventDefault();
          // Deselect in place: history.back() would pop to the previously selected session.
          historyResumeGeneration.current += 1;
          setStartingSession(null);
          setHistoryOpeningId(null);
          setSelectedId(null);
          window.history.replaceState({ ...window.history.state, [WEB_CHAT_HISTORY_KEY]: null }, '');
        }
        return;
      }
      if (newSessionOpen || overlayOpen()) return;
      event.preventDefault();
      if (action.type === 'new-session') {
        setNewSessionError(null);
        setNewSessionOpen(true);
        return;
      }
      if (action.type === 'select-index') {
        const sessionId = visibleSessionIdsRef.current[action.index];
        if (sessionId) openSession(sessionId, true, 'shortcut');
        return;
      }
      if (action.type === 'select-adjacent') {
        const ids = visibleSessionIdsRef.current;
        const current = selectedId ? ids.indexOf(selectedId) : -1;
        if (current === -1) {
          if (action.delta === 1 && ids.length) openSession(ids[0], true, 'shortcut');
          return;
        }
        const next = Math.min(ids.length - 1, Math.max(0, current + action.delta));
        if (next !== current) openSession(ids[next], true, 'shortcut');
        return;
      }
      if (action.type === 'focus-search') {
        settleSection('sessions');
        searchInputRef.current?.focus();
        return;
      }
      void loadHistory();
      settleSection('history');
    };
    // Capture phase: react-native-web TextInput stops key events from bubbling, so the
    // composer and the search field would otherwise swallow every shortcut.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [loadHistory, newSessionOpen, openSession, selectedId, settleSection, webSplit]);

  const tabPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => (
      !selectedId && isTabSwipeGesture(section, gesture.dx, gesture.dy)
    ),
    onPanResponderGrant: () => {
      if (section === 'sessions') void loadHistory();
    },
    onPanResponderMove: (_, gesture) => {
      tabX.setValue(tabDragOffset(section, tabViewportWidth, gesture.dx));
    },
    onPanResponderRelease: (_, gesture) => {
      settleSection(settledTab(section, gesture.dx, gesture.vx, tabViewportWidth), gesture.vx);
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => settleSection(section),
  }), [loadHistory, section, selectedId, settleSection, tabViewportWidth, tabX]);

  const resumeHistory = useCallback(async (conversation: RuntimeHistoryConversation) => {
    if (!historyReady || historyOpeningId || startingSession) return;
    const generation = ++historyResumeGeneration.current;
    dragX.setValue(0);
    setHistoryOpeningId(conversation.id);
    setStartingSession({
      agent: conversation.agent,
      cwd: conversation.projectPath,
      title: conversation.title,
      project: runtime.projects.find((project) => project.path === conversation.projectPath) || {
        path: conversation.projectPath,
        name: conversation.projectName,
      },
    });
    try {
      const result = demoMode ? demoCommand({
        type: 'session.resume',
        payload: { historyId: conversation.id },
      }) as { sessionId?: string } | undefined : await client.sendCommand({
        type: 'session.resume',
        payload: { historyId: conversation.id },
      }) as { sessionId?: string };
      if (!result?.sessionId) throw new Error('The desktop did not return the resumed session');
      if (generation !== historyResumeGeneration.current) return;
      setStartingSession((current) => current ? { ...current, sessionId: result.sessionId } : current);
      openSession(result.sessionId, true, 'history');
    } catch (error) {
      if (generation !== historyResumeGeneration.current) return;
      setStartingSession(null);
      showNotice(error instanceof Error ? error.message : 'Could not open the conversation');
    } finally {
      if (generation === historyResumeGeneration.current) setHistoryOpeningId(null);
    }
  }, [client, demoCommand, demoMode, dragX, historyOpeningId, historyReady, openSession, runtime.projects, showNotice, startingSession]);

  const loadModels = useCallback(async (sessionId: string) => {
    const result = (demoMode
      ? demoCommand({ type: 'session.models', sessionId })
      : await client.sendCommand({ type: 'session.models', sessionId })) as Partial<MobileModelCatalog>;
    return {
      models: Array.isArray(result?.models) ? result.models : [],
      permissionModes: Array.isArray(result?.permissionModes) ? result.permissionModes : [],
    };
  }, [client, demoCommand, demoMode]);

  const loadEarlierHistory = useCallback(async (
    sessionId: string,
    before?: number,
    anchor?: { role: string; text: string; timestamp?: string },
    knownCount?: number,
  ) => (
    (demoMode ? demoCommand({
      type: 'history.older',
      sessionId,
      payload: {
        ...(Number.isSafeInteger(before) ? { before } : {}),
        ...(anchor ? { anchor } : {}),
        ...(Number.isSafeInteger(knownCount) ? { knownCount } : {}),
      },
    }) : await client.sendCommand({
      type: 'history.older',
      sessionId,
      payload: {
        ...(Number.isSafeInteger(before) ? { before } : {}),
        ...(anchor ? { anchor } : {}),
        ...(Number.isSafeInteger(knownCount) ? { knownCount } : {}),
      },
    })) as { items?: RuntimeItem[]; nextCursor?: number | null; hasMore?: boolean }
  ), [client, demoCommand, demoMode]);

  const configureSession = useCallback(async (sessionId: string, configId: ConfigId, value: ConfigValue) => {
    if (demoMode) demoCommand({ type: 'session.configure', sessionId, payload: { configId, value } });
    else await client.sendCommand({ type: 'session.configure', sessionId, payload: { configId, value } });
  }, [client, demoCommand, demoMode]);

  const readAttachment = useCallback(
    (sessionId: string, attachmentId: string) => client.readAttachment(sessionId, attachmentId),
    [client]
  );

  const transcribeAudio = useCallback(
    (uri: string, mimeType: string, durationMs: number) => demoMode
      ? Promise.resolve('Review the voice note in this sample conversation')
      : client.transcribeAudio(uri, mimeType, durationMs, visibleSession?.sessionId),
    [client, demoMode, visibleSession?.sessionId]
  );

  const resolveImageReference = useCallback(
    (sessionId: string, path: string) => client.resolveImageReference(sessionId, path),
    [client]
  );

  const openPreview = useCallback(async (value: string) => {
    if (demoMode) {
      showNotice('Local previews become available after connecting your computer');
      return false;
    }
    try {
      const url = await client.createPreview(value.trim(), visibleSession?.sessionId);
      await openExternalUrl(url);
      showNotice('Localhost preview opened');
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not open the localhost preview');
      return false;
    }
  }, [client, demoMode, showNotice, visibleSession?.sessionId]);

  const closeSession = useCallback(async (session: RuntimeSession) => {
    if (closingSessionIds.current.has(session.sessionId)) return;
    closingSessionIds.current.add(session.sessionId);
    setOptimisticallyClosedSessionIds((current) => new Set(current).add(session.sessionId));
    if (selectedId === session.sessionId) backToSessions();
    tabX.setValue(0);
    setSection('sessions');
    try {
      if (demoMode) demoCommand({ type: 'session.stop', sessionId: session.sessionId });
      else await client.sendCommand({ type: 'session.stop', sessionId: session.sessionId });
      showNotice('Conversation closed · kept in History');
    } catch (error) {
      setOptimisticallyClosedSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.sessionId);
        return next;
      });
      showNotice(error instanceof Error ? error.message : 'Could not close the conversation');
    } finally {
      closingSessionIds.current.delete(session.sessionId);
    }
  }, [backToSessions, client, demoCommand, demoMode, selectedId, showNotice, tabX]);
  const forgetChatDevice = useCallback(() => {
    void forgetDevice(visibleSession?.hostRuntimeId);
  }, [forgetDevice, visibleSession?.hostRuntimeId]);
  const stopVisibleSession = useCallback(() => {
    if (visibleSession) void closeSession(visibleSession);
  }, [closeSession, visibleSession]);
  const interruptVisibleSession = useCallback(() => {
    if (visibleSession) void run({ type: 'turn.interrupt', sessionId: visibleSession.sessionId });
  }, [run, visibleSession]);

  const runtimeHosts = runtime.hosts || [];
  const selectedNewHost = runtimeHosts.find((host) => host.runtimeId === newHostId) || runtimeHosts[0] || null;
  const projects = selectedNewHost
    ? runtime.projects.filter((project) => project.hostRuntimeId === selectedNewHost.runtimeId)
    : runtime.projects;

  useEffect(() => {
    if (!runtimeHosts.length) return;
    if (!runtimeHosts.some((host) => host.runtimeId === newHostId)) setNewHostId(runtimeHosts[0].runtimeId);
  }, [newHostId, runtimeHosts]);

  useEffect(() => {
    if (selectedNewHost && client instanceof WebMultiHostRuntimeClient) {
      client.setPreferredRuntimeId(selectedNewHost.runtimeId);
    }
    if (selectedNewHost && !selectedNewHost.availableAgents.includes(newAgent)) {
      setNewAgent(selectedNewHost.availableAgents.includes('codex') ? 'codex' : selectedNewHost.availableAgents[0] || '');
    }
  }, [client, newAgent, selectedNewHost]);

  useEffect(() => {
    if (!projects.length) {
      setNewProject('');
      return;
    }
    if (!projects.some((project) => project.path === newProject)) setNewProject(projects[0].path);
  }, [newProject, projects]);

  useEffect(() => {
    void loadMobileWorktreePreference().then(setNewUseWorktree);
  }, []);

  const selectedNewProject = projects.find((project) => project.path === newProject) || projects[0];
  const selectedNewProjectPath = selectedNewProject?.path || '';
  const effectiveNewUseWorktree = selectedNewProject?.worktreeEligible === true
    && (newUseWorktree ?? selectedNewProject.useWorktreeByDefault === true);

  const updateNewUseWorktree = useCallback((enabled: boolean) => {
    setNewUseWorktree(enabled);
    void saveMobileWorktreePreference(enabled);
  }, []);

  /** One path for every new session: the dialog and the wide-web shortcut chips share it. */
  const startSession = useCallback(async ({ agent, cwd, project, useWorktree, initialPrompt }: {
    agent: string;
    cwd: string;
    project?: RuntimeProject | null;
    useWorktree?: boolean;
    initialPrompt?: string;
  }) => {
    if (!cwd || creatingSession) return showNotice(cwd ? 'The session is already starting' : 'Choose a project first');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const firstPrompt = (initialPrompt || '').trim();
    const clientRequestId = Crypto.randomUUID();
    setNewSessionError(null);
    setCreatingSession(true);
    setStartingSession({
      agent,
      cwd,
      clientRequestId,
      project: project || {
        path: cwd,
        name: projectName(cwd),
      },
    });
    openSession(clientRequestId, true, 'created');
    setNewSessionOpen(false);
    try {
      const result = demoMode ? demoCommand({
        type: 'session.create',
        payload: {
          agent,
          cwd,
          initialPrompt: firstPrompt,
          clientRequestId,
        },
      }) as { sessionId?: string } | undefined : await client.sendCommand({
        type: 'session.create',
        payload: {
          agent,
          cwd,
          useWorktree,
          initialPrompt: firstPrompt,
          clientRequestId,
        },
      }) as { sessionId?: string } | undefined;
      if (!result?.sessionId) throw new Error('The desktop did not return the new session');
      const sessionId = result.sessionId;
      setStartingSession((current) => current ? { ...current, sessionId } : current);
      setNewPrompt('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showNotice(firstPrompt ? 'Session created and prompt sent' : 'Session created');
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const failedSessionId = client.getState().sessions.find((session) => (
        session.clientRequestId === clientRequestId
      ))?.sessionId;
      const queueIds = [clientRequestId, failedSessionId]
        .filter((sessionId): sessionId is string => Boolean(sessionId));
      const queued = [...new Map<string, PendingSend>(queueIds
        .flatMap((sessionId) => pendingSendsRef.current[sessionId] || [])
        .map((entry) => [entry.id, entry] as const)).values()];
      if (queued.length) {
        const next = { ...pendingSendsRef.current };
        for (const sessionId of queueIds) delete next[sessionId];
        setPendingSends(next);
        void savePendingSends(next);
        setNewPrompt((current) => [current.trim(), ...queued.map((entry) => entry.text.trim())]
          .filter(Boolean)
          .join('\n\n'));
      }
      if (Platform.OS === 'web'
        && typeof window !== 'undefined'
        && queueIds.includes(window.history.state?.[WEB_CHAT_HISTORY_KEY])) {
        window.history.back();
      } else {
        setSelectedId(null);
      }
      setStartingSession(null);
      setNewSessionOpen(true);
      setNewSessionError(error instanceof Error ? error.message : 'Could not create the session');
    } finally {
      setCreatingSession(false);
    }
  }, [client, creatingSession, demoCommand, demoMode, openSession, showNotice]);

  const createSession = useCallback(() => startSession({
    agent: newAgent,
    cwd: selectedNewProjectPath,
    project: selectedNewProject,
    useWorktree: effectiveNewUseWorktree,
    initialPrompt: newPrompt,
  }), [effectiveNewUseWorktree, newAgent, newPrompt, selectedNewProject, selectedNewProjectPath, startSession]);

  const launchShortcut = useCallback((shortcut: RuntimeShortcut) => startSession({
    agent: shortcut.agent,
    cwd: shortcut.projectPath,
    project: projects.find((project) => project.path === shortcut.projectPath) || shortcutProject(shortcut),
    useWorktree: shortcut.useWorktree === true ? true : shortcut.useWorktree === false ? false : undefined,
    initialPrompt: '',
  }), [projects, startSession]);

  const watchSleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wakes the relay briefly while the iPhone app is backgrounded so Watch commands run without opening the phone. */
  const wakeForWatch = useCallback(async () => {
    if (watchSleepTimer.current) clearTimeout(watchSleepTimer.current);
    watchSleepTimer.current = null;
    if (appActive.current || client.getState().phase === 'online') return client.getState();
    client.setActive(true);
    return new Promise<MobileRuntimeState>((resolveState) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => { unsubscribe(); resolveState(client.getState()); }, WATCH_WAKE_TIMEOUT_MS);
      unsubscribe = client.subscribe((state) => {
        if (state.phase !== 'online') return;
        clearTimeout(timer);
        unsubscribe();
        resolveState(state);
      });
    });
  }, [client]);
  const sleepAfterWatch = useCallback(() => {
    if (appActive.current || watchEventsInFlight.current.size > 0) return;
    if (watchSleepTimer.current) clearTimeout(watchSleepTimer.current);
    watchSleepTimer.current = setTimeout(() => {
      watchSleepTimer.current = null;
      if (!appActive.current) client.setActive(false);
    }, WATCH_SLEEP_DELAY_MS);
  }, [client]);

  const handleWatchEvent = useCallback(async (raw: unknown) => {
    const event = parseWatchEvent(raw);
    const rawId = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id
      : null;
    if (!event) {
      if (rawId) await watchBridge.acknowledge(rawId);
      return;
    }
    if (watchEventsInFlight.current.has(event.id)) return;
    watchEventsInFlight.current.add(event.id);
    let shouldAcknowledge = true;
    try {
      if (event.type === 'error') throw new Error(event.message);
      const runtime = demoRuntime ?? await wakeForWatch();
      if (event.type === 'command' && event.action === 'refresh') {
        if (!appActive.current && runtime.phase !== 'online') return;
        await watchBridge.publishState(makeWatchSnapshot(runtime, theme));
        return;
      }
      if (event.type === 'command') {
        if (runtime.phase !== 'online') {
          shouldAcknowledge = false;
          await watchBridge.sendResult({
            id: event.id,
            status: 'pending',
            message: event.action === 'loadSession' ? 'Open iPhone to update chat' : 'Queued · open iPhone',
          });
          return;
        }
        if (event.action === 'setStatus' || event.action === 'closeSession') {
          const session = runtime.sessions.find((candidate) => candidate.sessionId === event.sessionId && candidate.state !== 'stopped');
          if (!session) throw new Error('The session is no longer available');
          if (event.action === 'closeSession') {
            await client.sendCommand({ type: 'session.stop', sessionId: session.sessionId });
            await watchBridge.sendResult({ id: event.id, status: 'success', message: 'Session closed · kept in History' });
          } else {
            const label = event.status === 'clear' ? 'No status' : runtime.terminalStatuses.find((status) => status.key === event.status)?.label;
            if (!label) throw new Error('Unknown status');
            await client.sendCommand({ type: 'session.status', sessionId: session.sessionId, payload: { status: event.status } });
            await watchBridge.sendResult({ id: event.id, status: 'success', message: `Status: ${label}` });
          }
          return;
        }
        if (event.action === 'loadSession') {
          const session = runtime.sessions.find((candidate) => candidate.sessionId === event.sessionId && candidate.state !== 'stopped');
          if (!session) throw new Error('The session is no longer available');
          const result = await client.sendCommand({
            type: 'history.older',
            sessionId: session.sessionId,
            payload: { before: 8 },
          }) as { items?: RuntimeItem[] };
          const history = makeWatchMessages(Array.isArray(result.items) ? result.items : [], 8);
          const messages = history.length ? history : makeWatchMessages(session.items, 8);
          await watchBridge.sendResult({
            id: event.id,
            status: 'success',
            message: messages.length ? 'Chat updated' : 'No messages yet',
            sessionId: session.sessionId,
            messages,
          });
          return;
        }
        const project = runtime.projects.find((candidate) => candidate.path === event.projectPath);
        if (!project) throw new Error('The project is no longer available');
        let publishedStarting = false;
        let createdState: MobileRuntimeState | null = null;
        const unsubscribeFromCreate = client.subscribe((state) => {
          if (!state.sessions.some((session) => session.clientRequestId === event.id)) return;
          createdState = state;
          if (publishedStarting) return;
          publishedStarting = true;
          void watchBridge.publishState(makeWatchSnapshot(state, theme, event.id));
        });
        try {
          const result = await client.sendCommand({
            type: 'session.create',
            payload: {
              agent: event.agent,
              cwd: project.path,
              useWorktree: project.worktreeEligible === true && project.useWorktreeByDefault === true,
              initialPrompt: '',
              clientRequestId: event.id,
            },
          }, event.id) as { sessionId?: string };
          if (!result?.sessionId) throw new Error('The computer did not return the new session');
          if (createdState) await watchBridge.publishState(makeWatchSnapshot(createdState, theme, event.id)).catch(() => {});
          await watchBridge.sendResult({ id: event.id, status: 'success', message: 'Session created', sessionId: result.sessionId });
        } finally {
          unsubscribeFromCreate();
        }
        return;
      }
      const session = runtime.sessions.find((candidate) => candidate.sessionId === event.sessionId && candidate.state !== 'stopped');
      if (!session) throw new Error('This session is no longer available');
      let text = '';
      let attachments: MobileAttachment[] = [];
      try {
        text = await client.transcribeAudio(event.uri, event.mimeType, event.durationMs, session.sessionId);
      } catch {
        attachments = [createMobileAttachment({
          type: 'audio',
          name: 'apple-watch-voice.m4a',
          mimeType: event.mimeType,
          durationMs: event.durationMs,
          dataUrl: await uriToDataUrl(event.uri, event.mimeType),
        })];
      }
      if (!await queueSessionSend(session.sessionId, text, attachments, event.id)) throw new Error('The message queue is full');
      await watchBridge.sendResult({
        id: event.id,
        status: 'success',
        message: text ? 'Audio transcribed and sent' : 'Audio sent',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not complete the action';
      showNotice(message);
      await watchBridge.sendResult({ id: event.id, status: 'error', message });
    } finally {
      if (shouldAcknowledge) await watchBridge.acknowledge(event.id);
      watchEventsInFlight.current.delete(event.id);
      sleepAfterWatch();
    }
  }, [client, demoRuntime, queueSessionSend, showNotice, sleepAfterWatch, theme, wakeForWatch]);

  useEffect(() => {
    // ponytail: keep the last confirmed snapshot until a native background relay exists.
    if (!watchBridge.available || !appActive.current) return;
    void watchBridge.publishState(makeWatchSnapshot(runtime, theme));
  }, [runtime, theme]);

  useEffect(() => {
    if (!watchBridge.available) return;
    let active = true;
    const consume = (event: unknown) => { if (active) void handleWatchEvent(event); };
    const subscription = watchBridge.subscribe(consume);
    void watchBridge.pendingEvents().then((events) => events.forEach(consume));
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [handleWatchEvent]);

  if (!themeReady) return null;

  if (runtime.phase === 'booting') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
        <SessionListSkeleton colors={colors} styles={styles} reduceMotion={reduceMotion} message="Loading your saved sessions…" />
      </SafeAreaView>
    );
  }

  if (!addingHost && (runtime.phase === 'unpaired' || (runtime.phase === 'connecting' && !runtime.runtimeId))) {
    return (
      <PairingScreen
        colors={colors}
        styles={styles}
        runtime={runtime}
        pairingCode={pairingCode}
        setPairingCode={setPairingCode}
        openScanner={() => setScannerOpen(true)}
        pair={() => void pair(pairingCode)}
        enterDemo={enterDemo}
        notice={notice}
        scanner={(
          <Scanner
            open={scannerOpen}
            colors={colors}
            styles={styles}
            close={() => setScannerOpen(false)}
            onCode={(code) => void pair(code)}
          />
        )}
      />
    );
  }

  if (!addingHost && runtime.phase === 'confirming') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
        <PairingConfirmation runtime={runtime} styles={styles} cancel={() => client.cancelPairing()} />
      </SafeAreaView>
    );
  }

  const activeChatScreen = openingSession && !visibleSession ? (
    <StartingChatScreen
      colors={colors}
      session={openingSession}
      styles={styles}
      reduceMotion={reduceMotion}
      desktopWeb={webSplit}
      back={webSplit ? undefined : backToSessions}
    />
  ) : visibleSession ? (
    <ChatScreen
      key={visibleSession.sessionId}
      colors={colors}
      dark={dark}
      styles={styles}
      session={visibleSession}
      computerName={visibleSession.hostName || runtime.computerName}
      hostLabel={visibleSession.hostKind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop'}
      conversationActions={demoMode || (visibleHost ? visibleHost.capabilities : runtime.capabilities).includes('session.action')}
      online={visibleSession.hostPhase ? visibleSession.hostPhase === 'online' : runtime.phase === 'online'}
      offline={visibleSession.hostPhase ? visibleHostOffline : runtime.phase === 'offline'}
      showConnectionNotice={connectionNoticeVisible || visibleHostOffline}
      composerDrafts={composerDrafts}
      dismissComposerRef={dismissComposerRef}
      send={send}
      retryPending={retryPending}
      notify={showNotice}
      back={webSplit ? undefined : backToSessions}
      forget={forgetChatDevice}
      stop={stopVisibleSession}
      interrupt={interruptVisibleSession}
      run={run}
      pending={pendingSends[visibleSession.sessionId] || EMPTY_PENDING_SENDS}
      drafts={questionDrafts}
      setDrafts={setQuestionDrafts}
      listRef={listRef}
      nearBottom={nearBottom}
      setNearBottom={setNearBottom}
      keyboardOffset={insets.top}
      loadModels={loadModels}
      loadEarlierHistory={loadEarlierHistory}
      configureSession={configureSession}
      readAttachment={readAttachment}
      transcribeAudio={transcribeAudio}
      resolveImageReference={resolveImageReference}
      openPreview={openPreview}
      reduceMotion={reduceMotion}
      terminalStatuses={visibleHost?.terminalStatuses || runtime.terminalStatuses}
      availableAgents={visibleHost?.availableAgents || runtime.availableAgents}
      demoMode={demoMode}
      contextMenuRequest={webContextMenuRequest}
      consumeContextMenuRequest={consumeWebContextMenuRequest}
    />
  ) : null;

  const primaryNav = (
    <BottomNav
      active={section}
      screenWidth={tabViewportWidth}
      colors={colors}
      showSessions={() => settleSection('sessions')}
      showProjects={() => settleSection('projects')}
      showKanban={() => settleSection('kanban')}
      showHistory={() => {
        void loadHistory();
        settleSection('history');
      }}
      styles={styles}
      placement={webSplit ? 'top' : 'bottom'}
    />
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
      {demoMode ? <DemoBanner exit={exitDemo} colors={colors} styles={styles} /> : null}
      {webSplit ? (
        <WebTopBar
          shortcuts={webShortcuts}
          projects={runtime.projects}
          hosts={runtime.hosts || []}
          hostIcons={webHostIcons}
          disabled={runtime.phase !== 'online' && !demoMode}
          colors={colors}
          styles={styles}
          launch={(shortcut) => void launchShortcut(shortcut)}
          edit={(shortcut) => shortcutEditorRef.current?.(shortcut)}
          add={() => shortcutEditorRef.current?.()}
          create={() => {
            setNewSessionError(null);
            setNewSessionOpen(true);
          }}
        />
      ) : null}
      <View style={[styles.workspace, webSplit && styles.webSplitWorkspace]}>
        {section === 'projects' || section === 'kanban' ? (
          <View style={[styles.flex, !webSplit && { paddingBottom: 84 }]}>
            {webSplit ? primaryNav : null}
            <ProjectsKanbanScreen
              mode={section}
              openBoard={() => settleSection('kanban')}
              runtime={runtime}
              colors={{ ...colors, elevated: colors.raised }}
              desktopWeb={webSplit}
              refreshVersion={taskRefreshVersion}
              sendCommand={managementCommand}
              notify={showNotice}
            />
            {webSplit ? null : primaryNav}
          </View>
        ) : <>
        <Animated.View testID="primary-tab-viewport" style={[styles.tabViewport, webSplit && styles.webSplitSidebar, !webSplit && chatLayerVisible && chatMotion.baseStyle]}>
          {webSplit ? primaryNav : null}
          <Animated.View
            testID="primary-tab-track"
            style={[styles.tabTrack, { width: tabViewportWidth * 2, transform: [{ translateX: tabX }] }]}
          >
            <View
              testID="sessions-screen"
              accessibilityElementsHidden={section !== 'sessions'}
              importantForAccessibility={section === 'sessions' ? 'auto' : 'no-hide-descendants'}
              style={[styles.tabScreen, { width: tabViewportWidth }]}
            >
              <SessionList
                runtime={listRuntime}
                managedShortcuts={Platform.OS === 'web' ? webShortcuts : undefined}
                replaceManagedShortcuts={Platform.OS === 'web' ? replaceWebShortcuts : undefined}
                localShortcuts={Platform.OS === 'web'}
                hostIcons={webHostIcons}
                selectHostIcon={selectWebHostIcon}
                shortcutEditorRef={shortcutEditorRef}
                colors={colors}
                dark={dark}
                styles={styles}
                run={run}
                open={openSession}
                openContextMenu={openSessionContextMenu}
                selectedSessionId={selectedId}
                create={() => {
                  setNewSessionError(null);
                  setNewSessionOpen(true);
                }}
                connectHost={() => {
                  setAddingHostBaseline(runtime.hosts?.length || 0);
                  setAddingHost(true);
                }}
                reconnect={() => client.reconnectNow()}
                forget={(runtimeId) => void forgetDevice(runtimeId)}
                stop={(session) => void closeSession(session)}
                minimize={(session) => void run({ type: 'session.minimize', sessionId: session.sessionId })}
                restore={(session) => void run({ type: 'session.restore', sessionId: session.sessionId })}
                theme={theme}
                selectTheme={selectTheme}
                notificationsEnabled={notificationsEnabled}
                selectNotificationsEnabled={selectNotificationsEnabled}
                cloudProviders={cloudProviders}
                cloudProvidersLoading={cloudProvidersLoading}
                providerLogins={providerLogins}
                loadCloudProviders={loadCloudProviders}
                signInProvider={startCloudProviderLogin}
                demoMode={demoMode}
                reduceMotion={reduceMotion}
                showConnectionNotice={connectionNoticeVisible}
                tabSwipeHandlers={tabPanResponder.panHandlers}
                visibleSessionIds={visibleSessionIdsRef}
                searchInputRef={searchInputRef}
              />
            </View>
            <View
              testID="history-screen"
              accessibilityElementsHidden={section !== 'history'}
              importantForAccessibility={section === 'history' ? 'auto' : 'no-hide-descendants'}
              style={[styles.tabScreen, { width: tabViewportWidth }]}
            >
              <HistoryList
                conversations={history}
                desktopWeb={webSplit}
                loading={historyLoading}
                openingId={historyOpeningId}
                online={runtime.phase === 'online'}
                ready={historyReady}
                projects={runtime.projects}
                colors={colors}
                dark={dark}
                styles={styles}
                open={(conversation) => void resumeHistory(conversation)}
                refresh={() => void loadHistory()}
                reduceMotion={reduceMotion}
                showConnectionNotice={connectionNoticeVisible}
                tabSwipeHandlers={tabPanResponder.panHandlers}
              />
            </View>
          </Animated.View>
          {webSplit ? null : primaryNav}
        </Animated.View>
        {webSplit ? (
          <View testID="web-split-chat-pane" style={styles.webSplitChatPane}>
            {activeChatScreen || (
              <View testID="web-split-empty-state" style={styles.webSplitEmptyState}>
                <View style={styles.webSplitEmptyIcon}><UiIcon name="session-message" size={25} color={colors.accent} /></View>
                <Text style={styles.webSplitEmptyTitle}>Select a session</Text>
                <Text style={styles.webSplitEmptyCopy}>Its conversation will open here while the list stays visible.</Text>
              </View>
            )}
          </View>
        ) : null}
        </>}
      </View>

      {!webSplit && activeChatScreen ? (
        <PanGestureHandler {...chatSwipeHandlers}>
          <Animated.View testID={visibleSession ? 'chat-screen-layer' : undefined} style={[styles.screenOverlay, { top: insets.top, bottom: insets.bottom }, chatMotion.layerStyle]}>
            <Animated.View testID={visibleSession ? 'chat-screen-entry' : undefined} style={[styles.screenOverlayContent, chatMotion.entryStyle]}>{activeChatScreen}</Animated.View>
          </Animated.View>
        </PanGestureHandler>
      ) : null}

      <BottomSheet
        open={addingHost}
        onClose={cancelAddingHost}
        closeLabel="Back to Settings"
        accessibilityLabel="Connect another host"
        reduceMotion={reduceMotion}
        testID="pairing-host-sheet"
        sheetStyle={[styles.configSheet, styles.pairingHostSheet, webSplit && styles.sheetDesktopDialog, webSplit && styles.sheetDesktopCompactDialog, webSplit && styles.pairingHostDesktopSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={[styles.modalLayout, webSplit && styles.modalLayoutCentered]}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle, webSplit && styles.sheetDesktopNoHandle]}
        dragAreaStyle={[styles.quotaDragArea, webSplit && styles.sheetDesktopNoHandle]}
        avoidKeyboard
      >
        {runtime.phase === 'confirming' ? (
          <PairingConfirmation runtime={runtime} styles={styles} cancel={cancelAddingHost} modal />
        ) : (
          <PairingScreen
            colors={colors}
            styles={styles}
            runtime={runtime}
            pairingCode={pairingCode}
            setPairingCode={setPairingCode}
            openScanner={() => setScannerOpen(true)}
            pair={() => void pair(pairingCode)}
            enterDemo={enterDemo}
            notice={notice}
            connecting={pairingBusy}
            addingHost
            cancel={cancelAddingHost}
            scanner={(
              <Scanner
                open={scannerOpen}
                colors={colors}
                styles={styles}
                close={() => setScannerOpen(false)}
                onCode={(code) => void pair(code)}
              />
            )}
          />
        )}
      </BottomSheet>

      <NewSessionModal
        open={newSessionOpen}
        desktopWeb={webSplit}
        colors={colors}
        styles={styles}
        projects={projects}
        hosts={runtimeHosts}
        selectedHost={selectedNewHost?.runtimeId || ''}
        setSelectedHost={setNewHostId}
        selectedProject={selectedNewProjectPath}
        setSelectedProject={setNewProject}
        selectedAgent={newAgent}
        setSelectedAgent={setNewAgent}
        availableAgents={selectedNewHost?.availableAgents || runtime.availableAgents}
        cloudProvider={cloudProviders.find((provider) => provider.id === newAgent) || null}
        providerSigningIn={providerLogins.has(newAgent)}
        providerLoginFlow={providerLoginFlows[newAgent] || null}
        signInProvider={() => void startCloudProviderLogin(newAgent)}
        copyProviderCode={() => copyCloudProviderLoginCode(newAgent)}
        openProviderLogin={() => openCloudProviderLogin(newAgent)}
        useWorktree={effectiveNewUseWorktree}
        setUseWorktree={updateNewUseWorktree}
        prompt={newPrompt}
        setPrompt={setNewPrompt}
        error={newSessionError}
        close={() => {
          setNewSessionError(null);
          setNewSessionOpen(false);
        }}
        create={() => void createSession()}
        online={selectedNewHost ? selectedNewHost.phase === 'online' : runtime.phase === 'online'}
        creating={creatingSession}
        reduceMotion={reduceMotion}
      />
    </SafeAreaView>
  );
}

function ChatEmptyState({ agent, project, desktopWeb, connecting, opening, dark, stopped, hasEarlierHistory, online, colors, styles, reduceMotion }: {
  agent?: string;
  project: RuntimeProject | null;
  desktopWeb: boolean;
  connecting?: boolean;
  opening?: boolean;
  dark: boolean;
  stopped?: boolean;
  hasEarlierHistory?: boolean;
  online?: boolean;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion: boolean;
}) {
  const startingAgent = agentInfo(agent || null);
  const title = stopped
    ? 'No messages'
    : connecting && opening
      ? 'Opening conversation'
      : connecting
        ? 'Starting session'
        : hasEarlierHistory
          ? online ? 'Earlier messages available' : 'Conversation stored on your computer'
        : 'What should we work on?';
  const copy = stopped
    ? 'This session was stopped before any messages arrived.'
    : connecting
      ? opening ? 'Connecting to your computer' : `Starting ${startingAgent.label} on your computer`
      : hasEarlierHistory
        ? online ? 'Load the earlier messages to continue.' : 'Reconnect your computer to load this conversation.'
        : 'Send a message to start working.';
  return (
    <MotionRise testID="chat-empty-state" reduceMotion={reduceMotion} replayKey={`${title}:${copy}`} distance={14} duration={420} style={styles.chatEmpty}>
      <View accessibilityLiveRegion={connecting ? 'polite' : 'none'} style={[styles.chatEmptyInner, desktopWeb && styles.chatEmptyInnerDesktop]}>
        <View style={[styles.chatEmptyBrand, desktopWeb && styles.chatEmptyBrandDesktop]}>
          <Image source={dark ? BRAND_MARK : BRAND_ICON} resizeMode="contain" style={styles.chatEmptyLogo} />
        </View>
        {desktopWeb ? <Text style={styles.chatEmptyEyebrow}>Chat</Text> : null}
        <Text style={[styles.chatEmptyTitle, desktopWeb && styles.chatEmptyTitleDesktop]}>{title}</Text>
        <View accessible={connecting} accessibilityLabel={connecting ? copy : undefined} style={[styles.chatEmptyStatus, desktopWeb && styles.chatEmptyStatusDesktop]}>
          {connecting ? <ThinkingOrb state="connecting" dark={dark} reduceMotion={reduceMotion} size={20} testID="connecting-orb" /> : null}
          <Text style={[styles.chatEmptyCopy, desktopWeb && styles.chatEmptyCopyDesktop]}>{desktopWeb && !connecting && !stopped && !hasEarlierHistory ? 'Bring an idea, a problem, or a task. Your agent is ready to build alongside you.' : copy}</Text>
          {connecting ? <View accessibilityLabel={`${startingAgent.label} agent icon`}><AgentIcon agent={agent || null} size={20} styles={styles} /></View> : null}
        </View>
        {desktopWeb && !connecting && !stopped && !hasEarlierHistory ? (
          <View accessibilityLabel={`${startingAgent.label} in ${project?.name || 'New project'}`} style={styles.chatEmptyIdentity}>
            <AgentIcon agent={agent || null} size={24} styles={styles} />
            <Text style={styles.chatEmptyIdentityLink}>in</Text>
            <ProjectIcon project={project} size={28} styles={styles} />
          </View>
        ) : null}
      </View>
    </MotionRise>
  );
}

function MessageEntrance({ children, createdAtMs, kind, reduceMotion, testID }: {
  children: ReactNode;
  createdAtMs?: number;
  kind: 'assistant' | 'user';
  reduceMotion: boolean;
  testID?: string;
}) {
  const fresh = Number.isFinite(createdAtMs)
    && Date.now() - createdAtMs! < FRESH_MESSAGE_WINDOW_MS;
  const animate = fresh && !reduceMotion;
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    progress.stopAnimation();
    if (!animate) {
      progress.setValue(1);
      return undefined;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: MESSAGE_ENTRY_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [animate, progress]);
  return (
    <Animated.View
      testID={testID}
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [kind === 'user' ? 14 : 8, 0] }) },
          { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [kind === 'user' ? .98 : .992, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

function ActivityCue({ label, state, dark, reduceMotion, testID, styles }: {
  label: string;
  state: OrbState;
  dark: boolean;
  reduceMotion: boolean;
  testID: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={styles.activityCue}
    >
      <Text style={styles.activityCueText}>{label}</Text>
      <ThinkingOrb state={state} dark={dark} reduceMotion={reduceMotion} size={20} testID={`${testID}-orb`} />
    </View>
  );
}

function SearchCue({ active, colors, dark, reduceMotion, testID, styles }: {
  active: boolean;
  colors: Palette;
  dark: boolean;
  reduceMotion: boolean;
  testID: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.searchIcon}>
      {active
        ? <ThinkingOrb state="breathing" dark={dark} reduceMotion={reduceMotion} size={20} testID={testID} />
        : <UiIcon name="search" size={17} color={colors.muted} />}
    </View>
  );
}

function latestStreamingAssistantMessage(items: RuntimeItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.status === 'inProgress'
      && (item.itemType === 'assistant_message' || item.content.assistant_text !== undefined)) {
      return { itemId: item.itemId, textLength: itemText(item).length };
    }
  }
  return null;
}

function useStreamingHaptics(sessionId: string, items: RuntimeItem[]) {
  const latest = latestStreamingAssistantMessage(items);
  const hydrated = useRef(false);
  const previousSessionId = useRef(sessionId);
  const previousItemId = useRef<string | null>(null);
  const previousTextLength = useRef(0);
  const lastPulseAt = useRef(0);
  useEffect(() => {
    if (previousSessionId.current !== sessionId) {
      previousSessionId.current = sessionId;
      hydrated.current = false;
      lastPulseAt.current = 0;
    }
    if (!hydrated.current) {
      hydrated.current = true;
      previousItemId.current = latest?.itemId || null;
      previousTextLength.current = latest?.textLength || 0;
      return;
    }
    if (!latest) {
      previousItemId.current = null;
      previousTextLength.current = 0;
      return;
    }
    const newStream = latest.itemId !== previousItemId.current;
    const textGrew = !newStream && latest.textLength > previousTextLength.current;
    previousItemId.current = latest.itemId;
    previousTextLength.current = latest.textLength;
    if (!newStream && !textGrew) return;
    const now = Date.now();
    if (!newStream && now - lastPulseAt.current < STREAM_HAPTIC_INTERVAL_MS) return;
    lastPulseAt.current = now;
    if (AppState.currentState === 'active') {
      void Haptics.selectionAsync().catch(() => {});
    }
  }, [latest?.itemId, latest?.textLength, sessionId]);
}

function ChatTimelineSkeleton({ overlay = false, reduceMotion, styles, testID }: {
  overlay?: boolean;
  reduceMotion: boolean;
  styles: ReturnType<typeof createStyles>;
  testID: string;
}) {
  return (
    <SkeletonPulse
      pointerEvents="none"
      testID={testID}
      accessibilityLabel="Loading conversation"
      reduceMotion={reduceMotion}
      style={[styles.startingChatSkeletonFrame, overlay && styles.timelineSkeletonOverlay]}
    >
      <View testID="chat-skeleton-content" style={[styles.startingChatSkeleton, styles.timelineDesktop]}>
        {Array.from({ length: 18 }, (_, index) => (
          <View
            key={index}
            testID="chat-skeleton-placeholder"
            style={[
              styles.skeleton,
              index % 3 === 0
                ? styles.startingSkeletonLineWide
                : index % 3 === 1
                  ? styles.startingSkeletonLineShort
                  : styles.startingSkeletonBubble,
            ]}
          />
        ))}
      </View>
    </SkeletonPulse>
  );
}

function StartingChatScreen({ colors, session, styles, reduceMotion, desktopWeb, back }: {
  colors: Palette;
  session: StartingSession;
  styles: ReturnType<typeof createStyles>;
  reduceMotion: boolean;
  desktopWeb: boolean;
  back?: () => void;
}) {
  const agent = agentInfo(session.agent);
  const project = session.project || { path: session.cwd, name: projectName(session.cwd) };
  return (
    <View accessibilityLabel={`Starting ${agent.label}`} style={styles.flex}>
      {!desktopWeb ? <View testID="chat-header" style={styles.chatHeader}>
        {back ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back to sessions" onPress={back} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        ) : <View style={styles.startingChatHeaderEdge} />}
        <View style={styles.chatHeaderIdentity}>
          <View style={styles.chatHeaderIcons}><ProjectIcon project={project} size={32} styles={styles} /><View style={styles.chatAgentIcon}><AgentIcon agent={session.agent} size={19} styles={styles} /></View></View>
          <View style={styles.chatHeading}>
            <Text style={styles.chatTitle} numberOfLines={1}>{session.title || 'Starting session…'}</Text>
            <View style={styles.chatSubtitleRow}>
              <View style={[styles.chatConnectionDot, { backgroundColor: colors.accent }]} />
              <Text style={styles.chatSubtitle} numberOfLines={1}>Connecting · {agent.label}</Text>
            </View>
          </View>
        </View>
        <View style={styles.startingChatHeaderEdge} />
        <ProgressRail colors={colors} reduceMotion={reduceMotion} testID="starting-chat-progress-rail" style={styles.headerProgressRail} />
      </View> : null}
      <View style={styles.startingActivityRow}><View style={[styles.sessionStatusRail, { backgroundColor: colors.accent }]} /><Text style={styles.startingActivityLabel}>Starting</Text><Text style={styles.startingActivityText}>Opening conversation on your computer</Text></View>
      <ChatTimelineSkeleton reduceMotion={reduceMotion} styles={styles} testID="starting-chat-skeleton" />
      <View style={styles.startingComposerWrap}><View style={styles.startingComposer}><Text style={styles.startingComposerAdd}>+</Text><Text style={styles.startingComposerText}>Starting {agent.label}…</Text><View style={styles.startingComposerSend}><UiIcon name="arrow-up" size={19} color={colors.accentText} /></View></View></View>
    </View>
  );
}

function PairingScreen({
  colors,
  styles,
  runtime,
  pairingCode,
  setPairingCode,
  openScanner,
  pair,
  enterDemo,
  notice,
  scanner,
  connecting: pairingBusy,
  addingHost = false,
  cancel,
}: {
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  runtime: MobileRuntimeState;
  pairingCode: string;
  setPairingCode: (value: string) => void;
  openScanner: () => void;
  pair: () => void;
  enterDemo: () => void;
  notice: string | null;
  scanner: React.ReactNode;
  connecting?: boolean;
  addingHost?: boolean;
  cancel?: () => void;
}) {
  const connecting = pairingBusy ?? runtime.phase === 'connecting';
  const pairingCodeReady = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/.test(pairingCode);
  const [firstPairingSegment = '', lastPairingSegment = ''] = pairingCode.includes('-')
    ? pairingCode.split('-', 2)
    : [pairingCode, ''];
  const firstPairingInputRef = useRef<TextInput>(null);
  const lastPairingInputRef = useRef<TextInput>(null);
  const updatePairingSegment = (value: string, segment: 'first' | 'last') => {
    const entered = value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '');
    const nextFirst = entered.length > 4 ? entered.slice(0, 4) : segment === 'first' ? entered : firstPairingSegment;
    const nextLast = entered.length > 4 ? entered.slice(4, 8) : segment === 'last' ? entered : lastPairingSegment;
    setPairingCode(nextLast || nextFirst.length === 4 ? `${nextFirst}-${nextLast}` : nextFirst);
    if (segment === 'first' && entered.length >= 4) lastPairingInputRef.current?.focus();
  };
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  const content = (
    <View testID="pairing-card" style={[styles.pairingContent, addingHost ? styles.pairingModalContent : desktopWeb && styles.pairingCard]}>
        {addingHost ? (
          <View style={styles.pairingModalHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back to Settings" disabled={connecting} onPress={cancel} style={({ pressed }) => [styles.pairingModalBack, pressed && styles.pressed, connecting && styles.disabled]}>
              <UiIcon name="chevron-left" size={21} color={colors.text} strokeWidth={2.4} />
            </Pressable>
            <View style={styles.pairingModalHeaderCopy}>
              <Text accessibilityRole="header" style={styles.pairingModalTitle}>Connect another host</Text>
              <Text style={styles.pairingModalSubtitle}>Your current host stays connected</Text>
            </View>
          </View>
        ) : (
          <>
            <Image source={BRAND_ICON} resizeMode="contain" style={styles.brandLogo} />
            <Text accessibilityRole="header" style={styles.brandWordmark}>CODE<Text style={styles.brandAccent}>AGENT</Text>SWARM</Text>
            <Text style={styles.pairingTitle}>Your agents, within reach</Text>
          </>
        )}
        <Text style={[styles.pairingCopy, addingHost && styles.pairingModalCopy]}>
          {addingHost ? 'Scan the QR or enter the one-time code shown in CAS Desktop or CAS Cloud.' : 'Scan the QR or enter the one-time code shown in CodeAgentSwarm. Your agents keep running on your computer.'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan pairing QR code"
          disabled={connecting}
          onPress={openScanner}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, connecting && styles.disabled]}
        >
          <Text style={styles.primaryButtonText}>{connecting ? 'Connecting…' : 'Scan QR code'}</Text>
        </Pressable>
        <View style={styles.orRow}><View style={styles.orLine} /><Text style={styles.orText}>or enter the code</Text><View style={styles.orLine} /></View>
        <View style={[styles.inlineForm, addingHost && !desktopWeb && styles.pairingModalInlineForm]}>
          <View style={styles.pairInput}>
            <TextInput
              ref={firstPairingInputRef}
              accessibilityLabel="Pairing code, first four characters"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect={false}
              placeholder="XXXX"
              placeholderTextColor={colors.muted}
              value={firstPairingSegment}
              onChangeText={(value) => updatePairingSegment(value, 'first')}
              onSubmitEditing={() => lastPairingInputRef.current?.focus()}
              returnKeyType="next"
              style={styles.pairInputSegment}
            />
            <TextInput
              ref={lastPairingInputRef}
              accessibilityLabel="Pairing code, last four characters"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect={false}
              placeholder="XXXX"
              placeholderTextColor={colors.muted}
              value={lastPairingSegment}
              onChangeText={(value) => updatePairingSegment(value, 'last')}
              onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === 'Backspace' && !lastPairingSegment) firstPairingInputRef.current?.focus();
              }}
              onSubmitEditing={pairingCodeReady ? pair : undefined}
              returnKeyType="done"
              style={styles.pairInputSegment}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connect with pairing code"
            disabled={!pairingCodeReady || connecting}
            onPress={pair}
            style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed, (!pairingCodeReady || connecting) && styles.disabled]}
          >
            <Text style={styles.inlineButtonText}>Connect</Text>
          </Pressable>
        </View>
        {!addingHost ? <Pressable
          accessibilityRole="button"
          accessibilityLabel="Explore demo"
          disabled={connecting}
          onPress={enterDemo}
          style={({ pressed }) => [styles.secondaryButton, styles.demoEntryButton, pressed && styles.pressed, connecting && styles.disabled]}
        >
          <Text style={styles.secondaryButtonText}>Explore demo</Text>
        </Pressable> : null}
        {(notice || runtime.error) ? <Text style={styles.inlineError} accessibilityLiveRegion="assertive">{notice || runtime.error}</Text> : null}
        <Text style={[styles.securityNote, addingHost && styles.pairingModalSecurityNote]}>{addingHost ? 'One-time codes expire after five minutes. Confirmation may still be required on the host.' : 'One-time QR or code. Confirmation required on your computer.'}</Text>
    </View>
  );
  if (addingHost) return <>{content}{scanner}</>;
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={colors === DARK || colors === NEON ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
      <KeyboardAvoidingView style={styles.pairingScreen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>{content}</KeyboardAvoidingView>
      {scanner}
    </SafeAreaView>
  );
}

function PairingConfirmation({ runtime, styles, cancel, modal = false }: {
  runtime: MobileRuntimeState;
  styles: ReturnType<typeof createStyles>;
  cancel: () => void;
  modal?: boolean;
}) {
  return (
    <View style={[styles.confirmScreen, modal && styles.pairingModalConfirmation]}>
      <View style={styles.confirmIcon}><Text style={styles.confirmIconText}>✓</Text></View>
      <Text style={styles.confirmTitle}>Confirm on your computer</Text>
      <Text style={styles.confirmCopy}>Check that this code matches the one shown in CodeAgentSwarm.</Text>
      <Text style={styles.confirmCode} accessibilityLabel={`Verification code ${runtime.challengeCode}`}>
        {runtime.challengeCode || '······'}
      </Text>
      <Text style={styles.confirmHint}>This request expires automatically.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel pairing" onPress={cancel} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
        <Text style={styles.secondaryButtonText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

/** Wide-web header: the desktop brand, its project shortcut chips and the New agent button. */
type WebPressableState = { pressed: boolean; hovered?: boolean; focused?: boolean };

function setWebTitle(node: unknown, title: string) {
  if (Platform.OS === 'web' && node instanceof HTMLElement) node.title = title;
}

function WebTopBar({ shortcuts, projects, hosts, hostIcons, disabled, colors, styles, launch, edit, add, create }: {
  shortcuts: RuntimeShortcut[];
  projects: RuntimeProject[];
  hosts: RuntimeHost[];
  hostIcons: WebHostIcons;
  disabled: boolean;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  launch: (shortcut: RuntimeShortcut) => void;
  edit: (shortcut: RuntimeShortcut) => void;
  add: () => void;
  create: () => void;
}) {
  const empty = shortcuts.length === 0;
  return (
    <View testID="web-top-bar" style={styles.webTopBar}>
      <View style={styles.wordmarkRow}><Image source={BRAND_MARK} resizeMode="contain" style={styles.webTopBarMark} /><Text style={styles.webTopBarWordmark}>Agents</Text></View>
      <ScrollView
        testID="web-top-bar-shortcuts"
        horizontal
        keyboardDismissMode="none"
        showsHorizontalScrollIndicator={false}
        style={styles.webTopBarShortcuts}
        contentContainerStyle={styles.webTopBarShortcutsContent}
      >
        {shortcuts.map((shortcut) => {
          const project = projects.find((candidate) => candidate.path === shortcut.projectPath);
          const host = hosts.find((candidate) => candidate.runtimeId === (shortcut.hostRuntimeId || project?.hostRuntimeId));
          const shortcutDisabled = disabled || host?.phase === 'offline' || host?.phase === 'error';
          const usesWorktree = shortcut.useWorktree === true
            || (shortcut.useWorktree === null && project?.useWorktreeByDefault === true);
          const worktreeLabel = shortcut.useWorktree === true
            ? ' using a worktree'
            : shortcut.useWorktree === false ? ' without a worktree' : ' using the project worktree default';
          const label = `Start ${agentInfo(shortcut.agent).label} in ${shortcut.projectName}${host ? ` on ${host.name}` : ''}${worktreeLabel}`;
          return (
            <Pressable
              key={shortcut.shortcutId}
              testID="web-shortcut-chip"
              tabIndex={-1}
                  style={({ hovered }: WebPressableState) => [
                    styles.webShortcutChip,
                    hovered && !shortcutDisabled && styles.webShortcutChipHovered,
                    disabled && styles.webShortcutChipDisabled,
                    shortcutDisabled && styles.webShortcutChipDisabled,
              ]}
            >
              <Pressable
                testID="web-shortcut-launch"
                ref={(node) => setWebTitle(node, label)}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: shortcutDisabled }}
                disabled={shortcutDisabled}
                onPress={() => launch(shortcut)}
                style={({ pressed, focused }: WebPressableState) => [styles.webShortcutLaunch, pressed && styles.webShortcutPartPressed, focused && styles.webShortcutChipFocused]}
              >
                <ProjectIcon project={shortcutProject(shortcut)} size={24} styles={styles} />
                {host ? <HostIcon host={host} icons={hostIcons} size={8} color={host.phase === 'online' ? colors.success : colors.muted} testID={`web-shortcut-host-${host.runtimeId}`} style={styles.webShortcutHost} /> : null}
              </Pressable>
              <View style={styles.webShortcutDivider} />
              <Pressable
                testID="web-shortcut-provider"
                ref={(node) => setWebTitle(node, `Edit ${shortcut.projectName} · ${agentInfo(shortcut.agent).label}`)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${shortcut.projectName} shortcut. Provider: ${agentInfo(shortcut.agent).label}`}
                onPress={() => edit(shortcut)}
                style={({ pressed, focused }: WebPressableState) => [styles.webShortcutProvider, pressed && styles.webShortcutPartPressed, focused && styles.webShortcutChipFocused]}
              >
                <AgentIcon agent={shortcut.agent} size={16} styles={styles} />
                <UiIcon name="chevron-down" size={7} color={colors.muted} />
              </Pressable>
              {usesWorktree ? <View testID="web-shortcut-worktree" pointerEvents="none" style={styles.webShortcutWorktree}><UiIcon name="git-branch" size={9} color={colors.accent} strokeWidth={2.5} /></View> : null}
            </Pressable>
          );
        })}
        <Pressable
          testID="web-shortcuts-manage-button"
          ref={(node) => setWebTitle(node, empty ? 'Add your first shortcut' : 'Add web shortcut')}
          accessibilityRole="button"
          accessibilityLabel={empty ? 'Add your first web shortcut' : 'Add web project shortcut'}
          disabled={shortcuts.length >= 10}
          onPress={add}
          style={({ pressed, hovered, focused }: WebPressableState) => [styles.webShortcutAdd, empty && styles.webShortcutAddEmpty, hovered && styles.webShortcutAddHovered, focused && styles.webShortcutChipFocused, pressed && styles.webShortcutPartPressed, shortcuts.length >= 10 && styles.disabled]}
        >
          <UiIcon name="plus" size={17} color={colors.secondary} />
          {empty ? <Text style={styles.webShortcutAddText}>Add your first shortcut</Text> : null}
        </Pressable>
      </ScrollView>
      <Pressable
        testID="new-agent-button"
        ref={(node) => setWebTitle(node, 'New agent (⌥N)')}
        accessibilityRole="button"
        accessibilityLabel="Create a new session"
        onPress={create}
        style={({ pressed }) => [styles.newAgentButton, pressed && styles.pressed]}
      >
        <UiIcon name="plus" size={18} color={colors.accentText} />
        <Text style={styles.newAgentButtonText}>NEW AGENT</Text>
      </Pressable>
    </View>
  );
}

function DemoBanner({ exit, colors, styles }: {
  exit: () => void;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View testID="demo-banner" style={styles.demoBanner}>
      <Text style={styles.demoBadge}>DEMO</Text>
      <Text style={styles.demoBannerText} numberOfLines={1}>Sample workspace · no computer connected</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Connect a computer" onPress={exit} hitSlop={8}>
        <Text style={[styles.demoExit, { color: colors.brand }]}>Connect</Text>
      </Pressable>
    </View>
  );
}

function Scanner({ open, close, onCode, colors, styles }: {
  open: boolean;
  close: () => void;
  onCode: (value: string) => void;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [webCameraGranted, setWebCameraGranted] = useState(() => (
    Platform.OS === 'web' && localStorage.getItem(WEB_CAMERA_PERMISSION_KEY) === 'granted'
  ));
  const [locked, setLocked] = useState(false);
  const [zoom, setZoom] = useState(0);
  const pinch = useRef({ distance: 0, zoom: 0 });
  const zoomRef = useRef(0);
  const setCameraZoom = useCallback((value: number) => {
    zoomRef.current = Math.max(0, Math.min(0.7, value));
    setZoom(zoomRef.current);
  }, []);
  const zoomGesture = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length === 2,
    onMoveShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length === 2,
    onPanResponderGrant: (event) => {
      const [a, b] = event.nativeEvent.touches;
      if (!a || !b) return;
      pinch.current = { distance: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY), zoom: zoomRef.current };
    },
    onPanResponderMove: (event) => {
      const [a, b] = event.nativeEvent.touches;
      if (!a || !b) return;
      setCameraZoom(cameraZoomFromPinch(
        pinch.current.zoom,
        pinch.current.distance,
        Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
      ));
    },
  }), [setCameraZoom]);
  useEffect(() => {
    if (!open) {
      setLocked(false);
      setCameraZoom(0);
    }
  }, [open, setCameraZoom]);
  const cameraGranted = permission?.granted || webCameraGranted;
  const allowCamera = useCallback(async () => {
    const result = await requestPermission();
    if (Platform.OS === 'web' && result.granted) {
      localStorage.setItem(WEB_CAMERA_PERMISSION_KEY, 'granted');
      setWebCameraGranted(true);
    }
  }, [requestPermission]);
  return (
    <Modal visible={open} animationType="slide" onRequestClose={close} presentationStyle="fullScreen">
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SafeAreaView style={styles.scannerScreen}>
        <View style={styles.scannerHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close scanner" onPress={close} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>Close</Text>
          </Pressable>
          <Text style={styles.scannerTitle}>Scan your computer</Text>
          <View style={styles.headerButton} />
        </View>
        {!permission ? <View style={styles.scannerPermission}><Text style={styles.secondaryText}>Checking camera access…</Text></View> : null}
        {permission && !cameraGranted ? (
          <View style={styles.scannerPermission}>
            <Text style={styles.permissionTitle}>Camera access is needed</Text>
            <Text style={styles.permissionCopy}>CodeAgentSwarm only uses it to read the one-time pairing QR.</Text>
            <Pressable onPress={() => void allowCamera()} style={styles.primaryButton} accessibilityRole="button">
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          </View>
        ) : null}
        {cameraGranted ? (
          <View style={[styles.cameraWrap, Platform.OS === 'web' && ({ touchAction: 'none' } as any)]} {...zoomGesture.panHandlers}>
            <CameraView
              active={open}
              autofocus="on"
              facing="back"
              zoom={zoom}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onMountError={() => {
                if (Platform.OS !== 'web') return;
                localStorage.removeItem(WEB_CAMERA_PERMISSION_KEY);
                setWebCameraGranted(false);
              }}
              onBarcodeScanned={locked ? undefined : ({ data }) => {
                if (!pairingInputFromUrl(data)) return;
                setLocked(true);
                onCode(data);
              }}
              style={StyleSheet.absoluteFill}
            />
            <View pointerEvents="none" style={styles.scanShade}>
              <View style={styles.scanFrame} />
              <Text style={styles.scanHint}>Point at the QR. It does not need to fit exactly.</Text>
            </View>
            <View style={styles.zoomControls}>
              <Pressable accessibilityRole="button" accessibilityLabel="Zoom camera out" disabled={zoom === 0} onPress={() => setCameraZoom(zoom - 0.12)} style={styles.zoomButton}>
                <Text style={styles.zoomButtonText}>−</Text>
              </Pressable>
              <Text style={styles.zoomValue}>{zoom ? `${Math.round(zoom * 10) / 10}×` : '1×'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Zoom camera in" disabled={zoom >= 0.7} onPress={() => setCameraZoom(zoom + 0.12)} style={styles.zoomButton}>
                <Text style={styles.zoomButtonText}>+</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <Text style={[styles.securityNote, { color: colors.secondary }]}>The QR expires after five minutes.</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function quotaWindowName(window: RuntimeQuotaWindow) {
  return window.key === '5h' ? '5-hour window' : window.key === 'weekly' ? 'Weekly' : window.label || window.key;
}

function quotaUsedPercent(window: RuntimeQuotaWindow) {
  return Math.round((1 - window.remainingFraction) * 100);
}

function quotaResetText(resetsAt: number | null) {
  if (!resetsAt) return '';
  const minutes = Math.max(0, Math.ceil((resetsAt - Date.now()) / 60000));
  if (!minutes) return 'Resets now';
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `Resets in ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days}d ${hours % 24}h`;
}

function quotaPrimaryWindow(snapshot: RuntimeQuotaSnapshot) {
  const account = snapshot.windows.filter((window) => !window.model);
  return (account.length ? account : snapshot.windows).reduce<RuntimeQuotaWindow | null>((tightest, window) => (
    !tightest || window.remainingFraction < tightest.remainingFraction ? window : tightest
  ), null);
}

function primaryQuota(snapshots: RuntimeQuotaSnapshot[]) {
  return snapshots.reduce<RuntimeQuotaSnapshot | null>((primary, snapshot) => {
    const window = quotaPrimaryWindow(snapshot);
    if (!window) return primary;
    const current = primary && quotaPrimaryWindow(primary);
    return !current || window.remainingFraction < current.remainingFraction ? snapshot : primary;
  }, null);
}

function QuotaRing({ snapshot, colors, styles }: {
  snapshot: RuntimeQuotaSnapshot;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
}) {
  const window = quotaPrimaryWindow(snapshot);
  const circumference = 2 * Math.PI * 15;
  const used = window ? quotaUsedPercent(window) / 100 : 0;
  return (
    <View style={styles.quotaRing}>
      <Svg width={36} height={36} viewBox="0 0 40 40" style={styles.quotaRingSvg}>
        <Circle cx={20} cy={20} r={15} fill="none" stroke={colors.subtle} strokeWidth={3} />
        <Circle
          cx={20}
          cy={20}
          r={15}
          fill="none"
          stroke={window?.severity === 'critical' ? colors.warning : colors.accent}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - Math.max(.06, used))}
          transform="rotate(-90 20 20)"
        />
      </Svg>
      <AgentIcon agent={snapshot.agent} size={14} styles={styles} />
    </View>
  );
}

function QuotaSheet({ open, close, snapshots, pinnedAgent, pinAgent, colors, styles, reduceMotion }: {
  open: boolean;
  close: () => void;
  snapshots: RuntimeQuotaSnapshot[];
  pinnedAgent: string | null;
  pinAgent: (agent: string | null) => void;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion: boolean;
}) {
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close usage"
      reduceMotion={reduceMotion}
      testID="quota-sheet"
      handleTestID="quota-sheet-handle"
      sheetStyle={[styles.configSheet, styles.quotaSheet, desktopWeb && styles.sheetDesktopDialog, desktopWeb && styles.sheetDesktopCompactDialog]}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={[styles.modalLayout, desktopWeb && styles.modalLayoutCentered]}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
      dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
    >
          <View style={styles.sheetHeader}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>Usage</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close usage" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          <Text style={styles.sheetIntro}>Pin one provider to keep it on the list, or leave it automatic.</Text>
          <ScrollView contentContainerStyle={styles.quotaSheetContent} keyboardDismissMode={KEYBOARD_DISMISS_MODE}>
            {snapshots.filter((snapshot) => snapshot.windows.length).map((snapshot) => {
              const agent = agentInfo(snapshot.agent);
              const pinned = pinnedAgent === snapshot.agent;
              return (
                <View key={`${snapshot.agent}:${snapshot.accountId}`} style={styles.quotaProvider}>
                  <View style={styles.quotaProviderHeader}>
                    <AgentIcon agent={snapshot.agent} size={22} styles={styles} />
                    <Text style={styles.quotaProviderName}>{agent.label}</Text>
                    {snapshot.accountLabel ? <Text style={styles.quotaPlan}>{snapshot.accountLabel}</Text> : null}
                    {snapshot.plan ? <Text style={styles.quotaPlan}>{snapshot.plan}</Text> : null}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ selected: pinned }}
                      accessibilityLabel={pinned ? `Unpin ${agent.label} from the list` : `Show ${agent.label} usage on the list`}
                      onPress={() => pinAgent(pinned ? null : snapshot.agent)}
                      style={[styles.quotaPin, pinned && styles.quotaPinSelected]}
                    >
                      <Text style={[styles.quotaPinText, pinned && styles.quotaPinTextSelected]}>{pinned ? 'Pinned' : 'Pin'}</Text>
                    </Pressable>
                  </View>
                  {snapshot.windows.map((window, index) => {
                    const used = quotaUsedPercent(window);
                    return (
                      <View key={`${window.key}-${window.model || ''}-${index}`} style={styles.quotaWindow}>
                        <View style={styles.quotaWindowLine}>
                          <Text style={styles.quotaWindowName}>{quotaWindowName(window)}{window.model ? ` · ${window.model}` : ''} · used</Text>
                          <Text style={styles.quotaWindowValue}>{used}%</Text>
                        </View>
                        <View style={styles.quotaTrack}><View style={[styles.quotaFill, { width: `${used}%` as `${number}%` }]} /></View>
                        {quotaResetText(window.resetsAt) ? <Text style={styles.quotaCountdown}>{quotaResetText(window.resetsAt)}</Text> : null}
                      </View>
                    );
                  })}
                  {snapshot.stale ? <Text style={styles.quotaStale}>Last known usage · waiting for the computer to refresh it</Text> : null}
                </View>
              );
            })}
          </ScrollView>
    </BottomSheet>
  );
}

function QuotaOverview({ snapshot, open, colors, styles }: {
  snapshot: RuntimeQuotaSnapshot;
  open: () => void;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
}) {
  const agent = agentInfo(snapshot.agent);
  const window = quotaPrimaryWindow(snapshot);
  if (!window) return null;
  const used = quotaUsedPercent(window);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Usage quota for ${agent.label}, ${used}% used`}
      onPress={open}
      style={({ pressed }) => [styles.quotaOverview, pressed && styles.rowPressed]}
    >
      <QuotaRing snapshot={snapshot} colors={colors} styles={styles} />
      <View style={styles.quotaOverviewCopy}>
        <Text style={styles.quotaEyebrow} numberOfLines={1}>Usage · {agent.label}{snapshot.plan ? ` ${snapshot.plan}` : ''}</Text>
        <Text style={styles.quotaOverviewTitle} numberOfLines={1}>{quotaWindowName(window)} · {used}% used</Text>
      </View>
      <View style={styles.quotaOverviewEnd}>
        {quotaResetText(window.resetsAt) ? <Text style={styles.quotaOverviewReset}>{quotaResetText(window.resetsAt)}</Text> : null}
        <UiIcon name="chevron-right" size={17} color={colors.muted} />
      </View>
    </Pressable>
  );
}

type ShortcutDraft = {
  shortcutId: string | null;
  name: string;
  hostRuntimeId: string;
  projectPath: string;
  agent: string;
  useWorktree: boolean | null;
};

function ShortcutSheet({ draft, projects, hosts, hostIcons, availableAgents, local, close, update, save, colors, styles, reduceMotion }: {
  draft: ShortcutDraft | null;
  projects: RuntimeProject[];
  hosts: RuntimeHost[];
  hostIcons: WebHostIcons;
  availableAgents: string[];
  local?: boolean;
  close: () => void;
  update: (patch: Partial<ShortcutDraft>) => void;
  save: () => void;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion: boolean;
}) {
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  const [projectSelectOpen, setProjectSelectOpen] = useState(false);
  const projectSelectRef = useRef<any>(null);
  const selectedHost = hosts.find((host) => host.runtimeId === draft?.hostRuntimeId) || hosts[0] || null;
  const hostProjects = selectedHost ? projects.filter((project) => project.hostRuntimeId === selectedHost.runtimeId) : projects;
  const hostAgents = selectedHost?.availableAgents || availableAgents;
  const selectedProject = hostProjects.find((project) => project.path === draft?.projectPath) || null;
  const projectOptions = hostProjects.map((project) => {
    const selected = project.path === draft?.projectPath;
    return <Pressable key={project.path} accessibilityRole="radio" accessibilityLabel={`Use project ${project.name}`} accessibilityState={{ checked: selected }} onPress={() => { update({ projectPath: project.path, useWorktree: null }); setProjectSelectOpen(false); if (desktopWeb) setTimeout(() => projectSelectRef.current?.focus?.(), 0); }} style={[styles.shortcutEditorOption, desktopWeb && styles.shortcutProjectMenuOption, selected && styles.shortcutEditorOptionSelected]}><ProjectIcon project={project} size={28} styles={styles} /><View style={styles.shortcutProjectCopy}><Text style={[styles.shortcutEditorOptionText, selected && styles.shortcutEditorOptionTextSelected]} numberOfLines={1}>{project.name}</Text>{desktopWeb ? <Text style={styles.shortcutProjectPath} numberOfLines={1}>{project.hostPath || project.path}</Text> : null}</View>{selected ? <Text style={styles.shortcutEditorCheck}>✓</Text> : null}</Pressable>;
  });
  const closeEditor = () => { setProjectSelectOpen(false); close(); };
  return (
    <BottomSheet
      open={Boolean(draft)}
      onClose={closeEditor}
      closeLabel="Close shortcut editor"
      reduceMotion={reduceMotion}
      testID="shortcut-editor-sheet"
      sheetStyle={[styles.configSheet, styles.shortcutEditorSheet, desktopWeb && styles.sheetDesktopDialog, desktopWeb && styles.shortcutEditorDesktopSheet]}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={[styles.modalLayout, desktopWeb && styles.settingsDesktopLayout]}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
      dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
    >
      {draft ? <>
        <View style={styles.sheetHeader}>
          <View><Text accessibilityRole="header" style={styles.sheetTitle}>{draft.shortcutId ? 'Edit shortcut' : 'New shortcut'}</Text><Text style={styles.sheetIntro}>{local ? 'Choose a project, LLM and worktree. Saved only in this browser.' : 'Start an agent in one tap.'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close shortcut editor" onPress={closeEditor} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
        </View>
        <ScrollView keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsVerticalScrollIndicator={false} contentContainerStyle={styles.shortcutEditorContent}>
          {!local ? <><Text style={styles.configLabel}>Name</Text><TextInput testID="shortcut-name-input" accessibilityLabel="Shortcut name" value={draft.name} onChangeText={(name) => update({ name })} maxLength={80} placeholder="Release" placeholderTextColor={colors.muted} style={styles.shortcutNameInput} /></> : null}
          {hosts.length > 1 ? <><Text style={styles.configLabel}>Run on</Text><View style={styles.hostPickerRow}>{hosts.map((host) => {
            const selected = host.runtimeId === selectedHost?.runtimeId;
            return <Pressable key={host.runtimeId} testID={`shortcut-host-${host.runtimeId}`} accessibilityRole="radio" accessibilityLabel={`Run shortcut on ${host.name}`} accessibilityState={{ checked: selected, disabled: host.phase !== 'online' }} disabled={host.phase !== 'online'} onPress={() => {
              const firstProject = projects.find((project) => project.hostRuntimeId === host.runtimeId);
              const agent = host.availableAgents.includes(draft.agent) ? draft.agent : host.availableAgents[0] || '';
              update({ hostRuntimeId: host.runtimeId, projectPath: firstProject?.path || '', agent, useWorktree: null });
              setProjectSelectOpen(false);
            }} style={[styles.hostPickerChoice, selected && styles.hostPickerChoiceSelected, host.phase !== 'online' && styles.disabled]}><HostIcon host={host} icons={hostIcons} size={16} color={selected ? colors.accent : colors.secondary} /><View><Text style={[styles.hostPickerName, selected && styles.hostPickerNameSelected]} numberOfLines={1}>{host.name}</Text><Text style={styles.hostPickerMeta}>{host.kind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop'}</Text></View></Pressable>;
          })}</View></> : null}
          <Text style={styles.configLabel}>Project</Text>
          {desktopWeb
            ? <><Pressable ref={projectSelectRef} testID="shortcut-project-select" accessibilityRole="button" accessibilityLabel={`Choose project. Current project: ${selectedProject?.name || 'None'}`} accessibilityState={{ expanded: projectSelectOpen }} aria-expanded={projectSelectOpen} onPress={() => setProjectSelectOpen((open) => !open)} style={[styles.shortcutProjectSelect, projectSelectOpen && styles.shortcutEditorOptionSelected]}>{selectedProject ? <ProjectIcon project={selectedProject} size={32} styles={styles} /> : null}<View style={styles.shortcutProjectCopy}><Text style={styles.shortcutProjectSelectName} numberOfLines={1}>{selectedProject?.name || 'Choose a project'}</Text>{selectedProject ? <Text style={styles.shortcutProjectPath} numberOfLines={1}>{selectedProject.hostPath || selectedProject.path}</Text> : null}</View><UiIcon name="chevron-down" size={16} color={colors.muted} /></Pressable>{projectSelectOpen ? <ScrollView testID="shortcut-project-options" style={styles.shortcutProjectMenu} keyboardDismissMode={KEYBOARD_DISMISS_MODE} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={[styles.shortcutEditorOptions, styles.shortcutProjectMenuContent]}>{projectOptions}</ScrollView> : null}</>
            : <View style={styles.shortcutEditorOptions}>{projectOptions}</View>}
          <Text style={styles.configLabel}>LLM</Text>
          <View style={styles.shortcutAgentChoices}>{AGENTS.filter((agent) => hostAgents.includes(agent.id)).map((agent) => {
            const selected = agent.id === draft.agent;
            return <Pressable key={agent.id} accessibilityRole="radio" accessibilityLabel={`Use ${agent.label}`} accessibilityState={{ checked: selected }} onPress={() => update({ agent: agent.id })} style={[styles.shortcutAgentChoice, selected && styles.shortcutAgentChoiceSelected]}><AgentIcon agent={agent.id} size={23} styles={styles} /><Text style={[styles.shortcutAgentLabel, selected && styles.shortcutEditorOptionTextSelected]} numberOfLines={1}>{agent.label}</Text></Pressable>;
          })}</View>
          {selectedProject?.worktreeEligible ? <>
            <Text style={styles.configLabel}>Worktree</Text>
            <View style={styles.shortcutWorktreeChoices}>{([['Project default', null], ['Use worktree', true], ['No worktree', false]] as const).map(([label, value]) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: draft.useWorktree === value }} onPress={() => update({ useWorktree: value })} style={[styles.shortcutWorktreeChoice, draft.useWorktree === value && styles.shortcutWorktreeChoiceSelected]}><Text style={[styles.shortcutWorktreeText, draft.useWorktree === value && styles.shortcutEditorOptionTextSelected]}>{label}</Text></Pressable>)}</View>
          </> : null}
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel="Save shortcut" disabled={(!local && !draft.name.trim()) || !selectedProject || !hostAgents.includes(draft.agent)} onPress={() => { setProjectSelectOpen(false); save(); }} style={({ pressed }) => [styles.primaryButton, ((!local && !draft.name.trim()) || !selectedProject || !hostAgents.includes(draft.agent)) && styles.disabled, pressed && styles.pressed]}><Text style={styles.primaryButtonText}>Save shortcut</Text></Pressable>
      </> : null}
    </BottomSheet>
  );
}


const WEB_COMPOSER_GAP = 16;
const WEB_CONFIG_POPOVER_WIDTH = 360;
const WEB_CONTEXT_MENU_WIDTH = 280;

function projectCardChrome(projectColor: string | undefined, surface: string) {
  if (!projectColor) return { backgroundColor: surface };
  return {
    borderLeftWidth: 3,
    borderLeftColor: hexWithAlpha(projectColor, .38),
    backgroundColor: mixHex(surface, projectColor, .05),
  };
}

function hexWithAlpha(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const normalized = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean;
  const n = Number.parseInt(normalized, 16);
  if (!Number.isFinite(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function SwipeableSessionRow({ id, title, minimized, revealed, offline, reduceMotion, colors, styles, reveal, setSwiping, minimize, restore, stop, children, compact }: {
  id: string;
  title: string;
  minimized: boolean;
  revealed: boolean;
  offline: boolean;
  reduceMotion: boolean;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reveal: (id: string | null) => void;
  setSwiping: (id: string | null) => void;
  minimize: () => void;
  restore: () => void;
  stop: () => void;
  children: ReactNode;
  compact: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const closeArmed = useRef(false);
  const latestDx = useRef(0);
  const touchStartX = useRef<number | null>(null);
  const totalDx = useCallback((event: GestureResponderEvent, fallback: number) => (
    touchStartX.current === null ? fallback : event.nativeEvent.pageX - touchStartX.current
  ), []);
  const animateTo = useCallback((value: number, done?: () => void) => {
    if (reduceMotion) {
      translateX.setValue(value);
      done?.();
      return;
    }
    Animated.spring(translateX, { toValue: value, useNativeDriver: true, speed: 25, bounciness: 3 }).start(({ finished }) => {
      if (finished) done?.();
    });
  }, [reduceMotion, translateX]);
  const dragTo = useCallback((offset: number) => {
    const clamped = Math.max(-SESSION_CLOSE_SWIPE_THRESHOLD, Math.min(0, offset));
    translateX.setValue(clamped);
    const armed = isSessionCloseArmed(clamped);
    if (armed && !closeArmed.current && Platform.OS !== 'web') void Haptics.selectionAsync();
    closeArmed.current = armed;
  }, [translateX]);
  const finishSwipe = useCallback((dx: number, allowDirectClose = true) => {
    const offset = (revealed ? -SESSION_ACTIONS_WIDTH : 0) + dx;
    closeArmed.current = false;
    if (allowDirectClose && isSessionCloseArmed(offset)) {
      stop();
      animateTo(-SESSION_CLOSE_SWIPE_THRESHOLD, () => reveal(null));
      return;
    }
    const open = shouldOpenSessionActions(dx, revealed);
    reveal(open ? id : null);
    if (open && !revealed && Platform.OS !== 'web') void Haptics.selectionAsync();
    animateTo(open ? -SESSION_ACTIONS_WIDTH : 0);
  }, [animateTo, id, reveal, revealed, stop]);
  useEffect(() => animateTo(revealed ? -SESSION_ACTIONS_WIDTH : 0), [animateTo, revealed]);
  useEffect(() => {
    if (offline && revealed) reveal(null);
  }, [offline, reveal, revealed]);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: (event) => {
      touchStartX.current = event.nativeEvent.pageX;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_, gesture) => !offline && isSessionSwipeGesture(gesture.dx, gesture.dy),
    onMoveShouldSetPanResponder: (_, gesture) => !offline && isSessionSwipeGesture(gesture.dx, gesture.dy),
    onPanResponderGrant: (event, gesture) => {
      latestDx.current = totalDx(event, gesture.dx);
      setSwiping(id);
      dragTo((revealed ? -SESSION_ACTIONS_WIDTH : 0) + latestDx.current);
    },
    onPanResponderMove: (event, gesture) => {
      latestDx.current = totalDx(event, gesture.dx);
      dragTo((revealed ? -SESSION_ACTIONS_WIDTH : 0) + latestDx.current);
    },
    onPanResponderRelease: () => {
      setSwiping(null);
      finishSwipe(latestDx.current);
      touchStartX.current = null;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      setSwiping(null);
      finishSwipe(latestDx.current, false);
      touchStartX.current = null;
    },
  }), [dragTo, finishSwipe, id, offline, revealed, setSwiping, totalDx]);
  const run = (action: () => void) => {
    reveal(null);
    action();
  };
  // Middle-click closes the session on web, like the desktop tab bar.
  const onPointerDown = Platform.OS === 'web' ? (event: { nativeEvent: { button?: number }; preventDefault: () => void }) => {
    if (event.nativeEvent.button !== 1 || offline) return;
    event.preventDefault();
    run(stop);
  } : undefined;
  const armedProgress = translateX.interpolate({ inputRange: [-SESSION_CLOSE_SWIPE_THRESHOLD, -SESSION_ACTIONS_WIDTH], outputRange: [1, 0], extrapolate: 'clamp' });
  const normalProgress = translateX.interpolate({ inputRange: [-SESSION_CLOSE_SWIPE_THRESHOLD, -SESSION_ACTIONS_WIDTH], outputRange: [0, 1], extrapolate: 'clamp' });
  const dangerShift = translateX.interpolate({ inputRange: [-SESSION_CLOSE_SWIPE_THRESHOLD, -SESSION_ACTIONS_WIDTH], outputRange: [-(SESSION_CLOSE_SWIPE_THRESHOLD - SESSION_ACTIONS_WIDTH / 2) / 2, 0], extrapolate: 'clamp' });
  const dangerScale = translateX.interpolate({ inputRange: [-SESSION_CLOSE_SWIPE_THRESHOLD, -SESSION_ACTIONS_WIDTH], outputRange: [1.16, 1], extrapolate: 'clamp' });
  return (
    <Reanimated.View
      layout={reduceMotion ? undefined : LinearTransition.delay(90).duration(160)}
      exiting={reduceMotion ? undefined : FadeOut.duration(140)}
      style={[styles.sessionSwipeContainer, compact && styles.sessionSwipeContainerCompact]}
    >
      <View accessibilityElementsHidden={!revealed} importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'} pointerEvents={revealed ? 'box-none' : 'none'} style={styles.sessionSwipeActions}>
        <View style={styles.sessionSwipeDangerBed} />
        <Animated.View testID={`session-swipe-danger-fill-${id}`} style={[styles.sessionSwipeDangerFill, { opacity: armedProgress }]} />
        <Animated.View testID={`session-swipe-primary-${id}`} style={[styles.sessionSwipePrimaryMotion, { opacity: normalProgress, transform: [{ translateX: Animated.multiply(armedProgress, -24) }, { scale: Animated.add(1, Animated.multiply(armedProgress, -0.12)) }] }]}>
          <Pressable testID={`session-${minimized ? 'restore' : 'minimize'}-${id}`} accessibilityRole={revealed ? 'button' : undefined} accessibilityLabel={revealed ? `${minimized ? 'Restore' : 'Minimize'} ${title}` : undefined} disabled={offline} onPress={() => run(minimized ? restore : minimize)} style={({ pressed }) => [styles.sessionSwipeAction, styles.sessionSwipePrimary, offline && styles.disabled, pressed && styles.rowPressed]}>
            <UiIcon name={minimized ? 'arrow-up' : 'arrow-down'} size={17} color={colors.accent} />
            <Text style={[styles.sessionSwipeActionText, { color: colors.accent }]}>{minimized ? 'Restore' : 'Minimize'}</Text>
          </Pressable>
        </Animated.View>
        <Animated.View testID={`session-swipe-danger-${id}`} style={[styles.sessionSwipeDangerMotion, { transform: [{ translateX: dangerShift }, { scale: dangerScale }] }]}>
          <Pressable testID={`session-close-${id}`} accessibilityRole={revealed ? 'button' : undefined} accessibilityLabel={revealed ? `Close ${title}` : undefined} disabled={offline} onPress={stop} style={({ pressed }) => [styles.sessionSwipeAction, offline && styles.disabled, pressed && styles.rowPressed]}>
            <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.sessionSwipeActionContent, { opacity: normalProgress }]}><UiIcon name="close-circle" size={18} color={colors.danger} /><Text style={[styles.sessionSwipeActionText, { color: colors.danger }]}>Close</Text></Animated.View>
            <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.sessionSwipeActionContent, styles.sessionSwipeArmedContent, { opacity: armedProgress }]}><View style={styles.sessionSwipeDangerRing} /><UiIcon name="close-circle" size={18} color="#ffffff" /><Text style={[styles.sessionSwipeActionText, styles.sessionSwipeArmedText]}>Close</Text></Animated.View>
          </Pressable>
        </Animated.View>
      </View>
      <Animated.View {...panResponder.panHandlers} onPointerDown={onPointerDown} style={[styles.sessionSwipeCard, { transform: [{ translateX }] }]}>
        {children}
      </Animated.View>
    </Reanimated.View>
  );
}

function SessionList({ runtime, managedShortcuts, replaceManagedShortcuts, localShortcuts, hostIcons, selectHostIcon, shortcutEditorRef, colors, dark, styles, run, open, openContextMenu, selectedSessionId, create, connectHost, reconnect, forget, stop, minimize, restore, theme, selectTheme, notificationsEnabled, selectNotificationsEnabled, cloudProviders, cloudProvidersLoading, providerLogins, loadCloudProviders, signInProvider, demoMode, reduceMotion, showConnectionNotice, tabSwipeHandlers, visibleSessionIds, searchInputRef }: {
  runtime: MobileRuntimeState;
  managedShortcuts?: RuntimeShortcut[];
  replaceManagedShortcuts?: (shortcuts: RuntimeShortcut[]) => void;
  localShortcuts?: boolean;
  hostIcons: WebHostIcons;
  selectHostIcon: (runtimeId: string, icon: WebHostIconId) => void;
  shortcutEditorRef?: MutableRefObject<((shortcut?: RuntimeShortcut) => void) | null>;
  colors: Palette;
  dark: boolean;
  styles: ReturnType<typeof createStyles>;
  run: (command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => Promise<void>;
  open: (id: string) => void;
  openContextMenu: (id: string, position: WebContextMenuPosition) => void;
  selectedSessionId: string | null;
  create: () => void;
  connectHost: () => void;
  reconnect: () => void;
  forget: (runtimeId?: string) => void;
  stop: (session: RuntimeSession) => void;
  minimize: (session: RuntimeSession) => void;
  restore: (session: RuntimeSession) => void;
  theme: MobileTheme;
  selectTheme: (theme: MobileTheme) => void;
  notificationsEnabled: boolean;
  selectNotificationsEnabled: (enabled: boolean) => void;
  cloudProviders: RuntimeProvider[];
  cloudProvidersLoading: boolean;
  providerLogins: Set<string>;
  loadCloudProviders: () => Promise<RuntimeProvider[]>;
  signInProvider: (agent: string) => Promise<void>;
  demoMode: boolean;
  reduceMotion: boolean;
  showConnectionNotice: boolean;
  tabSwipeHandlers: object;
  visibleSessionIds: MutableRefObject<string[]>;
  searchInputRef: RefObject<TextInput | null>;
}) {
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  const shortcuts = managedShortcuts ?? runtime.shortcuts;
  const [query, setQuery] = useState('');
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectAfterSettings, setConnectAfterSettings] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft | null>(null);
  const [grouping, setGrouping] = useState<'project' | 'status'>('project');
  const [density, setDensity] = useState<'roomy' | 'compact'>('roomy');
  const [pinnedQuotaAgent, setPinnedQuotaAgent] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [revealedSessionId, setRevealedSessionId] = useState<string | null>(null);
  const [statusSessionId, setStatusSessionId] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [hostFilter, setHostFilter] = useState<string>('all');
  const [hostIconPicker, setHostIconPicker] = useState<string | null>(null);
  const [swipingSessionId, setSwipingSessionId] = useState<string | null>(null);
  const sessionListScrolling = useRef(false);
  const sessionListScrollEndedAt = useRef(0);
  const [, setElapsedTick] = useState(0);
  useEffect(() => {
    let active = true;
    void loadMobileListPreferences().then((preferences) => {
      if (!active) return;
      setGrouping(preferences.grouping);
      setDensity(preferences.density);
      setPinnedQuotaAgent(preferences.pinnedQuotaAgent);
      setCollapsedGroups(new Set(preferences.collapsedGroups));
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setElapsedTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const persistListPreferences = (next: { grouping?: 'project' | 'status'; density?: 'roomy' | 'compact'; pinnedQuotaAgent?: string | null }) => {
    const preferences = {
      grouping: next.grouping || grouping,
      density: next.density || density,
      pinnedQuotaAgent: next.pinnedQuotaAgent === undefined ? pinnedQuotaAgent : next.pinnedQuotaAgent,
      collapsedGroups: [...collapsedGroups],
    };
    setGrouping(preferences.grouping);
    setDensity(preferences.density);
    setPinnedQuotaAgent(preferences.pinnedQuotaAgent);
    void saveMobileListPreferences(preferences);
  };
  const updateDisplay = (next: { grouping?: 'project' | 'status'; density?: 'roomy' | 'compact' }) => {
    persistListPreferences(next);
  };
  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void saveMobileListPreferences({ grouping, density, pinnedQuotaAgent, collapsedGroups: [...next] });
      return next;
    });
  };
  const projects = new Map(runtime.projects.map((project) => [project.path, project]));
  const hosts = runtime.hosts || [];
  const offlineHosts = hosts.filter((host) => host.phase === 'offline' || host.phase === 'error');
  const statusesForSession = (session: RuntimeSession) => (
    hosts.find((host) => host.runtimeId === session.hostRuntimeId)?.terminalStatuses || runtime.terminalStatuses
  );
  useEffect(() => {
    if (hostFilter !== 'all' && !hosts.some((host) => host.runtimeId === hostFilter)) setHostFilter('all');
  }, [hostFilter, hosts]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeSessions = runtime.sessions.filter((session) => session.state !== 'stopped' && (hostFilter === 'all' || session.hostRuntimeId === hostFilter));
  const visible = normalizedQuery ? activeSessions.filter((session) => [
    session.title,
    session.goal,
    session.activity,
    session.project?.name,
    projectName(session.cwd),
    agentInfo(session.agent).label,
    session.hostName,
    ...session.items.map(itemText),
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))) : activeSessions;
  const sorted = sortSessionsByTerminalOrder(visible);
  const minimized = sorted.filter((session) => session.minimized);
  const active = sorted.filter((session) => !session.minimized);
  const sections: Array<{ key: string; title: string; data: RuntimeSession[]; project: RuntimeProject | null; minimized?: boolean; hasAttention?: boolean }> = [];
  if (grouping === 'project') {
    const grouped = new Map<string, { key: string; title: string; data: RuntimeSession[]; project: RuntimeProject | null; hasAttention: boolean }>();
    for (const session of active) {
      const project = session.project || (session.cwd ? projects.get(session.cwd) : null) || null;
      const key = project?.path || session.cwd || '__no_project__';
      const group = grouped.get(key) || { key: `project:${key}`, title: project?.name || projectName(session.cwd), data: [], project, hasAttention: false };
      group.data.push(session);
      group.hasAttention ||= session.needsAttention;
      grouped.set(key, group);
    }
    sections.push(...grouped.values());
  } else {
    const sectionOrder = ['Needs input', 'Approval', 'Working', 'Needs testing', 'Done', 'Pushed', 'Ready', 'Error', 'Stopped'];
    const grouped = new Map<string, RuntimeSession[]>();
    for (const session of active) {
      const label = sessionStatus(session, statusesForSession(session)).label;
      grouped.set(label, [...(grouped.get(label) || []), session]);
    }
    const orderedStatuses = [
      ...sectionOrder,
      ...runtime.terminalStatuses.map((status) => status.label),
      ...grouped.keys(),
    ].filter((title, index, titles) => titles.indexOf(title) === index);
    sections.push(...orderedStatuses.flatMap((title) => {
      const data = grouped.get(title) || [];
      return data.length ? [{
        key: `status:${title}`,
        title,
        data: sortSessionsByRecentActivity(data),
        project: null,
        hasAttention: data.some((session) => session.needsAttention),
      }] : [];
    }));
  }
  if (minimized.length) sections.push({
    key: 'minimized',
    title: 'Minimized',
    data: sortSessionsByRecentActivity(minimized),
    project: null,
    minimized: true,
    hasAttention: minimized.some((session) => session.needsAttention),
  });
  const renderedSections = sections.map((section) => ({
    ...section,
    count: section.data.length,
    collapsed: collapsedGroups.has(section.key),
    data: collapsedGroups.has(section.key) ? [] : section.data,
  }));
  visibleSessionIds.current = renderedSections.flatMap((section) => section.data.map((session) => session.sessionId));
  const swipingSessionVisible = !swipingSessionId || visible.some((session) => session.sessionId === swipingSessionId);
  useEffect(() => {
    if (!swipingSessionVisible) setSwipingSessionId(null);
  }, [swipingSessionVisible]);
  const offline = runtime.phase !== 'online';
  const quota = featuredQuota(runtime.quotas, pinnedQuotaAgent, primaryQuota);
  const statusSession = runtime.sessions.find((session) => session.sessionId === statusSessionId) || null;
  const hostLabel = runtimeHostLabel(runtime);
  const orderedProviders = [...cloudProviders].sort((left, right) => (
    AGENTS.findIndex((agent) => agent.id === left.id) - AGENTS.findIndex((agent) => agent.id === right.id)
  ));
  const openProviders = () => {
    setSettingsOpen(false);
    setProvidersOpen(true);
    void loadCloudProviders();
  };
  const editShortcut = (shortcut?: RuntimeShortcut) => {
    setSettingsOpen(false);
    const shortcutProjectMatch = shortcut ? runtime.projects.find((project) => project.path === shortcut.projectPath) : null;
    const initialHost = shortcut?.hostRuntimeId
      || shortcutProjectMatch?.hostRuntimeId
      || hosts.find((host) => host.phase === 'online')?.runtimeId
      || hosts[0]?.runtimeId
      || '';
    const initialProjects = initialHost ? runtime.projects.filter((project) => project.hostRuntimeId === initialHost) : runtime.projects;
    const initialAgents = hosts.find((host) => host.runtimeId === initialHost)?.availableAgents || runtime.availableAgents;
    setShortcutDraft(shortcut ? {
      shortcutId: shortcut.shortcutId,
      name: shortcut.name,
      hostRuntimeId: initialHost,
      projectPath: shortcut.projectPath,
      agent: shortcut.agent,
      useWorktree: shortcut.useWorktree,
    } : {
      shortcutId: null,
      name: localShortcuts ? initialProjects[0]?.name || '' : '',
      hostRuntimeId: initialHost,
      projectPath: initialProjects[0]?.path || '',
      agent: initialAgents.includes('codex') ? 'codex' : initialAgents[0] || '',
      useWorktree: null,
    });
  };
  useEffect(() => {
    if (!shortcutEditorRef) return undefined;
    shortcutEditorRef.current = editShortcut;
    return () => { shortcutEditorRef.current = null; };
  }, [shortcutEditorRef, shortcuts, runtime.availableAgents, runtime.projects]);
  const replaceShortcuts = (next: RuntimeShortcut[]) => {
    if (replaceManagedShortcuts) return replaceManagedShortcuts(next);
    return run({
      type: 'shortcuts.replace',
      payload: {
        shortcuts: next.map((shortcut) => ({
          name: shortcut.name,
          projectPath: shortcut.projectPath,
          agent: shortcut.agent,
          useWorktree: shortcut.useWorktree,
        })),
      },
    });
  };
  const saveShortcut = () => {
    if (!shortcutDraft) return;
    const project = runtime.projects.find((candidate) => candidate.path === shortcutDraft.projectPath);
    if (!project || (!localShortcuts && !shortcutDraft.name.trim())) return;
    const saved: RuntimeShortcut = {
      shortcutId: shortcutDraft.shortcutId || `pending-${Date.now()}`,
      name: localShortcuts ? project.name : shortcutDraft.name.trim(),
      projectPath: project.path,
      projectName: project.name,
      color: project.color,
      icon: project.icon,
      iconDataUrl: project.iconDataUrl,
      agent: shortcutDraft.agent,
      useWorktree: shortcutDraft.useWorktree,
      hostRuntimeId: project.hostRuntimeId,
      hostName: project.hostName,
      hostKind: project.hostKind,
    };
    const next = shortcutDraft.shortcutId
      ? shortcuts.map((shortcut) => shortcut.shortcutId === shortcutDraft.shortcutId ? saved : shortcut)
      : [...shortcuts, saved];
    setShortcutDraft(null);
    void replaceShortcuts(next);
  };
  const removeShortcut = (shortcutId: string) => void replaceShortcuts(shortcuts.filter((shortcut) => shortcut.shortcutId !== shortcutId));
  return (
    <View style={styles.flex}>
      <View {...tabSwipeHandlers} style={[styles.appHeader, desktopWeb && styles.appHeaderCompact]}>
        {desktopWeb
          ? <Text style={styles.sidebarHeading}>Sessions</Text>
          : <View style={styles.wordmarkRow}><Image source={BRAND_MARK} resizeMode="contain" style={styles.miniMark} /><Text style={styles.wordmark}>Agents</Text></View>}
        <View style={styles.headerActions}>
          <Pressable ref={(node) => setWebTitle(node, 'Settings')} accessibilityRole="button" accessibilityLabel="Open Settings" onPress={() => setSettingsOpen(true)} style={({ pressed }) => [styles.settingsButton, pressed && styles.rowPressed]}>
            <UiIcon name="sliders" size={20} color={colors.secondary} />
          </Pressable>
          {desktopWeb ? null : (
            <Pressable
              testID="new-agent-button"
              ref={(node) => setWebTitle(node, 'New agent (⌥N)')}
              accessibilityRole="button"
              accessibilityLabel="Create a new session"
              onPress={create}
              style={({ pressed }) => [styles.plusButton, pressed && styles.pressed]}
            >
              {Platform.OS === 'web' ? <UiIcon name="plus" size={24} color={colors.accentText} /> : <Text style={styles.plusText}>+</Text>}
            </Pressable>
          )}
        </View>
      </View>
      {hosts.length > 1 ? <ScrollView horizontal keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsHorizontalScrollIndicator={false} style={styles.hostFilterScroll} contentContainerStyle={styles.hostFilterRow}>
        <Pressable testID="host-filter-all" accessibilityRole="radio" accessibilityLabel={`All hosts, ${runtime.sessions.filter((session) => session.state !== 'stopped').length} sessions`} accessibilityState={{ checked: hostFilter === 'all' }} onPress={() => setHostFilter('all')} style={[styles.hostFilterChip, hostFilter === 'all' && styles.hostFilterChipSelected]}>
          <View testID="host-filter-icon-frame-all" style={[styles.hostFilterIconFrame, hostFilter === 'all' && styles.hostFilterIconFrameSelected]}><UiIcon name="list" size={13} color={hosts.some((host) => host.phase === 'online') ? colors.success : colors.muted} /></View>
          <Text style={[styles.hostFilterText, hostFilter === 'all' && styles.hostFilterTextSelected]}>All</Text>
          <View testID="host-filter-count-all" style={[styles.hostFilterCount, hostFilter === 'all' && styles.hostFilterCountSelected]}><Text style={[styles.hostFilterCountText, hostFilter === 'all' && styles.hostFilterCountTextSelected]}>{runtime.sessions.filter((session) => session.state !== 'stopped').length}</Text></View>
          {hostFilter === 'all' ? <View testID="host-filter-indicator-all" style={styles.hostFilterIndicator} /> : null}
        </Pressable>
        {hosts.map((host) => {
          const selected = hostFilter === host.runtimeId;
          return <Pressable key={host.runtimeId} testID={`host-filter-${host.runtimeId}`} accessibilityRole="radio" accessibilityLabel={`${host.name}, ${host.sessionCount} sessions`} accessibilityState={{ checked: selected }} onPress={() => setHostFilter(host.runtimeId)} style={[styles.hostFilterChip, selected && styles.hostFilterChipSelected]}>
            <View testID={`host-filter-icon-frame-${host.runtimeId}`} style={[styles.hostFilterIconFrame, selected && styles.hostFilterIconFrameSelected]}><HostIcon host={host} icons={hostIcons} size={13} color={host.phase === 'online' ? colors.success : colors.muted} testID={`host-filter-icon-${host.runtimeId}`} style={styles.hostFilterIcon} /></View>
            <Text style={[styles.hostFilterText, selected && styles.hostFilterTextSelected]} numberOfLines={1}>{host.name}</Text>
            <View testID={`host-filter-count-${host.runtimeId}`} style={[styles.hostFilterCount, selected && styles.hostFilterCountSelected]}><Text style={[styles.hostFilterCountText, selected && styles.hostFilterCountTextSelected]}>{host.sessionCount}</Text></View>
            {selected ? <View testID={`host-filter-indicator-${host.runtimeId}`} style={styles.hostFilterIndicator} /> : null}
          </Pressable>;
        })}
      </ScrollView> : null}
      {hosts.length > 1 && offlineHosts.length ? <View style={styles.connectionBanner}><Text style={styles.connectionBannerText}>{offlineHosts.map((host) => host.name).join(', ')} offline · other hosts stay available</Text><Pressable accessibilityRole="button" onPress={reconnect} hitSlop={8}><Text style={styles.bannerAction}>Retry</Text></Pressable></View> : showConnectionNotice ? (
        <View style={styles.connectionBanner}>
          <Text style={styles.connectionBannerText}>
            {runtime.phase === 'error' ? runtime.error || 'Connection failed' : 'Showing the last synced state'}
          </Text>
          <Pressable accessibilityRole="button" onPress={reconnect} hitSlop={8}><Text style={styles.bannerAction}>Retry</Text></Pressable>
        </View>
      ) : null}
      <View style={[styles.searchWrap, searchFocused && styles.searchWrapFocused]}>
        <SearchCue active={searchFocused || Boolean(query)} colors={colors} dark={dark} reduceMotion={reduceMotion} testID="session-search-orb" styles={styles} />
        <TextInput
          ref={searchInputRef}
          accessibilityLabel="Search open sessions"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onBlur={() => setSearchFocused(false)}
          onChangeText={setQuery}
          onFocus={() => setSearchFocused(true)}
          placeholder="Search sessions"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          underlineColorAndroid="transparent"
          style={[styles.searchInput, Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as object) : null]}
          value={query}
        />
      </View>
      {quota ? <QuotaOverview snapshot={quota} open={() => setQuotaOpen(true)} colors={colors} styles={styles} /> : null}
      {sections.length ? (
        <SectionList
          disableScrollViewPanResponder
          scrollEnabled={!swipingSessionId}
          keyboardDismissMode={Platform.OS === 'web' ? 'none' : KEYBOARD_DISMISS_MODE}
          onScrollBeginDrag={() => { sessionListScrolling.current = true; }}
          onScrollEndDrag={() => { sessionListScrolling.current = false; sessionListScrollEndedAt.current = Date.now(); }}
          onMomentumScrollBegin={() => { sessionListScrolling.current = true; }}
          onMomentumScrollEnd={() => { sessionListScrolling.current = false; sessionListScrollEndedAt.current = Date.now(); }}
          sections={renderedSections}
          keyExtractor={(session) => session.sessionId}
          contentContainerStyle={[styles.sessionList, density === 'compact' && styles.sessionListCompact]}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => <Pressable testID={`session-group-${section.key}`} accessibilityRole="button" accessibilityState={{ expanded: !section.collapsed }} {...(Platform.OS === 'web' ? ({ 'aria-expanded': !section.collapsed } as object) : {})} accessibilityLabel={`${section.collapsed ? 'Expand' : 'Collapse'} ${section.title} group, ${section.count}${section.hasAttention ? ', new notification' : ''}`} accessibilityHint="Shows or hides sessions in this group" hitSlop={4} onPress={() => toggleGroup(section.key)} style={({ pressed }) => [styles.sectionHeading, density === 'compact' && styles.sectionHeadingCompact, pressed && styles.sectionHeadingPressed]}>{section.project ? <ProjectIcon project={section.project} size={18} styles={styles} /> : null}{section.minimized ? <Text style={styles.minimizedSectionIcon}>☾</Text> : null}<Text style={[styles.sectionTitle, section.minimized && styles.minimizedSectionTitle]}>{section.title}  {section.count}</Text>{section.hasAttention ? <View style={styles.sectionNotificationDot} /> : null}<View style={styles.sectionLine} /><View style={styles.sectionChevron}><UiIcon name={section.collapsed ? 'chevron-right' : 'chevron-down'} size={15} color={colors.muted} /></View></Pressable>}
          renderItem={({ item }) => {
            const agent = agentInfo(item.agent);
            const terminalStatuses = statusesForSession(item);
            const status = sessionStatus(item, terminalStatuses);
            const project = item.project || (item.cwd ? projects.get(item.cwd) : null) || null;
            const host = hosts.find((candidate) => candidate.runtimeId === item.hostRuntimeId) || null;
            const rowOffline = item.hostPhase ? item.hostPhase !== 'online' : offline;
            return (
              <SwipeableSessionRow
                id={item.sessionId}
                title={sessionTitle(item)}
                minimized={Boolean(item.minimized)}
                revealed={revealedSessionId === item.sessionId}
                offline={rowOffline}
                reduceMotion={reduceMotion}
                colors={colors}
                styles={styles}
                reveal={setRevealedSessionId}
                setSwiping={setSwipingSessionId}
                minimize={() => minimize(item)}
                restore={() => restore(item)}
                stop={() => stop(item)}
                compact={density === 'compact'}
              >
                <View
                  testID={`session-card-${item.sessionId}`}
                  style={[
                    styles.sessionRow,
                    density === 'compact' && styles.sessionRowCompact,
                    styles.sessionSwipeRow,
                    projectCardChrome(project?.color, colors.surface),
                    item.needsAttention && styles.sessionNotificationRow,
                    selectedSessionId === item.sessionId && styles.sessionSelectedRow,
                  ]}
                >
                  <Pressable
                    testID={`session-status-button-${item.sessionId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Change agent status for ${sessionTitle(item)}. Current status: ${status.label}`}
                    accessibilityHint="Shows agent statuses"
                    accessibilityState={{ disabled: rowOffline || item.state === 'starting' || !terminalStatuses.length }}
                    disabled={rowOffline || item.state === 'starting' || !terminalStatuses.length}
                    hitSlop={{ top: 14, right: 20, bottom: 14, left: 21 }}
                    onPress={() => { setStatusSessionId(item.sessionId); setStatusOpen(true); }}
                    style={styles.sessionStatusButton}
                  >
                    <BarberPoleRail testID={`session-status-rail-${item.sessionId}`} color={item.minimized ? colors.accent : status.color} working={!item.minimized && status.key === 'working'} style={[styles.sessionStatusRail, density === 'compact' && styles.sessionStatusRailCompact]} />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${agent.label}, ${sessionTitle(item)}, ${status.label}`} accessibilityHint="Opens the conversation" accessibilityState={{ selected: selectedSessionId === item.sessionId }} {...(Platform.OS === 'web' ? ({
                    'aria-selected': selectedSessionId === item.sessionId,
                    onContextMenu: (event: any) => {
                      if (!desktopWeb) return;
                      event.preventDefault?.();
                      const nativeEvent = event.nativeEvent || event;
                      nativeEvent.preventDefault?.();
                      openContextMenu(item.sessionId, {
                        left: Number(nativeEvent.clientX ?? nativeEvent.pageX) || 0,
                        top: Number(nativeEvent.clientY ?? nativeEvent.pageY) || 0,
                      });
                    },
                  } as object) : {})} onPress={() => {
                    if (shouldOpenSessionAfterScroll(sessionListScrolling.current, sessionListScrollEndedAt.current)) open(item.sessionId);
                  }} style={({ pressed }) => [styles.sessionRowMain, pressed && styles.sessionRowMainPressed]}>
                    <View style={[styles.sessionIcons, density === 'compact' && styles.sessionIconsCompact]}><ProjectIcon project={project} size={density === 'compact' ? 34 : 42} styles={styles} /><View style={[styles.sessionAgentIcon, density === 'compact' && styles.sessionAgentIconCompact]}><AgentIcon agent={item.agent} size={density === 'compact' ? 18 : 22} styles={styles} /></View></View>
                    <View style={[styles.sessionCopy, density === 'compact' && styles.sessionCopyCompact]}><Text style={[styles.sessionTitle, density === 'compact' && styles.sessionTitleCompact]} numberOfLines={1}>{sessionTitle(item)}</Text>{density === 'roomy' && item.goal ? <Text style={styles.sessionGoal} numberOfLines={1}>◎  {item.goal}</Text> : null}{item.activity ? <Text style={[styles.sessionActivity, density === 'compact' && styles.sessionActivityCompact]} numberOfLines={1}>{item.minimized ? '☾  ' : density === 'compact' ? '•  ' : '⌁  '}{item.activity}</Text> : null}{!item.goal && !item.activity ? <Text style={[styles.sessionMeta, density === 'compact' && styles.sessionMetaCompact]} numberOfLines={1}>{agent.label} · {project?.name || projectName(item.cwd)}</Text> : null}</View>
                  </Pressable>
                  <View testID={`session-host-corner-${item.sessionId}`} pointerEvents="none" style={[styles.sessionHostCorner, density === 'compact' && styles.sessionHostCornerCompact]}>{item.lastActivityAt ? <Text style={styles.sessionElapsed}>{relativeTime(item.lastActivityAt)}</Text> : null}{host ? <HostIcon host={host} icons={hostIcons} size={density === 'compact' ? 9 : 12} color={host.phase === 'online' ? colors.success : colors.muted} testID={`session-host-${item.sessionId}`} style={[styles.sessionHostIcon, density === 'compact' && styles.sessionHostIconCompact]} /> : null}</View>
                  <Pressable testID={`session-actions-${item.sessionId}`} accessibilityRole="button" accessibilityLabel={`Actions for ${sessionTitle(item)}`} accessibilityHint="Shows minimize or restore and close actions" accessibilityState={{ disabled: rowOffline, expanded: revealedSessionId === item.sessionId }} disabled={rowOffline} hitSlop={6} onPress={() => setRevealedSessionId((current) => current === item.sessionId ? null : item.sessionId)} style={({ pressed }) => [styles.sessionActionsButton, density === 'compact' && styles.sessionActionsButtonCompact, rowOffline && styles.disabled, pressed && styles.rowPressed]}><Text style={styles.sessionActionsText}>•••</Text></Pressable>
                </View>
              </SwipeableSessionRow>
            );
          }}
        />
      ) : (
        <MotionRise reduceMotion={reduceMotion} replayKey={normalizedQuery || 'empty'} distance={14} duration={420} style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{normalizedQuery ? 'No sessions found' : 'No active sessions'}</Text>
          <Text style={styles.emptyCopy}>{normalizedQuery ? 'Try another title, project or agent.' : 'Create one here or open Chat on your computer. It will appear instantly.'}</Text>
          {!normalizedQuery ? <Pressable accessibilityRole="button" onPress={create} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
            <Text style={styles.primaryButtonText}>New session</Text>
          </Pressable> : null}
        </MotionRise>
      )}
      {statusSession ? <TerminalStatusSheet open={statusOpen} close={() => setStatusOpen(false)} session={statusSession} terminalStatuses={statusesForSession(statusSession)} interactive={(statusSession.hostPhase ? statusSession.hostPhase === 'online' : !offline) && statusSession.state !== 'starting'} run={run} colors={colors} styles={styles} reduceMotion={reduceMotion} /> : null}
      <QuotaSheet
        open={quotaOpen}
        close={() => setQuotaOpen(false)}
        snapshots={runtime.quotas}
        pinnedAgent={pinnedQuotaAgent}
        pinAgent={(agent) => persistListPreferences({ pinnedQuotaAgent: agent })}
        colors={colors}
        styles={styles}
        reduceMotion={reduceMotion}
      />
      <ShortcutSheet
        draft={shortcutDraft}
        projects={runtime.projects}
        hosts={hosts}
        hostIcons={hostIcons}
        availableAgents={runtime.availableAgents}
        local={localShortcuts}
        close={() => setShortcutDraft(null)}
        update={(patch) => setShortcutDraft((current) => current ? { ...current, ...patch } : current)}
        save={saveShortcut}
        colors={colors}
        styles={styles}
        reduceMotion={reduceMotion}
      />
      <BottomSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDismiss={() => {
          if (!connectAfterSettings) return;
          setConnectAfterSettings(false);
          connectHost();
        }}
        closeLabel="Close Settings"
        reduceMotion={reduceMotion}
        testID="mobile-settings-sheet"
        sheetStyle={[styles.configSheet, styles.settingsSheet, desktopWeb && styles.settingsDesktopSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={[styles.modalLayout, desktopWeb && styles.settingsDesktopLayout]}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
            <View style={styles.sheetHeader}>
              <View style={styles.settingsHeaderCopy}><Text accessibilityRole="header" style={styles.settingsTitle}>Settings</Text><Text style={styles.settingsSubtitle}>{Platform.OS === 'web' ? 'How Agents looks and behaves in this browser.' : 'How Agents looks and behaves on this phone.'}</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close Settings" onPress={() => setSettingsOpen(false)} style={styles.settingsCloseButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <ScrollView keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsVerticalScrollIndicator={false} style={styles.settingsScroll} contentContainerStyle={styles.settingsContent}>
            <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>Sessions</Text><Text style={styles.settingsSectionMeta}>List preferences</Text></View>
            <View style={styles.settingsGroup}>
            <View style={styles.settingsBlock}>
              <Text style={styles.settingsOptionTitle}>Separate the list by</Text>
              <Text style={styles.settingsOptionHelp}>Choose the headings used between sessions</Text>
              <View style={styles.displayChoices}>
                {(['project', 'status'] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: grouping === value }} aria-checked={grouping === value} onPress={() => updateDisplay({ grouping: value })} style={[styles.displayChoice, grouping === value && styles.displayChoiceSelected]}><Text style={[styles.displayChoiceText, grouping === value && styles.displayChoiceTextActive]}>{value === 'project' ? 'Project' : 'Status'}</Text><Text style={[styles.displayChoiceMeta, grouping === value && styles.displayChoiceMetaSelected]}>{value === 'project' ? 'CodeAgentSwarm, My app…' : 'Working, waiting, done…'}</Text></Pressable>)}
              </View>
            </View>
            <View style={[styles.settingsBlock, styles.settingsBlockDivider]}>
              <Text style={styles.settingsOptionTitle}>Session rows</Text>
              <Text style={styles.settingsOptionHelp}>Preview how every session will appear</Text>
              <View style={styles.densityChoices}>
                {(['roomy', 'compact'] as const).map((value) => {
                  const selected = density === value;
                  return <Pressable key={value} accessibilityRole="radio" accessibilityLabel={value === 'roomy' ? 'Show details' : 'Fit more sessions'} accessibilityState={{ checked: selected }} aria-checked={selected} onPress={() => updateDisplay({ density: value })} style={[styles.densityChoice, selected && styles.densityChoiceSelected]}>
                    <View style={[styles.densityPreview, value === 'compact' && styles.densityPreviewCompact]}><View style={[styles.densityPreviewAvatar, value === 'compact' && styles.densityPreviewAvatarCompact]} /><View style={styles.densityPreviewLines}><View style={styles.densityPreviewLine} /><View style={[styles.densityPreviewLine, styles.densityPreviewLineShort, value === 'compact' && styles.densityPreviewLineHidden]} /></View></View>
                    <Text style={[styles.densityChoiceTitle, selected && styles.displayChoiceTextSelected]}>{value === 'roomy' ? 'Show details' : 'Fit more sessions'}</Text>
                    <Text style={styles.densityChoiceMeta}>{value === 'roomy' ? 'Title, goal and current activity' : 'Shorter rows with title and activity'}</Text>
                  </Pressable>;
                })}
              </View>
            </View>
            </View>
            <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>Notifications</Text><Text style={styles.settingsSectionMeta}>{notificationsEnabled ? 'On' : 'Muted'}</Text></View>
            <View style={styles.settingsGroup}>
              <View style={styles.settingsNotificationRow}>
                <View style={styles.settingsNotificationCopy}><Text style={styles.settingsOptionTitle}>{Platform.OS === 'web' ? 'Desktop notifications' : 'Mobile notifications'}</Text><Text style={styles.settingsNotificationHelp}>{notificationsEnabled ? 'Alerts appear when a session needs your attention' : 'No alerts until you turn them back on'}</Text></View>
                <Pressable testID="mobile-notifications-switch" accessibilityRole="switch" accessibilityLabel={Platform.OS === 'web' ? 'Desktop notifications' : 'Mobile notifications'} accessibilityState={{ checked: notificationsEnabled }} aria-checked={notificationsEnabled} onPress={() => selectNotificationsEnabled(!notificationsEnabled)} style={[styles.settingsNotificationSwitch, notificationsEnabled && styles.settingsNotificationSwitchEnabled]}>
                  <View style={[styles.settingsNotificationKnob, notificationsEnabled && styles.settingsNotificationKnobEnabled]} />
                </Pressable>
              </View>
            </View>
            <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>Appearance</Text><Text style={styles.settingsSectionMeta}>Applies instantly</Text></View>
            <View style={[styles.settingsGroup, styles.themeChoices]}>
              {MOBILE_THEMES.map((option) => {
                const selected = theme === option.id;
                return <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} aria-checked={selected} onPress={() => selectTheme(option.id)} style={[styles.themeChoice, selected && styles.themeChoiceSelected]}>
                  <View style={[styles.themePreview, { backgroundColor: option.preview.background, borderColor: option.preview.border }]}><View style={[styles.themePreviewSurface, { backgroundColor: option.preview.surface }]} /><View style={[styles.themePreviewAccent, { backgroundColor: option.preview.accent }]} /></View>
                  <Text style={[styles.displayChoiceText, selected && styles.displayChoiceTextSelected]}>{option.label}</Text>
                  {selected ? <Text style={[styles.themeCheck, { color: colors.accent }]}>✓</Text> : null}
                </Pressable>;
              })}
            </View>
            <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>{demoMode ? 'Computer' : hosts.length > 1 ? 'Connected hosts' : hostLabel}</Text><Text style={styles.settingsSectionMeta}>{!demoMode && hosts.length > 1 ? `${hosts.length} active` : ''}</Text></View>
            <View style={styles.settingsGroup}>
              {demoMode ? <View style={styles.settingsComputerRow}><View style={styles.settingsComputerIcon}><UiIcon name="monitor" size={17} color={colors.accent} /></View><View style={styles.connectionCardCopy}><Text style={styles.connectionCardTitle}>Review demo</Text><Text style={styles.connectionCardMeta}>Sample data · no host connected</Text></View></View> : hosts.length ? hosts.map((host, index) => <View key={host.runtimeId} style={index > 0 && styles.shortcutRowDivider}>
                <View testID={`connected-host-${host.runtimeId}`} style={styles.connectedHostRow}>
                  <HostIcon host={host} icons={hostIcons} size={18} color={host.phase === 'online' ? colors.success : colors.muted} testID={`connected-host-icon-${host.runtimeId}`} style={styles.settingsComputerIcon} />
                  <View style={styles.connectionCardCopy}><Text style={styles.connectionCardTitle}>{host.name}</Text><Text style={styles.connectionCardMeta}>{host.kind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop'} · {host.phase === 'online' ? 'Online' : 'Offline'} · {host.sessionCount} sessions</Text></View>
                  <View style={styles.connectedHostActions}><Pressable accessibilityRole="button" accessibilityLabel={`Change icon for ${host.name}`} accessibilityState={{ expanded: hostIconPicker === host.runtimeId }} onPress={() => setHostIconPicker((current) => current === host.runtimeId ? null : host.runtimeId)} style={styles.hostIconChange}><Text style={styles.hostIconChangeText}>Change icon</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Forget ${host.name}`} onPress={() => forget(host.runtimeId)} style={styles.projectShortcutRemove}><Text style={styles.projectShortcutRemoveText}>Forget</Text></Pressable></View>
                </View>
                {hostIconPicker === host.runtimeId ? <View testID={`host-icon-picker-${host.runtimeId}`} style={styles.hostIconPicker}>
                  <View style={styles.hostIconPickerHeader}><Text style={styles.hostIconPickerTitle}>Choose host icon</Text><Text style={styles.hostIconPickerCount}>{WEB_HOST_ICON_IDS.length} options</Text></View>
                  <View style={styles.hostIconChoices}>{WEB_HOST_ICON_IDS.map((icon) => {
                    const selected = webHostIcon(host, hostIcons) === icon;
                    return <Pressable key={icon} testID={`host-icon-choice-${icon}`} accessibilityRole="radio" accessibilityLabel={`Use ${HOST_ICON_LABELS[icon]} icon for ${host.name}`} accessibilityState={{ checked: selected }} onPress={() => { selectHostIcon(host.runtimeId, icon); setHostIconPicker(null); }} style={[styles.hostIconChoice, desktopWeb && styles.hostIconChoiceDesktop, selected && styles.hostIconChoiceSelected]}>{selected ? <View style={styles.hostIconChoiceDot} /> : null}<HostGlyph icon={icon} size={22} color={selected ? colors.accent : colors.secondary} /><Text style={[styles.hostIconChoiceText, selected && styles.hostIconChoiceTextSelected]}>{HOST_ICON_LABELS[icon]}</Text></Pressable>;
                  })}</View>
                </View> : null}
              </View>) : <View style={styles.settingsComputerRow}><View style={styles.settingsComputerIcon}><UiIcon name={runtime.hostKind === 'cloud' ? 'server' : 'monitor'} size={17} color={colors.accent} /></View><View style={styles.connectionCardCopy}><Text style={styles.connectionCardTitle}>{runtime.computerName || hostLabel}</Text><Text style={styles.connectionCardMeta}>{hostLabel}</Text></View></View>}
              {!demoMode && (runtime.hostKind === 'cloud' || hosts.some((host) => host.kind === 'cloud')) && runtime.capabilities.includes('providers.list') ? <Pressable accessibilityRole="button" accessibilityLabel="Agent accounts" onPress={openProviders} style={styles.settingsActionRow}><Text style={styles.settingsActionTitle}>Agent accounts</Text><Text style={styles.settingsDangerMeta}>{cloudProviders.filter((provider) => provider.installed).length || 7} installed  ›</Text></Pressable> : null}
              {!demoMode && !hosts.length ? <Pressable accessibilityRole="button" accessibilityLabel="Forget this host" onPress={() => forget()} style={styles.settingsDangerRow}><Text style={styles.dangerRowTitle}>Forget this host</Text><Text style={styles.settingsDangerMeta}>Pair again later  ›</Text></Pressable> : null}
              <Pressable testID="connect-another-host" accessibilityRole="button" accessibilityLabel={demoMode ? 'Connect a host' : 'Connect another host'} onPress={() => {
                if (demoMode) { setSettingsOpen(false); forget(); }
                else if (Platform.OS === 'web') connectHost();
                else { setConnectAfterSettings(true); setSettingsOpen(false); }
              }} style={styles.settingsActionRow}><Text style={styles.settingsActionTitle}>{demoMode ? 'Connect a host' : 'Connect another host'}</Text><Text style={styles.settingsDangerMeta}>＋</Text></Pressable>
            </View>
            {(localShortcuts || runtime.capabilities.includes('shortcuts.manage')) ? <>
              <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>{localShortcuts ? 'Web shortcuts' : 'Project shortcuts'}</Text><Text style={styles.settingsSectionMeta}>{shortcuts.length}/10{localShortcuts ? ' · This browser' : ''}</Text></View>
              <View testID="project-shortcuts-settings" style={styles.settingsGroup}>
                {localShortcuts ? <View style={styles.settingsBlock}><Text style={styles.settingsOptionHelp}>These shortcuts stay in this browser. Desktop shortcuts are unchanged.</Text></View> : null}
                {shortcuts.map((shortcut, index) => <View key={shortcut.shortcutId} testID="project-shortcut-row" style={[styles.projectShortcutRow, (index > 0 || localShortcuts) && styles.shortcutRowDivider]}><Pressable accessibilityRole="button" accessibilityLabel={`Edit shortcut ${shortcut.name}${shortcut.hostName ? ` on ${shortcut.hostName}` : ''}`} onPress={() => editShortcut(shortcut)} style={styles.projectShortcutMain}><ProjectIcon project={shortcutProject(shortcut)} size={30} styles={styles} /><View style={styles.projectShortcutCopy}><Text style={styles.settingsOptionTitle} numberOfLines={1}>{shortcut.projectName}</Text><Text style={styles.settingsOptionHelp} numberOfLines={1}>{agentInfo(shortcut.agent).label}{shortcut.hostName ? ` · ${shortcut.hostName}` : ''}{shortcut.useWorktree === true ? ' · Worktree' : shortcut.useWorktree === false ? ' · No worktree' : ' · Project default'}</Text></View></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Remove shortcut ${shortcut.name}`} hitSlop={6} onPress={() => removeShortcut(shortcut.shortcutId)} style={styles.projectShortcutRemove}><Text style={styles.projectShortcutRemoveText}>Remove</Text></Pressable></View>)}
                <Pressable accessibilityRole="button" accessibilityLabel="Add project shortcut" disabled={shortcuts.length >= 10 || !runtime.projects.length || !runtime.availableAgents.length} onPress={() => editShortcut()} style={[styles.settingsActionRow, (shortcuts.length >= 10 || !runtime.projects.length || !runtime.availableAgents.length) && styles.disabled]}><Text style={styles.settingsActionTitle}>Add shortcut</Text><Text style={styles.settingsDangerMeta}>＋</Text></Pressable>
              </View>
            </> : null}
            {desktopWeb ? (
              <>
                <View style={styles.settingsSectionHeading}><Text style={styles.settingsSectionTitle}>Keyboard shortcuts</Text><Text style={styles.settingsSectionMeta}>Web</Text></View>
                <View testID="settings-shortcuts" style={styles.settingsGroup}>
                  {WEB_SHORTCUTS.map((shortcut, index) => (
                    <View key={shortcut.keys} testID={`settings-shortcut-row-${index}`} style={[styles.shortcutRow, index > 0 && styles.shortcutRowDivider]}>
                      <Text style={styles.settingsOptionTitle}>{shortcut.label}</Text>
                      <Text style={styles.shortcutKeys}>{shortcut.keys}</Text>
                    </View>
                  ))}
                </View>
              </>
            ) : null}
            </ScrollView>
      </BottomSheet>
      <BottomSheet
        open={providersOpen}
        onClose={() => setProvidersOpen(false)}
        closeLabel="Close CAS Cloud agent accounts"
        reduceMotion={reduceMotion}
        testID="cloud-provider-sheet"
        sheetStyle={[styles.configSheet, styles.settingsSheet, desktopWeb && styles.settingsDesktopSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={[styles.modalLayout, desktopWeb && styles.settingsDesktopLayout]}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
        <View style={styles.sheetHeader}><View><Text accessibilityRole="header" style={styles.sheetTitle}>Agents on CAS Cloud</Text><Text style={styles.sheetIntro}>{runtime.computerName || 'CAS Cloud'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close agent accounts" onPress={() => setProvidersOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
        <ScrollView keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsVerticalScrollIndicator={false} contentContainerStyle={styles.cloudProviderList}>
          {cloudProvidersLoading && !orderedProviders.length ? <ActivityIndicator color={colors.accent} /> : orderedProviders.map((provider) => {
            const signedIn = provider.login.status.known && provider.login.status.loggedIn === true;
            const signingIn = providerLogins.has(provider.id);
            const canSignIn = provider.installed && provider.login.mode === 'cli' && !signedIn;
            const status = !provider.installed ? 'Unavailable' : signedIn ? 'Signed in' : provider.login.mode === 'cli' ? 'Sign in required' : 'Installed';
            return <View key={provider.id} style={styles.cloudProviderRow}><View style={styles.cloudProviderIcon}><AgentIcon agent={provider.id} size={22} styles={styles} /></View><View style={styles.cloudProviderCopy}><Text style={styles.cloudProviderName}>{provider.name}</Text>{provider.id === 'pi' && provider.installed && !signedIn ? <Text style={styles.fieldHelp}>{PI_LOGIN_HELP}</Text> : null}<Text style={styles.cloudProviderStatus}>{status}{provider.version ? ` · ${provider.version}` : ''}</Text></View>{signedIn ? <Text style={styles.cloudProviderReady}>✓ Ready</Text> : canSignIn ? <Pressable accessibilityRole="button" accessibilityLabel={`Sign in to ${provider.name}`} disabled={signingIn} onPress={() => void signInProvider(provider.id)} style={[styles.cloudProviderButton, signingIn && styles.disabled]}>{signingIn ? <ActivityIndicator size="small" color={colors.accentText} /> : <Text style={styles.cloudProviderButtonText}>Sign in</Text>}</Pressable> : null}</View>;
          })}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function dateGroupLabel(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Older';
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(date);
  startOfThatDay.setHours(0, 0, 0, 0);
  const days = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Older';
}

function BottomNav({ active, screenWidth, colors, showSessions, showProjects, showKanban, showHistory, styles, placement = 'bottom' }: {
  active: MobileTab;
  screenWidth: number;
  colors: Palette;
  showSessions: () => void;
  showProjects: () => void;
  showKanban: () => void;
  showHistory: () => void;
  styles: ReturnType<typeof createStyles>;
  placement?: 'top' | 'bottom';
}) {
  const top = placement === 'top';
  const tabs: MobileTab[] = ['sessions', 'projects', 'kanban', 'history'];
  const indicatorWidth = Math.max(0, (screenWidth - 36) / tabs.length);
  const indicatorX = tabs.indexOf(active) * indicatorWidth;
  const selectedTab = (selected: boolean) => (Platform.OS === 'web' ? ({ 'aria-selected': selected } as object) : {});
  return (
    <View testID="primary-bottom-nav" style={[styles.bottomNav, top && styles.topNav]} accessibilityRole="tablist">
      <Animated.View testID="primary-bottom-nav-indicator" style={[styles.bottomNavIndicator, top && styles.topNavIndicator, { width: indicatorWidth, transform: [{ translateX: indicatorX }] }]} />
      <Pressable testID="sessions-tab" accessibilityRole="tab" accessibilityState={{ selected: active === 'sessions' }} {...selectedTab(active === 'sessions')} onPress={showSessions} style={[styles.bottomNavItem, top && styles.topNavItem]}>
        <UiIcon name="list" size={20} color={active === 'sessions' ? colors.text : colors.muted} />
        <Text style={[styles.bottomNavLabel, active === 'sessions' && styles.bottomNavActive]}>Sessions</Text>
      </Pressable>
      <Pressable testID="projects-tab" accessibilityRole="tab" accessibilityState={{ selected: active === 'projects' }} {...selectedTab(active === 'projects')} onPress={showProjects} style={[styles.bottomNavItem, top && styles.topNavItem]}>
        <UiIcon name="panels" size={20} color={active === 'projects' ? colors.text : colors.muted} />
        <Text style={[styles.bottomNavLabel, active === 'projects' && styles.bottomNavActive]}>Projects</Text>
      </Pressable>
      <Pressable testID="kanban-tab" accessibilityRole="tab" accessibilityState={{ selected: active === 'kanban' }} {...selectedTab(active === 'kanban')} onPress={showKanban} style={[styles.bottomNavItem, top && styles.topNavItem]}>
        <UiIcon name="check-circle" size={20} color={active === 'kanban' ? colors.text : colors.muted} />
        <Text style={[styles.bottomNavLabel, active === 'kanban' && styles.bottomNavActive]}>Kanban</Text>
      </Pressable>
      <Pressable testID="history-tab" accessibilityRole="tab" accessibilityState={{ selected: active === 'history' }} {...selectedTab(active === 'history')} onPress={showHistory} style={[styles.bottomNavItem, top && styles.topNavItem]}>
        <UiIcon name="clock" size={20} color={active === 'history' ? colors.text : colors.muted} />
        <Text style={[styles.bottomNavLabel, active === 'history' && styles.bottomNavActive]}>History</Text>
      </Pressable>
    </View>
  );
}

function HistoryList({ conversations, desktopWeb, loading, openingId, online, ready, projects, colors, dark, styles, open, refresh, reduceMotion, showConnectionNotice, tabSwipeHandlers }: {
  conversations: RuntimeHistoryConversation[];
  desktopWeb: boolean;
  loading: boolean;
  openingId: string | null;
  online: boolean;
  ready: boolean;
  projects: RuntimeProject[];
  colors: Palette;
  dark: boolean;
  styles: ReturnType<typeof createStyles>;
  open: (conversation: RuntimeHistoryConversation) => void;
  refresh: () => void;
  reduceMotion: boolean;
  showConnectionNotice: boolean;
  tabSwipeHandlers: object;
}) {
  const [query, setQuery] = useState('');
  const [enabledAgents, setEnabledAgents] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(AGENTS.map((agent) => [agent.id, true]))
  ));
  const [selectedProject, setSelectedProject] = useState('all');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase();
  const searching = Boolean(normalized);
  const projectsByPath = new Map(projects.map((project) => [project.path, project]));
  const selectedProjectName = selectedProject === 'all' ? 'All projects' : projectsByPath.get(selectedProject)?.name || 'All projects';
  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase();
  const visibleProjects = projects.filter((project) => (
    !normalizedProjectQuery
    || project.name.toLocaleLowerCase().includes(normalizedProjectQuery)
    || project.path.toLocaleLowerCase().includes(normalizedProjectQuery)
  ));
  useEffect(() => {
    if (selectedProject !== 'all' && !projectsByPath.has(selectedProject)) setSelectedProject('all');
  }, [projects, selectedProject]);
  const visible = conversations.filter((conversation) => {
    if (enabledAgents[conversation.agent] === false) return false;
    if (selectedProject !== 'all' && conversation.projectPath !== selectedProject) return false;
    if (!normalized) return true;
    return [
      conversation.title,
      conversation.projectName,
      conversation.hostName,
      agentInfo(conversation.agent).label,
    ].some((value) => value?.toLocaleLowerCase().includes(normalized));
  });
  const sections = searching
    ? [{ title: `Search Results · ${visible.length}`, data: visible }]
    : visible.reduce<{ title: string; data: RuntimeHistoryConversation[] }[]>((groups, conversation) => {
      const title = dateGroupLabel(conversation.timestamp);
      const last = groups[groups.length - 1];
      if (last && last.title === title) last.data.push(conversation);
      else groups.push({ title, data: [conversation] });
      return groups;
    }, []);
  const filteringAgents = Object.values(enabledAgents).some((on) => on === false);
  const toggleAgent = (agentId: string) => {
    setEnabledAgents((current) => {
      const next = { ...current, [agentId]: current[agentId] === false };
      if (Object.values(next).every((on) => on === false)) return current;
      return next;
    });
  };
  return (
    <View style={styles.flex}>
      <View {...tabSwipeHandlers} style={styles.appHeader}>
        <View style={styles.wordmarkRow}><Image source={BRAND_MARK} resizeMode="contain" style={styles.miniMark} /><Text style={styles.wordmark}>History</Text></View>
        <Pressable accessibilityRole="button" disabled={!online || loading} onPress={refresh} style={styles.historyRefresh}>
          <Text style={styles.historyRefreshText}>{loading ? 'Loading…' : 'Refresh'}</Text>
        </Pressable>
        {loading ? <ProgressRail colors={colors} reduceMotion={reduceMotion} testID="history-progress-rail" style={styles.headerProgressRail} /> : null}
      </View>
      {!online && showConnectionNotice ? <View style={styles.connectionBanner}><Text style={styles.connectionBannerText}>Reconnect your computer to open history.</Text></View> : null}
      <View style={styles.historySearchSection}>
        <View style={styles.historyFilterPanel}>
          <View style={[styles.historySearchWrap, styles.historyPanelSearchWrap]}>
            <SearchCue active={Boolean(query)} colors={colors} dark={dark} reduceMotion={reduceMotion} testID="history-search-orb" styles={styles} />
            <TextInput
              accessibilityLabel="Search conversation history"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search conversations..."
              placeholderTextColor={colors.muted}
              returnKeyType="search"
              style={[styles.historySearchInput, Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as object) : null]}
              value={query}
            />
          </View>
          <View style={styles.historyAgentSection}>
            <View style={styles.historyFilterHeading}>
              <Text style={styles.historyFilterLabel}>Agents</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Select all history agents"
                accessibilityState={{ disabled: !filteringAgents }}
                disabled={!filteringAgents}
                onPress={() => setEnabledAgents(Object.fromEntries(AGENTS.map((agent) => [agent.id, true])))}
                style={styles.historyFilterReset}
              >
                <Text style={styles.historyFilterResetText}>{filteringAgents ? `${Object.values(enabledAgents).filter(Boolean).length} selected` : 'All selected'}</Text>
              </Pressable>
            </View>
            <View style={styles.historyFilterRow}>
              {AGENTS.map((agent) => {
                const on = enabledAgents[agent.id] !== false;
                return (
                  <Pressable
                    key={agent.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Toggle ${agent.label} conversations`}
                    accessibilityState={{ selected: on }}
                    onPress={() => toggleAgent(agent.id)}
                    style={[styles.historyAgentToggle, !on && styles.historyAgentToggleOff, filteringAgents && on && styles.historyAgentToggleOn]}
                  >
                    {filteringAgents && on ? <View style={styles.historyAgentToggleIndicator} /> : null}
                    <AgentIcon agent={agent.id} size={28} styles={styles} />
                    <Text style={styles.historyAgentToggleLabel} numberOfLines={1}>{agent.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          {projects.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Choose history project, ${selectedProjectName}`}
              onPress={() => {
                setProjectQuery('');
                setProjectPickerOpen(true);
              }}
              style={styles.historyProjectSelect}
            >
              {selectedProject === 'all'
                ? <View style={styles.historyProjectSelectIcon}><UiIcon name="list" size={18} color={colors.accent} /></View>
                : <ProjectIcon project={projectsByPath.get(selectedProject) || null} size={32} styles={styles} />}
              <View style={styles.historyProjectSelectCopy}>
                <Text style={styles.historyProjectSelectLabel}>Project</Text>
                <Text style={styles.historyProjectSelectText} numberOfLines={1}>{selectedProjectName}</Text>
              </View>
              <UiIcon name="chevron-down" size={16} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <SectionList
        sections={sections}
        keyboardDismissMode={KEYBOARD_DISMISS_MODE}
        keyExtractor={(conversation) => conversation.id}
        contentContainerStyle={styles.historyList}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.historyGroupLabel}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const project = projectsByPath.get(item.projectPath) || { name: item.projectName, path: item.projectPath };
          const opening = openingId === item.id;
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.title}${item.hostName ? ` on ${item.hostName}` : ''}`} disabled={!ready || Boolean(openingId)} onPress={() => open(item)} style={({ pressed }) => [styles.historyRow, pressed && styles.rowPressed, (!ready || Boolean(openingId)) && styles.disabled]}>
              <View style={styles.sessionIcons}><ProjectIcon project={project} size={36} styles={styles} /><View style={styles.sessionAgentIcon}><AgentIcon agent={item.agent} size={18} styles={styles} /></View></View>
              <View style={styles.sessionCopy}>
                <Text style={styles.sessionTitle} numberOfLines={1}>{item.title}</Text>
                <View style={styles.historyMetaRow}>
                  <View style={styles.historyProjectBadge}><Text style={styles.historyProjectBadgeText} numberOfLines={1}>{item.projectName}</Text></View>
                  {item.hostName ? <View style={[styles.sessionHostBadge, item.hostKind === 'cloud' && styles.sessionHostBadgeCloud]}><UiIcon name={item.hostKind === 'cloud' ? 'globe' : 'monitor'} size={9} color={item.hostKind === 'cloud' ? colors.primary : colors.secondary} /><Text style={[styles.sessionHostBadgeText, item.hostKind === 'cloud' && styles.sessionHostBadgeTextCloud]} numberOfLines={1}>{item.hostName}</Text></View> : null}
                  <Text style={styles.historyTime}>{opening ? 'Opening…' : relativeTime(item.timestamp)}</Text>
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={<View style={styles.emptyState}><Text style={styles.emptyTitle}>{loading ? 'Loading history…' : 'No conversations found'}</Text><Text style={styles.emptyCopy}>{loading ? 'Reading the histories stored on your computer.' : 'Try another search or start a new session.'}</Text></View>}
      />
      <BottomSheet
        open={projectPickerOpen}
        onClose={() => setProjectPickerOpen(false)}
        closeLabel="Close project picker"
        avoidKeyboard
        sheetStyle={[styles.configSheet, styles.historyProjectSheet, desktopWeb && styles.sheetDesktopDialog, desktopWeb && styles.historyProjectDesktopSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={[styles.modalLayout, desktopWeb && styles.modalLayoutCentered]}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
        dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
      >
            <View style={styles.sheetHeader}>
              <View><Text accessibilityRole="header" style={styles.sheetTitle}>Projects</Text><Text style={styles.historyProjectCount}>{normalizedProjectQuery ? `${visibleProjects.length} result${visibleProjects.length === 1 ? '' : 's'}` : `${projects.length} project${projects.length === 1 ? '' : 's'}`}</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setProjectPickerOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <View style={styles.historySearchWrap}>
              <SearchCue active={Boolean(projectQuery)} colors={colors} dark={dark} reduceMotion={reduceMotion} testID="project-search-orb" styles={styles} />
              <TextInput
                accessibilityLabel="Search history projects"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                onChangeText={setProjectQuery}
                placeholder="Search projects..."
                placeholderTextColor={colors.muted}
                returnKeyType="search"
                style={[styles.historySearchInput, Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as object) : null]}
                value={projectQuery}
              />
            </View>
            <ScrollView style={[styles.historyProjectOptionsScroll, desktopWeb && styles.historyProjectOptionsScrollDesktop]} contentContainerStyle={styles.historyProjectOptions} keyboardDismissMode={KEYBOARD_DISMISS_MODE} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {!normalizedProjectQuery ? (
                <Pressable accessibilityRole="radio" accessibilityState={{ selected: selectedProject === 'all' }} onPress={() => { setSelectedProject('all'); setProjectPickerOpen(false); }} style={[styles.projectChoice, selectedProject === 'all' && styles.projectChoiceSelected]}>
                  <View style={styles.historyProjectOptionIcon}><UiIcon name="list" size={18} color={colors.accent} /></View>
                  <View style={styles.projectChoiceCopy}><Text style={styles.projectChoiceName}>All projects</Text><Text style={styles.projectChoicePath}>Show every conversation</Text></View>
                  {selectedProject === 'all' ? <UiIcon name="check-circle" size={22} color={colors.accent} /> : null}
                </Pressable>
              ) : null}
              {visibleProjects.map((project) => (
                <Pressable key={project.path} accessibilityRole="radio" accessibilityLabel={project.name} accessibilityState={{ selected: selectedProject === project.path }} onPress={() => { setSelectedProject(project.path); setProjectPickerOpen(false); }} style={[styles.projectChoice, selectedProject === project.path && styles.projectChoiceSelected]}>
                  <ProjectIcon project={project} size={36} styles={styles} />
                  <View style={styles.projectChoiceCopy}><Text numberOfLines={1} style={styles.projectChoiceName}>{project.name}</Text><Text numberOfLines={1} style={styles.projectChoicePath}>{project.hostPath || project.path}</Text></View>
                  {selectedProject === project.path ? <UiIcon name="check-circle" size={22} color={colors.accent} /> : null}
                </Pressable>
              ))}
              {!visibleProjects.length ? <Text style={styles.fieldHelp}>No desktop projects found.</Text> : null}
            </ScrollView>
      </BottomSheet>
    </View>
  );
}

function ActivitySheet({ open, close, session, activity, terminalStatuses, desktopWeb, styles, reduceMotion = false }: {
  open: boolean;
  close: () => void;
  session: RuntimeSession;
  activity: string;
  terminalStatuses: RuntimeTerminalStatus[];
  desktopWeb: boolean;
  styles: ReturnType<typeof createStyles>;
  reduceMotion?: boolean;
}) {
  const status = sessionStatus(session, terminalStatuses);
  const history = session.activityHistory.length
    ? session.activityHistory
    : [{ activity, createdAt: null, taskId: null }];
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close activity history"
      reduceMotion={reduceMotion}
      sheetStyle={[styles.configSheet, styles.activitySheet, desktopWeb && styles.sheetDesktopDialog]}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={[styles.modalLayout, desktopWeb && styles.modalLayoutCentered]}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
      dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
    >
          <View style={styles.sheetHeader}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>Activity history</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close activity history" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.activityContent} keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsVerticalScrollIndicator={false}>
            <View style={styles.activitySummaryRow}>
              <Text style={[styles.activityCardLabel, { color: status.color }]}>{status.label}</Text>
              <Text style={styles.activityCount}>{history.length} {history.length === 1 ? 'activity' : 'activities'}</Text>
            </View>
            {session.goal ? <View style={styles.activityGoal}><Text style={styles.activityMetaLabel}>Goal</Text><Text style={styles.activityGoalText}>{session.goal}</Text></View> : null}
            <View style={styles.activityTimeline}>
              {history.map((entry, index) => {
                const timestamp = Date.parse(entry.createdAt || '');
                return (
                  <View key={`${entry.createdAt || 'current'}-${index}`} testID="activity-history-entry" style={styles.activityEntry}>
                    <View style={styles.activityRail}><View style={[styles.activityDot, index === 0 && { backgroundColor: status.color }]} /></View>
                    <View style={styles.activityEntryCopy}>
                      <View style={styles.activityEntryHeader}>
                        <Text style={styles.activityEntryTime}>{Number.isFinite(timestamp) ? relativeTime(timestamp) : 'Now'}</Text>
                        {entry.taskId ? <Text style={styles.activityTaskBadge}>#{entry.taskId}</Text> : null}
                      </View>
                      <Text style={[styles.activityEntryText, index === 0 && styles.activityEntryCurrent]}>{entry.activity}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
            <View style={styles.activityMetaRow}>
              <View style={styles.activityMetaBlock}><Text style={styles.activityMetaLabel}>Agent</Text><Text style={styles.activityMetaValue}>{agentInfo(session.agent).label}</Text></View>
              <View style={styles.activityMetaBlock}><Text style={styles.activityMetaLabel}>Worktree</Text><Text numberOfLines={1} style={styles.activityMetaValue}>{projectName(session.cwd)}</Text></View>
            </View>
          </ScrollView>
    </BottomSheet>
  );
}

function TerminalStatusSheet({ open, close, session, terminalStatuses, interactive, run, colors, styles, reduceMotion = false }: {
  open: boolean;
  close: () => void;
  session: RuntimeSession;
  terminalStatuses: RuntimeTerminalStatus[];
  interactive: boolean;
  run: (command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => Promise<void>;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion?: boolean;
}) {
  const select = (status: string) => {
    close();
    void run({ type: 'session.status', sessionId: session.sessionId, payload: { status } });
  };
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close agent statuses"
      reduceMotion={reduceMotion}
      testID="terminal-status-sheet"
      sheetStyle={[styles.configSheet, styles.sessionConfigSheet]}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={styles.modalLayout}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
      dragAreaStyle={styles.quotaDragArea}
    >
      <View style={styles.sheetHeader}><Text accessibilityRole="header" style={styles.sheetTitle}>Agent status</Text><Pressable accessibilityRole="button" accessibilityLabel="Close agent statuses" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
      <Text style={styles.sheetIntro}>Set the work phase shown on your computer and mobile.</Text>
      <ScrollView contentContainerStyle={styles.configOptionList} keyboardDismissMode={KEYBOARD_DISMISS_MODE}>
        {terminalStatuses.map((status) => {
          const selectedStatus = session.workStatus === status.key;
          return <Pressable key={status.key} accessibilityRole="radio" accessibilityState={{ selected: selectedStatus }} disabled={!interactive} onPress={() => select(status.key)} style={[styles.configOption, selectedStatus && styles.configOptionSelected, !interactive && styles.disabled]}><View style={[styles.connectionDot, { backgroundColor: status.color }]} /><View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>{status.label}</Text></View>{selectedStatus ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}</Pressable>;
        })}
        <Pressable accessibilityRole="radio" accessibilityState={{ selected: !session.workStatus }} disabled={!interactive} onPress={() => select('clear')} style={[styles.configOption, !session.workStatus && styles.configOptionSelected, !interactive && styles.disabled]}><View style={[styles.connectionDot, { backgroundColor: colors.muted }]} /><View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>No status</Text></View>{!session.workStatus ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}</Pressable>
      </ScrollView>
    </BottomSheet>
  );
}

function RecordingWakeLock() {
  useEffect(() => {
    let mounted = true;
    void activateKeepAwakeAsync('voice-recording').then(() => {
      if (!mounted) void deactivateKeepAwake('voice-recording').catch(() => {});
    }).catch(() => {});
    return () => {
      mounted = false;
      void deactivateKeepAwake('voice-recording').catch(() => {});
    };
  }, []);
  return null;
}

const ChatScreen = memo(function ChatScreen({
  colors,
  dark,
  session,
  computerName,
  hostLabel,
  conversationActions,
  online,
  offline,
  showConnectionNotice,
  composerDrafts,
  dismissComposerRef,
  send,
  retryPending,
  notify,
  back,
  forget,
  stop,
  interrupt,
  run,
  pending,
  drafts,
  setDrafts,
  listRef,
  nearBottom,
  setNearBottom,
  keyboardOffset,
  loadModels,
  loadEarlierHistory,
  configureSession,
  readAttachment,
  transcribeAudio,
  resolveImageReference,
  openPreview,
  reduceMotion,
  terminalStatuses,
  availableAgents,
  demoMode,
  contextMenuRequest,
  consumeContextMenuRequest,
  styles,
}: {
  colors: Palette;
  dark: boolean;
  styles: ReturnType<typeof createStyles>;
  session: RuntimeSession;
  computerName: string | null;
  hostLabel: string;
  conversationActions: boolean;
  online: boolean;
  offline: boolean;
  showConnectionNotice: boolean;
  composerDrafts: MutableRefObject<Map<string, InlineDraft>>;
  dismissComposerRef: RefObject<(() => void) | null>;
  send: (attachments: MobileAttachment[], explicitText: string) => Promise<boolean>;
  retryPending: (message: PendingSend) => void;
  notify: (message: string) => void;
  back?: () => void;
  forget: () => void;
  stop: () => void;
  interrupt: () => void;
  run: (command: Parameters<MobileRuntimeClient['sendCommand']>[0]) => Promise<void>;
  pending: PendingSend[];
  drafts: Record<string, QuestionDraft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, QuestionDraft>>>;
  listRef: React.RefObject<FlatList<RuntimeItem> | null>;
  nearBottom: boolean;
  setNearBottom: (value: boolean) => void;
  keyboardOffset: number;
  loadModels: (sessionId: string) => Promise<MobileModelCatalog>;
  loadEarlierHistory: (sessionId: string, before?: number, anchor?: { role: string; text: string; timestamp?: string }, knownCount?: number) => Promise<{ items?: RuntimeItem[]; nextCursor?: number | null; hasMore?: boolean }>;
  configureSession: (sessionId: string, configId: ConfigId, value: ConfigValue) => Promise<void>;
  readAttachment: (sessionId: string, attachmentId: string) => Promise<MobileAttachment>;
  transcribeAudio: (uri: string, mimeType: string, durationMs: number) => Promise<string>;
  resolveImageReference: (sessionId: string, path: string) => Promise<Record<string, unknown>>;
  openPreview: (url: string) => Promise<boolean>;
  reduceMotion: boolean;
  terminalStatuses: RuntimeTerminalStatus[];
  availableAgents: string[];
  demoMode: boolean;
  contextMenuRequest: WebContextMenuRequest | null;
  consumeContextMenuRequest: () => void;
}) {
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && viewportWidth >= WEB_SPLIT_BREAKPOINT;
  const [configOpen, setConfigOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(90);
  const [configSection, setConfigSection] = useState<ConfigSection>('model');
  const [configAnchor, setConfigAnchor] = useState<WebPopoverAnchor | null>(null);
  const [chatContextMenu, setChatContextMenu] = useState<WebContextMenuPosition | null>(null);
  const [contextHandoffOpen, setContextHandoffOpen] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const messageSelection = useMemo(() => ({ activeId: selectedMessageId, activate: setSelectedMessageId }), [selectedMessageId]);
  const [models, setModels] = useState<MobileModel[]>([]);
  const [permissionModes, setPermissionModes] = useState<MobilePermissionMode[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [viewingGallery, setViewingGallery] = useState<ImageGallery | null>(null);
  const [imageViewport, setImageViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [nativeImageZoomed, setNativeImageZoomed] = useState(false);
  const [editingImage, setEditingImage] = useState<{ attachment: MobileAttachment } | null>(null);
  const imageEditResult = useRef<((attachment: MobileAttachment | null) => void) | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [hasComposerText, setHasComposerText] = useState(false);
  const [composerReady, setComposerReady] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [voiceRecordingActive, setVoiceRecordingActive] = useState(false);
  const [voiceRecordingReady, setVoiceRecordingReady] = useState(false);
  const [voiceRecordingPaused, setVoiceRecordingPaused] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceLevels, setVoiceLevels] = useState(EMPTY_VOICE_LEVELS);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 80);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingGeneration = useRef(0);
  const finishingRecording = useRef(false);
  const composerInputRef = useRef<InlineComposerRef>(null);
  // Expo registers DOM methods asynchronously; keep its proxy scoped to this Chat.
  useImperativeHandle(dismissComposerRef, () => () => composerInputRef.current?.blur?.(), []);
  const focusComposer = useCallback(() => composerInputRef.current?.focus(), []);
  const imageViewerRef = useRef<ScrollView>(null);
  // ponytail: retain only the last original; add a bounded gallery cache if paging needs it.
  const lastFullImage = useRef<{ sessionId: string; attachmentId: string; dataUrl: string } | null>(null);
  const imageLoadRequest = useRef(0);
  const imageDismissRef = useRef<PanGestureHandler>(null);
  const imageDismissY = useRef(new Animated.Value(0)).current;
  const imageChromeOpacity = imageDismissY.interpolate({ inputRange: [0, 120], outputRange: [1, 0], extrapolate: 'clamp' });
  const imageDismissDrag = useRef({ active: false, axis: '' as '' | 'dismiss' | 'gallery' | 'other', index: 0, startX: 0, startY: 0, lastY: 0, lastAt: 0, velocity: 0, dx: 0 });
  const imageViewportRef = useRef(imageViewport);
  const imageStageSizeRef = useRef({ width: viewportWidth, height: viewportHeight });
  const imageGestureStart = useRef({ mode: '' as '' | 'pan' | 'pinch', distance: 0, pageX: 0, pageY: 0, localX: 0, localY: 0, x: 0, y: 0, scale: 1 });
  const pendingAttachmentAction = useRef<(() => void) | null>(null);
  const followLatest = useRef(true);
  const historyScrollGesture = useRef(false);
  const autoLoadEarlierTimelineRef = useRef<() => void>(() => {});
  const timelineReadyRef = useRef(false);
  const timelineSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timelineSettleFrame = useRef<number | null>(null);
  const timelineContentHeightRef = useRef(0);
  const timelineViewportHeightRef = useRef(0);
  const timelineOffsetRef = useRef(0);
  const timelineDragStartRef = useRef(0);
  const timelineDistanceFromEndRef = useRef(0);
  const timelineGestureActiveRef = useRef(false);
  const timelineGestureEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferTimelineScrollUntilKeyboardHide = useRef(false);
  const jumpToFirstGeneration = useRef(0);
  const pendingScrollToFirst = useRef(false);
  const timelineReveal = useRef(new Animated.Value(0)).current;
  const hasEarlierHistoryRef = useRef(session.hasEarlierHistory);
  const onlineRef = useRef(online);
  const historyRequestedRef = useRef(false);
  const initialHistoryLoadingRef = useRef(false);
  const automaticHistorySessionRef = useRef<string | null>(null);
  const [timelineReady, setTimelineReady] = useState(false);
  const [earlierItems, setEarlierItems] = useState<RuntimeItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyRequested, setHistoryRequested] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [jumpingToFirst, setJumpingToFirst] = useState(false);
  const [nearHistoryStart, setNearHistoryStart] = useState(false);
  const [firstJumpRevealed, setFirstJumpRevealed] = useState(false);
  const [timelineItemLimit, setTimelineItemLimit] = useState(INITIAL_TIMELINE_ITEM_LIMIT);
  hasEarlierHistoryRef.current = session.hasEarlierHistory;
  onlineRef.current = online;
  imageViewportRef.current = imageViewport;
  const agent = agentInfo(session.agent);
  const project = session.project || (session.cwd ? { name: projectName(session.cwd), path: session.cwd } : null);
  const canCompose = session.state !== 'stopped';
  const desktopActions = conversationActions;
  const canForkConversation = desktopActions && session.agent !== 'cursor';
  const reconnecting = !online && !offline;
  const interactive = online && session.state !== 'starting' && canCompose;
  const sessionStarting = session.state === 'starting';
  const running = session.state !== 'stopped' && (session.currentTurn?.state === 'running' || session.state === 'running');
  const allItems = useMemo(() => earlierItems.length
    ? Array.from(new Map(
      [...earlierItems, ...session.items].map((item) => [item.itemId, item]),
    ).values())
    : session.items, [earlierItems, session.items]);
  useStreamingHaptics(session.sessionId, allItems);
  const timelineItems = useMemo(() => orderTimelineItems(allItems.filter((item) => (
    !(item.remoteCommand && item.status === 'failed')
    && ((isConversationItem(item) && item.itemType !== 'user_message' ? assistantText(item) : itemText(item)).replaceAll('\u200B', '').trim()
      || itemAttachments(item).length || isTodoItem(item))
  ))), [allItems]);
  const retainedTimelineItems = useMemo(() => {
    const boundedStart = retainedTimelineStart(timelineItems, timelineItemLimit, isConversationItem);
    const activeTurnStart = running
      ? timelineItems.findLastIndex((item) => item.itemType === 'user_message')
      : -1;
    const keepsCompleteActiveTurn = activeTurnStart >= 0
      && timelineItems.length - activeTurnStart <= ACTIVE_TURN_ITEM_LIMIT;
    return timelineItems.slice(keepsCompleteActiveTurn ? Math.min(boundedStart, activeTurnStart) : boundedStart);
  }, [running, timelineItemLimit, timelineItems]);
  const hasEarlierCachedItems = retainedTimelineItems.length < timelineItems.length;
  const allHistoryLoaded = historyRequested ? !historyHasMore : !session.hasEarlierHistory;
  const atFirstMessage = nearHistoryStart && !hasEarlierCachedItems && allHistoryLoaded;
  const canJumpToFirst = timelineItems.length > 1 || hasEarlierCachedItems || session.hasEarlierHistory || historyHasMore;
  const historyRetryAvailable = historyRequested && !historyLoading && !timelineItems.length && historyHasMore;
  const showFirstJump = timelineReady && (firstJumpRevealed || historyRetryAvailable) && !atFirstMessage && canJumpToFirst;
  const latestTodoItem = useMemo(() => [...timelineItems].reverse().find(isTodoItem) || null, [timelineItems]);
  const displayItems = useMemo(
    () => retainedTimelineItems.filter((item) => item !== latestTodoItem),
    [latestTodoItem, retainedTimelineItems],
  );
  const coordinationItems = useMemo(() => displayItems.filter((item) => (
    item.itemType === 'user_message' && parseSessionCoordinationPrompt(itemText(item))
  )), [displayItems]);
  const coordinationItemIds = useMemo(() => new Set(coordinationItems.map((item) => item.itemId)), [coordinationItems]);
  const visibleItems = useMemo(() => displayItems.filter((item) => !coordinationItemIds.has(item.itemId)), [coordinationItemIds, displayItems]);
  const coordinationAnchorIndex = useMemo(() => {
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      if (!isConversationItem(visibleItems[index]) && !isTodoItem(visibleItems[index])) {
        while (index > 0 && !isConversationItem(visibleItems[index - 1]) && !isTodoItem(visibleItems[index - 1])) index -= 1;
        return index;
      }
    }
    return -1;
  }, [visibleItems]);
  const retainedConversationItems = useMemo(() => session.items.filter((item) => (
    item.itemType === 'assistant_message'
    || (item.itemType === 'user_message' && !parseSessionCoordinationPrompt(itemText(item)))
  )), [session.items]);
  const oldestAnchorItem = retainedConversationItems.find((item) => item.itemType === 'user_message')
    || retainedConversationItems[0];
  const initialHistoryLoading = online
    && session.hasEarlierHistory
    && retainedConversationItems.length === 0
    && earlierItems.length === 0
    && (!historyRequested || historyLoading);
  initialHistoryLoadingRef.current = initialHistoryLoading;
  const requestEarlierHistory = useCallback(async (initial = false) => {
    if (!online || historyLoading || (!initial && !historyHasMore)) return;
    historyRequestedRef.current = true;
    setHistoryRequested(true);
    setHistoryLoading(true);
    try {
      const result = await loadEarlierHistory(
        session.sessionId,
        historyRequested && Number.isSafeInteger(historyCursor) ? historyCursor! : undefined,
        !historyRequested && oldestAnchorItem ? {
          role: oldestAnchorItem.itemType || 'user_message',
          text: itemText(oldestAnchorItem).slice(0, 2_000),
          ...(Number.isFinite(oldestAnchorItem.startedAtMs)
            ? { timestamp: new Date(oldestAnchorItem.startedAtMs!).toISOString() }
            : {}),
        } : undefined,
        retainedConversationItems.length,
      );
      const items = Array.isArray(result.items)
        ? result.items.filter((item) => item && typeof item.itemId === 'string')
        : [];
      setEarlierItems((current) => Array.from(new Map(
        [...items, ...current].map((item) => [item.itemId, item]),
      ).values()));
      setHistoryCursor(Number.isSafeInteger(result.nextCursor) ? result.nextCursor! : null);
      setHistoryHasMore(result.hasMore === true);
    } catch (error) {
      setNearHistoryStart(true);
      setHistoryHasMore(true);
      notify(error instanceof Error ? error.message : 'Could not load earlier messages');
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCursor, historyHasMore, historyLoading, historyRequested, loadEarlierHistory, notify, oldestAnchorItem, online, retainedConversationItems.length, session.sessionId]);
  const requestEarlierHistoryRef = useRef(requestEarlierHistory);
  requestEarlierHistoryRef.current = requestEarlierHistory;
  useEffect(() => {
    if (
      !online
      || !session.hasEarlierHistory
      || retainedConversationItems.length > 0
      || earlierItems.length > 0
      || historyRequested
      || automaticHistorySessionRef.current === session.sessionId
    ) return;
    automaticHistorySessionRef.current = session.sessionId;
    void requestEarlierHistory(true);
  }, [earlierItems.length, historyRequested, online, requestEarlierHistory, retainedConversationItems.length, session.hasEarlierHistory, session.sessionId]);
  const activeModel = models.find((model) => model.current)
    || models.find((model) => model.id === session.model)
    || models[0];
  const reasoning = reasoningDescriptor(activeModel);
  const speed = activeModel?.capabilities?.optionDescriptors?.find((option) => option.id === 'serviceTier');
  const effortValue = reasoning?.currentValue ?? session.effort ?? '';
  const effortLabel = reasoning?.type === 'boolean'
    ? (effortValue === true ? 'On' : effortValue === false ? 'Off' : 'Reasoning')
    : reasoning?.options?.find((option) => option.id === String(effortValue))?.label || String(effortValue || 'Reasoning');
  const speedValue = speed?.currentValue || session.serviceTier || '';
  const speedLabel = speed?.options?.find((option) => option.id === speedValue)?.label || speedValue || 'Speed';
  const permissionLabel = permissionModes.find((option) => option.id === session.permissionMode)?.label
    || session.permissionMode
    || 'Permissions';
  const usedTokens = Number(session.tokenUsage?.usedTokens) || 0;
  const maxTokens = Number(session.tokenUsage?.maxTokens) || 0;
  const contextLabel = maxTokens ? `${compactTokens(usedTokens)} / ${compactTokens(maxTokens)}` : 'No usage yet';
  const contextPercent = maxTokens ? Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100))) : 0;
  const contextRingLength = 151;
  const currentStatus = sessionStatus(session, terminalStatuses);
  const handoffAgents = AGENTS.filter((candidate) => candidate.id !== session.agent && availableAgents.includes(candidate.id));
  const visiblePending = pending.filter((message) => (
    message.failed || (
      !message.confirmed
      &&
      matchingUserMessages(timelineItems, message.text) <= message.baselineMatches
    )
  ));
  const latestConversation = [...timelineItems].reverse().find(isConversationItem);
  const latestConversationIndex = timelineItems.findLastIndex(isConversationItem);
  const activeTurnHasLaterWork = timelineItems.slice(latestConversationIndex + 1).some((item) => (
    item.turnId === session.currentTurn?.turnId && !isConversationItem(item) && !isTodoItem(item)
  ));
  const showThinking = running && (visiblePending.length > 0 || (
    latestConversation?.itemType === 'user_message'
    && !activeTurnHasLaterWork
  ));
  const latestWork = [...timelineItems].reverse().find((item) => !isConversationItem(item));
  const activity = session.state === 'starting'
    ? `Preparing ${agent.label}…`
    : session.activity?.trim() || latestWork?.detail || latestWork?.title || 'Ready';
  const openConfig = useCallback((section: ConfigSection, event?: GestureResponderEvent) => {
    const target = event?.currentTarget as unknown as HTMLElement | undefined;
    const rect = Platform.OS === 'web' && viewportWidth >= WEB_SPLIT_BREAKPOINT
      ? target?.getBoundingClientRect?.()
      : null;
    setConfigAnchor(rect ? {
      left: Math.min(
        viewportWidth - WEB_CONFIG_POPOVER_WIDTH - 16,
        Math.max(16, rect.left + rect.width / 2 - WEB_CONFIG_POPOVER_WIDTH / 2),
      ),
      bottom: Math.max(16, viewportHeight - rect.top + 8),
    } : null);
    setConfigSection(section);
    setConfigOpen(true);
  }, [viewportHeight, viewportWidth]);
  const openChatContextMenuAt = useCallback((x: number, y: number) => {
    setContextHandoffOpen(false);
    const menuBottomInset = desktopActions ? (session.sandboxMode ? 388 : 342) : 236;
    setChatContextMenu({
      left: Math.min(viewportWidth - WEB_CONTEXT_MENU_WIDTH - 12, Math.max(12, x)),
      top: Math.max(12, Math.min(viewportHeight - menuBottomInset, Math.max(12, y))),
    });
  }, [desktopActions, session.sandboxMode, viewportHeight, viewportWidth]);
  const openChatContextMenu = useCallback((event: any) => {
    if (Platform.OS !== 'web' || viewportWidth < WEB_SPLIT_BREAKPOINT) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const nativeEvent = event.nativeEvent || event;
    nativeEvent.preventDefault?.();
    openChatContextMenuAt(
      Number(nativeEvent.clientX ?? nativeEvent.pageX) || 0,
      Number(nativeEvent.clientY ?? nativeEvent.pageY) || 0,
    );
  }, [openChatContextMenuAt, viewportWidth]);
  useEffect(() => {
    if (!desktopWeb || contextMenuRequest?.sessionId !== session.sessionId) return;
    openChatContextMenuAt(contextMenuRequest.left, contextMenuRequest.top);
    consumeContextMenuRequest();
  }, [consumeContextMenuRequest, contextMenuRequest, desktopWeb, openChatContextMenuAt, session.sessionId]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !chatContextMenu || typeof document === 'undefined') return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setChatContextMenu(null);
        setContextHandoffOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [chatContextMenu]);
  const continueWithAgent = useCallback((targetAgent: string) => {
    setHandoffPending(true);
    void run({ type: 'session.handoff', sessionId: session.sessionId, payload: { targetAgent } })
      .finally(() => {
        setHandoffPending(false);
        setHandoffOpen(false);
        setChatContextMenu(null);
        setContextHandoffOpen(false);
      });
  }, [run, session.sessionId]);
  const runConversationAction = useCallback((action: 'generateTitle' | 'fork' | 'rename' | 'resetTitle' | 'promoteSandbox') => {
    let title: string | undefined;
    if (action === 'rename') {
      title = window.prompt('Rename agent', session.title || '')?.trim();
      if (title === undefined) return;
      if (!title) return notify('Enter an agent title');
    }
    setChatContextMenu(null);
    setContextHandoffOpen(false);
    void run({ type: 'session.action', sessionId: session.sessionId, payload: { action, ...(title ? { title } : {}) } });
  }, [notify, run, session.sessionId, session.title]);
  const resetImageZoom = useCallback(() => {
    setImageViewport({ x: 0, y: 0, scale: 1 });
    setNativeImageZoomed(false);
  }, []);
  const closeImageViewer = useCallback(() => {
    imageDismissY.stopAnimation();
    setViewingGallery(null);
  }, [imageDismissY]);
  const settleImageViewer = useCallback(() => {
    if (reduceMotion) {
      imageDismissY.setValue(0);
      return;
    }
    Animated.spring(imageDismissY, {
      toValue: 0,
      speed: 24,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [imageDismissY, reduceMotion]);
  const dismissImageViewer = useCallback(() => {
    if (reduceMotion) {
      closeImageViewer();
      return;
    }
    Animated.timing(imageDismissY, {
      toValue: viewportHeight,
      duration: 180,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) closeImageViewer(); });
  }, [closeImageViewer, imageDismissY, reduceMotion, viewportHeight]);
  const boundedImageViewport = useCallback((x: number, y: number, value: number) => {
    const scale = Math.max(1, Math.min(4, value));
    const maxX = viewportWidth * (scale - 1) / 2;
    const maxY = viewportHeight * (scale - 1) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
      scale,
    };
  }, [viewportHeight, viewportWidth]);
  const changeImageZoom = useCallback((value: number) => setImageViewport((current) => {
    return boundedImageViewport(current.x, current.y, value);
  }), [boundedImageViewport]);
  const imageGesture = useMemo(() => {
    const distance = (event: GestureResponderEvent) => {
      const [first, second] = event.nativeEvent.touches;
      return first && second ? Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY) : 0;
    };
    const center = (event: GestureResponderEvent, local = false) => {
      const [first, second] = event.nativeEvent.touches;
      const x = local ? 'locationX' : 'pageX';
      const y = local ? 'locationY' : 'pageY';
      return first && second
        ? { x: (first[x] + second[x]) / 2, y: (first[y] + second[y]) / 2 }
        : { x: first?.[x] || 0, y: first?.[y] || 0 };
    };
    const begin = (event: GestureResponderEvent) => {
      const current = imageViewportRef.current;
      const pinchDistance = distance(event);
      const pageCenter = center(event);
      const localCenter = center(event, true);
      imageGestureStart.current = {
        mode: pinchDistance ? 'pinch' : 'pan',
        distance: pinchDistance,
        pageX: pageCenter.x,
        pageY: pageCenter.y,
        localX: localCenter.x,
        localY: localCenter.y,
        x: current.x,
        y: current.y,
        scale: current.scale,
      };
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2 || imageViewportRef.current.scale > 1,
      onMoveShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2 || imageViewportRef.current.scale > 1,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: begin,
      onPanResponderMove: (event, gesture) => {
        if (event.nativeEvent.touches.length >= 2) {
          if (imageGestureStart.current.mode !== 'pinch') begin(event);
          const start = imageGestureStart.current;
          const currentCenter = center(event);
          const next = viewportFromPinch({
            viewport: { x: start.x, y: start.y, scale: start.scale },
            startDistance: start.distance,
            currentDistance: distance(event),
            startCenter: { x: start.localX, y: start.localY },
            currentCenter: {
              x: start.localX + currentCenter.x - start.pageX,
              y: start.localY + currentCenter.y - start.pageY,
            },
            stage: imageStageSizeRef.current,
          });
          setImageViewport(boundedImageViewport(next.x, next.y, next.scale));
          return;
        }
        const start = imageGestureStart.current;
        if (start.mode !== 'pan' || start.scale <= 1) return;
        setImageViewport(boundedImageViewport(start.x + gesture.dx, start.y + gesture.dy, start.scale));
      },
      onPanResponderRelease: () => { imageGestureStart.current.mode = ''; },
      onPanResponderTerminate: () => { imageGestureStart.current.mode = ''; },
    });
  }, [boundedImageViewport, viewportHeight, viewportWidth]);
  const loadFullImage = useCallback(async (image: ImagePreview) => {
    const request = ++imageLoadRequest.current;
    if (!image.attachmentId || image.dataUrl) {
      if (image.attachmentId && image.dataUrl) {
        lastFullImage.current = { sessionId: session.sessionId, attachmentId: image.attachmentId, dataUrl: image.dataUrl };
      }
      setImageLoading(false);
      return;
    }
    setImageLoading(true);
    try {
      const attachment = await readAttachment(session.sessionId, image.attachmentId);
      if (request !== imageLoadRequest.current) return;
      lastFullImage.current = { sessionId: session.sessionId, attachmentId: image.attachmentId, dataUrl: attachment.dataUrl };
      setViewingGallery((current) => current ? {
        ...current,
        images: current.images.map((candidate) => candidate.attachmentId === image.attachmentId
          ? { ...candidate, dataUrl: attachment.dataUrl }
          : candidate),
      } : current);
    } catch (error) {
      if (request === imageLoadRequest.current) notify(error instanceof Error ? error.message : 'Could not open the image');
    } finally {
      if (request === imageLoadRequest.current) setImageLoading(false);
    }
  }, [notify, readAttachment, session.sessionId]);
  const openImage = useCallback((image: ImagePreview, gallery: ImagePreview[] = [image]) => {
    const cached = lastFullImage.current;
    const images = (gallery.length ? gallery : [image]).map((candidate) => ({
      ...candidate,
      dataUrl: candidate.attachmentId
        ? cached?.sessionId === session.sessionId && cached.attachmentId === candidate.attachmentId ? cached.dataUrl : undefined
        : candidate.dataUrl,
    }));
    const index = Math.max(0, images.findIndex((candidate) => (
      candidate === image
      || (candidate.attachmentId && candidate.attachmentId === image.attachmentId)
      || candidate.name === image.name
    )));
    // Reset on open: iOS still displays the previous position during modal dismissal.
    imageDismissY.setValue(0);
    resetImageZoom();
    setViewingGallery({ images, index });
    void loadFullImage(images[index]);
  }, [imageDismissY, loadFullImage, resetImageZoom, session.sessionId]);
  const showGalleryImage = useCallback((index: number) => {
    if (!viewingGallery) return;
    const next = Math.max(0, Math.min(viewingGallery.images.length - 1, index));
    resetImageZoom();
    setViewingGallery((current) => current ? { ...current, index: next } : current);
    imageViewerRef.current?.scrollTo({ x: viewportWidth * next, animated: !reduceMotion });
    void loadFullImage(viewingGallery.images[next]);
  }, [loadFullImage, reduceMotion, resetImageZoom, viewingGallery, viewportWidth]);
  const imageDismissEvent = useMemo(() => Animated.event(
    [{ nativeEvent: { translationY: imageDismissY } }],
    { useNativeDriver: true },
  ), [imageDismissY]);
  const settleImageDismissGesture = useCallback((event: PanGestureHandlerStateChangeEvent) => {
    const { oldState, state, translationY, velocityY } = event.nativeEvent;
    if (oldState !== State.ACTIVE) return;
    if (state === State.END && shouldDismissSheet(Math.max(0, translationY), Math.max(0, velocityY / 1_000))) dismissImageViewer();
    else settleImageViewer();
  }, [dismissImageViewer, settleImageViewer]);
  const imageDismissHandlers = {
    enabled: Platform.OS !== 'web' && !nativeImageZoomed && imageViewport.scale <= 1.01,
    activeOffsetY: 8,
    failOffsetX: [-16, 16] as [number, number],
    failOffsetY: -8,
    maxPointers: 1,
    onGestureEvent: imageDismissEvent,
    onHandlerStateChange: settleImageDismissGesture,
  } satisfies PanGestureHandlerProps;
  useEffect(() => {
    if (Platform.OS !== 'web' || !viewingGallery) return undefined;
    const node = document.getElementById('image-viewer-gesture-area');
    if (!node) return undefined;
    const start = (event: TouchEvent) => {
      if (!(event.target instanceof Node) || !node.contains(event.target)) return;
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1 || imageViewport.scale > 1.01) return;
      imageDismissDrag.current = {
        active: true,
        axis: '',
        index: viewingGallery.index,
        startX: touch.pageX,
        startY: touch.pageY,
        lastY: touch.pageY,
        lastAt: Date.now(),
        velocity: 0,
        dx: 0,
      };
      imageDismissY.stopAnimation();
    };
    const move = (event: TouchEvent) => {
      const drag = imageDismissDrag.current;
      const touch = event.touches[0];
      if (!drag.active || !touch || event.touches.length !== 1) return;
      const dx = touch.pageX - drag.startX;
      const dy = touch.pageY - drag.startY;
      drag.dx = dx;
      if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
        drag.axis = dy > 0 && dy > Math.abs(dx) ? 'dismiss' : Math.abs(dx) > Math.abs(dy) ? 'gallery' : 'other';
      }
      if (drag.axis === 'dismiss') {
        event.preventDefault();
        const now = Date.now();
        drag.velocity = (touch.pageY - drag.lastY) / Math.max(1, now - drag.lastAt);
        drag.lastY = touch.pageY;
        drag.lastAt = now;
        imageDismissY.setValue(Math.max(0, dy));
      } else if (drag.axis === 'gallery') {
        event.preventDefault();
        imageViewerRef.current?.scrollTo({ x: viewportWidth * drag.index - dx, animated: false });
      }
    };
    const finish = () => {
      const drag = imageDismissDrag.current;
      if (!drag.active) return;
      drag.active = false;
      if (drag.axis === 'dismiss') {
        if (shouldDismissSheet(Math.max(0, drag.lastY - drag.startY), Math.max(0, drag.velocity))) dismissImageViewer();
        else settleImageViewer();
      } else if (drag.axis === 'gallery') {
        const next = Math.max(0, Math.min(viewingGallery.images.length - 1,
          Math.abs(drag.dx) >= viewportWidth * .18 ? drag.index + (drag.dx < 0 ? 1 : -1) : drag.index));
        if (next === drag.index) imageViewerRef.current?.scrollTo({ x: viewportWidth * drag.index, animated: !reduceMotion });
        else showGalleryImage(next);
      }
      drag.axis = '';
    };
    const cancel = () => {
      if (imageDismissDrag.current.axis === 'dismiss') settleImageViewer();
      if (imageDismissDrag.current.axis === 'gallery') imageViewerRef.current?.scrollTo({ x: viewportWidth * imageDismissDrag.current.index, animated: !reduceMotion });
      imageDismissDrag.current.active = false;
      imageDismissDrag.current.axis = '';
    };
    document.addEventListener('touchstart', start, { passive: true, capture: true });
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    document.addEventListener('touchend', finish, true);
    document.addEventListener('touchcancel', cancel, true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', finish, true);
      document.removeEventListener('touchcancel', cancel, true);
    };
  }, [dismissImageViewer, imageDismissY, imageViewport.scale, reduceMotion, settleImageViewer, showGalleryImage, viewingGallery, viewportWidth]);
  useEffect(() => {
    let current = true;
    setModelsLoading(true);
    setModelsError('');
    if (sessionStarting) return () => { current = false; };
    void loadModels(session.sessionId).then((available) => {
      if (!current) return;
      setModels(available.models);
      setPermissionModes(available.permissionModes);
    }, (reason) => {
      if (current) setModelsError(reason instanceof Error ? reason.message : 'Could not load models');
    }).finally(() => {
      if (current) setModelsLoading(false);
    });
    return () => { current = false; };
  }, [loadModels, session.sessionId, sessionStarting]);
  const reloadModels = useCallback(async (selectedModelId?: string) => {
    const available = await loadModels(session.sessionId);
    setModels(selectedModelId
      ? available.models.map((model) => ({ ...model, current: model.id === selectedModelId }))
      : available.models);
    setPermissionModes(available.permissionModes);
  }, [loadModels, session.sessionId]);
  const addAttachment = useCallback((attachment: MobileAttachment) => {
    composerInputRef.current?.insert([attachment]);
  }, []);
  const chooseMedia = useCallback(async () => {
    setMediaBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_MOBILE_ATTACHMENTS,
      });
      if (result.canceled || !result.assets.length) return;
      const picked: MobileAttachment[] = [];
      for (const asset of result.assets.slice(0, MAX_MOBILE_ATTACHMENTS)) {
        if (asset.type === 'video' || asset.mimeType?.startsWith('video/')) {
          const attachment = await pickedVideoAttachment(asset);
          appendMobileAttachment(picked, attachment);
          picked.push(attachment);
          continue;
        }
        let attachment: MobileAttachment;
        try {
          attachment = await pickedImageAttachment(asset);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('too large')) throw error;
          attachment = await pickedImageAttachment(asset, MOBILE_IMAGE_MAX_EDGE, MOBILE_IMAGE_RETRY_QUALITY);
        }
        appendMobileAttachment(picked, attachment);
        picked.push(attachment);
      }
      composerInputRef.current?.insert(picked, attachmentCount === 0);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not attach the image');
    } finally {
      setMediaBusy(false);
    }
  }, [attachmentCount, notify]);
  const chooseFile = useCallback(async () => {
    setMediaBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled) return;
      for (const asset of result.assets.slice(0, MAX_MOBILE_ATTACHMENTS)) addAttachment(await pickedDocumentAttachment(asset));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not attach the file');
    } finally {
      setMediaBusy(false);
    }
  }, [addAttachment, notify]);
  const takePhoto = useCallback(async () => {
    setMediaBusy(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error('Camera permission is needed to take a photo');
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: MOBILE_CAMERA_QUALITY });
      if (result.canceled || !result.assets[0]) return;
      const attachment = await pickedImageAttachment(result.assets[0], MOBILE_CAMERA_MAX_EDGE, MOBILE_CAMERA_QUALITY, true);
      composerInputRef.current?.insert([attachment], attachmentCount === 0);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not take the photo');
    } finally {
      setMediaBusy(false);
    }
  }, [attachmentCount, notify]);
  const closeAttachmentsThen = useCallback((action: () => void) => {
    if (Platform.OS === 'ios') pendingAttachmentAction.current = action;
    setAttachmentOpen(false);
    if (Platform.OS !== 'ios') action();
  }, []);
  const finishVoice = useCallback(async () => {
    if (finishingRecording.current) return;
    finishingRecording.current = true;
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    recordingTimer.current = null;
    setMediaBusy(true);
    try {
      if (recorder.getStatus().canRecord) await recorder.stop();
      if (!recorder.uri) throw new Error('The recording could not be saved');
      const uri = recorder.uri;
      const mimeType = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
      const durationMs = recorderState.durationMillis;
      setVoiceRecordingReady(false);
      setVoiceTranscribing(true);
      try {
        const transcript = await transcribeAudio(uri, mimeType, durationMs);
        composerInputRef.current?.submit(transcript);
      } catch {
        addAttachment(createMobileAttachment({
          type: 'audio',
          name: `voice-note.${mimeType === 'audio/webm' ? 'webm' : 'm4a'}`,
          mimeType,
          durationMs,
          dataUrl: await uriToDataUrl(uri, mimeType),
        }));
        notify('Could not transcribe. Voice note attached instead.');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not attach the recording');
    } finally {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setVoiceRecordingActive(false);
      setVoiceRecordingReady(false);
      setVoiceRecordingPaused(false);
      setVoiceTranscribing(false);
      finishingRecording.current = false;
      setMediaBusy(false);
    }
  }, [addAttachment, notify, recorder, recorderState.durationMillis, transcribeAudio]);
  const toggleVoice = useCallback(async () => {
    const generation = ++recordingGeneration.current;
    const cancelled = () => generation !== recordingGeneration.current;
    setVoiceLevels(EMPTY_VOICE_LEVELS);
    setVoiceRecordingReady(false);
    setVoiceRecordingPaused(false);
    setVoiceTranscribing(false);
    setVoiceRecordingActive(true);
    setMediaBusy(true);
    try {
      const [permission] = await Promise.all([
        Platform.OS === 'web' ? null : requestRecordingPermissionsAsync(),
        setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }),
      ]);
      if (cancelled()) {
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        return;
      }
      if (permission && !permission.granted) throw new Error('Microphone permission is needed to record a voice note');
      await recorder.prepareToRecordAsync();
      if (cancelled()) {
        await recorder.stop().catch(() => {});
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        return;
      }
      recorder.record();
      setVoiceRecordingReady(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      recordingTimer.current = setTimeout(() => void finishVoice(), VOICE_NOTE_MAX_MS);
    } catch (error) {
      if (cancelled()) return;
      if (recorder.getStatus().canRecord) await recorder.stop().catch(() => {});
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setVoiceRecordingActive(false);
      notify(error instanceof Error ? error.message : 'Could not start recording');
    } finally {
      setMediaBusy(false);
    }
  }, [finishVoice, notify, recorder]);
  const cancelVoice = useCallback(async () => {
    recordingGeneration.current += 1;
    setVoiceRecordingActive(false);
    setVoiceRecordingReady(false);
    setVoiceRecordingPaused(false);
    setVoiceTranscribing(false);
    setMediaBusy(true);
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    recordingTimer.current = null;
    try {
      if (recorder.getStatus().canRecord) await recorder.stop().catch(() => {});
      await setAudioModeAsync({ allowsRecording: false });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not cancel the recording');
    } finally {
      setMediaBusy(false);
    }
  }, [notify, recorder]);
  const toggleVoicePause = useCallback(() => {
    if (!voiceRecordingReady) return;
    if (voiceRecordingPaused) recorder.record();
    else recorder.pause();
    setVoiceRecordingPaused((paused) => !paused);
  }, [recorder, voiceRecordingPaused, voiceRecordingReady]);
  const scrollTimelineToEnd = useCallback((animated = false) => {
    if (deferTimelineScrollUntilKeyboardHide.current) return;
    const timeline = listRef.current;
    if (!timeline) return;
    const node = Platform.OS === 'web' ? timeline.getScrollableNode?.() : null;
    const offset = Math.max(0, node
      ? node.scrollHeight - node.clientHeight
      : timelineContentHeightRef.current - timelineViewportHeightRef.current);
    if (Math.abs(offset - (node ? node.scrollTop : timelineOffsetRef.current)) < 1) return;
    // Initial readiness must use the observed offset, not an unacknowledged request.
    if (timelineReadyRef.current) timelineOffsetRef.current = offset;
    timeline.scrollToOffset({ offset, animated });
  }, [listRef]);
  const scrollTimelineToStart = useCallback(() => {
    followLatest.current = false;
    timelineOffsetRef.current = 0;
    setNearBottom(false);
    setNearHistoryStart(true);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [listRef, setNearBottom]);
  const jumpToLatest = useCallback((animated = false) => {
    followLatest.current = true;
    setFirstJumpRevealed(false);
    setNearBottom(true);
    setNearHistoryStart(false);
    requestAnimationFrame(() => scrollTimelineToEnd(animated));
  }, [scrollTimelineToEnd, setNearBottom]);
  const finishTimelineGesture = useCallback(() => {
    timelineGestureEndTimerRef.current = null;
    timelineGestureActiveRef.current = false;
    if (timelineDistanceFromEndRef.current < 96) followLatest.current = true;
  }, []);
  const scheduleTimelineGestureEnd = useCallback(() => {
    if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
    timelineGestureEndTimerRef.current = setTimeout(finishTimelineGesture, 160);
  }, [finishTimelineGesture]);
  const jumpToFirst = useCallback(async () => {
    if (jumpingToFirst || historyLoading) return;
    const generation = ++jumpToFirstGeneration.current;
    const needsRemoteHistory = historyRequested ? historyHasMore : session.hasEarlierHistory;
    if (needsRemoteHistory && !online) {
      notify('Reconnect your computer to load the first message');
      return;
    }
    followLatest.current = false;
    historyRequestedRef.current = true;
    setNearBottom(false);
    setJumpingToFirst(true);
    setHistoryLoading(true);
    try {
      let before = historyRequested && Number.isSafeInteger(historyCursor) ? historyCursor! : undefined;
      let hasMore = needsRemoteHistory;
      let firstPage = !historyRequested;
      while (hasMore) {
        const result = await loadEarlierHistory(
          session.sessionId,
          before,
          firstPage && oldestAnchorItem ? {
            role: oldestAnchorItem.itemType || 'user_message',
            text: itemText(oldestAnchorItem).slice(0, 2_000),
            ...(Number.isFinite(oldestAnchorItem.startedAtMs)
              ? { timestamp: new Date(oldestAnchorItem.startedAtMs!).toISOString() }
              : {}),
          } : undefined,
          firstPage ? retainedConversationItems.length : undefined,
        );
        if (generation !== jumpToFirstGeneration.current) return;
        const items = Array.isArray(result.items)
          ? result.items.filter((item) => item && typeof item.itemId === 'string')
          : [];
        setEarlierItems((current) => Array.from(new Map(
          [...items, ...current].map((item) => [item.itemId, item]),
        ).values()));
        const nextBefore = Number.isSafeInteger(result.nextCursor) ? result.nextCursor! : undefined;
        if (result.hasMore === true && (nextBefore === undefined || nextBefore === before)) {
          throw new Error('Could not advance through conversation history');
        }
        before = nextBefore;
        hasMore = result.hasMore === true;
        setHistoryRequested(true);
        setHistoryCursor(before ?? null);
        setHistoryHasMore(hasMore);
        firstPage = false;
      }
      setTimelineItemLimit(Number.MAX_SAFE_INTEGER);
      pendingScrollToFirst.current = true;
      requestAnimationFrame(() => requestAnimationFrame(scrollTimelineToStart));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load the first message');
    } finally {
      if (generation === jumpToFirstGeneration.current) {
        setJumpingToFirst(false);
        setHistoryLoading(false);
      }
    }
  }, [historyCursor, historyHasMore, historyLoading, historyRequested, jumpingToFirst, loadEarlierHistory, notify, oldestAnchorItem, online, retainedConversationItems.length, scrollTimelineToStart, session.hasEarlierHistory, session.sessionId, setNearBottom]);
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      if (!deferTimelineScrollUntilKeyboardHide.current) return;
      deferTimelineScrollUntilKeyboardHide.current = false;
      requestAnimationFrame(() => scrollTimelineToEnd(false));
    });
    return () => hidden.remove();
  }, [scrollTimelineToEnd]);
  const sendComposer = useCallback(() => {
    deferTimelineScrollUntilKeyboardHide.current = Platform.OS === 'ios' && Keyboard.isVisible();
    composerInputRef.current?.submit();
  }, []);
  const settleInitialTimeline: () => void = useCallback(() => {
    if (initialHistoryLoadingRef.current || timelineReadyRef.current) return;
    if (timelineSettleTimer.current) clearTimeout(timelineSettleTimer.current);
    if (timelineSettleFrame.current !== null) cancelAnimationFrame(timelineSettleFrame.current);
    timelineSettleTimer.current = setTimeout(() => {
      if (initialHistoryLoadingRef.current) return;
      timelineSettleFrame.current = requestAnimationFrame(() => {
        const node = Platform.OS === 'web' ? listRef.current?.getScrollableNode?.() : null;
        const distanceFromEnd = () => node
          ? node.scrollHeight - node.clientHeight - node.scrollTop
          : timelineContentHeightRef.current - timelineViewportHeightRef.current - timelineOffsetRef.current;
        const needsScroll = distanceFromEnd() > 1;
        scrollTimelineToEnd(false);
        // Scrolling can render another batch; let its measurements settle too.
        if (needsScroll) {
          settleInitialTimeline();
          return;
        }
        timelineSettleFrame.current = requestAnimationFrame(() => {
          if (distanceFromEnd() > 1) {
            settleInitialTimeline();
            return;
          }
          timelineReadyRef.current = true;
          setTimelineReady(true);
          if (
            onlineRef.current
            && hasEarlierHistoryRef.current
            && !historyRequestedRef.current
            && timelineContentHeightRef.current <= timelineViewportHeightRef.current + 96
          ) {
            void requestEarlierHistoryRef.current(true);
          }
        });
      });
    }, 100);
  }, [listRef, scrollTimelineToEnd]);
  useEffect(() => {
    followLatest.current = true;
    timelineGestureActiveRef.current = false;
    if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
    timelineGestureEndTimerRef.current = null;
    setFirstJumpRevealed(false);
    setNearBottom(true);
    setNearHistoryStart(false);
    setJumpingToFirst(false);
    setTimelineItemLimit(INITIAL_TIMELINE_ITEM_LIMIT);
    timelineOffsetRef.current = 0;
    timelineReadyRef.current = false;
    setTimelineReady(false);
    if (initialHistoryLoading) return undefined;
    settleInitialTimeline();
    return () => {
      if (timelineSettleTimer.current) clearTimeout(timelineSettleTimer.current);
      if (timelineSettleFrame.current !== null) cancelAnimationFrame(timelineSettleFrame.current);
      if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
    };
  }, [initialHistoryLoading, session.sessionId, setNearBottom, settleInitialTimeline]);
  useEffect(() => () => {
    jumpToFirstGeneration.current += 1;
    pendingScrollToFirst.current = false;
  }, []);
  useEffect(() => {
    if (
      !online
      || !timelineReadyRef.current
      || !hasEarlierHistoryRef.current
      || historyRequestedRef.current
      || timelineContentHeightRef.current > timelineViewportHeightRef.current + 96
    ) return;
    void requestEarlierHistoryRef.current(true);
  }, [online, session.hasEarlierHistory]);
  useEffect(() => {
    timelineReveal.stopAnimation();
    if (!timelineReady) {
      timelineReveal.setValue(0);
      return undefined;
    }
    if (reduceMotion) {
      timelineReveal.setValue(1);
      return undefined;
    }
    timelineReveal.setValue(0);
    const animation = Animated.timing(timelineReveal, {
      toValue: 1,
      duration: 360,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, timelineReady, timelineReveal]);
  // On web neither onScrollBeginDrag nor wheel gestures reach the FlatList, so
  // user scrolls towards older messages must release followLatest here. Without
  // this, throttled onScroll events with a stale offset would be the only
  // release path and they also fire during programmatic autoscrolls.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = listRef.current?.getScrollableNode?.();
    if (!node?.addEventListener) return undefined;
    let touchStartY: number | null = null;
    let touchHistoryGestureActive = false;
    let wheelGestureActive = false;
    let wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
    const disengage = () => {
      if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
      timelineGestureEndTimerRef.current = null;
      timelineGestureActiveRef.current = true;
      followLatest.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > 2) composerInputRef.current?.blur();
      if (event.deltaY < -2) {
        if (!wheelGestureActive) historyScrollGesture.current = true;
        wheelGestureActive = true;
        if (wheelGestureTimer) clearTimeout(wheelGestureTimer);
        wheelGestureTimer = setTimeout(() => {
          wheelGestureActive = false;
        }, 160);
        disengage();
        scheduleTimelineGestureEnd();
        if (node.scrollTop < 96) autoLoadEarlierTimelineRef.current();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
      touchHistoryGestureActive = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchStartY !== null && y !== undefined && Math.abs(y - touchStartY) > 8) composerInputRef.current?.blur();
      if (touchStartY !== null && y !== undefined && y - touchStartY > 8) {
        if (!touchHistoryGestureActive) historyScrollGesture.current = true;
        touchHistoryGestureActive = true;
        disengage();
        if (node.scrollTop < 96) autoLoadEarlierTimelineRef.current();
      }
    };
    const onTouchEnd = () => scheduleTimelineGestureEnd();
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      if (wheelGestureTimer) clearTimeout(wheelGestureTimer);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [listRef, scheduleTimelineGestureEnd]);
  useEffect(() => {
    if (!voiceRecordingActive || voiceRecordingPaused) return;
    const metering = recorderState.metering;
    const level = metering === undefined
      ? .25 + (Math.sin(recorderState.durationMillis / 90) + 1) * .22
      : Math.max(.08, Math.min(1, (metering + 60) / 60));
    setVoiceLevels((levels) => [...levels.slice(1), level]);
  }, [recorderState.durationMillis, recorderState.metering, voiceRecordingActive, voiceRecordingPaused]);
  useEffect(() => () => {
    recordingGeneration.current += 1;
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
  }, []);
  const renderTimelineItem = useCallback((info: ListRenderItemInfo<RuntimeItem>) => (
    <TimelineItem info={info} items={visibleItems} coordinationItems={info.index === coordinationAnchorIndex ? coordinationItems : []} activeTurnId={session.currentTurn?.turnId} sessionRunning={running && visiblePending.length === 0} openWorkByDefault={session.agent === 'grok'} sessionId={session.sessionId} resolveImageReference={resolveImageReference} openImage={openImage} openPreview={openPreview} online={online} colors={colors} dark={dark} desktopWeb={desktopWeb} reduceMotion={reduceMotion} styles={styles} />
  ), [colors, coordinationAnchorIndex, coordinationItems, dark, desktopWeb, openImage, openPreview, online, reduceMotion, resolveImageReference, running, session.agent, session.currentTurn?.turnId, session.sessionId, styles, visibleItems, visiblePending.length]);
  const loadEarlierTimeline = useCallback(() => {
    if (hasEarlierCachedItems) {
      setTimelineItemLimit((current) => current + INITIAL_TIMELINE_ITEM_LIMIT);
      return;
    }
    void requestEarlierHistory();
  }, [hasEarlierCachedItems, requestEarlierHistory]);
  const autoLoadEarlierTimeline = useCallback(() => {
    if (!historyScrollGesture.current) return;
    historyScrollGesture.current = false;
    loadEarlierTimeline();
  }, [loadEarlierTimeline]);
  autoLoadEarlierTimelineRef.current = autoLoadEarlierTimeline;
  const layoutTimeline = useCallback(({ nativeEvent }: { nativeEvent: { layout: { height: number } } }) => {
    timelineViewportHeightRef.current = nativeEvent.layout.height;
    settleInitialTimeline();
    if (timelineReadyRef.current && followLatest.current) scrollTimelineToEnd(false);
  }, [scrollTimelineToEnd, settleInitialTimeline]);
  const beginTimelineDrag = useCallback(() => {
    if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
    timelineGestureEndTimerRef.current = null;
    timelineGestureActiveRef.current = true;
    timelineDragStartRef.current = timelineOffsetRef.current;
    followLatest.current = false;
    historyScrollGesture.current = true;
    if (timelineOffsetRef.current < 96) autoLoadEarlierTimeline();
  }, [autoLoadEarlierTimeline]);
  const endTimelineDrag = useCallback(() => scheduleTimelineGestureEnd(), [scheduleTimelineGestureEnd]);
  const beginTimelineMomentum = useCallback(() => {
    if (timelineGestureEndTimerRef.current) clearTimeout(timelineGestureEndTimerRef.current);
    timelineGestureEndTimerRef.current = null;
    timelineGestureActiveRef.current = true;
  }, []);
  const scrollTimeline = useCallback(({ nativeEvent }: {
    nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } };
  }) => {
    const offset = nativeEvent.contentOffset.y;
    timelineOffsetRef.current = offset;
    const distance = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - offset;
    timelineDistanceFromEndRef.current = distance;
    if (timelineGestureActiveRef.current && timelineGestureEndTimerRef.current) scheduleTimelineGestureEnd();
    if (!followLatest.current) setFirstJumpRevealed(Math.max(distance, timelineDragStartRef.current - offset) >= 96);
    const latest = followLatest.current || distance < 96;
    setNearBottom(latest);
    if (timelineReadyRef.current) {
      const atStart = nativeEvent.contentOffset.y < 96;
      setNearHistoryStart(atStart && !followLatest.current);
      if (atStart && !followLatest.current && !historyRequested && session.hasEarlierHistory) setHistoryHasMore(true);
    }
    if (!timelineGestureActiveRef.current && latest) followLatest.current = true;
  }, [historyRequested, scheduleTimelineGestureEnd, session.hasEarlierHistory, setNearBottom]);
  const resizeTimeline = useCallback((_width: number, height: number) => {
    timelineContentHeightRef.current = height;
    if (pendingScrollToFirst.current) {
      pendingScrollToFirst.current = false;
      requestAnimationFrame(scrollTimelineToStart);
      return;
    }
    if (!timelineReadyRef.current) return settleInitialTimeline();
    if (followLatest.current) requestAnimationFrame(() => {
      if (followLatest.current) scrollTimelineToEnd(false);
    });
  }, [scrollTimelineToEnd, scrollTimelineToStart, settleInitialTimeline]);
  const leaveChat = useCallback(() => {
    if (!back) return;
    jumpToFirstGeneration.current += 1;
    pendingScrollToFirst.current = false;
    back();
  }, [back]);
  const renderConfigControls = () => <>
    <Pressable accessibilityRole="button" accessibilityLabel="Change model" accessibilityValue={{ text: activeModel?.name || session.model || 'Default' }} onPress={(event) => openConfig('model', event)} style={({ pressed }) => [styles.composerConfigChip, pressed && styles.pressed]}>
      <AgentIcon agent={session.agent} size={18} styles={styles} />
      <Text numberOfLines={1} style={styles.composerConfigValue}>{activeModel?.name || session.model || 'Default'}</Text>
    </Pressable>
    {reasoning ? <Pressable accessibilityRole="button" accessibilityLabel="Change reasoning" accessibilityValue={{ text: effortLabel }} onPress={(event) => openConfig('effort', event)} style={({ pressed }) => [styles.composerConfigChip, pressed && styles.pressed]}>
      <UiIcon name="brain" size={14} color={colors.accent} />
      <Text style={styles.composerConfigValue}>{desktopWeb ? `Reasoning · ${effortLabel}` : effortLabel}</Text>
    </Pressable> : null}
    {speed?.options?.length ? <Pressable accessibilityRole="button" accessibilityLabel="Change speed" accessibilityValue={{ text: String(speedLabel) }} onPress={(event) => openConfig('serviceTier', event)} style={({ pressed }) => [styles.composerConfigChip, pressed && styles.pressed]}>
      <UiIcon name="gauge" size={14} color={colors.accent} />
      <Text style={styles.composerConfigValue}>{desktopWeb ? `Speed · ${speedLabel}` : speedLabel}</Text>
    </Pressable> : null}
    {permissionModes.length ? <Pressable accessibilityRole="button" accessibilityLabel="Change permissions" accessibilityValue={{ text: permissionLabel }} onPress={(event) => openConfig('permissionMode', event)} style={({ pressed }) => [styles.composerConfigChip, pressed && styles.pressed]}>
      <View style={[styles.composerConfigDot, { backgroundColor: colors.success }]} />
      <Text style={styles.composerConfigValue}>{permissionLabel}</Text>
    </Pressable> : null}
    {!desktopWeb || usedTokens > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="View context usage" accessibilityValue={{ text: contextLabel }} onPress={(event) => openConfig('context', event)} style={({ pressed }) => [styles.composerConfigChip, pressed && styles.pressed]}>
      {desktopWeb ? <View style={styles.composerContextUsage}>
        <Text style={styles.composerConfigValue}>{contextLabel}</Text>
        <View testID="composer-context-gauge" accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: contextPercent }} style={styles.composerContextTrack}>
          <View style={[styles.composerContextFill, { width: `${contextPercent}%` as `${number}%` }]} />
        </View>
      </View> : <Text style={styles.composerConfigValue}>{maxTokens ? `${contextPercent}%` : 'Context'}</Text>}
    </Pressable> : null}
  </>;
  const renderComposerInput = () => <View style={{ flex: desktopWeb ? undefined : 1, minWidth: 0, width: desktopWeb ? '100%' : undefined }}>
    <InlineComposer
      ref={composerInputRef}
      dom={{ matchContents: true, containerStyle: { flex: 0, minHeight: 42 }, scrollEnabled: false, keyboardDisplayRequiresUserAction: false, hideKeyboardAccessoryView: true, style: { backgroundColor: 'transparent' } }}
      onFocus={async () => setSelectedMessageId(null)}
      onReady={async () => {
        setComposerReady(true);
        return composerDrafts.current.get(session.sessionId) || { parts: [], attachments: [] };
      }}
      label={`Message ${agent.label}`}
      desktop={desktopWeb}
      native={Platform.OS !== 'web'}
      color={colors.text}
      accent={colors.accent}
      surface={colors.background}
      editable={canCompose}
      placeholder={canCompose ? `Message ${agent.label}…` : session.state === 'starting' ? `Starting ${agent.label}…` : 'Session stopped'}
      onChange={async (text, parts, updatedAttachments) => {
        const attachments = updatedAttachments || composerDrafts.current.get(session.sessionId)?.attachments || [];
        if (!parts.length && !attachments.length) composerDrafts.current.delete(session.sessionId);
        else composerDrafts.current.set(session.sessionId, { parts, attachments });
        setHasComposerText(Boolean(text.trim()));
        setAttachmentCount(attachments.length);
      }}
      onSubmit={async (text, outgoing) => {
        jumpToLatest(false);
        return send(outgoing, text);
      }}
      onError={async (message) => notify(message)}
      onEdit={(attachment) => new Promise((resolve) => {
        imageEditResult.current?.(null);
        imageEditResult.current = resolve;
        setEditingImage({ attachment });
      })}
    />
  </View>;
  const renderAttachmentButton = () => <ComposerButton dark={dark} reduceMotion={reduceMotion} accessibilityRole="button" accessibilityLabel="Add attachments" disabled={!canCompose || !composerReady || mediaBusy} onPress={(event) => {
    if (Platform.OS === 'web') {
      anchorWebFilePicker(event.currentTarget);
      void chooseMedia();
      return;
    }
    composerInputRef.current?.blur();
    setAttachmentOpen(true);
  }} style={({ pressed }) => [styles.composerTool, pressed && styles.pressed, (!canCompose || mediaBusy) && styles.disabled]}>
    <UiIcon name={desktopWeb ? 'paperclip' : 'plus'} size={desktopWeb ? 21 : 23} color={colors.secondary} />
  </ComposerButton>;
  const renderVoiceButton = () => <ComposerButton dark={dark} reduceMotion={reduceMotion} accessibilityRole="button" accessibilityLabel="Record voice note" disabled={!canCompose || mediaBusy} onPress={() => void toggleVoice()} style={({ pressed }) => [styles.composerTool, pressed && styles.pressed, (!canCompose || mediaBusy) && styles.disabled]}>
    <UiIcon name="mic" size={21} color={colors.secondary} />
  </ComposerButton>;
  const renderSendButton = () => running && !hasComposerText && !attachmentCount ? (
    <ComposerButton dark={dark} reduceMotion={reduceMotion} accessibilityRole="button" accessibilityLabel="Stop current response" disabled={!interactive} onPress={interrupt} style={({ pressed }) => [styles.interruptButton, pressed && styles.pressed, !interactive && styles.disabled]}>
      <View style={styles.stopSquare} />
    </ComposerButton>
  ) : <ComposerButton dark={dark} reduceMotion={reduceMotion} accessibilityRole="button" accessibilityLabel="Send message" disabled={!canCompose || (!hasComposerText && !attachmentCount)} onPress={sendComposer} style={({ pressed }) => [styles.sendButton, pressed && styles.pressed, (!canCompose || (!hasComposerText && !attachmentCount)) && styles.disabled]}>
    <UiIcon name="arrow-up" size={20} color={colors.accentText} />
  </ComposerButton>;
  return (
    <MessageSelectionContext.Provider value={messageSelection}>
    <KeyboardAvoidingView
      style={styles.flex}
      onTouchStart={() => setSelectedMessageId(null)}
      behavior={Platform.OS === 'ios' ? 'height' : 'padding'}
      keyboardVerticalOffset={keyboardOffset}
    >
      {!desktopWeb ? <View testID="chat-header" style={styles.chatHeader}>
        {back ? <Pressable accessibilityRole="button" accessibilityLabel="Back to sessions" onPress={leaveChat} style={styles.backButton}><UiIcon name="chevron-left" size={23} color={colors.text} /></Pressable> : <View style={styles.startingChatHeaderEdge} />}
        <View style={styles.chatHeaderIdentity}>
          <View style={styles.chatHeaderMarks}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Change agent status: ${currentStatus.label}`}
              disabled={!interactive}
              onPress={() => setStatusOpen(true)}
              style={({ pressed }) => [styles.chatHeaderStatus, pressed && styles.rowPressed]}
            >
              <BarberPoleRail testID="activity-status-rail" color={currentStatus.color} working={currentStatus.key === 'working'} style={styles.chatHeaderStatusRail} />
            </Pressable>
            <View style={styles.chatHeaderIcons}><ProjectIcon project={project} size={32} styles={styles} /><View style={styles.chatAgentIcon}><AgentIcon agent={session.agent} size={19} styles={styles} /></View></View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open current activity: ${sessionTitle(session)}. ${activity}`} accessibilityHint={`${agent.label}. ${demoMode ? 'Sample workspace' : online ? 'Live' : offline ? 'Offline' : 'Connecting'}`} onPress={() => setActivityOpen(true)} style={({ pressed }) => [styles.chatHeading, styles.chatHeadingButton, pressed && styles.rowPressed]}>
            <Text style={styles.chatTitle} numberOfLines={1}>{sessionTitle(session)}</Text>
            <View style={styles.chatSubtitleRow}>
              {!demoMode ? <View accessible accessibilityLabel={`${session.state === 'starting' ? 'Starting' : online ? 'Live' : offline ? 'Offline' : 'Connecting'} · ${agent.label}`} testID="chat-connection-dot" style={[styles.chatConnectionDot, { backgroundColor: online ? colors.success : colors.muted }]} /> : null}
              <Text style={styles.chatSubtitle} numberOfLines={1}>{activity}</Text>
            </View>
          </Pressable>
        </View>
        <View style={styles.chatHeaderActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Conversation settings" onPress={() => setConversationOpen(true)} style={styles.moreButton}><Text style={styles.moreButtonText}>•••</Text></Pressable>
        </View>
        {session.state === 'starting' ? <ProgressRail colors={colors} reduceMotion={reduceMotion} testID="chat-starting-progress-rail" style={styles.headerProgressRail} /> : null}
      </View> : null}
      {offline && showConnectionNotice ? <View style={styles.connectionBanner}><Text style={styles.connectionBannerText}>{hostLabel} offline. Messages will send when it reconnects.</Text></View> : null}
      {session.state === 'stopped' ? <View style={styles.connectionBanner}><Text style={styles.connectionBannerText}>Session stopped. History is read-only.</Text></View> : null}
      <View style={styles.timelineFrame}>
        <Animated.View style={[styles.flex, {
          opacity: timelineReveal,
          transform: [{ translateY: timelineReveal.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        }]}>
        <FlatList
          testID="chat-timeline"
          ref={listRef}
          data={visibleItems}
          accessibilityElementsHidden={!timelineReady}
          importantForAccessibility={timelineReady ? 'auto' : 'no-hide-descendants'}
          keyboardDismissMode={Platform.OS === 'web' ? 'none' : KEYBOARD_DISMISS_MODE}
          {...(Platform.OS === 'web' && viewportWidth >= WEB_SPLIT_BREAKPOINT ? { onContextMenu: openChatContextMenu } as any : {})}
          keyExtractor={timelineItemKey}
          renderItem={renderTimelineItem}
          style={[styles.flex, !timelineReady && styles.timelineHidden]}
          contentContainerStyle={[styles.timeline, desktopWeb && styles.timelineDesktop, showFirstJump && styles.timelineWithFirst]}
          onLayout={layoutTimeline}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={beginTimelineDrag}
          onScrollEndDrag={endTimelineDrag}
          onMomentumScrollBegin={beginTimelineMomentum}
          onMomentumScrollEnd={scheduleTimelineGestureEnd}
          onScroll={scrollTimeline}
          onStartReached={followLatest.current ? undefined : autoLoadEarlierTimeline}
          onStartReachedThreshold={0.15}
          scrollEventThrottle={100}
          onContentSizeChange={resizeTimeline}
          maintainVisibleContentPosition={Platform.OS === 'web' || nearBottom ? undefined : { minIndexForVisible: 0 }}
          ListHeaderComponent={nearHistoryStart && (hasEarlierCachedItems || (online && historyHasMore)) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Load earlier messages"
              disabled={historyLoading}
              onPress={loadEarlierTimeline}
              style={({ pressed }) => [styles.historyLoadButton, pressed && styles.rowPressed]}
            >
              <Text style={styles.historyLoadButtonText}>{historyLoading ? 'Loading…' : 'Load earlier messages'}</Text>
            </Pressable>
          ) : null}
          ListEmptyComponent={visiblePending.length || coordinationItems.length ? null : <ChatEmptyState agent={session.agent || undefined} project={project} desktopWeb={desktopWeb} connecting={session.state === 'starting' || reconnecting} opening={reconnecting} colors={colors} dark={dark} stopped={session.state === 'stopped'} hasEarlierHistory={session.hasEarlierHistory} online={online} styles={styles} reduceMotion={reduceMotion} />}
          ListFooterComponent={(
          <View>
            {coordinationItems.length && coordinationAnchorIndex < 0 ? <SessionCoordinationCluster items={coordinationItems} colors={colors} reduceMotion={reduceMotion} styles={styles} fallback /> : null}
            {visiblePending.map((message) => (
              <MessageEntrance key={message.id} createdAtMs={message.createdAtMs} kind="user" reduceMotion={reduceMotion} testID="pending-message-entry">
                <View style={[styles.messageRow, styles.userRow]}>
                  <View style={[styles.userBubble, message.failed && styles.failedBubble]}>
                  <AttachmentMessage text={message.text} attachments={message.attachments} open={openImage} desktopWeb={desktopWeb} styles={styles} />
                  {message.failed || message.queued || (message.attachments.length > 0 && (message.progress || 0) < 1) ? <View style={styles.pendingStatusRow}>
                    <Text style={[styles.pendingLabel, message.failed && styles.pendingFailed]}>
                      {message.failed
                        ? 'Not sent'
                        : message.queued
                          ? online ? 'Sending…' : 'Waiting for connection'
                        : `Uploading ${Math.round((message.progress || 0) * 100)}%`}
                    </Text>
                    {message.failed ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`Retry ${message.text || message.attachments[0]?.name || 'failed message'}`} onPress={() => retryPending(message)} style={styles.pendingRetry}>
                        <Text style={styles.pendingRetryText}>Retry</Text>
                      </Pressable>
                    ) : null}
                  </View> : null}
                  {message.attachments.length > 0 && !message.failed && !message.queued && (message.progress || 0) < 1 ? (
                    <View testID="pending-upload-progress" accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round((message.progress || 0) * 100) }} style={styles.pendingProgressTrack}>
                      <View style={[styles.pendingProgressFill, { width: `${Math.round((message.progress || 0) * 100)}%` }]} />
                    </View>
                  ) : null}
                  </View>
                  <TimelineTime atMs={message.createdAtMs} label="Sent at" testID={`pending-message-time-${message.id}`} styles={styles} />
                </View>
              </MessageEntrance>
            ))}
            {showThinking ? <ActivityCue label="Thinking" state="solving" dark={dark} reduceMotion={reduceMotion} testID="thinking-indicator" styles={styles} /> : null}
            {session.pendingRequests.map((request) => (
              <ApprovalCard
                key={request.requestId}
                request={request}
                styles={styles}
                disabled={!interactive}
                decide={(decision) => void run({
                  type: 'request.respond',
                  sessionId: session.sessionId,
                  payload: { requestId: request.requestId, decision },
                })}
              />
            ))}
            {session.pendingQuestions.map((question) => (
              <QuestionCard
                key={question.requestId}
                request={question}
                colors={colors}
                styles={styles}
                disabled={!interactive}
                draft={drafts[question.requestId] || {}}
                update={(next) => setDrafts((current) => ({ ...current, [question.requestId]: next }))}
                submit={() => {
                  const draft = drafts[question.requestId] || {};
                  const answers = Object.fromEntries((question.questions || []).map((entry) => {
                    const answer = draft[entry.id] || { values: [], custom: '' };
                    const values = [...answer.values, ...(answer.custom.trim() ? [answer.custom.trim()] : [])];
                    return [entry.id, { values }];
                  }));
                  void run({
                    type: 'question.respond',
                    sessionId: session.sessionId,
                    payload: { requestId: question.requestId, decision: 'submit', answers },
                  });
                }}
                decline={() => void run({
                  type: 'question.respond',
                  sessionId: session.sessionId,
                  payload: { requestId: question.requestId, decision: 'decline', answers: {} },
                })}
              />
            ))}
          </View>
          )}
        />
        </Animated.View>
        {showFirstJump ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={jumpingToFirst ? 'Finding first message' : 'Jump to first message'}
            disabled={jumpingToFirst || historyLoading}
            onPress={() => void jumpToFirst()}
            style={({ pressed }) => [styles.firstButton, pressed && styles.rowPressed, (jumpingToFirst || historyLoading) && styles.disabled]}
          >
            <UiIcon name="arrow-up" size={16} color={colors.text} />
            <Text style={styles.firstText}>{jumpingToFirst ? 'Finding…' : 'First'}</Text>
          </Pressable>
        ) : null}
        {!timelineReady ? <ChatTimelineSkeleton overlay reduceMotion={reduceMotion} styles={styles} testID="chat-timeline-skeleton" /> : null}
      </View>
      {timelineReady && !nearBottom ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest message" onPress={() => jumpToLatest(false)} style={[styles.latestButton, { bottom: composerHeight + 10 + (Platform.OS === 'web' ? WEB_COMPOSER_GAP : 0) }]}>
          <UiIcon name="arrow-down" size={16} color={colors.text} /><Text style={styles.latestText}>Latest</Text>
        </Pressable>
      ) : null}
      <View onLayout={({ nativeEvent }) => setComposerHeight(Math.ceil(nativeEvent.layout.height))} style={[styles.composerRegion, desktopWeb && styles.composerRegionDesktop]}>
        {latestTodoItem ? <TodoListCard colors={colors} item={latestTodoItem} styles={styles} /> : null}
        {voiceRecordingActive ? (
          <View testID="voice-recording" style={styles.recordingBar}>
            {!voiceTranscribing ? <RecordingWakeLock /> : null}
            <View style={styles.recordingTrack}>
              <ThinkingOrb state="listening" dark={dark} reduceMotion={reduceMotion} size={20} testID="voice-listening-orb" />
              <Text style={styles.recordingMode}>Listening</Text>
              <Text style={styles.recordingText}>{voiceTranscribing ? 'Transcribing…' : voiceRecordingReady ? formatDuration(recorderState.durationMillis) : 'Starting…'}</Text>
              <View testID="voice-wave" style={styles.recordingWave}>
                {voiceLevels.map((level, index) => <View key={index} testID="voice-wave-bar" style={[styles.voiceWaveBar, { height: Math.max(4, Math.round(level * 28)) }]} />)}
              </View>
            </View>
            <View style={styles.recordingActions}>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete voice note" disabled={voiceTranscribing} onPress={() => void cancelVoice()} style={({ pressed }) => [styles.recordingAction, pressed && styles.pressed, voiceTranscribing && styles.disabled]}><UiIcon name="trash" size={23} color={colors.secondary} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={voiceRecordingPaused ? 'Resume recording' : 'Pause recording'} disabled={!voiceRecordingReady || voiceTranscribing} onPress={toggleVoicePause} style={({ pressed }) => [styles.recordingPause, pressed && styles.pressed, (!voiceRecordingReady || voiceTranscribing) && styles.disabled]}><UiIcon name={voiceRecordingPaused ? 'play' : 'pause'} size={22} color={colors.text} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={voiceTranscribing ? 'Transcribing voice note' : 'Transcribe voice note'} disabled={!voiceRecordingReady || voiceTranscribing} onPress={() => void finishVoice()} style={({ pressed }) => [styles.recordingDone, pressed && styles.pressed, (!voiceRecordingReady || voiceTranscribing) && styles.disabled]}><UiIcon name="arrow-up" size={22} color={colors.accentText} /></Pressable>
            </View>
          </View>
        ) : null}
        <View>
          {desktopWeb && !voiceRecordingActive ? (
            <Pressable
              testID="chat-context-tray"
              accessibilityRole="button"
              accessibilityLabel="Open current activity"
              onPress={() => setActivityOpen(true)}
              style={({ pressed }) => [styles.desktopContextTray, pressed && styles.rowPressed]}
            >
              <BarberPoleRail testID="composer-activity-status-rail" color={currentStatus.color} working={currentStatus.key === 'working'} style={styles.desktopContextRail} />
              <Text numberOfLines={1} style={styles.desktopContextTitle}>{sessionTitle(session)}</Text>
              <View style={styles.desktopContextDivider} />
              <MotionRise reduceMotion={reduceMotion} replayKey={activity} distance={6} duration={260} style={styles.desktopContextActivityMotion}>
                <Text numberOfLines={1} style={styles.desktopContextActivity}>{activity}</Text>
              </MotionRise>
            </Pressable>
          ) : null}
          <View testID={desktopWeb ? 'chat-composer' : undefined} style={desktopWeb ? styles.composerDesktop : undefined}>
            <View testID={!desktopWeb ? 'chat-composer' : undefined} style={!desktopWeb ? styles.composerRow : undefined}>
              {!desktopWeb && !voiceRecordingActive ? renderAttachmentButton() : null}
              {renderComposerInput()}
              {!desktopWeb && !voiceRecordingActive ? <ComposerTrailingActions>
                {renderVoiceButton()}
                {renderSendButton()}
              </ComposerTrailingActions> : null}
            </View>
            {desktopWeb ? !voiceRecordingActive && <View style={styles.composerDesktopFooter}>
              {renderAttachmentButton()}
              <ScrollView
                horizontal
                testID="chat-provider-controls"
                keyboardDismissMode={KEYBOARD_DISMISS_MODE}
                showsHorizontalScrollIndicator={false}
                style={styles.composerDesktopControls}
                contentContainerStyle={[styles.composerConfigStrip, styles.composerConfigStripDesktop]}
              >
                {renderConfigControls()}
              </ScrollView>
              {renderVoiceButton()}
              {renderSendButton()}
            </View> : null}
          </View>
        </View>
      </View>
      <ActivitySheet open={activityOpen} close={() => setActivityOpen(false)} session={session} activity={activity} terminalStatuses={terminalStatuses} desktopWeb={desktopWeb} styles={styles} reduceMotion={reduceMotion} />
      <Modal visible={Boolean(viewingGallery)} transparent animationType={Platform.OS === 'web' ? 'none' : 'fade'} onRequestClose={closeImageViewer}>
        <GestureHandlerRootView style={styles.imageViewerShell}>
          <Animated.View testID="image-viewer-backdrop" pointerEvents="none" style={[styles.imageViewerBackdrop, { opacity: imageDismissY.interpolate({
            inputRange: [0, viewportHeight * .25, viewportHeight],
            outputRange: [1, 1, 0],
            extrapolate: 'clamp',
          }) }]} />
          <View testID="image-viewer-content" style={styles.imageViewer}>
          <Animated.View style={[styles.imageViewerHeader, { opacity: imageChromeOpacity }]}>
            <Text numberOfLines={1} style={styles.imageViewerTitle}>{viewingGallery?.images[viewingGallery.index]?.name || 'Image'}</Text>
            {viewingGallery && viewingGallery.images.length > 1 ? <Text accessibilityLabel={`Image ${viewingGallery.index + 1} of ${viewingGallery.images.length}`} style={styles.imageViewerCount}>{viewingGallery.index + 1} / {viewingGallery.images.length}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Close image" onPress={closeImageViewer} style={styles.imageViewerClose}><UiIcon name="close-circle" size={27} color="#ffffff" /></Pressable>
          </Animated.View>
          <PanGestureHandler ref={imageDismissRef} {...imageDismissHandlers}>
          <Animated.View nativeID="image-viewer-gesture-area" testID="image-viewer-gesture-area" style={[styles.imageViewerGestureArea, { transform: [{ translateY: imageDismissY.interpolate({
            inputRange: [0, viewportHeight],
            outputRange: [0, viewportHeight],
            extrapolate: 'clamp',
          }) }] }]}>
          {viewingGallery ? <GestureScrollView
            ref={imageViewerRef}
            waitFor={imageDismissRef}
            disableScrollViewPanResponder
            horizontal
            keyboardDismissMode={KEYBOARD_DISMISS_MODE}
            pagingEnabled
            scrollEnabled={Platform.OS === 'ios' ? !nativeImageZoomed : imageViewport.scale === 1}
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: viewportWidth * viewingGallery.index, y: 0 }}
            onMomentumScrollEnd={({ nativeEvent }) => {
              const index = Math.round(nativeEvent.contentOffset.x / Math.max(1, viewportWidth));
              if (index === viewingGallery.index || !viewingGallery.images[index]) return;
              resetImageZoom();
              setViewingGallery((current) => current ? { ...current, index } : current);
              void loadFullImage(viewingGallery.images[index]);
            }}
            style={styles.imageViewerCarousel}
          >
            {viewingGallery.images.map((image, index) => {
              const active = index === viewingGallery.index;
              return <View
                key={`${image.attachmentId || image.name}-${index}`}
                onLayout={active ? ({ nativeEvent }) => { imageStageSizeRef.current = nativeEvent.layout; } : undefined}
                style={[styles.imageViewerPage, { width: viewportWidth }]}
              >
                {Platform.OS === 'ios' && active ? <GestureScrollView
                  testID="zoomable-gallery-image"
                  waitFor={imageDismissRef}
                  keyboardDismissMode={KEYBOARD_DISMISS_MODE}
                  minimumZoomScale={1}
                  maximumZoomScale={4}
                  pinchGestureEnabled
                  bouncesZoom
                  centerContent
                  directionalLockEnabled
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onScroll={({ nativeEvent }) => setNativeImageZoomed((nativeEvent.zoomScale || 1) > 1.01)}
                  style={styles.imageViewerNativeZoom}
                  contentContainerStyle={styles.imageViewerZoomSurface}
                >
                  {image.dataUrl ? <Image testID="full-size-gallery-image" source={{ uri: image.dataUrl }} resizeMode="contain" style={styles.imageViewerImage} /> : null}
                </GestureScrollView> : <View
                  testID={active ? 'zoomable-gallery-image' : undefined}
                  {...(active ? imageGesture.panHandlers : {})}
                  style={[styles.imageViewerZoomSurface, active && {
                    transform: [{ translateX: imageViewport.x }, { translateY: imageViewport.y }, { scale: imageViewport.scale }],
                    ...(Platform.OS === 'web' ? { touchAction: imageViewport.scale > 1 ? 'none' : 'pan-x' as any } : {}),
                  }]}
                >
                  {image.dataUrl ? <Image testID={active ? 'full-size-gallery-image' : undefined} source={{ uri: image.dataUrl }} resizeMode="contain" style={styles.imageViewerImage} /> : null}
                </View>}
              </View>;
            })}
          </GestureScrollView> : null}
          </Animated.View>
          </PanGestureHandler>
          {imageLoading ? <Text style={styles.imageViewerLoading}>Loading full image…</Text> : null}
          {Platform.OS === 'web' && viewingGallery ? <Animated.View style={[styles.imageViewerZoomControls, { opacity: imageChromeOpacity }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Zoom out image" disabled={imageViewport.scale <= 1} onPress={() => changeImageZoom(imageViewport.scale - .25)} style={[styles.imageViewerZoomButton, imageViewport.scale <= 1 && styles.disabled]}><Text style={styles.imageViewerZoomButtonText}>−</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Reset image zoom" onPress={resetImageZoom} style={styles.imageViewerZoomLevel}><Text style={styles.imageViewerZoomLevelText}>{Math.round(imageViewport.scale * 100)}%</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Zoom in image" disabled={imageViewport.scale >= 4} onPress={() => changeImageZoom(imageViewport.scale + .25)} style={[styles.imageViewerZoomButton, imageViewport.scale >= 4 && styles.disabled]}><Text style={styles.imageViewerZoomButtonText}>+</Text></Pressable>
          </Animated.View> : null}
          {viewingGallery && viewingGallery.images.length > 1 ? <Animated.View style={[styles.imageViewerControls, { opacity: imageChromeOpacity }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous image" disabled={viewingGallery.index === 0} onPress={() => showGalleryImage(viewingGallery.index - 1)} style={[styles.imageViewerArrow, viewingGallery.index === 0 && styles.disabled]}><UiIcon name="chevron-left" size={23} color="#ffffff" /></Pressable>
            <View style={styles.imageViewerDots}>{viewingGallery.images.map((_, index) => <View key={index} style={[styles.imageViewerDot, index === viewingGallery.index && styles.imageViewerDotActive]} />)}</View>
            <Pressable accessibilityRole="button" accessibilityLabel="Next image" disabled={viewingGallery.index === viewingGallery.images.length - 1} onPress={() => showGalleryImage(viewingGallery.index + 1)} style={[styles.imageViewerArrow, viewingGallery.index === viewingGallery.images.length - 1 && styles.disabled]}><UiIcon name="chevron-right" size={23} color="#ffffff" /></Pressable>
          </Animated.View> : null}
          </View>
        </GestureHandlerRootView>
      </Modal>
      <MobileImageEditor
        attachment={editingImage?.attachment || null}
        colors={colors}
        onDismiss={focusComposer}
        close={() => {
          imageEditResult.current?.(null);
          imageEditResult.current = null;
          setEditingImage(null);
        }}
        save={(edited) => {
          if (!editingImage) return;
          imageEditResult.current?.(edited);
          imageEditResult.current = null;
        }}
      />
      <BottomSheet
        open={attachmentOpen}
        onClose={() => setAttachmentOpen(false)}
        closeLabel="Close attachments"
        reduceMotion={reduceMotion}
        onDismiss={() => {
          const action = pendingAttachmentAction.current;
          pendingAttachmentAction.current = null;
          action?.();
        }}
        sheetStyle={[styles.configSheet, styles.attachmentSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={styles.modalLayout}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={styles.sheetTitle}>Add to message</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close attachments" onPress={() => setAttachmentOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <Text style={styles.sheetIntro}>Review everything before sending.</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Choose multiple photos or videos" onPress={(event) => { anchorWebFilePicker(event.currentTarget); closeAttachmentsThen(() => { void chooseMedia(); }); }} style={styles.conversationOption}>
              <View style={styles.conversationOptionIcon}><UiIcon name="image" size={18} color={colors.accent} /></View><View style={styles.conversationOptionCopy}><Text style={styles.conversationOptionTitle}>Photos &amp; videos</Text><Text style={styles.conversationOptionMeta}>Select several photos or videos at once</Text></View><Text style={styles.conversationOptionMeta}>Multiple</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Take a photo" onPress={(event) => { anchorWebFilePicker(event.currentTarget); closeAttachmentsThen(() => { void takePhoto(); }); }} style={styles.conversationOption}>
              <View style={styles.conversationOptionIcon}><UiIcon name="camera" size={18} color={colors.accent} /></View><View style={styles.conversationOptionCopy}><Text style={styles.conversationOptionTitle}>Camera</Text><Text style={styles.conversationOptionMeta}>Take a new photo</Text></View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Choose files" onPress={(event) => { anchorWebFilePicker(event.currentTarget); closeAttachmentsThen(() => { void chooseFile(); }); }} style={styles.conversationOption}>
              <View style={styles.conversationOptionIcon}><UiIcon name="file" size={18} color={colors.accent} /></View><View style={styles.conversationOptionCopy}><Text style={styles.conversationOptionTitle}>Files</Text><Text style={styles.conversationOptionMeta}>Documents and other attachments</Text></View><Text style={styles.conversationOptionMeta}>Multiple</Text>
            </Pressable>
      </BottomSheet>
      <BottomSheet
        open={conversationOpen && !desktopWeb}
        onClose={() => setConversationOpen(false)}
        closeLabel="Close conversation settings"
        reduceMotion={reduceMotion}
        testID="conversation-settings-sheet"
        handleTestID="conversation-settings-sheet-handle"
        sheetStyle={[styles.configSheet, styles.conversationSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={styles.modalLayout}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={styles.sheetTitle}>Conversation</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close conversation settings" onPress={() => setConversationOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <ScrollView keyboardDismissMode={KEYBOARD_DISMISS_MODE} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.conversationSheetScroll} contentContainerStyle={styles.conversationSheetContent}>
            <View testID="conversation-agent-hero" style={styles.conversationHeroBezel}>
              <View style={styles.conversationHero}>
                <Pressable accessibilityRole="button" accessibilityLabel="Change model" onPress={(event) => { setConversationOpen(false); openConfig('model', event); }} style={({ pressed }) => [styles.conversationModel, pressed && styles.pressed]}>
                  <View style={styles.conversationAgentHalo}><AgentIcon agent={session.agent} size={36} styles={styles} /></View>
                  <View style={styles.conversationHeroCopy}>
                    <Text style={styles.conversationHeroEyebrow}>{agentInfo(session.agent).label} · Model</Text>
                    <Text numberOfLines={1} style={styles.conversationHeroTitle}>{activeModel?.name || session.model || 'Default'}</Text>
                    <Text style={styles.conversationHeroMeta}>Tap to switch model</Text>
                  </View>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="View context usage" accessibilityHint={contextLabel} onPress={(event) => { setConversationOpen(false); openConfig('context', event); }} style={({ pressed }) => [styles.conversationContext, pressed && styles.pressed]}>
                  <Svg width={62} height={62} viewBox="0 0 62 62" accessibilityElementsHidden style={styles.conversationContextRing}>
                    <Circle cx="31" cy="31" r="24" fill="none" stroke={colors.subtle} strokeWidth="5" />
                    <Circle cx="31" cy="31" r="24" fill="none" stroke={colors.accent} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${contextRingLength} ${contextRingLength}`} strokeDashoffset={contextRingLength * (1 - contextPercent / 100)} rotation="-90" origin="31, 31" />
                  </Svg>
                  <View style={styles.conversationContextCopy}><Text style={styles.conversationContextValue}>{maxTokens ? `${contextPercent}%` : '—'}</Text><Text style={styles.conversationContextLabel}>Context</Text></View>
                </Pressable>
              </View>
            </View>
            <View testID="conversation-control-grid" style={styles.conversationControlGrid}>
              <Pressable accessibilityRole="button" accessibilityLabel="Change reasoning" accessibilityValue={{ text: effortLabel }} onPress={(event) => { setConversationOpen(false); openConfig('effort', event); }} style={({ pressed }) => [styles.conversationControlTile, pressed && styles.pressed]}>
                <View style={styles.conversationControlHeading}><Text style={styles.conversationControlLabel}>Thinking</Text><View style={styles.conversationControlIcon}><UiIcon name="brain" size={14} color={colors.accent} /></View></View>
                <Text numberOfLines={1} style={styles.conversationControlValue}>{effortLabel}</Text>
              </Pressable>
              {speed?.options?.length ? <Pressable accessibilityRole="button" accessibilityLabel="Change speed" accessibilityValue={{ text: String(speedLabel) }} onPress={(event) => { setConversationOpen(false); openConfig('serviceTier', event); }} style={({ pressed }) => [styles.conversationControlTile, pressed && styles.pressed]}>
                <View style={styles.conversationControlHeading}><Text style={styles.conversationControlLabel}>Speed</Text><View style={styles.conversationControlIcon}><UiIcon name="gauge" size={14} color={colors.accent} /></View></View>
                <Text numberOfLines={1} style={styles.conversationControlValue}>{speedLabel}</Text>
              </Pressable> : null}
            </View>
            {permissionModes.length ? <Pressable accessibilityRole="button" accessibilityLabel="Change permissions" onPress={(event) => { setConversationOpen(false); openConfig('permissionMode', event); }} style={({ pressed }) => [styles.conversationPermission, pressed && styles.pressed]}>
              <View style={styles.conversationPermissionIcon}><UiIcon name="shield" size={15} color={colors.accent} /></View><Text style={styles.conversationControlLabel}>Permissions</Text><Text numberOfLines={1} style={styles.conversationPermissionValue}>{permissionLabel}</Text><View style={styles.conversationArrow}><UiIcon name="chevron-right" size={15} color={colors.muted} /></View>
            </Pressable> : null}
            <Text style={styles.conversationSectionLabel}>Live session</Text>
            <View testID="conversation-live-session" style={styles.conversationSessionBezel}>
              <View style={styles.conversationSessionGroup}>
                {terminalStatuses.length ? <Pressable accessibilityRole="button" accessibilityLabel="Change agent status" disabled={!interactive} onPress={() => { setConversationOpen(false); setStatusOpen(true); }} style={({ pressed }) => [styles.conversationSessionRow, pressed && styles.pressed]}>
                  <View style={styles.conversationSessionIcon}><View style={[styles.connectionDot, { backgroundColor: currentStatus.color }]} /></View><View style={styles.conversationSessionCopy}><Text style={styles.conversationSessionTitle}>Agent status</Text><Text style={styles.conversationSessionMeta}>Shared with your computer</Text></View><View style={[styles.conversationStatusPill, { backgroundColor: `${currentStatus.color}18` }]}><View style={[styles.conversationStatusDot, { backgroundColor: currentStatus.color }]} /><Text style={[styles.conversationStatusText, { color: currentStatus.color }]}>{currentStatus.label}</Text></View>
                </Pressable> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Host connection" onPress={() => { setConversationOpen(false); setConnectionOpen(true); }} style={({ pressed }) => [styles.conversationSessionRow, pressed && styles.pressed]}>
                  <View style={styles.conversationSessionIcon}><UiIcon name={hostLabel === 'CAS Cloud' ? 'globe' : 'monitor'} size={16} color={colors.accent} /></View><View style={styles.conversationSessionCopy}><Text numberOfLines={1} style={styles.conversationSessionTitle}>{demoMode ? 'Review demo' : computerName || hostLabel}</Text><Text style={styles.conversationSessionMeta}>{demoMode ? 'Sample data · no host connected' : `This conversation is running on ${hostLabel}`}</Text></View><View style={styles.conversationArrow}><UiIcon name="chevron-right" size={15} color={colors.accent} /></View>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Open localhost preview" disabled={demoMode || !online} onPress={() => { setConversationOpen(false); setPreviewOpen(true); }} style={({ pressed }) => [styles.conversationSessionRow, styles.conversationSessionRowLast, (demoMode || !online) && styles.conversationSessionUnavailable, pressed && styles.pressed]}>
                  <View style={styles.conversationSessionIcon}><UiIcon name="globe" size={17} color={colors.accent} /></View><View style={styles.conversationSessionCopy}><Text style={styles.conversationSessionTitle}>Open local preview</Text><Text style={styles.conversationSessionMeta}>{demoMode || !online ? `Available when ${hostLabel} reconnects` : 'View localhost from this phone'}</Text></View><View style={styles.conversationArrow}><UiIcon name="arrow-up" size={14} color={colors.accent} /></View>
                </Pressable>
              </View>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Continue in another LLM" disabled={!interactive} onPress={() => { setConversationOpen(false); setHandoffOpen(true); }} style={({ pressed }) => [styles.conversationPermission, !interactive && styles.disabled, pressed && styles.pressed]}>
              <View style={styles.conversationPermissionIcon}><UiIcon name="git-branch" size={15} color={colors.accent} /></View><Text style={styles.conversationControlLabel}>Continue in another LLM</Text><View style={styles.conversationArrow}><UiIcon name="chevron-right" size={15} color={colors.muted} /></View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Close conversation" disabled={!interactive} onPress={() => { setConversationOpen(false); stop(); }} style={({ pressed }) => [styles.conversationClose, !interactive && styles.disabled, pressed && styles.pressed]}>
              <View style={styles.conversationCloseIcon}><UiIcon name="close-circle" size={17} color={colors.danger} /></View><View style={styles.conversationSessionCopy}><Text style={styles.dangerRowTitle}>Close conversation</Text><Text style={styles.conversationSessionMeta}>{demoMode ? 'Stops this sample · keeps it in History' : 'Stops the agent · keeps it in History'}</Text></View>
            </Pressable>
            </ScrollView>
      </BottomSheet>
      <BottomSheet
        open={Boolean(chatContextMenu)}
        onClose={() => { setChatContextMenu(null); setContextHandoffOpen(false); }}
        closeLabel="Close conversation menu"
        reduceMotion
        testID="chat-context-menu"
        accessibilityLabel="Conversation actions"
        sheetStyle={[styles.chatContextMenu, { maxHeight: Math.max(120, viewportHeight - 24), overflow: 'auto' as unknown as ViewStyle['overflow'] }]}
        backdropStyle={styles.modalBackdropClear}
        layoutStyle={[styles.chatContextMenuLayout, chatContextMenu && { left: chatContextMenu.left, top: chatContextMenu.top }]}
        handleStyle={styles.sheetDesktopNoHandle}
        dragAreaStyle={styles.sheetDesktopNoHandle}
      >
        {desktopActions ? <Pressable accessibilityRole="button" accessibilityLabel="Generate title" disabled={!interactive} onPress={() => runConversationAction('generateTitle')} style={({ pressed }) => [styles.chatContextMenuItem, !interactive && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="sliders" size={16} color={colors.secondary} />
          <Text style={styles.chatContextMenuText}>Generate title</Text>
        </Pressable> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Continue with another LLM" accessibilityState={{ expanded: contextHandoffOpen }} disabled={!interactive || !handoffAgents.length} onPress={() => setContextHandoffOpen((current) => !current)} style={({ pressed }) => [styles.chatContextMenuItem, (!interactive || !handoffAgents.length) && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="git-branch" size={16} color={colors.accent} />
          <Text style={styles.chatContextMenuText}>Continue with another LLM…</Text>
        </Pressable>
        {contextHandoffOpen ? <View testID="chat-context-handoff-agents" accessibilityLabel="Available LLMs" style={styles.chatContextHandoffAgents}>
          {handoffAgents.map((candidate) => <Pressable key={candidate.id} accessibilityRole="button" accessibilityLabel={`Continue with ${candidate.label}`} disabled={handoffPending} onPress={() => continueWithAgent(candidate.id)} style={({ pressed }) => [styles.chatContextHandoffAgent, handoffPending && styles.disabled, pressed && styles.pressed]}><AgentIcon agent={candidate.id} size={20} styles={styles} /></Pressable>)}
        </View> : null}
        {desktopActions && session.sandboxMode ? <Pressable accessibilityRole="button" accessibilityLabel="Turn Sandbox into Project" disabled={!interactive} onPress={() => runConversationAction('promoteSandbox')} style={({ pressed }) => [styles.chatContextMenuItem, !interactive && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="plus" size={16} color={colors.secondary} />
          <Text style={styles.chatContextMenuText}>Turn Sandbox into Project…</Text>
        </Pressable> : null}
        {canForkConversation ? <Pressable accessibilityRole="button" accessibilityLabel="Fork conversation" disabled={!interactive} onPress={() => runConversationAction('fork')} style={({ pressed }) => [styles.chatContextMenuItem, !interactive && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="git-branch" size={16} color={colors.secondary} />
          <Text style={styles.chatContextMenuText}>Fork conversation</Text>
        </Pressable> : null}
        {desktopActions ? <View style={styles.chatContextMenuDivider} /> : null}
        {desktopActions ? <Pressable accessibilityRole="button" accessibilityLabel="Rename agent" disabled={!interactive} onPress={() => runConversationAction('rename')} style={({ pressed }) => [styles.chatContextMenuItem, !interactive && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="sliders" size={16} color={colors.secondary} />
          <Text style={styles.chatContextMenuText}>Rename agent</Text>
        </Pressable> : null}
        {desktopActions ? <Pressable accessibilityRole="button" accessibilityLabel="Reset agent title" disabled={!interactive} onPress={() => runConversationAction('resetTitle')} style={({ pressed }) => [styles.chatContextMenuItem, !interactive && styles.disabled, pressed && styles.pressed]}>
          <UiIcon name="clock" size={16} color={colors.secondary} />
          <Text style={styles.chatContextMenuText}>Reset agent title</Text>
        </Pressable> : null}
      </BottomSheet>
      <BottomSheet
        open={handoffOpen}
        onClose={() => !handoffPending && setHandoffOpen(false)}
        closeLabel="Close model handoff"
        reduceMotion={reduceMotion}
        testID="conversation-handoff-sheet"
        sheetStyle={styles.configSheet}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={styles.modalLayout}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
        <View style={styles.sheetHeader}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>Continue with another LLM</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close model handoff" disabled={handoffPending} onPress={() => setHandoffOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
        </View>
        <Text style={styles.sheetIntro}>Starts a new agent with this conversation and keeps the source unchanged.</Text>
        {handoffAgents.map((candidate) => (
          <Pressable
            key={candidate.id}
            accessibilityRole="button"
            accessibilityLabel={`Continue with ${candidate.label}`}
            disabled={handoffPending}
            onPress={() => continueWithAgent(candidate.id)}
            style={({ pressed }) => [styles.conversationOption, handoffPending && styles.disabled, pressed && styles.pressed]}
          >
            <View style={styles.conversationOptionIcon}><AgentIcon agent={candidate.id} size={20} styles={styles} /></View>
            <View style={styles.conversationOptionCopy}><Text style={styles.conversationOptionTitle}>{candidate.label}</Text><Text style={styles.conversationOptionMeta}>Continue in a new {candidate.label} conversation</Text></View>
            <UiIcon name="chevron-right" size={15} color={colors.muted} />
          </Pressable>
        ))}
        {!handoffAgents.length ? <Text style={styles.configHelp}>No other installed LLM is available on this host.</Text> : null}
      </BottomSheet>
      <TerminalStatusSheet open={statusOpen} close={() => setStatusOpen(false)} session={session} terminalStatuses={terminalStatuses} interactive={interactive} run={run} colors={colors} styles={styles} reduceMotion={reduceMotion} />
      <BottomSheet
        open={connectionOpen}
        onClose={() => setConnectionOpen(false)}
        closeLabel="Close host connection"
        reduceMotion={reduceMotion}
        sheetStyle={[styles.configSheet, styles.connectionSheet]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={styles.modalLayout}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
        dragAreaStyle={styles.quotaDragArea}
      >
            <View style={styles.sheetHeader}>
              <Text accessibilityRole="header" style={styles.sheetTitle}>Host connection</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close host connection" onPress={() => setConnectionOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
            </View>
            <View style={styles.settingsComputerRow}>
              <View style={styles.settingsComputerIcon}><UiIcon name={hostLabel === 'CAS Cloud' ? 'globe' : 'monitor'} size={17} color={colors.accent} /></View>
              <View style={styles.connectionCardCopy}><Text style={styles.connectionCardTitle}>{demoMode ? 'Review demo' : computerName || hostLabel}</Text><Text style={styles.connectionCardMeta}>{demoMode ? 'Sample data · no host connected' : hostLabel}</Text></View>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={demoMode ? 'Connect a host' : 'Forget this host'} onPress={() => { setConnectionOpen(false); forget(); }} style={styles.dangerRow}>
              <Text style={styles.dangerRowTitle}>{demoMode ? 'Connect a host' : 'Forget this host'}</Text>
              <Text style={styles.dangerRowMeta}>{demoMode ? 'Leave the demo and return to QR pairing' : 'Pair again with a QR or one-time code'}</Text>
            </Pressable>
      </BottomSheet>
      <SessionConfigSheet
        open={configOpen}
        close={() => { setConfigOpen(false); setConfigAnchor(null); }}
        section={configSection}
        session={session}
        models={models}
        setModels={setModels}
        permissionModes={permissionModes}
        loading={modelsLoading}
        loadError={modelsError}
        configure={configureSession}
        reloadModels={reloadModels}
        colors={colors}
        styles={styles}
        reduceMotion={reduceMotion}
        popoverBottom={composerHeight + WEB_COMPOSER_GAP + 10}
        popoverAnchor={configAnchor}
      />
      <PreviewSheet open={previewOpen} close={() => setPreviewOpen(false)} openPreview={openPreview} online={online} colors={colors} styles={styles} reduceMotion={reduceMotion} />
    </KeyboardAvoidingView>
    </MessageSelectionContext.Provider>
  );
});

function PreviewSheet({ open, close, openPreview, online, colors, styles, reduceMotion = false }: {
  open: boolean;
  close: () => void;
  openPreview: (url: string) => Promise<boolean>;
  online: boolean;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion?: boolean;
}) {
  const [url, setUrl] = useState('http://localhost:3000');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!url.trim() || busy || !online) return;
    setBusy(true);
    if (await openPreview(url)) close();
    setBusy(false);
  };
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close localhost preview"
      reduceMotion={reduceMotion}
      sheetStyle={styles.configSheet}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={styles.modalLayout}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle]}
      dragAreaStyle={styles.quotaDragArea}
    >
          <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>Open localhost</Text><Pressable accessibilityRole="button" accessibilityLabel="Close localhost preview" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
          <Text style={styles.previewHelp}>Enter the local URL running on your computer.</Text>
          <TextInput
            accessibilityLabel="Localhost URL"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setUrl}
            onSubmitEditing={() => void submit()}
            placeholder="http://localhost:3000"
            placeholderTextColor={colors.muted}
            style={styles.previewInput}
            value={url}
          />
          <Text style={styles.previewNote}>The private link expires after 20 minutes. Preview traffic passes through CodeAgentSwarm Connect.</Text>
          <Pressable accessibilityRole="button" disabled={!online || busy || !url.trim()} onPress={() => void submit()} style={({ pressed }) => [styles.primaryButton, styles.previewSubmit, pressed && styles.pressed, (!online || busy || !url.trim()) && styles.disabled]}>
            <Text style={styles.primaryButtonText}>{busy ? 'Opening…' : 'Open preview'}</Text>
          </Pressable>
    </BottomSheet>
  );
}

function SessionConfigSheet({ open, close, section, session, models, setModels, permissionModes, loading, loadError, configure, reloadModels, colors, styles, reduceMotion = false, popoverBottom, popoverAnchor }: {
  open: boolean;
  close: () => void;
  section: ConfigSection;
  session: RuntimeSession;
  models: MobileModel[];
  setModels: React.Dispatch<React.SetStateAction<MobileModel[]>>;
  permissionModes: MobilePermissionMode[];
  loading: boolean;
  loadError: string;
  configure: (sessionId: string, configId: ConfigId, value: ConfigValue) => Promise<void>;
  reloadModels: (selectedModelId?: string) => Promise<void>;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  reduceMotion?: boolean;
  popoverBottom: number;
  popoverAnchor: WebPopoverAnchor | null;
}) {
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  const [selectedEffort, setSelectedEffort] = useState<ConfigValue | ''>('');
  const [selectedSpeed, setSelectedSpeed] = useState('');
  const [selectedPermissionMode, setSelectedPermissionMode] = useState(session.permissionMode || '');
  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedEffort('');
    setSelectedSpeed('');
    setSelectedPermissionMode(session.permissionMode || '');
  }, [open, session.permissionMode]);
  const activeModel = models.find((model) => model.current)
    || models.find((model) => model.id === session.model)
    || models[0];
  const reasoning = reasoningDescriptor(activeModel);
  const speed = activeModel?.capabilities?.optionDescriptors?.find((option) => option.id === 'serviceTier');
  const reasoningOptions: Array<{ id: string; label: string; value: ConfigValue }> = reasoning?.type === 'boolean'
    ? [{ id: 'true', label: 'On', value: true }, { id: 'false', label: 'Off', value: false }]
    : (reasoning?.options || []).map((option) => ({ ...option, value: option.id }));
  const apply = async (configId: ConfigId, value: ConfigValue) => {
    setChanging(true);
    setError('');
    try {
      await configure(session.sessionId, configId, value);
      if (configId === 'model') {
        setModels((current) => current.map((model) => ({ ...model, current: model.id === value })));
        await reloadModels(String(value));
      }
      else if (REASONING_CONFIG_IDS.has(configId) || configId === 'serviceTier') {
        setModels((current) => current.map((model) => model.id === activeModel?.id ? {
          ...model,
          capabilities: {
            ...model.capabilities,
            optionDescriptors: model.capabilities?.optionDescriptors?.map((option) => (
              option.id === configId ? { ...option, currentValue: value } : option
            )),
          },
        } : model));
        if (REASONING_CONFIG_IDS.has(configId)) setSelectedEffort(value);
        else if (typeof value === 'string') setSelectedSpeed(value);
      }
      else if (typeof value === 'string') setSelectedPermissionMode(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change the session');
    } finally {
      setChanging(false);
    }
  };
  const used = Number(session.tokenUsage?.usedTokens) || 0;
  const maximum = Number(session.tokenUsage?.maxTokens) || 0;
  const percent = maximum ? Math.min(100, Math.round((used / maximum) * 100)) : 0;
  const busy = changing || session.currentTurn?.state === 'running';
  const title = section === 'model' ? 'Model' : section === 'effort' ? 'Reasoning' : section === 'serviceTier' ? 'Speed' : section === 'permissionMode' ? 'Permissions' : 'Context';
  const showLoading = section !== 'context' && loading && !models.length;
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close session settings"
      reduceMotion={desktopWeb || reduceMotion}
      testID="session-config-sheet"
      sheetStyle={[styles.configSheet, styles.sessionConfigSheet, desktopWeb && styles.sessionConfigDesktopPopover]}
      backdropStyle={[styles.modalBackdrop, desktopWeb && styles.modalBackdropClear]}
      layoutStyle={[
        styles.modalLayout,
        desktopWeb && styles.sessionConfigDesktopLayout,
        desktopWeb && (popoverAnchor
          ? { paddingLeft: popoverAnchor.left, paddingBottom: popoverAnchor.bottom }
          : { alignItems: 'flex-end', paddingRight: 24, paddingBottom: popoverBottom }),
      ]}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
      dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
    >
          <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`} onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
          <ScrollView testID="session-config-scroll" contentContainerStyle={styles.configContent} keyboardDismissMode={KEYBOARD_DISMISS_MODE}>
            {section === 'model' ? <Text style={styles.sheetIntro}>Available models come from the agent running this conversation.</Text> : null}
            {section === 'effort' ? <Text style={styles.sheetIntro}>Available levels follow the selected model.</Text> : null}
            {section === 'serviceTier' ? <Text style={styles.sheetIntro}>Speed options come from the selected model.</Text> : null}
            {section === 'permissionMode' ? <Text style={styles.sheetIntro}>Choose what this agent may do without asking on your computer.</Text> : null}
            {showLoading ? (
              <View style={styles.configSkeleton} accessibilityLabel="Loading available models">
                {[0, 1, 2].map((index) => <View key={index} style={styles.configSkeletonRow}><View style={[styles.skeleton, { width: index === 1 ? '58%' : '72%' }]} /></View>)}
              </View>
            ) : null}
            {section === 'model' && !showLoading ? <View style={styles.configOptionList}>{models.map((model) => {
              const selected = model.id === activeModel?.id;
              return (
                <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} aria-checked={selected} disabled={busy} onPress={() => void apply('model', model.id)} style={[styles.configOption, selected && styles.configOptionSelected, busy && styles.disabled]}>
                  <View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>{model.name}</Text>{model.id !== model.name ? <Text style={styles.configOptionMeta}>{model.id}</Text> : null}</View>
                  {selected ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}
                </Pressable>
              );
            })}</View> : null}
            {section === 'effort' && !showLoading && reasoningOptions.length ? <View style={styles.configOptionList}>{reasoningOptions.map((option) => {
              const selected = option.value === (selectedEffort === '' ? reasoning?.currentValue ?? session.effort : selectedEffort);
              return (
                <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} aria-checked={selected} disabled={busy} onPress={() => void apply(reasoning!.id as ConfigId, option.value)} style={[styles.configOption, selected && styles.configOptionSelected, busy && styles.disabled]}>
                  <View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>{option.label}</Text><Text style={styles.configOptionMeta}>{option.id}</Text></View>
                  {selected ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}
                </Pressable>
              );
            })}</View> : null}
            {section === 'effort' && !showLoading && !reasoningOptions.length ? <Text style={styles.configHelp}>This model does not expose reasoning levels.</Text> : null}
            {section === 'serviceTier' && !showLoading && speed?.options?.length ? <View style={styles.configOptionList}>{speed.options.map((option) => {
              const selected = option.id === (selectedSpeed || speed.currentValue || session.serviceTier);
              return (
                <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} aria-checked={selected} disabled={busy} onPress={() => void apply('serviceTier', option.id)} style={[styles.configOption, selected && styles.configOptionSelected, busy && styles.disabled]}>
                  <View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>{option.label}</Text><Text style={styles.configOptionMeta}>{option.id}</Text></View>
                  {selected ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}
                </Pressable>
              );
            })}</View> : null}
            {section === 'serviceTier' && !showLoading && !speed?.options?.length ? <Text style={styles.configHelp}>This model does not expose speed options.</Text> : null}
            {section === 'permissionMode' && !showLoading ? <View style={styles.configOptionList}>{permissionModes.map((option) => {
              const selected = option.id === selectedPermissionMode;
              return (
                <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} aria-checked={selected} disabled={busy} onPress={() => void apply('permissionMode', option.id)} style={[styles.configOption, selected && styles.configOptionSelected, busy && styles.disabled]}>
                  <View style={styles.configOptionCopy}><Text style={styles.configOptionTitle}>{option.label}</Text>{option.description ? <Text style={styles.configOptionMeta}>{option.description}</Text> : null}</View>
                  {selected ? <UiIcon name="check-circle" size={19} color={colors.accent} /> : <View style={styles.configOptionEmpty} />}
                </Pressable>
              );
            })}</View> : null}
            {section === 'model' && !showLoading && !models.length ? <Text style={styles.configHelp}>No model options are available for this session.</Text> : null}
            {section === 'context' ? <View style={styles.contextCard}>
              <View style={styles.contextRow}><Text style={styles.contextValue}>{maximum ? `${compactTokens(used)} / ${compactTokens(maximum)}` : used ? compactTokens(used) : 'No usage yet'}</Text><Text style={styles.contextMeta}>{maximum ? `${percent}% used` : 'Context limit unavailable'}</Text></View>
              {maximum ? <View style={styles.contextTrack}><View style={[styles.contextFill, { width: `${percent}%` as `${number}%` }]} /></View> : null}
              <Text style={styles.contextNote}>Current context can decrease after compaction.</Text>
            </View> : null}
            {session.currentTurn?.state === 'running' ? <Text style={styles.configHelp}>Wait for the current response to finish before changing model or reasoning.</Text> : null}
            {loadError || error ? <Text style={[styles.configHelp, { color: colors.danger }]}>{error || loadError}</Text> : null}
          </ScrollView>
    </BottomSheet>
  );
}

function AttachmentMessage({ text, attachments, open, desktopWeb, styles }: {
  text: string;
  attachments: Array<{ type: 'image' | 'audio' | 'file'; name: string; dataUrl?: string; durationMs?: number; attachmentId?: string }>;
  open: (image: ImagePreview, gallery?: ImagePreview[]) => void;
  desktopWeb: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  if (!attachments.length) return text ? <MessageText style={styles.userBubbleText}>{text}</MessageText> : null;
  if (!/\[\[(Image|File|Audio) \d+\]\]/.test(text)) return <>
    {text ? <MessageText style={styles.userBubbleText}>{text}</MessageText> : null}
    <AttachmentPreviews attachments={attachments} open={(image, _index, gallery) => open(image, gallery)} desktopWeb={desktopWeb} styles={styles} />
  </>;
  const gallery = attachments.filter((attachment) => attachment.type === 'image');
  const parts = attachmentMessageParts(text, attachments);
  const openAttachment = (index: number) => {
    const attachment = attachments[index];
    if (attachment) attachment.type === 'image' ? open(attachment, gallery) : Alert.alert(attachment.name);
  };
  // iOS paragraphs omit embedded views from VoiceOver; expose named actions on
  // the message while leaving the thumbnail itself tappable for sighted users.
  return <View accessible={Platform.OS === 'ios'}
    accessibilityLabel={Platform.OS === 'ios' ? parts.map((part) => 'text' in part ? part.text
      : `${attachments[part.index].type} ${attachmentOrdinal(attachments, part.index)}: ${attachments[part.index].name}`).join('') : undefined}
    accessibilityActions={Platform.OS === 'ios' ? attachments.map((attachment, index) => ({ name: String(index), label: `Open ${attachment.name}` })) : undefined}
    onAccessibilityAction={(event) => openAttachment(Number(event.nativeEvent.actionName))}>
  <Text selectable style={[styles.userBubbleText, { lineHeight: 28 }]}>
    {parts.map((part, index) => {
      if ('text' in part) return <Text key={index}>{part.text}</Text>;
      const attachment = attachments[part.index];
      const ordinal = attachmentOrdinal(attachments, part.index);
      return <Pressable key={index} accessibilityRole="button" accessibilityLabel={`${attachment.type === 'image' ? 'Open' : 'File'} ${attachment.name}`}
        onPress={() => openAttachment(part.index)}
        style={styles.inlineMessageAttachment}>
        {attachment.type === 'image' && attachment.dataUrl
          ? <Image source={{ uri: attachment.dataUrl }} style={{ width: 22, height: 22, borderRadius: 5 }} resizeMode="cover" />
          : <Text>{attachment.type === 'audio' ? '♪' : '▤'}</Text>}
        <Text style={styles.inlineMessageNumber}>{ordinal}</Text>
      </Pressable>;
    })}
  </Text></View>;
}

function AttachmentPreviews({ attachments, remove, open, compact = false, desktopWeb = false, styles }: {
  attachments: Array<{ type: 'image' | 'audio' | 'file'; name: string; dataUrl?: string; durationMs?: number; attachmentId?: string }>;
  remove?: (index: number) => void;
  open?: (attachment: ImagePreview, index: number, gallery: ImagePreview[]) => void;
  compact?: boolean;
  desktopWeb?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  if (!attachments.length) return null;
  const gallery = attachments.filter((attachment) => attachment.type === 'image').map((attachment) => ({
    name: attachment.name,
    dataUrl: attachment.dataUrl,
    attachmentId: attachment.attachmentId,
  }));
  const previews = attachments.map((attachment, index) => {
        const content = <>
          {attachment.type === 'image' && attachment.dataUrl ? (
            <Image source={{ uri: attachment.dataUrl }} resizeMode="cover" style={[styles.attachmentImage, compact && styles.composerAttachmentImage]} />
          ) : (
            <View style={styles.attachmentIcon}><UiIcon name={attachment.type === 'audio' ? 'mic' : attachment.type === 'file' ? 'file' : 'image'} size={18} color="#fbbf24" /></View>
          )}
          {!(compact && attachment.type === 'image') ? <View style={styles.attachmentCopy}>
            <Text numberOfLines={1} style={styles.attachmentName}>{attachment.type === 'audio' ? 'Voice note' : attachment.name}</Text>
            <Text style={styles.attachmentMeta}>{attachment.type === 'audio' && attachment.durationMs ? `${Math.max(1, Math.round(attachment.durationMs / 1000))}s` : attachment.type}</Text>
          </View> : null}
          {remove ? <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} hitSlop={8} onPress={() => remove(index)} style={compact && attachment.type === 'image' ? [styles.composerAttachmentRemove, desktopWeb && styles.composerAttachmentRemoveDesktop] : undefined}><UiIcon name="close-circle" size={20} color="#b4b4b4" /></Pressable> : null}
        </>;
        const previewStyle = [styles.attachmentPreview, compact && attachment.type === 'image' && styles.composerAttachmentPreview];
        return attachment.type === 'image' && open ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${compact ? 'Edit' : 'Open'} ${attachment.name}`} key={`${attachment.name}-${index}`} onPress={() => open(attachment, index, gallery)} style={previewStyle}>{content}</Pressable>
        ) : <View key={`${attachment.name}-${index}`} style={previewStyle}>{content}</View>;
      });
  const stripStyle = [styles.attachmentStrip, attachments.length > 1 && styles.attachmentStripCarousel, compact && styles.composerAttachmentStrip, compact && desktopWeb && styles.composerAttachmentStripDesktop];
  return attachments.length > 1 && (!desktopWeb || compact) ? (
    <ScrollView horizontal keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsHorizontalScrollIndicator={false} style={[styles.attachmentCarousel, compact && desktopWeb && styles.attachmentCarouselDesktop]} contentContainerStyle={stripStyle}>{previews}</ScrollView>
  ) : <View style={stripStyle}>{previews}</View>;
}

function LocalImagePreviews({ text, sessionId, resolve, open, desktopWeb = false, styles }: {
  text: string;
  sessionId: string;
  resolve: (sessionId: string, path: string) => Promise<Record<string, unknown>>;
  open: (image: ImagePreview, gallery?: ImagePreview[]) => void;
  desktopWeb?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  const references = useMemo(() => extractLocalImageReferences(text), [text]);
  const [images, setImages] = useState<ResolvedImageReference[]>([]);
  const referenceKey = references.map((reference) => reference.path).join('\n');
  useEffect(() => {
    let active = true;
    void Promise.all(references.map(async (reference) => {
      const result = await resolve(sessionId, reference.path);
      if (result.success !== true || typeof result.attachmentId !== 'string') return null;
      return {
        path: reference.path,
        name: typeof result.name === 'string' ? result.name : reference.name,
        attachmentId: result.attachmentId,
        dataUrl: typeof result.thumbnailDataUrl === 'string' ? result.thumbnailDataUrl : undefined,
      };
    })).then((resolved) => {
      if (active) setImages(resolved.filter((image): image is NonNullable<typeof image> => image !== null));
    }).catch(() => {});
    return () => { active = false; };
  }, [referenceKey, resolve, sessionId]);
  if (!images.length) return null;
  return <AttachmentPreviews attachments={images.map((image) => ({ ...image, type: 'image' as const }))} open={(image, _index, gallery) => open(image, gallery)} desktopWeb={desktopWeb} styles={styles} />;
}

function isConversationItem(item: RuntimeItem) {
  return item.itemType === 'user_message'
    || item.itemType === 'assistant_message'
    || Boolean(item.content.assistant_text);
}

function isTodoItem(item: RuntimeItem) {
  return Array.isArray(item.todos) && item.todos.length > 0;
}

function mixHex(hex: string, toward: string, amount: number) {
  const parse = (value: string) => {
    const clean = value.replace('#', '');
    const normalized = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean;
    const n = Number.parseInt(normalized, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const from = parse(hex);
  const to = parse(toward);
  const mix = (start: number, end: number) => Math.round(start + (end - start) * amount);
  return `rgb(${mix(from.r, to.r)}, ${mix(from.g, to.g)}, ${mix(from.b, to.b)})`;
}

function BarberPoleRail({
  color,
  working,
  style,
  testID,
}: {
  color: string;
  working: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      style={[style, { backgroundColor: working ? mixHex(color, '#111111', .14) : color, overflow: 'hidden' }]}
    >
      {working ? (
        <Svg width="100%" height="100%" viewBox="0 0 3 32" preserveAspectRatio="none" pointerEvents="none">
          {Array.from({ length: 6 }, (_, index) => {
            const y = index * 8 - 8;
            return <Path key={index} d={`M0 ${y} L3 ${y + 3} L3 ${y + 7} L0 ${y + 4} Z`} fill={mixHex(color, '#ffffff', .7)} />;
          })}
        </Svg>
      ) : null}
    </View>
  );
}

function TimelineTime({ atMs, label, testID, work = false, styles }: { atMs?: number; label: string; testID: string; work?: boolean; styles: ReturnType<typeof createStyles> }) {
  const time = formatClock(atMs);
  return time ? <Text testID={testID} accessibilityLabel={`${label} ${time}`} style={[styles.messageTime, work && styles.workGroupTime]}>{time}</Text> : null;
}

function TodoListCard({ colors, item, styles }: { colors: Palette; item: RuntimeItem; styles: ReturnType<typeof createStyles> }) {
  const [expanded, setExpanded] = useState(false);
  const todos = item.todos || [];
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress')
    || todos.find((todo) => todo.status === 'pending');
  return (
    <View accessible accessibilityLabel={`Todo list, ${completed} of ${todos.length} complete`} style={styles.todoCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} todo list`}
        onPress={() => setExpanded((value) => !value)}
        style={styles.todoHeader}
      >
        <UiIcon name="list" size={17} color={colors.accent} />
        <Text style={styles.todoTitle}>Todos</Text>
        <Text style={styles.todoCount}>{completed}/{todos.length}</Text>
        <UiIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={15} color={colors.muted} />
      </Pressable>
      {current ? <Text style={styles.todoCurrent} numberOfLines={1}>{current.step}</Text> : null}
      {expanded ? <View style={styles.todoBody}>{todos.map((todo, index) => (
        <View key={`${index}-${todo.step}`} style={styles.todoRow}>
          {todo.status === 'completed'
            ? <UiIcon name="check-circle" size={16} color={colors.success} />
            : <View style={[styles.todoDot, todo.status === 'in_progress' && styles.todoDotActive]} />}
          <Text style={[styles.todoText, todo.status === 'completed' && styles.todoTextDone]}>{todo.step}</Text>
        </View>
      ))}</View> : null}
    </View>
  );
}

function WorkGroup({ items, coordinationItems = [], forceActive, endedAtMs, openByDefault, colors, dark, reduceMotion, styles }: { items: RuntimeItem[]; coordinationItems?: RuntimeItem[]; forceActive: boolean; endedAtMs?: number; openByDefault: boolean; colors: Palette; dark: boolean; reduceMotion: boolean; styles: ReturnType<typeof createStyles> }) {
  const active = forceActive;
  const orbState = orbStateForActivities(items);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const startedAt = Math.min(...items.map((item) => item.startedAtMs).filter((value): value is number => Number.isFinite(value)));
  const endedAt = Number.isFinite(endedAtMs)
    ? endedAtMs!
    : Math.max(...items.map((item) => item.endedAtMs).filter((value): value is number => Number.isFinite(value)));
  const durationEnd = active ? nowMs : endedAt;
  const duration = Number.isFinite(startedAt) && Number.isFinite(durationEnd) ? formatWorkDuration(durationEnd - startedAt) : '';
  const label = active ? `Working${duration ? ` · ${duration}` : ''}` : `Worked${duration ? ` for ${duration}` : ''}`;
  const accessibilityLabel = active ? `Working${duration ? ` for ${duration}` : ''}` : label;
  const timestamp = active ? startedAt : endedAt;
  const [flipped, setFlipped] = useState(false);
  const expanded = flipped ? !openByDefault : openByDefault;
  return (
    <View style={styles.workGroup}>
      <View style={styles.workGroupSummaryRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${accessibilityLabel}, ${items.length} steps`}
          onPress={() => setFlipped((value) => !value)}
          style={styles.workGroupSummary}
        >
          {active ? <ThinkingOrb state={orbState} dark={dark} reduceMotion={reduceMotion} size={20} testID="thinking-orb" /> : null}
          <Text style={[styles.workGroupTitle, active && styles.workGroupTitleActive]}>{label}</Text>
          <TimelineTime atMs={timestamp} label={active ? 'Started at' : 'Finished at'} testID="work-group-time" work styles={styles} />
          <UiIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} color="#8f98b7" />
        </Pressable>
        {coordinationItems.length ? <SessionCoordinationCluster items={coordinationItems} colors={colors} reduceMotion={reduceMotion} styles={styles} /> : null}
      </View>
      {expanded ? (
        <View style={styles.workGroupDetails}>
          {items.map((item, index) => {
            const stepActive = forceActive && index === items.length - 1;
            const assistant = isConversationItem(item);
            return (
            <View key={item.itemId} style={styles.workStep}>
              <View style={[styles.workStepDot, stepActive && styles.workStepDotActive, item.status === 'failed' && styles.workDotFailed]} />
              <View style={styles.workCopy}>
                <Text style={styles.workTitle}>{assistant ? 'Update' : item.title || item.itemType?.replaceAll('_', ' ') || 'Activity'}</Text>
                {assistant || item.detail ? <Text style={styles.workDetail} numberOfLines={6}>{assistant ? assistantText(item) : item.detail}</Text> : null}
              </View>
              <Text style={[styles.workStatus, stepActive && styles.workStatusActive]}>{stepActive ? 'Live' : item.status === 'failed' ? 'Failed' : 'Done'}</Text>
            </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function SessionCoordinationCluster({ items, colors, reduceMotion, styles, fallback = false }: {
  items: RuntimeItem[];
  colors: Palette;
  reduceMotion: boolean;
  styles: ReturnType<typeof createStyles>;
  fallback?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === 'web' && width >= WEB_SPLIT_BREAKPOINT;
  const entries = items.flatMap((item) => {
    const coordination = parseSessionCoordinationPrompt(itemText(item));
    return coordination ? [{ item, coordination }] : [];
  });
  const countLabel = `${entries.length} ${entries.length === 1 ? 'message' : 'messages'}`;
  return (
    <>
      <View style={fallback ? styles.sessionCoordinationFallback : null}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${countLabel} from other sessions`}
          accessibilityState={{ expanded: open }}
          testID="session-coordination-cluster"
          onPress={() => setOpen(true)}
          style={({ pressed }) => [styles.sessionCoordinationCluster, pressed && styles.pressed]}
        >
          <UiIcon name="session-message" size={15} color={colors.accent} />
          <Text style={styles.sessionCoordinationClusterText}>{countLabel}</Text>
        </Pressable>
      </View>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        closeLabel="Close session coordination"
        accessibilityLabel="Session coordination"
        reduceMotion={reduceMotion}
        testID="session-coordination-cluster-sheet"
        handleTestID="session-coordination-cluster-sheet-handle"
        sheetStyle={[styles.configSheet, styles.sessionCoordinationSheet, desktopWeb && styles.sheetDesktopDialog, desktopWeb && styles.sheetDesktopCompactDialog]}
        backdropStyle={styles.modalBackdrop}
        layoutStyle={[styles.modalLayout, desktopWeb && styles.modalLayoutCentered]}
        handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
        dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
      >
        <View style={styles.sessionCoordinationHeader}>
          <View style={styles.sessionCoordinationSheetIcon}><UiIcon name="session-message" size={20} color={colors.accent} /></View>
          <View style={styles.sessionCoordinationHeaderCopy}>
            <Text style={styles.sessionCoordinationLabel}>Session coordination</Text>
            <Text accessibilityRole="header" style={styles.sessionCoordinationTitle}>{countLabel}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close session coordination" onPress={() => setOpen(false)} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable>
        </View>
        <ScrollView style={styles.sessionCoordinationBodyScroll} keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsVerticalScrollIndicator={false}>
          {entries.map(({ item, coordination }) => {
            const action = coordination.type === 'request'
              ? 'asked for information'
              : coordination.type === 'response'
                ? 'answered your request'
                : 'sent a session message';
            const time = formatClock(item.startedAtMs);
            return (
              <View key={item.itemId} style={styles.sessionCoordinationItem}>
                <View style={styles.sessionCoordinationItemHeader}>
                  <View style={styles.sessionCoordinationIcon}><UiIcon name="session-message" size={16} color={colors.accent} /></View>
                  <View style={styles.sessionCoordinationCopy}>
                    <Text numberOfLines={1} style={styles.sessionCoordinationSource}>{coordination.source}</Text>
                    <Text style={styles.sessionCoordinationAction}>{action}</Text>
                  </View>
                  <Text numberOfLines={1} style={styles.sessionCoordinationAgent}>{coordination.agent}{time ? ` · ${time}` : ''}</Text>
                </View>
                <Text selectable style={styles.sessionCoordinationBody}>{coordination.message}</Text>
              </View>
            );
          })}
        </ScrollView>
        <View style={styles.sessionCoordinationGuard}>
          <UiIcon name="shield" size={16} color={colors.accent} />
          <Text style={styles.sessionCoordinationGuardText}>Session context only · your goal and permissions stay unchanged</Text>
        </View>
      </BottomSheet>
    </>
  );
}

// Keep completed message content independent of the changing timeline and active turn.
const ConversationMessage = memo(function ConversationMessage({ item, sessionId, resolveImageReference, openImage, openPreview, online, colors, desktopWeb, reduceMotion, styles }: { item: RuntimeItem; sessionId: string; resolveImageReference: (sessionId: string, path: string) => Promise<Record<string, unknown>>; openImage: (image: ImagePreview, gallery?: ImagePreview[]) => void; openPreview: (url: string) => Promise<boolean>; online: boolean; colors: Palette; desktopWeb: boolean; reduceMotion: boolean; styles: ReturnType<typeof createStyles> }) {
  const text = item.itemType === 'assistant_message' || item.content.assistant_text ? assistantText(item) : itemText(item);
  if (item.itemType === 'user_message') {
    const coordination = parseSessionCoordinationPrompt(text);
    if (coordination) return null;
    const attachments = itemAttachments(item);
    return <MessageEntrance createdAtMs={item.startedAtMs} kind="user" reduceMotion={reduceMotion || !!item.remoteCommand} testID={`user-message-entry-${item.itemId}`}><View style={[styles.messageRow, styles.userRow]}><View style={styles.userBubble}><AttachmentMessage text={text} attachments={attachments} open={openImage} desktopWeb={desktopWeb} styles={styles} /><LocalPreviewCards text={text} online={online} openPreview={openPreview} styles={styles} /></View><TimelineTime atMs={item.startedAtMs} label="Sent at" testID={`message-time-${item.itemId}`} styles={styles} /></View></MessageEntrance>;
  }
  if (item.itemType === 'assistant_message' || item.content.assistant_text) {
    const attachments = itemAttachments(item);
    return <MessageEntrance createdAtMs={item.startedAtMs} kind="assistant" reduceMotion={reduceMotion} testID={`assistant-message-entry-${item.itemId}`}><View style={styles.messageRow}><View style={styles.assistantBubble}><MobileMarkdown text={text} colors={colors} styles={styles} /><AttachmentPreviews attachments={attachments} open={(image, _index, gallery) => openImage(image, gallery)} desktopWeb={desktopWeb} styles={styles} /><LocalImagePreviews text={text} sessionId={sessionId} resolve={resolveImageReference} open={openImage} desktopWeb={desktopWeb} styles={styles} /><LocalPreviewCards text={text} online={online} openPreview={openPreview} styles={styles} /></View><TimelineTime atMs={item.startedAtMs} label="Received at" testID={`message-time-${item.itemId}`} styles={styles} /></View></MessageEntrance>;
  }
  return null;
});

function TimelineItem({ info, items, coordinationItems, activeTurnId, sessionRunning, openWorkByDefault, sessionId, resolveImageReference, openImage, openPreview, online, colors, dark, desktopWeb, reduceMotion, styles }: { info: ListRenderItemInfo<RuntimeItem>; items: RuntimeItem[]; coordinationItems: RuntimeItem[]; activeTurnId?: string; sessionRunning: boolean; openWorkByDefault: boolean; sessionId: string; resolveImageReference: (sessionId: string, path: string) => Promise<Record<string, unknown>>; openImage: (image: ImagePreview, gallery?: ImagePreview[]) => void; openPreview: (url: string) => Promise<boolean>; online: boolean; colors: Palette; dark: boolean; desktopWeb: boolean; reduceMotion: boolean; styles: ReturnType<typeof createStyles> }) {
  const item = info.item;
  if (isConversationItem(item)) {
    return <ConversationMessage item={item} sessionId={sessionId} resolveImageReference={resolveImageReference} openImage={openImage} openPreview={openPreview} online={online} colors={colors} desktopWeb={desktopWeb} reduceMotion={reduceMotion} styles={styles} />;
  }
  if (isTodoItem(item)) return null;
  if (info.index > 0 && !isConversationItem(items[info.index - 1]) && !isTodoItem(items[info.index - 1])) return null;
  const workItems = [];
  for (let index = info.index; index < items.length && !isConversationItem(items[index]) && !isTodoItem(items[index]); index += 1) {
    workItems.push(items[index]);
  }
  const hasLaterWork = items.slice(info.index + workItems.length).some((entry) => !isConversationItem(entry) && !isTodoItem(entry));
  const belongsToActiveTurn = Boolean(activeTurnId && workItems.some((entry) => entry.turnId === activeTurnId));
  const activeTurnHasLaterConversation = Boolean(activeTurnId && items.slice(info.index + workItems.length).some((entry) => (
    entry.turnId === activeTurnId && isConversationItem(entry)
  )));
  return <WorkGroup items={workItems} coordinationItems={coordinationItems} forceActive={sessionRunning && !hasLaterWork && belongsToActiveTurn && !activeTurnHasLaterConversation} openByDefault={openWorkByDefault} colors={colors} dark={dark} reduceMotion={reduceMotion} styles={styles} />;
}

function ApprovalCard({ request, styles, disabled, decide }: {
  request: RuntimeRequest;
  styles: ReturnType<typeof createStyles>;
  disabled: boolean;
  decide: (decision: string) => void;
}) {
  return (
    <View style={styles.decisionCard} accessibilityRole="summary">
      <Text style={styles.decisionLabel}>Approval needed</Text>
      <Text style={styles.decisionTitle}>{request.detail || 'The agent wants to perform an action.'}</Text>
      <View style={styles.decisionActions}>
        {commandOptions(request).map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => decide(option.id)}
            style={({ pressed }) => [option.allow ? styles.allowButton : styles.denyButton, pressed && styles.pressed, disabled && styles.disabled]}
          >
            <Text style={option.allow ? styles.allowText : styles.denyText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function QuestionCard({ request, colors, styles, disabled, draft, update, submit, decline }: {
  request: RuntimeQuestion;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  disabled: boolean;
  draft: QuestionDraft;
  update: (draft: QuestionDraft) => void;
  submit: () => void;
  decline: () => void;
}) {
  const questions = request.questions || [];
  const complete = questions.every((question) => {
    const answer = draft[question.id];
    return Boolean(answer?.values.length || answer?.custom.trim());
  });
  return (
    <View style={styles.questionCard}>
      <Text style={styles.decisionLabel}>Your input is needed</Text>
      {questions.map((question) => {
        const answer = draft[question.id] || { values: [], custom: '' };
        return (
          <View key={question.id} style={styles.questionBlock}>
            {question.header ? <Text style={styles.questionHeader}>{question.header}</Text> : null}
            <Text style={styles.questionText}>{question.question}</Text>
            {(question.options || []).map((option) => {
              const selected = answer.values.includes(option.label);
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ selected, checked: selected }}
                  disabled={disabled}
                  onPress={() => {
                    const values = question.multiSelect
                      ? selected
                        ? answer.values.filter((value) => value !== option.label)
                        : [...answer.values, option.label]
                      : [option.label];
                    update({ ...draft, [question.id]: { ...answer, values } });
                  }}
                  style={[styles.questionOption, selected && styles.questionOptionSelected]}
                >
                  <View style={[styles.optionControl, question.multiSelect && styles.optionCheck, selected && styles.optionControlSelected]} />
                  <View style={styles.optionCopy}><Text style={styles.optionLabel}>{option.label}</Text>{option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}</View>
                </Pressable>
              );
            })}
            {question.allowsFreeText ? (
              <TextInput
                accessibilityLabel={`Custom answer for ${question.question}`}
                editable={!disabled}
                secureTextEntry={question.secret === true}
                placeholder="Custom answer"
                placeholderTextColor={colors.muted}
                value={answer.custom}
                onChangeText={(custom) => update({ ...draft, [question.id]: { ...answer, custom } })}
                style={styles.questionInput}
              />
            ) : null}
          </View>
        );
      })}
      <View style={styles.decisionActions}>
        <Pressable accessibilityRole="button" disabled={disabled} onPress={decline} style={[styles.denyButton, disabled && styles.disabled]}><Text style={styles.denyText}>Decline</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={disabled || !complete} onPress={submit} style={[styles.allowButton, (disabled || !complete) && styles.disabled]}><Text style={styles.allowText}>Send answer</Text></Pressable>
      </View>
    </View>
  );
}

function NewSessionModal({
  open,
  desktopWeb = false,
  colors,
  styles,
  projects,
  hosts,
  selectedHost,
  setSelectedHost,
  selectedProject,
  setSelectedProject,
  selectedAgent,
  setSelectedAgent,
  availableAgents,
  cloudProvider,
  providerSigningIn,
  providerLoginFlow,
  signInProvider,
  copyProviderCode,
  openProviderLogin,
  useWorktree,
  setUseWorktree,
  prompt,
  setPrompt,
  error,
  close,
  create,
  online,
  creating,
  reduceMotion = false,
}: {
  open: boolean;
  desktopWeb?: boolean;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  projects: RuntimeProject[];
  hosts: RuntimeHost[];
  selectedHost: string;
  setSelectedHost: (runtimeId: string) => void;
  selectedProject: string;
  setSelectedProject: (path: string) => void;
  selectedAgent: string;
  setSelectedAgent: (agent: string) => void;
  availableAgents: string[];
  cloudProvider: RuntimeProvider | null;
  providerSigningIn: boolean;
  providerLoginFlow: CloudProviderLoginFlow | null;
  signInProvider: () => void;
  copyProviderCode: () => void;
  openProviderLogin: () => void;
  useWorktree: boolean;
  setUseWorktree: (enabled: boolean) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  error: string | null;
  close: () => void;
  create: () => void;
  online: boolean;
  creating: boolean;
  reduceMotion?: boolean;
}) {
  const project = projects.find((candidate) => candidate.path === selectedProject);
  const worktreeEligible = project?.worktreeEligible === true;
  const worktreeHelp = project?.worktreeEligibilityReason === 'no-commits'
    ? 'This repository needs its first commit.'
    : 'Requires a Git repository.';
  const providerSignInRequired = cloudProvider?.installed === true
    && cloudProvider.login.mode === 'cli'
    && cloudProvider.login.status.loggedIn !== true;
  return (
    <BottomSheet
      open={open}
      onClose={close}
      closeLabel="Close new session"
      testID="new-session-sheet"
      reduceMotion={reduceMotion}
      avoidKeyboard
      keyboardBehavior={Platform.OS === 'ios' ? 'height' : 'padding'}
      keyboardVerticalOffset={Platform.OS === 'android' ? 28 : 0}
      sheetStyle={[styles.sheet, desktopWeb && styles.sheetDesktopDialog]}
      backdropStyle={styles.modalBackdrop}
      layoutStyle={[styles.modalLayout, desktopWeb && styles.modalLayoutCentered]}
      handleStyle={[styles.sheetHandle, styles.quotaDragHandle, desktopWeb && styles.sheetDesktopNoHandle]}
      dragAreaStyle={[styles.quotaDragArea, desktopWeb && styles.sheetDesktopNoHandle]}
    >
          <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>New session</Text><Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
          <Text style={styles.sheetIntro}>Choose where it runs and which agent should start.</Text>
          {error ? <Text accessibilityLabel="Session creation error" style={styles.inlineError}>{error}</Text> : null}
          {hosts.length > 1 ? <><Text style={styles.fieldLabel}>Run on</Text><ScrollView horizontal keyboardDismissMode={KEYBOARD_DISMISS_MODE} showsHorizontalScrollIndicator={false} style={styles.hostPickerScroll} contentContainerStyle={styles.hostPickerRow}>{hosts.map((host) => {
            const selected = host.runtimeId === selectedHost;
            return <Pressable key={host.runtimeId} testID={`new-session-host-${host.runtimeId}`} accessibilityRole="radio" accessibilityLabel={`Run on ${host.name}`} accessibilityState={{ checked: selected, disabled: host.phase !== 'online' }} disabled={host.phase !== 'online'} onPress={() => setSelectedHost(host.runtimeId)} style={[styles.hostPickerChoice, selected && styles.hostPickerChoiceSelected, host.phase !== 'online' && styles.disabled]}><UiIcon name={host.kind === 'cloud' ? 'globe' : 'monitor'} size={16} color={selected ? colors.accent : colors.secondary} /><View><Text style={[styles.hostPickerName, selected && styles.hostPickerNameSelected]} numberOfLines={1}>{host.name}</Text><Text style={styles.hostPickerMeta}>{host.kind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop'} · {host.phase === 'online' ? 'Online' : 'Offline'}</Text></View></Pressable>;
          })}</ScrollView></> : null}
          <View style={styles.agentFieldHeader}>
            <Text style={[styles.fieldLabel, styles.agentFieldLabel]}>Agent</Text>
            <Text style={styles.selectedAgentName}>{agentInfo(selectedAgent).label}</Text>
          </View>
          <View style={styles.agentGrid}>
            {AGENTS.filter((agent) => availableAgents.includes(agent.id)).map((agent, index) => (
              <MotionRise key={agent.id} reduceMotion={reduceMotion} replayKey={open} delay={70 + index * 32} distance={10} duration={360} style={styles.agentChoiceMotion}>
                <Pressable accessibilityRole="radio" accessibilityLabel={agent.label} accessibilityState={{ selected: selectedAgent === agent.id }} onPress={() => setSelectedAgent(agent.id)} style={[styles.agentChoice, selectedAgent === agent.id && styles.agentChoiceSelected]}>
                  <AgentIcon agent={agent.id} size={28} styles={styles} />
                  {selectedAgent === agent.id ? <Text style={styles.agentChoiceCheck}>✓</Text> : null}
                </Pressable>
              </MotionRise>
            ))}
          </View>
          {selectedAgent === 'pi' && cloudProvider?.login.status.loggedIn !== true ? <Text style={styles.fieldHelp}>{PI_LOGIN_HELP}</Text> : null}
          {providerSigningIn && providerLoginFlow?.code ? (
            <View style={styles.newSessionLoginCard}>
              <Text style={styles.newSessionLoginLabel}>Device code</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy device code"
                onPress={copyProviderCode}
                style={({ pressed }) => [styles.newSessionLoginCodeRow, pressed && styles.pressed]}
              >
                <Text selectable style={styles.newSessionLoginCode}>{providerLoginFlow.code}</Text>
                <UiIcon name="copy" size={18} color={colors.secondary} />
              </Pressable>
              {providerLoginFlow.url ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${cloudProvider?.name || agentInfo(selectedAgent).label} sign-in`}
                  onPress={openProviderLogin}
                  style={({ pressed }) => [styles.primaryButton, styles.newSessionLoginOpenButton, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryButtonText}>Open {cloudProvider?.name || agentInfo(selectedAgent).label} sign-in</Text>
                </Pressable>
              ) : <ActivityIndicator style={styles.newSessionLoginOpenButton} color={colors.accent} />}
            </View>
          ) : providerSignInRequired ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sign in to ${cloudProvider?.name || agentInfo(selectedAgent).label}`}
              disabled={providerSigningIn}
              onPress={signInProvider}
              style={({ pressed }) => [styles.primaryButton, styles.newSessionSignInButton, pressed && styles.pressed, providerSigningIn && styles.disabled]}
            >
              {providerSigningIn ? (
                <View style={styles.newSessionSignInBusy}>
                  <ActivityIndicator size="small" color={colors.accentText} />
                  <Text style={styles.primaryButtonText}>Starting sign-in…</Text>
                </View>
              ) : <Text style={styles.primaryButtonText}>Sign in</Text>}
            </Pressable>
          ) : null}
          <ScrollView style={styles.newSessionScroll} contentContainerStyle={styles.newSessionContent} keyboardDismissMode={KEYBOARD_DISMISS_MODE} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={styles.fieldLabel}>Project</Text>
            {projects.length ? (
              <View style={styles.projectChoices}>
                {projects.map((project) => (
                  <Pressable key={project.path} accessibilityRole="radio" accessibilityState={{ selected: selectedProject === project.path }} onPress={() => setSelectedProject(project.path)} style={[styles.projectChoice, selectedProject === project.path && styles.projectChoiceSelected]}>
                    <ProjectIcon project={project} size={36} styles={styles} />
                    <View style={styles.projectChoiceCopy}><Text numberOfLines={1} style={styles.projectChoiceName}>{project.name}</Text><Text numberOfLines={1} style={styles.projectChoicePath}>{project.hostPath || project.path}</Text></View>
                    {selectedProject === project.path ? <UiIcon name="check-circle" size={22} color={colors.accent} /> : null}
                  </Pressable>
                ))}
              </View>
            ) : <Text style={styles.fieldHelp}>Open or add a project on your computer first.</Text>}
            <Text style={styles.fieldLabel}>First message <Text style={styles.optionalLabel}>optional</Text></Text>
            <TextInput
              accessibilityLabel="First message for the new session"
              multiline
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
              placeholder="What should the agent work on?"
              placeholderTextColor={colors.muted}
              value={prompt}
              onChangeText={setPrompt}
              style={styles.promptInput}
            />
          </ScrollView>
          {project ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel="Open in Git worktree"
              accessibilityState={{ checked: worktreeEligible && useWorktree, disabled: !worktreeEligible }}
              aria-checked={worktreeEligible && useWorktree}
              aria-disabled={!worktreeEligible}
              disabled={!worktreeEligible}
              onPress={() => setUseWorktree(!useWorktree)}
              style={[styles.worktreeChoice, !worktreeEligible && styles.disabled]}
            >
              <View style={styles.worktreeChoiceCopy}>
                <View style={styles.worktreeChoiceTitleRow}>
                  <UiIcon name="git-branch" size={18} color={worktreeEligible ? colors.accent : colors.muted} />
                  <Text style={styles.worktreeChoiceTitle}>Git Worktree</Text>
                </View>
                <Text style={styles.fieldHelp}>{worktreeEligible ? 'Start this chat in an isolated checkout.' : worktreeHelp}</Text>
              </View>
              <View style={[styles.worktreeCheckbox, worktreeEligible && useWorktree && styles.worktreeCheckboxSelected]}>
                {worktreeEligible && useWorktree ? <Text style={styles.worktreeCheck}>✓</Text> : null}
              </View>
            </Pressable>
          ) : null}
          {!online ? <Text style={styles.inlineError}>Reconnect your computer to create a session.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={prompt.trim() ? 'Create and send' : 'Create session'} disabled={!online || !selectedProject || creating || providerSignInRequired} onPress={create} style={({ pressed }) => [styles.primaryButton, styles.createSessionButton, pressed && styles.pressed, (!online || !selectedProject || creating || providerSignInRequired) && styles.disabled]}>
            <Text style={styles.primaryButtonText}>{creating ? 'Starting…' : prompt.trim() ? 'Create and send' : 'Create session'}</Text>
          </Pressable>
    </BottomSheet>
  );
}

function createStyles(colors: Palette) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: colors.background },
    workspace: { flex: 1, minHeight: 0 },
    webSplitWorkspace: { flexDirection: 'row' },
    tabViewport: { flex: 1, overflow: 'hidden', ...(Platform.OS === 'web' ? { touchAction: 'pan-y' as any } : {}) },
    webSplitSidebar: { width: WEB_SPLIT_SIDEBAR_WIDTH, flexBasis: WEB_SPLIT_SIDEBAR_WIDTH, flexGrow: 0, flexShrink: 0, borderRightWidth: 1, borderRightColor: colors.border },
    webSplitChatPane: { flex: 1, minWidth: 0, backgroundColor: colors.background },
    webSplitEmptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    webSplitEmptyIcon: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center', marginBottom: 16, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    webSplitEmptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
    webSplitEmptyCopy: { maxWidth: 330, marginTop: 8, color: colors.secondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
    tabTrack: { flex: 1, flexDirection: 'row' },
    tabScreen: { height: '100%', backgroundColor: colors.background },
    screenOverlay: { ...StyleSheet.absoluteFillObject },
    screenOverlayContent: { flex: 1, backgroundColor: colors.background },
    pressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
    rowPressed: { backgroundColor: colors.surface },
    disabled: { opacity: 0.42 },
    worktreeChoice: { minHeight: 58, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
    worktreeChoiceCopy: { flex: 1 },
    worktreeChoiceTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
    worktreeChoiceTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    worktreeCheckbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
    worktreeCheckboxSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
    worktreeCheck: { color: colors.accentText, fontSize: 15, fontWeight: '900' },
    secondaryText: { color: colors.secondary, fontSize: 15 },
    skeleton: { height: 12, borderRadius: 4, backgroundColor: colors.raised },
    brandLogo: { width: 76, height: 76, borderRadius: 18, marginBottom: 14 },
    brandWordmark: { color: colors.text, fontSize: 12, fontWeight: '900', letterSpacing: 1.1, marginBottom: 22 },
    brandAccent: { color: colors.brand },
    pairingScreen: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 24 },
    pairingContent: { width: '100%' },
    pairingCard: { maxWidth: 480, alignSelf: 'center', paddingHorizontal: 40, paddingVertical: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    pairingTitle: { color: colors.text, fontSize: 32, lineHeight: 36, fontWeight: '800', letterSpacing: -1, maxWidth: 330 },
    pairingCopy: { color: colors.secondary, fontSize: 16, lineHeight: 24, marginTop: 14, marginBottom: 28, maxWidth: 350 },
    primaryButton: { minHeight: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, backgroundColor: colors.brand },
    primaryButtonText: { color: colors.accentText, fontSize: 16, fontWeight: '800' },
    secondaryButton: { minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22, marginTop: 24, backgroundColor: colors.surface },
    secondaryButtonText: { color: colors.text, fontWeight: '700', fontSize: 15 },
    demoEntryButton: { marginTop: 10 },
    demoBanner: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: `${colors.brand}55`, backgroundColor: `${colors.brand}12` },
    demoBadge: { overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, backgroundColor: colors.brand, color: colors.accentText, fontSize: 9, fontWeight: '900', letterSpacing: .8 },
    demoBannerText: { flex: 1, minWidth: 0, color: colors.secondary, fontSize: 11 },
    demoExit: { fontSize: 11, fontWeight: '800' },
    orRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 20 },
    orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    orText: { color: colors.muted, fontSize: 12 },
    inlineForm: { flexDirection: 'row', gap: 8 },
    pairInput: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10 },
    pairInputSegment: { flex: 1, minWidth: 0, minHeight: 52, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, color: colors.text, paddingHorizontal: 8, textAlign: 'center', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 17, fontWeight: '800', letterSpacing: 3 },
    inlineButton: { minHeight: 48, minWidth: 86, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    inlineButtonText: { color: colors.text, fontWeight: '700' },
    inlineError: { color: colors.danger, fontSize: 13, lineHeight: 18, marginTop: 12 },
    securityNote: { color: colors.muted, fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 22 },
    pairingHostSheet: { paddingTop: 9 },
    pairingHostDesktopSheet: { maxWidth: 520 },
    pairingModalContent: { paddingBottom: 2 },
    pairingModalHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingBottom: 14, marginBottom: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    pairingModalBack: { width: 38, height: 38, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.raised },
    pairingModalHeaderCopy: { flex: 1, minWidth: 0 },
    pairingModalTitle: { color: colors.text, fontSize: 17, lineHeight: 21, fontWeight: '800' },
    pairingModalSubtitle: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 },
    pairingModalCopy: { maxWidth: undefined, marginTop: 0, marginBottom: 18, fontSize: 13, lineHeight: 20 },
    pairingModalInlineForm: { flexDirection: 'column' },
    pairingModalSecurityNote: { textAlign: 'left', fontSize: 10, lineHeight: 15, marginTop: 16 },
    pairingModalConfirmation: { flex: 0, paddingVertical: 24 },
    scannerScreen: { flex: 1, backgroundColor: '#090a0c' },
    scannerHeader: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
    scannerTitle: { color: '#f5f5f6', fontSize: 16, fontWeight: '700' },
    headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
    headerButtonText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
    scannerPermission: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
    permissionTitle: { color: '#ffffff', fontWeight: '800', fontSize: 23, textAlign: 'center' },
    permissionCopy: { color: '#a6acb8', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 6 },
    cameraWrap: { flex: 1, overflow: 'hidden' },
    scanShade: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.18)' },
    scanFrame: { width: 292, height: 292, borderRadius: 28, borderWidth: 3, borderColor: '#ffffff', backgroundColor: 'transparent' },
    scanHint: { color: '#ffffff', fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: 22, marginHorizontal: 24, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,.55)' },
    zoomControls: { position: 'absolute', left: 0, right: 0, bottom: 22, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
    zoomButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,.38)' },
    zoomButtonText: { color: '#ffffff', fontSize: 26, lineHeight: 28, fontWeight: '500' },
    zoomValue: { minWidth: 48, color: '#ffffff', fontSize: 13, fontWeight: '800', textAlign: 'center', paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(0,0,0,.72)' },
    confirmScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    confirmIcon: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: `${colors.success}20`, borderWidth: 1, borderColor: colors.success },
    confirmIconText: { color: colors.success, fontSize: 28, fontWeight: '800' },
    confirmTitle: { color: colors.text, fontSize: 27, fontWeight: '800', letterSpacing: -.7, textAlign: 'center', marginTop: 24 },
    confirmCopy: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 330 },
    confirmCode: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: 10, fontVariant: ['tabular-nums'], marginTop: 28 },
    confirmHint: { color: colors.muted, fontSize: 13, marginTop: 12 },
    appHeader: { position: 'relative', minHeight: 78, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background },
    wordmarkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    miniMark: { width: 25, height: 25 },
    wordmark: { color: colors.text, fontSize: 27, fontWeight: '800', letterSpacing: -1.05 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    settingsButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
    connectionDot: { width: 7, height: 7, borderRadius: 4 },
    plusButton: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand },
    plusText: { color: colors.accentText, fontSize: 27, lineHeight: 29, fontWeight: '500' },
    newAgentButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, paddingHorizontal: 11, borderRadius: 8, backgroundColor: colors.brand },
    newAgentButtonText: { color: colors.accentText, fontWeight: '800', fontSize: 11, letterSpacing: .6 },
    appHeaderCompact: { minHeight: 56, paddingTop: 10, paddingBottom: 10 },
    sidebarHeading: { color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: -.2 },
    webTopBar: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.background },
    webTopBarMark: { width: 24, height: 24 },
    webTopBarWordmark: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -.7 },
    webTopBarShortcuts: { flex: 1, minWidth: 0 },
    webTopBarShortcutsContent: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 4 },
    webShortcutChip: { position: 'relative', width: 56, height: 34, flexDirection: 'row', alignItems: 'center', padding: 0, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(251,191,36,.55)', backgroundColor: colors.raised, overflow: 'hidden', ...(Platform.OS === 'web' ? { transitionProperty: 'background-color, border-color, transform', transitionDuration: '140ms', transitionTimingFunction: 'ease-out' } as ViewStyle : {}) },
    webShortcutChipHovered: { borderColor: 'rgba(251,191,36,.85)', backgroundColor: mixHex(colors.raised, '#fbbf24', .08), transform: [{ translateY: -1 }] },
    webShortcutChipFocused: Platform.OS === 'web' ? ({ outlineStyle: 'solid', outlineColor: colors.primary, outlineWidth: 2, outlineOffset: 2 } as ViewStyle) : {},
    webShortcutChipDisabled: { borderColor: 'rgba(251,191,36,.35)', backgroundColor: colors.raised },
    webShortcutLaunch: { width: 27, height: '100%', alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: 8, borderBottomLeftRadius: 8 },
    webShortcutDivider: { width: 1, height: 19, backgroundColor: 'rgba(251,191,36,.38)' },
    webShortcutProvider: { width: 26, height: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
    webShortcutPartPressed: { backgroundColor: mixHex(colors.raised, '#fbbf24', .16) },
    webShortcutWorktree: { position: 'absolute', zIndex: 2, left: '50%', bottom: 1, width: 15, height: 9, marginLeft: -7.5, alignItems: 'center', justifyContent: 'center', borderRadius: 4, backgroundColor: colors.background },
    webShortcutHost: { position: 'absolute', zIndex: 2, top: 2, left: 2, width: 12, height: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
    webShortcutAdd: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, ...(Platform.OS === 'web' ? { transitionProperty: 'background-color, border-color, transform', transitionDuration: '140ms', transitionTimingFunction: 'ease-out' } as ViewStyle : {}) },
    webShortcutAddEmpty: { width: 'auto', flexDirection: 'row', gap: 6, paddingHorizontal: 10 },
    webShortcutAddText: { color: colors.secondary, fontSize: 11, fontWeight: '800' },
    webShortcutAddHovered: { borderColor: 'rgba(251,191,36,.68)', backgroundColor: mixHex(colors.surface, '#fbbf24', .08), transform: [{ translateY: -1 }] },
    loadingMuted: { opacity: .34 },
    headerProgressRail: { position: 'absolute', left: 0, right: 0, bottom: -1, height: 2 },
    loadingSearchLine: { width: '48%', height: 10 },
    loadingSessionList: { flex: 1, overflow: 'hidden', paddingHorizontal: 20, paddingBottom: 78 },
    loadingGroupRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 9 },
    loadingGroupLine: { width: 96, height: 9 },
    loadingGroupDivider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    loadingSessionRow: { borderLeftColor: colors.raised },
    loadingStatusRail: { backgroundColor: colors.subtle },
    loadingSessionIcon: { width: 42, height: 42, borderRadius: 11 },
    loadingSessionCopy: { flex: 1, gap: 8 },
    loadingSessionMeta: { width: '46%', height: 8 },
    loadingListText: { color: colors.muted, fontSize: 11, marginBottom: 8, marginLeft: 2 },
    connectionBanner: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: `${colors.warning}16`, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: `${colors.warning}55` },
    connectionBannerText: { flex: 1, color: colors.secondary, fontSize: 12, lineHeight: 17 },
    bannerAction: { color: colors.accent, fontWeight: '800', fontSize: 13 },
    hostFilterScroll: { flexGrow: 0, flexShrink: 0, height: 49, minHeight: 49, maxHeight: 49, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background },
    hostFilterRow: { height: 48, alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 5 },
    hostFilterChip: { position: 'relative', height: 38, maxWidth: 190, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 7, borderWidth: 0, backgroundColor: 'transparent' },
    hostFilterChipSelected: { backgroundColor: 'transparent' },
    hostFilterIconFrame: { width: 18, height: 18, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderWidth: 0, backgroundColor: 'transparent' },
    hostFilterIconFrameSelected: { backgroundColor: 'transparent' },
    hostFilterIcon: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
    hostFilterText: { flexShrink: 1, color: colors.secondary, fontSize: 11, fontWeight: '700' },
    hostFilterTextSelected: { color: colors.text },
    hostFilterCount: { minWidth: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, backgroundColor: 'transparent' },
    hostFilterCountSelected: { backgroundColor: 'transparent' },
    hostFilterCountText: { color: colors.muted, fontSize: 9, lineHeight: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
    hostFilterCountTextSelected: { color: colors.accent },
    hostFilterIndicator: { position: 'absolute', left: 7, right: 7, bottom: 1, height: 2, borderRadius: 1, backgroundColor: colors.accent },
    searchWrap: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 20, marginTop: 16, marginBottom: 10, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    searchWrapFocused: { borderColor: colors.accent },
    searchIcon: { width: 20, alignItems: 'center', justifyContent: 'center' },
    searchInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 15, paddingVertical: 8 },
    sessionRowMainPressed: { opacity: 0.92 },
    historySearchSection: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 13, backgroundColor: colors.raised, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    historyFilterPanel: { overflow: 'hidden', borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    historySearchWrap: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    historyPanelSearchWrap: { minHeight: 52, borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, borderRadius: 0 },
    historySearchInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 15, paddingVertical: 8 },
    historyAgentSection: { paddingHorizontal: 8, paddingTop: 9, paddingBottom: 12 },
    historyFilterHeading: { minHeight: 27, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 7 },
    historyFilterLabel: { color: colors.secondary, fontSize: 11, fontWeight: '800' },
    historyFilterReset: { minHeight: 26, justifyContent: 'center', paddingHorizontal: 7, borderRadius: 8 },
    historyFilterResetText: { color: colors.accent, fontSize: 10, fontWeight: '800' },
    historyFilterRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    historyAgentToggle: { position: 'relative', minWidth: 0, height: 55, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 2, borderRadius: 11, borderWidth: 1, borderColor: 'transparent', backgroundColor: colors.raised },
    historyAgentToggleOn: { borderColor: colors.accent, backgroundColor: `${colors.accent}14` },
    historyAgentToggleOff: { opacity: 0.34 },
    historyAgentToggleIndicator: { position: 'absolute', top: 5, right: 5, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
    historyAgentToggleLabel: { maxWidth: '100%', color: colors.muted, fontSize: 7.5, fontWeight: '700', letterSpacing: -0.15, textAlign: 'center' },
    historyProjectSelect: { minHeight: 49, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
    historyProjectSelectIcon: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.raised },
    historyProjectSelectCopy: { minWidth: 0, flex: 1 },
    historyProjectSelectLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: .3, textTransform: 'uppercase' },
    historyProjectSelectText: { minWidth: 0, color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 1 },
    historyProjectSheet: { height: '74%' },
    historyProjectDesktopSheet: { width: '100%', maxWidth: 680, height: 'auto', maxHeight: 680, overflow: 'hidden' },
    historyProjectCount: { color: colors.muted, fontSize: 11, marginTop: 4 },
    historyProjectOptionsScroll: { flex: 1, minHeight: 0 },
    historyProjectOptionsScrollDesktop: { flexGrow: 0, flexBasis: 'auto', maxHeight: 530 },
    historyProjectOptions: { gap: 8, paddingTop: 10, paddingBottom: 20 },
    historyProjectOptionIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.background },
    historyGroupLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase', paddingTop: 16, paddingBottom: 6 },
    historyMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
    historyProjectBadge: { maxWidth: 180, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.raised },
    historyProjectBadgeText: { color: colors.secondary, fontSize: 11, fontWeight: '700' },
    quotaOverview: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 20, marginBottom: 2, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 15, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    quotaRing: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    quotaRingSvg: { position: 'absolute' },
    quotaOverviewCopy: { flex: 1, minWidth: 0 },
    quotaEyebrow: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: .8, textTransform: 'uppercase' },
    quotaOverviewTitle: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 3 },
    quotaOverviewEnd: { maxWidth: 112, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
    quotaOverviewReset: { flexShrink: 1, color: colors.muted, fontSize: 10, lineHeight: 14, textAlign: 'right' },
    sessionList: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 88 },
    sessionListCompact: { paddingTop: 4 },
    sectionHeading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 3 },
    sectionHeadingCompact: { marginTop: 0 },
    sectionHeadingPressed: { opacity: .72 },
    sectionTitle: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.25, textTransform: 'uppercase' },
    sectionNotificationDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.warning },
    minimizedSectionIcon: { color: colors.accent, fontSize: 15, fontWeight: '800' },
    minimizedSectionTitle: { color: colors.secondary },
    sectionLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    sectionChevron: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
    sessionRow: { position: 'relative', minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 7, paddingLeft: 9, paddingRight: 47, paddingVertical: 11, overflow: 'hidden', borderRadius: 8, borderWidth: 1, borderLeftWidth: 3, borderColor: colors.border, backgroundColor: colors.surface },
    sessionSwipeCard: { width: '100%', backgroundColor: colors.background, ...(Platform.OS === 'web' ? { touchAction: 'pan-y' as any } : {}) },
    sessionSwipeContainer: { position: 'relative', marginBottom: 7, overflow: 'hidden', borderRadius: 8, backgroundColor: colors.raised },
    sessionSwipeContainerCompact: { marginBottom: 4, borderRadius: 12 },
    sessionSwipeRow: { marginBottom: 0 },
    sessionSwipeActions: { position: 'absolute', top: 0, right: 0, bottom: 0, width: SESSION_CLOSE_SWIPE_THRESHOLD },
    sessionSwipeDangerBed: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: `${colors.danger}18` },
    sessionSwipeDangerFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.danger },
    sessionSwipePrimaryMotion: { position: 'absolute', top: 0, bottom: 0, left: SESSION_CLOSE_SWIPE_THRESHOLD - SESSION_ACTIONS_WIDTH, width: SESSION_ACTIONS_WIDTH / 2 },
    sessionSwipeDangerMotion: { position: 'absolute', top: 0, right: 0, bottom: 0, width: SESSION_ACTIONS_WIDTH / 2 },
    sessionSwipeAction: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
    sessionSwipePrimary: { backgroundColor: `${colors.accent}18` },
    sessionSwipeActionContent: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 4 },
    sessionSwipeArmedContent: { zIndex: 1 },
    sessionSwipeDangerRing: { position: 'absolute', top: '50%', left: '50%', width: 46, height: 46, marginTop: -23, marginLeft: -23, borderWidth: 2, borderColor: '#ffffff', borderRadius: 23 },
    sessionSwipeArmedText: { color: '#ffffff' },
    sessionSwipeActionText: { fontSize: 10, fontWeight: '800' },
    sessionRowCompact: { minHeight: 48, marginBottom: 4, paddingRight: 40, paddingVertical: 6, borderRadius: 12 },
    sessionNotificationRow: { borderLeftColor: '#f59e0b', shadowColor: '#f59e0b', shadowOpacity: .55, shadowRadius: 10, shadowOffset: { width: -3, height: 0 }, elevation: 5 },
    sessionSelectedRow: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    sessionRowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 },
    sessionElapsed: { color: colors.muted, fontSize: 9, lineHeight: 12, fontVariant: ['tabular-nums'] },
    sessionHostCorner: { position: 'absolute', zIndex: 2, top: 7, right: 8, flexDirection: 'row', alignItems: 'center', gap: 5 },
    sessionHostCornerCompact: { top: 4, right: 5, gap: 3 },
    sessionHostIcon: { width: 21, height: 21, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: `${colors.secondary}12` },
    sessionHostIconCompact: { width: 12, height: 12, borderRadius: 4 },
    sessionHostBadge: { maxWidth: 92, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8, backgroundColor: `${colors.secondary}12` },
    sessionHostBadgeCloud: { backgroundColor: `${colors.primary}18` },
    sessionHostBadgeText: { flexShrink: 1, color: colors.secondary, fontSize: 8, fontWeight: '800' },
    sessionHostBadgeTextCloud: { color: colors.primary },
    sessionActionsButton: { position: 'absolute', zIndex: 2, top: '50%', right: 4, width: 32, minHeight: 22, marginTop: -11, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
    sessionActionsButtonCompact: { right: 1, width: 30, minHeight: 16, marginTop: -6, borderRadius: 7 },
    sessionActionsText: { color: colors.secondary, fontSize: 15, lineHeight: 18, fontWeight: '800', letterSpacing: 1 },
    sessionStatusButton: { flexShrink: 0 },
    sessionStatusRail: { width: 3, height: 26, borderRadius: 2, flexShrink: 0 },
    sessionStatusRailCompact: { height: 16 },
    agentIconFrame: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
    projectIconFrame: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    projectIconText: { color: '#ffffff', fontWeight: '900' },
    sessionIcons: { width: 42, height: 42, justifyContent: 'flex-start', overflow: 'visible' },
    sessionIconsCompact: { width: 34, height: 34 },
    sessionAgentIcon: { position: 'absolute', right: -3, bottom: -3, borderRadius: 8, borderWidth: 2, borderColor: colors.surface },
    sessionAgentIconCompact: { right: -2, bottom: -2, borderRadius: 6 },
    sessionCopy: { flex: 1, minWidth: 0 },
    sessionCopyCompact: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    sessionTitle: { color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: '700' },
    sessionTitleCompact: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
    sessionMeta: { color: colors.muted, fontSize: 12, marginTop: 4 },
    sessionMetaCompact: { flex: 1, minWidth: 72, marginTop: 0, fontSize: 10 },
    sessionGoal: { color: colors.secondary, fontSize: 11, lineHeight: 15, marginTop: 4 },
    sessionActivity: { color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 2 },
    sessionActivityCompact: { flex: 1, minWidth: 72, marginTop: 0, fontSize: 10 },
    emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 38 },
    emptyTitle: { color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'center' },
    emptyCopy: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, marginBottom: 24 },
    forgetButton: { position: 'absolute', bottom: 62, alignSelf: 'center', minHeight: 40, justifyContent: 'center', paddingHorizontal: 16 },
    forgetText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
    bottomNav: { position: 'absolute', zIndex: 10, left: 14, right: 14, bottom: 9, height: 66, flexDirection: 'row', alignItems: 'stretch', padding: 4, overflow: 'hidden', borderRadius: 33, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: `${colors.raised}ee`, shadowColor: '#000000', shadowOpacity: .28, shadowRadius: 17, shadowOffset: { width: 0, height: 10 }, elevation: 12 },
    bottomNavIndicator: { position: 'absolute', left: 4, top: 4, bottom: 4, borderRadius: 29, backgroundColor: colors.surface, shadowColor: '#000000', shadowOpacity: .16, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
    bottomNavItem: { zIndex: 1, flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 29 },
    topNav: { position: 'relative', left: 0, right: 0, bottom: 0, marginHorizontal: 14, marginTop: 10, marginBottom: 4, height: 44, borderRadius: 22, shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
    topNavIndicator: { borderRadius: 18 },
    topNavItem: { minHeight: 36, borderRadius: 18 },
    bottomNavLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' },
    bottomNavActive: { color: colors.text },
    settingsSheet: { paddingBottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
    settingsDesktopLayout: { alignItems: 'center', paddingHorizontal: 24 },
    settingsDesktopSheet: { width: '100%', maxWidth: 720 },
    settingsScroll: { flexShrink: 1 },
    settingsContent: { paddingBottom: Platform.OS === 'ios' ? 36 : 24 },
    settingsHeaderCopy: { flex: 1, minWidth: 0, paddingRight: 12 },
    settingsTitle: { color: colors.text, fontSize: 28, lineHeight: 30, fontWeight: '800', letterSpacing: -1 },
    settingsSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 5 },
    settingsCloseButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: colors.raised },
    settingsSectionHeading: { minHeight: 22, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 18, marginHorizontal: 2, marginBottom: 8 },
    settingsSectionTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
    settingsSectionMeta: { color: colors.muted, fontSize: 10 },
    settingsGroup: { overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: 17, backgroundColor: colors.background },
    settingsBlock: { paddingHorizontal: 13, paddingVertical: 11 },
    settingsBlockDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    settingsOptionTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
    settingsOptionHelp: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3, marginBottom: 9 },
    shortcutRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 13, paddingVertical: 9 },
    shortcutRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    shortcutKeys: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, color: colors.text, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.raised },
    projectShortcutRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 11, paddingRight: 7, paddingVertical: 7 },
    projectShortcutMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
    projectShortcutCopy: { flex: 1, minWidth: 0 },
    projectShortcutRemove: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 9 },
    projectShortcutRemoveText: { color: colors.danger, fontSize: 10, fontWeight: '800' },
    settingsNotificationRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
    settingsNotificationCopy: { flex: 1, minWidth: 0 },
    settingsNotificationHelp: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 },
    settingsNotificationSwitch: { width: 50, height: 30, flexShrink: 0, justifyContent: 'center', paddingHorizontal: 4, borderRadius: 15, backgroundColor: colors.raised },
    settingsNotificationSwitchEnabled: { backgroundColor: colors.accent },
    settingsNotificationKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.secondary },
    settingsNotificationKnobEnabled: { alignSelf: 'flex-end', backgroundColor: colors.accentText },
    displayChoices: { flexDirection: 'row', gap: 6 },
    displayChoice: { flex: 1, minHeight: 48, alignItems: 'flex-start', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.raised },
    displayChoiceSelected: { backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: .22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
    displayChoiceText: { color: colors.secondary, fontSize: 11, fontWeight: '800' },
    displayChoiceTextSelected: { color: colors.text },
    displayChoiceTextActive: { color: colors.accentText },
    displayChoiceMeta: { color: colors.muted, fontSize: 8, lineHeight: 11, marginTop: 3 },
    displayChoiceMetaSelected: { color: colors.accentText },
    densityChoices: { flexDirection: 'row', gap: 6 },
    densityChoice: { flex: 1, minHeight: 92, padding: 8, borderRadius: 11, borderWidth: 1, borderColor: 'transparent', backgroundColor: colors.raised },
    densityChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}18` },
    densityPreview: { height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingVertical: 5, overflow: 'hidden', borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    densityPreviewCompact: { height: 24, paddingVertical: 3 },
    densityPreviewAvatar: { width: 20, height: 20, flexShrink: 0, borderRadius: 6, backgroundColor: `${colors.accent}66` },
    densityPreviewAvatarCompact: { width: 14, height: 14, borderRadius: 4 },
    densityPreviewLines: { flex: 1 },
    densityPreviewLine: { width: '76%', height: 3, marginVertical: 2, borderRadius: 2, backgroundColor: colors.secondary },
    densityPreviewLineShort: { width: '52%', backgroundColor: colors.muted },
    densityPreviewLineHidden: { display: 'none' },
    densityChoiceTitle: { color: colors.secondary, fontSize: 10, fontWeight: '800', marginTop: 7 },
    densityChoiceMeta: { color: colors.muted, fontSize: 8, lineHeight: 11, marginTop: 2 },
    themeChoices: { flexDirection: 'row', gap: 5, padding: 9 },
    themeChoice: { position: 'relative', minWidth: 0, minHeight: 84, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 7, padding: 5, borderRadius: 13, borderWidth: 1, borderColor: 'transparent' },
    themeChoiceSelected: { borderColor: `${colors.accent}88`, backgroundColor: `${colors.accent}18` },
    themePreview: { width: 42, height: 42, flexShrink: 0, overflow: 'hidden', borderRadius: 14, borderWidth: 1 },
    themePreviewSurface: { height: 14, marginHorizontal: 7, marginTop: 7, borderRadius: 6 },
    themePreviewAccent: { width: 24, height: 6, alignSelf: 'center', marginTop: 7, borderRadius: 3 },
    themeCheck: { position: 'absolute', top: 5, right: 5, color: colors.accentText, backgroundColor: colors.accent, width: 16, height: 16, borderRadius: 8, textAlign: 'center', lineHeight: 16, fontSize: 9, fontWeight: '900' },
    settingsComputerRow: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, paddingVertical: 11 },
    connectedHostRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, paddingVertical: 9 },
    settingsComputerIcon: { width: 38, height: 38, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.raised },
    connectedHostActions: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
    hostIconChange: { minHeight: 28, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.raised },
    hostIconChangeText: { color: colors.secondary, fontSize: 9, fontWeight: '800' },
    hostIconPicker: { paddingHorizontal: 13, paddingBottom: 12 },
    hostIconPickerHeader: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    hostIconPickerTitle: { color: colors.secondary, fontSize: 9, fontWeight: '800', letterSpacing: .8, textTransform: 'uppercase' },
    hostIconPickerCount: { color: colors.muted, fontSize: 9 },
    hostIconChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    hostIconChoice: { position: 'relative', minWidth: 76, minHeight: 68, flexGrow: 1, flexBasis: '30%', maxWidth: '31.5%', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    hostIconChoiceDesktop: { flexBasis: '18%', maxWidth: '19.1%' },
    hostIconChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    hostIconChoiceDot: { position: 'absolute', top: 7, right: 7, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
    hostIconChoiceText: { color: colors.secondary, fontSize: 9, fontWeight: '800' },
    hostIconChoiceTextSelected: { color: colors.text },
    settingsActionRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    settingsActionTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
    settingsDangerRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    settingsDangerMeta: { color: colors.muted, fontSize: 10 },
    cloudProviderList: { paddingBottom: Platform.OS === 'ios' ? 36 : 24 },
    cloudProviderRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 4, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    cloudProviderIcon: { width: 36, height: 36, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.raised },
    cloudProviderCopy: { flex: 1, minWidth: 0 },
    cloudProviderName: { color: colors.text, fontSize: 13, fontWeight: '800' },
    cloudProviderStatus: { color: colors.muted, fontSize: 10, marginTop: 3 },
    cloudProviderReady: { color: colors.success, fontSize: 11, fontWeight: '800' },
    cloudProviderButton: { minWidth: 76, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 11, backgroundColor: colors.accent },
    cloudProviderButtonText: { color: colors.accentText, fontSize: 11, fontWeight: '800' },
    historyRefresh: { minWidth: 70, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    historyRefreshText: { color: colors.accent, fontSize: 13, fontWeight: '800' },
    historyList: { flexGrow: 1, paddingHorizontal: 16, paddingBottom: 76 },
    historyRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    historyTime: { color: colors.muted, fontSize: 11 },
    chatHeader: { position: 'relative', height: 68, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background },
    startingChatHeaderEdge: { width: 44, height: 44 },
    startingActivityRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    startingActivityLabel: { color: colors.accent, fontSize: 10, fontWeight: '800' },
    startingActivityText: { flex: 1, color: colors.secondary, fontSize: 10 },
    startingChatSkeletonFrame: { flex: 1, overflow: 'hidden' },
    startingChatSkeleton: { flex: 1, overflow: 'hidden', gap: 20, paddingHorizontal: 20, paddingTop: 28 },
    startingSkeletonLineWide: { width: '82%', height: 11 },
    startingSkeletonLineShort: { width: '61%', height: 11 },
    startingSkeletonBubble: { width: '68%', height: 54, alignSelf: 'flex-end', borderRadius: 18 },
    startingComposerWrap: { paddingHorizontal: 14, paddingVertical: 11 },
    startingComposer: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 27, backgroundColor: colors.surface },
    startingComposerAdd: { color: colors.muted, fontSize: 22 },
    startingComposerText: { flex: 1, color: colors.muted, fontSize: 15 },
    startingComposerSend: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: colors.accent, opacity: .42 },
    chatHeaderIdentity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
    chatHeaderIcons: { width: 48, height: 42, flexShrink: 0 },
    chatAgentIcon: { position: 'absolute', right: 0, bottom: 0, borderRadius: 8, borderWidth: 3, borderColor: colors.background, backgroundColor: colors.background },
    backButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    backText: { color: colors.text, fontSize: 38, lineHeight: 39, fontWeight: '300' },
    chatHeading: { flex: 1, minWidth: 0 },
    chatHeadingButton: { minHeight: 44, justifyContent: 'center' },
    chatHeaderMarks: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
    chatHeaderStatus: { width: 28, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
    chatHeaderStatusRail: { width: 4, height: 32, borderRadius: 2 },
    chatTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
    chatSubtitleRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    chatConnectionDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
    chatSubtitle: { flexShrink: 1, color: colors.muted, fontSize: 10 },
    chatHeaderActions: { flexDirection: 'row', alignItems: 'center' },
    moreButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    moreButtonText: { color: colors.secondary, fontSize: 18, lineHeight: 20, fontWeight: '800', letterSpacing: 1 },
    chatControlsScroll: { height: 54, minHeight: 54, maxHeight: 54, flexGrow: 0, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background },
    chatControls: { minHeight: 53, alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 6 },
    configChip: { minHeight: 41, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    configChipLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
    configChipText: { maxWidth: 112, color: colors.text, fontSize: 11, fontWeight: '700' },
    modelButton: { maxWidth: 88, minHeight: 36, justifyContent: 'center', paddingHorizontal: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    modelButtonText: { color: colors.secondary, fontSize: 10, fontWeight: '800' },
    previewButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    stopSessionButton: { minWidth: 52, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    stopSessionText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
    timeline: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12, flexGrow: 1 },
    timelineDesktop: { width: '100%', maxWidth: 970, alignSelf: 'center' },
    timelineWithFirst: { paddingTop: 68 },
    timelineFrame: { flex: 1, minHeight: 0 },
    timelineSkeletonOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    historyLoadButton: { alignSelf: 'center', minHeight: 36, justifyContent: 'center', marginBottom: 20, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    historyLoadButtonText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
    timelineHidden: { opacity: 0 },
    messageRow: { width: '100%', marginBottom: 30, alignItems: 'flex-start' },
    sessionCoordinationFallback: { alignItems: 'flex-end', marginBottom: 24 },
    sessionCoordinationCluster: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, borderColor: `${colors.accent}55`, backgroundColor: `${colors.accent}12` },
    sessionCoordinationClusterText: { color: colors.secondary, fontSize: 10, fontWeight: '800' },
    sessionCoordinationIcon: { width: 30, height: 30, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: `${colors.accent}18` },
    sessionCoordinationCopy: { flex: 1, minWidth: 0 },
    sessionCoordinationSource: { color: colors.text, fontSize: 13, fontWeight: '800' },
    sessionCoordinationAction: { color: colors.muted, fontSize: 10, lineHeight: 12, marginTop: 1 },
    sessionCoordinationAgent: { flexShrink: 0, color: colors.secondary, fontSize: 9, fontWeight: '800', textTransform: 'capitalize' },
    userRow: { alignItems: 'flex-end' },
    userBubble: { maxWidth: '86%', paddingHorizontal: 14, paddingVertical: 11, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomLeftRadius: 18, borderBottomRightRadius: 5, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    failedBubble: { borderColor: colors.danger, backgroundColor: `${colors.danger}14` },
    userBubbleText: { color: colors.text, fontSize: 16, lineHeight: 23 },
    assistantBubble: { width: '100%', paddingRight: 9 },
    assistantText: { color: colors.text, fontSize: 16, lineHeight: 25 },
    messageTime: { color: colors.muted, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 10, fontWeight: '500', fontVariant: ['tabular-nums'], marginTop: 7 },
    markdownBlock: { marginBottom: 12 },
    markdownBold: { fontWeight: '700' },
    markdownInlineCode: { color: colors.accent, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
    markdownLink: { color: colors.accent, textDecorationLine: 'underline' },
    markdownHeading: { color: colors.text, fontSize: 18, lineHeight: 25, fontWeight: '800' },
    markdownHeadingLarge: { fontSize: 21, lineHeight: 28 },
    markdownList: { gap: 5 },
    markdownListItem: { flexDirection: 'row', alignItems: 'flex-start' },
    markdownListMarker: { width: 22, color: colors.secondary, fontSize: 16, lineHeight: 25 },
    markdownListCopy: { flex: 1, minWidth: 0 },
    markdownCode: { position: 'relative', overflow: 'hidden', borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    markdownCodeError: { borderColor: `${colors.danger}80` },
    markdownCodeScroll: { paddingLeft: 12, paddingRight: 54, paddingVertical: 12 },
    markdownCodeScrollWithStatus: { paddingTop: 38 },
    markdownCodeText: { color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13, lineHeight: 20 },
    markdownCodeStatus: { position: 'absolute', top: 13, left: 13, color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: .7, textTransform: 'uppercase' },
    markdownCodeStatusError: { color: colors.danger },
    markdownCodeCopy: { position: 'absolute', top: 8, right: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    markdownCodeCopyDone: { backgroundColor: `${colors.success}18` },
    markdownMermaid: { position: 'relative', minHeight: 220, overflow: 'hidden', paddingTop: 38, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    markdownMermaidLabel: { position: 'absolute', top: 14, left: 13, color: colors.muted, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 9, fontWeight: '800', letterSpacing: .8 },
    markdownMermaidScroll: { minHeight: 180, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingBottom: 16 },
    markdownTable: { borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
    markdownTableContent: { flexGrow: 1 },
    markdownTableGrid: { flexGrow: 1 },
    markdownTableRow: { flexDirection: 'row' },
    markdownTableCell: { width: 140, flexGrow: 1, paddingHorizontal: 9, paddingVertical: 7, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    localPreviewCards: { width: '100%', gap: 8, marginTop: 8 },
    localPreviewCard: { width: '100%', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: `${colors.accent}52`, backgroundColor: colors.surface },
    localPreviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    localPreviewLabel: { color: colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
    localPreviewUrl: { color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 8 },
    localPreviewMeta: { color: colors.muted, fontSize: 10, marginTop: 4 },
    localPreviewAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 11, borderRadius: 9, backgroundColor: colors.accent },
    localPreviewActionDesktop: { minHeight: 36, alignSelf: 'flex-start', paddingHorizontal: 18 },
    localPreviewActionPressed: { opacity: .82 },
    localPreviewActionDisabled: { opacity: .5 },
    localPreviewActionText: { color: colors.accentText, fontSize: 12, fontWeight: '900' },
    localPreviewError: { color: colors.danger, fontSize: 10, lineHeight: 14, marginTop: 8 },
    activityCue: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 24 },
    activityCueText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
    pendingStatusRow: { minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
    pendingLabel: { color: colors.muted, fontSize: 10, textAlign: 'right' },
    pendingProgressTrack: { width: '100%', height: 3, overflow: 'hidden', borderRadius: 2, backgroundColor: colors.raised },
    pendingProgressFill: { height: 3, borderRadius: 2, backgroundColor: colors.accent },
    pendingFailed: { color: colors.danger },
    pendingRetry: { minHeight: 24, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 8, backgroundColor: `${colors.danger}18` },
    pendingRetryText: { color: colors.danger, fontSize: 10, fontWeight: '800' },
    attachmentStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
    attachmentStripCarousel: { flexWrap: 'nowrap' },
    attachmentCarousel: { width: '100%', maxWidth: 320, maxHeight: 60, flexGrow: 0, flexShrink: 0 },
    attachmentPreview: { minWidth: 132, maxWidth: 220, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 6, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    attachmentImage: { width: 34, height: 34, borderRadius: 7 },
    imageViewerShell: { flex: 1, overflow: 'hidden', ...(Platform.OS === 'web' ? { touchAction: 'pan-x' as any } : {}) },
    imageViewerBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
    imageViewer: { flex: 1, paddingTop: 52, paddingBottom: 24 },
    imageViewerHeader: { zIndex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 12 },
    imageViewerGestureArea: { flex: 1, ...(Platform.OS === 'web' ? { touchAction: 'none' as any } : {}) },
    imageViewerTitle: { flex: 1, color: '#ffffff', fontSize: 15, fontWeight: '700' },
    imageViewerCount: { color: '#a4a4aa', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    imageViewerClose: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
    imageViewerCarousel: { flex: 1 },
    imageViewerPage: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    imageViewerZoomSurface: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
    imageViewerNativeZoom: { width: '100%', height: '100%' },
    imageViewerImage: { width: '100%', height: '100%' },
    imageViewerLoading: { color: '#b4b4b4', textAlign: 'center', padding: 14, fontSize: 12, fontWeight: '600' },
    imageViewerZoomControls: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
    imageViewerZoomButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
    imageViewerZoomButtonText: { color: '#ffffff', fontSize: 23, lineHeight: 25, fontWeight: '500' },
    imageViewerZoomLevel: { minWidth: 62, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21, backgroundColor: 'rgba(255,255,255,.10)' },
    imageViewerZoomLevelText: { color: '#ffffff', fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
    imageViewerControls: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 18 },
    imageViewerArrow: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21, backgroundColor: 'rgba(255,255,255,.12)' },
    imageViewerDots: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    imageViewerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,.28)' },
    imageViewerDotActive: { width: 16, backgroundColor: '#ffffff' },
    attachmentIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: `${colors.accent}18` },
    attachmentCopy: { flex: 1, minWidth: 0 },
    attachmentName: { color: colors.text, fontSize: 11, fontWeight: '700' },
    attachmentMeta: { color: colors.muted, fontSize: 9, marginTop: 2, textTransform: 'capitalize' },
    composerAttachmentStrip: { gap: 7, paddingHorizontal: 10, paddingVertical: 8, marginTop: 0, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface },
    composerAttachmentStripDesktop: { alignSelf: 'flex-start', marginTop: 12, marginHorizontal: 16, paddingHorizontal: 0, paddingVertical: 0, borderWidth: 0, backgroundColor: 'transparent' },
    attachmentCarouselDesktop: { alignSelf: 'flex-start' },
    composerAttachmentPreview: { position: 'relative', minWidth: 54, width: 54, height: 54, minHeight: 54, padding: 0, overflow: 'visible', borderRadius: 12 },
    composerAttachmentImage: { width: 52, height: 52, borderRadius: 11 },
    composerAttachmentRemove: { position: 'absolute', right: -6, top: -6, borderRadius: 12, backgroundColor: colors.subtle },
    composerAttachmentRemoveDesktop: { right: 1, top: 1 },
    workGroup: { width: '100%', marginBottom: 34, overflow: 'hidden' },
    workGroupSummaryRow: { minHeight: 47, flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    workGroupSummary: { flex: 1, minWidth: 0, minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 8 },
    workGroupTitle: { color: colors.secondary, fontSize: 12.5, fontWeight: '600' },
    workGroupTitleActive: { color: colors.accent },
    workGroupTime: { marginTop: 0, marginLeft: 'auto' },
    workGroupDetails: { paddingTop: 10 },
    workStep: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', paddingVertical: 7, paddingRight: 4 },
    workStepDot: { width: 5, height: 5, borderRadius: 3, marginTop: 6, backgroundColor: colors.success },
    workStepDotActive: { backgroundColor: colors.accent },
    workDotFailed: { backgroundColor: colors.danger },
    workCopy: { flex: 1 },
    workTitle: { color: colors.text, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
    workDetail: { color: colors.secondary, fontSize: 12, lineHeight: 17, marginTop: 3 },
    workStatus: { color: colors.muted, fontSize: 10, fontWeight: '700' },
    workStatusActive: { color: colors.accent },
    chatEmpty: { flex: 1, minHeight: 300 },
    chatEmptyInner: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    chatEmptyInnerDesktop: { paddingHorizontal: 64, paddingBottom: 34 },
    chatEmptyBrand: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
    chatEmptyBrandDesktop: { marginBottom: 12 },
    chatEmptyLogo: { width: 64, height: 64 },
    chatEmptyEyebrow: { color: colors.accent, fontSize: 13, lineHeight: 18, fontWeight: '900', letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 20 },
    chatEmptyTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
    chatEmptyTitleDesktop: { fontSize: 40, lineHeight: 48, fontWeight: '800', letterSpacing: -1.2, textAlign: 'center' },
    chatEmptyStatus: { minHeight: 24, maxWidth: 300, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 9 },
    chatEmptyStatusDesktop: { maxWidth: 690, marginTop: 18 },
    chatEmptyCopy: { flexShrink: 1, color: colors.secondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
    chatEmptyCopyDesktop: { fontSize: 17, lineHeight: 26 },
    chatEmptyIdentity: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 28, paddingHorizontal: 15, paddingVertical: 7, borderRadius: 28, borderWidth: 1, borderColor: colors.border, backgroundColor: `${colors.surface}d9` },
    chatEmptyIdentityLink: { color: colors.secondary, fontSize: 13, fontWeight: '700' },
    latestButton: { position: 'absolute', right: 16, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    latestText: { color: colors.text, fontSize: 12, fontWeight: '700' },
    firstButton: { position: 'absolute', zIndex: 3, top: 12, right: 16, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    firstText: { color: colors.text, fontSize: 12, fontWeight: '700' },
    composerRegion: { zIndex: 4, marginHorizontal: 8, marginBottom: Platform.OS === 'web' ? 0 : 13, transform: Platform.OS === 'web' ? [{ translateY: -WEB_COMPOSER_GAP }] : undefined },
    composerRegionDesktop: { width: 'calc(100% - 56px)' as any, maxWidth: 930, alignSelf: 'center', marginHorizontal: 0 },
    desktopContextTray: { zIndex: 0, width: 'calc(100% - 44px)' as any, maxWidth: 886, minHeight: 54, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: -12, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 17, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: `${colors.surface}c7` },
    desktopContextRail: { width: 3, height: 24, borderRadius: 2 },
    desktopContextTitle: { maxWidth: '42%', color: colors.text, fontSize: 12, fontWeight: '800' },
    desktopContextDivider: { width: 1, height: 18, backgroundColor: colors.border },
    desktopContextActivityMotion: { flex: 1, minWidth: 0 },
    desktopContextActivity: { color: colors.secondary, fontSize: 11, fontWeight: '600' },
    composerDesktop: { zIndex: 1, width: '100%', maxWidth: 930, minHeight: 152, alignSelf: 'center', overflow: 'hidden', borderRadius: 20, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, shadowColor: '#000000', shadowOpacity: .24, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
    composerDesktopFooter: { minHeight: 57, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingTop: 3, paddingBottom: 10 },
    composerDesktopControls: { flex: 1, minWidth: 0, maxHeight: 36 },
    composerConfigStrip: { gap: 6, paddingHorizontal: 3, paddingBottom: 7 },
    composerConfigStripDesktop: { alignItems: 'center', gap: 8, paddingHorizontal: 0, paddingBottom: 0 },
    composerConfigChip: { minHeight: 34, maxWidth: 210, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    composerConfigValue: { flexShrink: 1, color: colors.secondary, fontSize: 11, fontWeight: '800' },
    composerConfigDot: { width: 7, height: 7, borderRadius: 4 },
    composerContextUsage: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    composerContextTrack: { width: 48, height: 3, overflow: 'hidden', borderRadius: 2, backgroundColor: colors.raised },
    composerContextFill: { height: 3, borderRadius: 2, backgroundColor: colors.accent },
    todoCard: { marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    todoHeader: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 8 },
    todoTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '800' },
    todoCount: { color: colors.secondary, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
    todoCurrent: { color: colors.accent, fontSize: 11, lineHeight: 16, marginTop: 4 },
    todoBody: { gap: 8, marginTop: 9, paddingTop: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    todoRow: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 8 },
    todoDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: colors.muted },
    todoDotActive: { borderWidth: 4, borderColor: colors.accent },
    todoText: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 17 },
    todoTextDone: { color: colors.muted, textDecorationLine: 'line-through' },
    recordingBar: { minHeight: 126, gap: 12, paddingHorizontal: 15, paddingTop: 15, paddingBottom: 12, borderRadius: 26, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, shadowColor: '#000000', shadowOpacity: .24, shadowRadius: 16, shadowOffset: { width: 0, height: 10 }, elevation: 10 },
    recordingTrack: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 11 },
    recordingMode: { color: colors.text, fontSize: 13, fontWeight: '700' },
    recordingWave: { flex: 1, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1.5, overflow: 'hidden' },
    voiceWaveBar: { width: 2, minHeight: 4, borderRadius: 2, backgroundColor: colors.accent },
    recordingText: { minWidth: 34, color: colors.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
    recordingActions: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 3 },
    recordingAction: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
    recordingPause: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: colors.subtle, borderWidth: 1, borderColor: colors.border },
    recordingDone: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: colors.accent },
    composerRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 2, padding: 8, borderRadius: 24, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface, shadowColor: '#000000', shadowOpacity: .24, shadowRadius: 16, shadowOffset: { width: 0, height: 10 }, elevation: 10 },
    composerTool: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
    composerToolRecording: { backgroundColor: `${colors.danger}18` },
    // Native inline text measures the view's width, not its outside margins.
    inlineMessageAttachment: { width: 34, height: 24, paddingHorizontal: 4, borderRadius: 5, backgroundColor: colors.subtle, ...(Platform.OS === 'web' ? { display: 'inline-flex' as 'flex', verticalAlign: 'middle' as const } : {}) },
    inlineMessageNumber: { position: 'absolute', bottom: 0, right: 4, minWidth: 12, borderRadius: 6, textAlign: 'center', fontSize: 10, lineHeight: 12, color: colors.accentText, backgroundColor: colors.accent },
    sendButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
    sendText: { color: colors.accentText, fontSize: 23, lineHeight: 25, fontWeight: '700' },
    interruptButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    stopSquare: { width: 13, height: 13, borderRadius: 3, backgroundColor: colors.danger },
    decisionCard: { marginTop: 10, marginBottom: 14, borderRadius: 10, padding: 15, backgroundColor: `${colors.warning}12`, borderWidth: 1, borderColor: `${colors.warning}55` },
    questionCard: { marginTop: 10, marginBottom: 14, borderRadius: 10, padding: 15, backgroundColor: `${colors.primary}0d`, borderWidth: 1, borderColor: `${colors.primary}55` },
    decisionLabel: { color: colors.accent, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .6 },
    decisionTitle: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: '600', marginTop: 8 },
    decisionActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
    allowButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 9, backgroundColor: colors.accent },
    allowText: { color: colors.accentText, fontWeight: '800', fontSize: 13 },
    denyButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 9, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    denyText: { color: colors.text, fontWeight: '700', fontSize: 13 },
    questionBlock: { marginTop: 13 },
    questionHeader: { color: colors.muted, fontSize: 11, fontWeight: '800', marginBottom: 5 },
    questionText: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: '600', marginBottom: 9 },
    questionOption: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 7 },
    questionOptionSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    optionControl: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.muted },
    optionCheck: { borderRadius: 5 },
    optionControlSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
    optionCopy: { flex: 1 },
    optionLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
    optionDescription: { color: colors.secondary, fontSize: 11, lineHeight: 16, marginTop: 2 },
    questionInput: { minHeight: 48, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 12, marginTop: 4 },

    modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,.54)' },
    modalBackdropClear: { backgroundColor: 'transparent' },
    modalLayout: { flex: 1, justifyContent: 'flex-end' },
    sheetDesktopNoHandle: { display: 'none' },
    modalLayoutCentered: { justifyContent: 'center', alignItems: 'center', padding: 24 },
    sheetDesktopDialog: { width: '100%', maxWidth: 720, height: undefined, maxHeight: '88%', borderRadius: 20, paddingTop: 22 },
    sheetDesktopCompactDialog: { height: 'auto' },
    sheet: { height: '92%', paddingHorizontal: 18, paddingTop: 9, paddingBottom: Platform.OS === 'ios' ? 30 : 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    configSheet: { maxHeight: '88%', paddingHorizontal: 18, paddingTop: 9, paddingBottom: Platform.OS === 'ios' ? 30 : 20, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    shortcutEditorSheet: { height: '84%' },
    shortcutEditorDesktopSheet: { width: '100%', maxWidth: 720, height: 'auto', maxHeight: 760, borderRadius: 20 },
    shortcutEditorContent: { paddingBottom: 18 },
    shortcutNameInput: { minHeight: 48, paddingHorizontal: 13, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, color: colors.text, fontSize: 15 },
    shortcutEditorOptions: { gap: 7, paddingRight: 2 },
    shortcutEditorOption: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    shortcutProjectSelect: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
    shortcutProjectCopy: { flex: 1, minWidth: 0 },
    shortcutProjectSelectName: { color: colors.text, fontSize: 13, fontWeight: '800' },
    shortcutProjectPath: { color: colors.muted, fontSize: 10, marginTop: 2 },
    shortcutProjectMenu: { maxHeight: 224, marginTop: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
    shortcutProjectMenuContent: { padding: 6 },
    shortcutProjectMenuOption: { width: '100%', borderWidth: 0, borderRadius: 8, backgroundColor: 'transparent' },
    shortcutEditorOptionSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    shortcutEditorOptionText: { flex: 1, minWidth: 0, color: colors.secondary, fontSize: 12, fontWeight: '700' },
    shortcutEditorOptionTextSelected: { color: colors.text },
    shortcutEditorCheck: { color: colors.accent, fontSize: 13, fontWeight: '900' },
    shortcutAgentChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    shortcutAgentChoice: { width: '23%', minWidth: 88, minHeight: 62, alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 5, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    shortcutAgentChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    shortcutAgentLabel: { maxWidth: '100%', color: colors.muted, fontSize: 9, fontWeight: '800' },
    shortcutWorktreeChoices: { flexDirection: 'row', gap: 7 },
    shortcutWorktreeChoice: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    shortcutWorktreeChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    shortcutWorktreeText: { color: colors.secondary, fontSize: 11, fontWeight: '800' },
    sessionCoordinationSheet: { maxHeight: '72%', paddingBottom: Platform.OS === 'ios' ? 30 : 20 },
    sessionCoordinationHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 14 },
    sessionCoordinationSheetIcon: { width: 40, height: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: `${colors.accent}18` },
    sessionCoordinationHeaderCopy: { flex: 1, minWidth: 0 },
    sessionCoordinationLabel: { color: colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: .8, textTransform: 'uppercase' },
    sessionCoordinationTitle: { color: colors.text, fontSize: 16, lineHeight: 21, fontWeight: '900', marginTop: 3 },
    sessionCoordinationBodyScroll: { maxHeight: 380 },
    sessionCoordinationItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    sessionCoordinationItemHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9 },
    sessionCoordinationBody: { color: colors.text, fontSize: 14, lineHeight: 21, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    sessionCoordinationGuard: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: `${colors.accent}12` },
    sessionCoordinationGuardText: { flex: 1, color: colors.secondary, fontSize: 10, lineHeight: 15 },
    connectionSheet: { paddingBottom: Platform.OS === 'ios' ? 36 : 24 },
    connectionCard: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, paddingHorizontal: 14, borderRadius: 15, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    connectionCardCopy: { flex: 1, minWidth: 0 },
    connectionCardTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
    connectionCardMeta: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    dangerRow: { minHeight: 64, justifyContent: 'center', marginTop: 12, paddingHorizontal: 14, borderRadius: 15, borderWidth: 1, borderColor: `${colors.danger}66` },
    dangerRowTitle: { color: colors.danger, fontSize: 14, fontWeight: '800' },
    dangerRowMeta: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    conversationSheet: { height: '88%', overflow: 'hidden', paddingBottom: Platform.OS === 'ios' ? 34 : 22 },
    conversationSheetScroll: { flex: 1, minHeight: 0 },
    conversationSheetContent: { paddingBottom: 2 },
    conversationHeroBezel: { padding: 4, borderRadius: 19, backgroundColor: `${colors.raised}a6`, borderWidth: 1, borderColor: colors.border },
    conversationHero: { minHeight: 116, flexDirection: 'row', alignItems: 'stretch', overflow: 'hidden', borderRadius: 15, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
    conversationModel: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingVertical: 14 },
    conversationAgentHalo: { width: 48, height: 48, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: `${colors.accent}16`, borderWidth: 2, borderColor: `${colors.accent}88`, shadowColor: colors.accent, shadowOpacity: .22, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
    conversationHeroCopy: { flex: 1, minWidth: 0 },
    conversationHeroEyebrow: { color: colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: .9, textTransform: 'uppercase' },
    conversationHeroTitle: { color: colors.text, fontSize: 17, fontWeight: '900', letterSpacing: -.4, marginTop: 6 },
    conversationHeroMeta: { color: colors.muted, fontSize: 10, marginTop: 4 },
    conversationContext: { width: 78, alignItems: 'center', justifyContent: 'center', marginRight: 5 },
    conversationContextRing: { position: 'absolute' },
    conversationContextCopy: { alignItems: 'center', justifyContent: 'center' },
    conversationContextValue: { color: colors.text, fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
    conversationContextLabel: { color: colors.muted, fontSize: 7, fontWeight: '900', letterSpacing: .5, textTransform: 'uppercase', marginTop: 1 },
    conversationControlGrid: { flexDirection: 'row', gap: 8, marginTop: 8 },
    conversationControlTile: { flex: 1, minWidth: 0, minHeight: 82, justifyContent: 'space-between', padding: 12, borderRadius: 16, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    conversationControlHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    conversationControlLabel: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: .8, textTransform: 'uppercase' },
    conversationControlIcon: { width: 25, height: 25, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: `${colors.accent}13` },
    conversationControlValue: { color: colors.text, fontSize: 19, fontWeight: '900', letterSpacing: -.4 },
    conversationPermission: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
    conversationPermissionIcon: { width: 25, height: 25, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: `${colors.accent}13` },
    conversationPermissionValue: { flex: 1, color: colors.secondary, fontSize: 12, fontWeight: '800', textAlign: 'right' },
    conversationArrow: { width: 28, height: 28, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: `${colors.accent}10` },
    conversationSectionLabel: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.1, textTransform: 'uppercase', marginTop: 13, marginBottom: 7, marginHorizontal: 3 },
    conversationSessionBezel: { padding: 4, borderRadius: 19, backgroundColor: `${colors.raised}99`, borderWidth: 1, borderColor: colors.border },
    conversationSessionGroup: { overflow: 'hidden', borderRadius: 15, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    conversationSessionRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    conversationSessionRowLast: { borderBottomWidth: 0 },
    conversationSessionUnavailable: { backgroundColor: `${colors.raised}55` },
    conversationSessionIcon: { width: 31, height: 31, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.raised },
    conversationSessionCopy: { flex: 1, minWidth: 0 },
    conversationSessionTitle: { color: colors.text, fontSize: 12, fontWeight: '800' },
    conversationSessionMeta: { color: colors.muted, fontSize: 9, lineHeight: 13, marginTop: 2 },
    conversationStatusPill: { maxWidth: 128, minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, borderRadius: 14 },
    conversationStatusDot: { width: 6, height: 6, borderRadius: 3 },
    conversationStatusText: { flexShrink: 1, fontSize: 10, fontWeight: '900' },
    conversationClose: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingHorizontal: 11, borderRadius: 15, backgroundColor: `${colors.danger}0d`, borderWidth: 1, borderColor: `${colors.danger}66` },
    conversationCloseIcon: { width: 31, height: 31, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: `${colors.danger}18` },
    attachmentSheet: { paddingBottom: Platform.OS === 'ios' ? 34 : 22 },
    conversationOption: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    conversationOptionIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised },
    conversationOptionGlyph: { color: colors.accent, fontSize: 16, fontWeight: '800' },
    conversationOptionCopy: { flex: 1, minWidth: 0 },
    conversationOptionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    conversationOptionMeta: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    chatContextMenuLayout: { position: 'absolute' },
    chatContextMenu: { width: WEB_CONTEXT_MENU_WIDTH, padding: 6, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, shadowColor: '#000000', shadowOpacity: .28, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
    chatContextMenuItem: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, borderRadius: 8 },
    chatContextMenuText: { color: colors.text, fontSize: 12, fontWeight: '700' },
    chatContextMenuDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 8, backgroundColor: colors.border },
    chatContextHandoffAgents: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginHorizontal: 8, marginBottom: 6, padding: 7, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    chatContextHandoffAgent: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    sessionConfigSheet: { height: 'auto' },
    sessionConfigDesktopLayout: { alignItems: 'flex-start' },
    sessionConfigDesktopPopover: { width: 360, borderRadius: 18, paddingTop: 12, overflow: 'hidden' },
    quotaSheet: { height: '72%' },
    quotaDragArea: { height: 56, alignItems: 'center', justifyContent: 'center', marginHorizontal: -18, marginTop: -9, ...(Platform.OS === 'web' ? { touchAction: 'none' as any } : {}) },
    quotaDragHandle: { marginBottom: 0 },
    quotaSheetContent: { paddingTop: 10, paddingBottom: 12 },
    quotaProvider: { paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    quotaProviderHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    quotaProviderName: { color: colors.text, fontSize: 14, fontWeight: '800' },
    quotaPlan: { color: colors.muted, fontSize: 11 },
    quotaPin: { marginLeft: 'auto', minHeight: 28, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
    quotaPinSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}18` },
    quotaPinText: { color: colors.muted, fontSize: 11, fontWeight: '800' },
    quotaPinTextSelected: { color: colors.accent },
    quotaWindow: { marginTop: 13 },
    quotaWindowLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    quotaWindowName: { flex: 1, color: colors.secondary, fontSize: 11 },
    quotaWindowValue: { color: colors.text, fontSize: 11, fontWeight: '800' },
    quotaTrack: { height: 6, marginTop: 7, overflow: 'hidden', borderRadius: 3, backgroundColor: colors.subtle },
    quotaFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
    quotaCountdown: { color: colors.muted, fontSize: 10, marginTop: 6 },
    quotaStale: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 12 },
    activitySheet: { maxHeight: '76%' },
    activityContent: { paddingTop: 8, paddingBottom: 4 },
    activitySummaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    activityCount: { color: colors.muted, fontSize: 10, fontWeight: '700' },
    activityCardLabel: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .8 },
    activityGoal: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: colors.raised },
    activityGoalText: { color: colors.secondary, fontSize: 12, lineHeight: 17, fontWeight: '600', marginTop: 4 },
    activityTimeline: { marginTop: 14 },
    activityEntry: { flexDirection: 'row', minHeight: 58 },
    activityRail: { width: 18, alignItems: 'center', borderLeftWidth: 1, borderLeftColor: colors.border, marginLeft: 4 },
    activityDot: { position: 'absolute', top: 4, left: -4, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.muted },
    activityEntryCopy: { flex: 1, minWidth: 0, paddingBottom: 16 },
    activityEntryHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    activityEntryTime: { color: colors.muted, fontSize: 10, fontWeight: '700' },
    activityTaskBadge: { color: colors.accent, fontSize: 9, fontWeight: '800' },
    activityEntryText: { color: colors.secondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
    activityEntryCurrent: { color: colors.text, fontWeight: '700' },
    activityMetaRow: { flexDirection: 'row', gap: 18, marginTop: 18, paddingTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    activityMetaBlock: { flex: 1, minWidth: 0 },
    activityMetaLabel: { color: colors.muted, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: .7 },
    activityMetaValue: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 4 },
    configContent: { minHeight: 194, paddingBottom: 12 },
    configLabel: { color: colors.secondary, fontSize: 12, fontWeight: '800', marginTop: 16, marginBottom: 9, textTransform: 'uppercase', letterSpacing: .6 },
    configChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    configChoice: { minHeight: 42, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 13, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    configChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}14` },
    configChoiceText: { color: colors.secondary, fontSize: 13, fontWeight: '700' },
    configChoiceTextSelected: { color: colors.text },
    configHelp: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
    configOptionList: { gap: 7, marginTop: 11 },
    configOption: { width: '100%', minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    configOptionSelected: { borderColor: `${colors.accent}99`, backgroundColor: `${colors.accent}10` },
    configOptionCopy: { flex: 1, minWidth: 0, gap: 3 },
    configOptionTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    configOptionMeta: { color: colors.muted, fontSize: 10 },
    configOptionEmpty: { width: 19, height: 19 },
    configSkeleton: { gap: 7, marginTop: 11 },
    configSkeletonRow: { minHeight: 56, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    contextCard: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    contextRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
    contextValue: { color: colors.text, fontSize: 16, fontWeight: '800' },
    contextMeta: { flex: 1, color: colors.muted, fontSize: 11, textAlign: 'right' },
    contextTrack: { height: 6, marginTop: 12, overflow: 'hidden', borderRadius: 3, backgroundColor: colors.subtle },
    contextFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
    contextNote: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 12 },
    previewHelp: { color: colors.secondary, fontSize: 14, lineHeight: 20, marginTop: 8 },
    previewInput: { minHeight: 48, marginTop: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, color: colors.text, paddingHorizontal: 13, fontSize: 15 },
    previewNote: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
    previewSubmit: { marginTop: 18 },
    sheetHandle: { alignSelf: 'center', width: 48, height: 5, borderRadius: 3, backgroundColor: colors.muted, marginBottom: 8 },
    sheetHeader: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sheetTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -.5 },
    sheetIntro: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 2 },
    newSessionScroll: { flex: 1 },
    newSessionContent: { paddingBottom: 12 },
    hostPickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 2 },
    hostPickerScroll: { flexGrow: 0 },
    hostPickerChoice: { minWidth: 142, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    hostPickerChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    hostPickerName: { maxWidth: 120, color: colors.secondary, fontSize: 11, fontWeight: '800' },
    hostPickerNameSelected: { color: colors.text },
    hostPickerMeta: { color: colors.muted, fontSize: 8, marginTop: 2 },
    closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    closeText: { color: colors.secondary, fontSize: 28, lineHeight: 29 },
    fieldLabel: { color: colors.secondary, fontSize: 12, fontWeight: '800', marginTop: 14, marginBottom: 8 },
    agentFieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 8 },
    agentFieldLabel: { marginTop: 0, marginBottom: 0 },
    selectedAgentName: { color: colors.accent, fontSize: 12, fontWeight: '800' },
    optionalLabel: { color: colors.muted, fontWeight: '600' },
    fieldHelp: { color: colors.muted, fontSize: 13, lineHeight: 18, paddingVertical: 8 },
    projectChoices: { gap: 8 },
    projectChoice: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    projectChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}10` },
    projectChoiceCopy: { flex: 1, minWidth: 0 },
    projectChoiceName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    projectChoicePath: { color: colors.muted, fontSize: 10, marginTop: 3 },
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choiceChip: { minHeight: 42, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 13, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    choiceChipSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}14` },
    choiceChipText: { color: colors.secondary, fontSize: 13, fontWeight: '700' },
    choiceChipTextSelected: { color: colors.text },
    agentGrid: { flexDirection: 'row', gap: 6 },
    newSessionSignInButton: { marginTop: 12 },
    newSessionSignInBusy: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    newSessionLoginCard: { marginTop: 12, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.background },
    newSessionLoginLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: .8 },
    newSessionLoginCodeRow: { minHeight: 46, marginTop: 7, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 9, backgroundColor: colors.raised },
    newSessionLoginCode: { flex: 1, color: colors.text, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 18, fontWeight: '800', letterSpacing: 1.2 },
    newSessionLoginOpenButton: { marginTop: 10 },
    agentChoiceMotion: { flex: 1, minWidth: 0, minHeight: 50 },
    agentChoice: { position: 'relative', flex: 1, minWidth: 0, minHeight: 50, alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised },
    agentChoiceSelected: { borderColor: colors.accent, backgroundColor: `${colors.accent}12` },
    agentChoiceCheck: { position: 'absolute', top: 3, right: 5, color: colors.accent, fontSize: 11, fontWeight: '900' },
    promptInput: { minHeight: 82, maxHeight: 130, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, color: colors.text, fontSize: 15, lineHeight: 21, padding: 12, textAlignVertical: 'top', marginBottom: 16 },
    createSessionButton: { marginTop: 10 },
  });
}
