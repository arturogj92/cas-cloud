import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const appSource = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url).href), 'utf8');

test('back navigation blurs the shared WebView composer as soon as a swipe activates', () => {
  const source = appSource.match(/const settleChatSwipe = useCallback[\s\S]*?(?=const chatSwipeHandlers)/)?.[0];
  assert.ok(source);
  const events: string[] = [];
  const State = { BEGAN: 2, ACTIVE: 4, END: 5, CANCELLED: 3, FAILED: 1 };
  const settle = runInNewContext(ts.transpileModule(`${source}\nsettleChatSwipe;`, {}).outputText, {
    State,
    useCallback: (callback: unknown) => callback,
    dismissComposerRef: { current: () => events.push('blur') },
    backToSessions: () => events.push('back'),
    dragX: {}, reduceMotion: false, screenWidth: 390,
    Animated: { spring: (_: unknown, options: { toValue: number }) => ({
      start: () => events.push(`spring:${options.toValue}`),
    }) },
  });
  const change = (oldState: number, state: number, translationX = 0) => settle({
    nativeEvent: { oldState, state, translationX, velocityX: 0 },
  });
  change(0, State.BEGAN);
  change(State.BEGAN, State.FAILED);
  assert.deepEqual(events, [], 'a tap or rejected gesture keeps keyboard focus');
  change(State.BEGAN, State.ACTIVE, 7);
  assert.deepEqual(events, ['blur'], 'the editor blurs while the finger is still down');
  change(State.ACTIVE, State.CANCELLED, 20);
  assert.deepEqual(events, ['blur', 'spring:0'], 'cancellation returns to Chat without navigating');
  events.length = 0;
  change(State.BEGAN, State.ACTIVE, 7);
  change(State.ACTIVE, State.END, 120);
  assert.deepEqual(events, ['blur', 'spring:390'], 'the keyboard starts closing before Chat finishes leaving');
});

test('native dismissal tolerates an unready DOM bridge and uses the current Chat proxy', () => {
  const source = appSource.match(/useImperativeHandle\(dismissComposerRef[^;]+;/)?.[0];
  assert.ok(source);
  const composerInputRef: { current: { blur?: () => void } | null } = { current: {} };
  const dismissComposerRef = { current: null as (() => void) | null };
  runInNewContext(ts.transpileModule(source, {}).outputText, {
    composerInputRef, dismissComposerRef,
    useImperativeHandle: (ref: typeof dismissComposerRef, create: () => () => void) => { ref.current = create(); },
  });
  assert.doesNotThrow(() => dismissComposerRef.current?.());
  let blurs = 0;
  composerInputRef.current = { blur: () => { blurs += 1; } };
  dismissComposerRef.current?.();
  assert.equal(blurs, 1);
  composerInputRef.current = null;
  assert.doesNotThrow(() => dismissComposerRef.current?.());
});

test('the back swipe keeps responder ownership and stays offscreen until the next Chat opens', () => {
  const gestureEvent = appSource.match(/const chatGestureEvent = useMemo[\s\S]*?\), \[dragX\]\);/)?.[0];
  const releaseHandler = appSource.match(/const settleChatSwipe = useCallback[\s\S]*?const chatSwipeHandlers/)?.[0];

  assert.ok(gestureEvent);
  assert.match(gestureEvent, /Animated\.event/);
  assert.match(gestureEvent, /translationX: dragX/);
  assert.match(gestureEvent, /useNativeDriver: true/);
  assert.doesNotMatch(appSource, /const chatPanResponder/);
  assert.ok(releaseHandler);
  assert.doesNotMatch(releaseHandler, /dragX\.setValue\(0\)/);
  assert.match(releaseHandler, /toValue: screenWidth/);
  assert.match(releaseHandler, /Animated\.spring\(dragX/);
  assert.match(releaseHandler, /velocity: Math\.max\(0, velocityX\)/);
  assert.doesNotMatch(releaseHandler, /duration: 150/);
  assert.doesNotMatch(appSource, /hitSlop: \{ left: 0, width:/);
  assert.match(appSource, /activeOffsetX: 6/);
  assert.match(appSource, /failOffsetX: -6/);
  assert.match(appSource, /outputRange: \[0, -screenWidth \* 0\.3\]/);
  assert.doesNotMatch(appSource, /if \(!selectedId\) dragX\.setValue\(0\)/);
  assert.match(appSource, /dragX\.setValue\(0\);\s*setSelectedId\(resolvedSessionId\);/);
  assert.match(appSource, /enabled: Platform\.OS !== 'web' && appForeground && Boolean\(selectedId \|\| startingSession\)/);
  assert.match(appSource, /openingSession && !visibleSession[\s\S]*?<PanGestureHandler \{\.\.\.chatSwipeHandlers\}>/);
  assert.match(appSource, /const backToSessions = useCallback[\s\S]*?historyResumeGeneration\.current \+= 1;[\s\S]*?setStartingSession\(null\);/);
  assert.match(appSource, /generation !== historyResumeGeneration\.current/);
});

test('an interrupted back swipe cannot survive app suspension or close a newer Chat', () => {
  const appStateHandler = appSource.match(/const applyAppState = \(state: string\) => \{[\s\S]*?\n    \};/)?.[0];
  const releaseHandler = appSource.match(/const settleChatSwipe = useCallback[\s\S]*?const chatSwipeHandlers/)?.[0];
  const startSession = appSource.match(/const startSession = useCallback[\s\S]*?\n  \}, \[/)?.[0];

  assert.ok(appStateHandler);
  assert.match(appStateHandler, /setAppForeground\(state === 'active'\)/);
  assert.match(appStateHandler, /dragX\.setValue\(0\)/);
  assert.ok(releaseHandler);
  assert.match(releaseHandler, /\.start\(\(\{ finished \}\) => \{\s*if \(finished\) backToSessions\(\);\s*\}\)/);
  assert.match(appSource, /enabled: Platform\.OS !== 'web' && appForeground && Boolean\(selectedId \|\| startingSession\)/);
  assert.ok(startSession);
  assert.match(startSession, /openSession\(clientRequestId, true, 'created'\)/);
  assert.doesNotMatch(startSession, /setSelectedId\(clientRequestId\)/);
});
