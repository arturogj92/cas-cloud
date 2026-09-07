import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../App.tsx', import.meta.url).href));
const sourceFiles = [join(root, 'App.tsx'), ...readdirSync(join(root, 'src'))
  .filter((file) => extname(file) === '.tsx')
  .map((file) => join(root, 'src', file))];

test('every mobile scroll surface dismisses the keyboard', () => {
  assert.match(readFileSync(join(root, 'App.tsx'), 'utf8'), /const KEYBOARD_DISMISS_MODE = 'on-drag'/);
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<(ScrollView|FlatList|SectionList)(?=\s)/g)) {
      assert.match(source.slice(match.index, match.index + 300), /keyboardDismissMode=/, `${file}: ${match[1]} is missing keyboard dismissal`);
    }
  }
});

test('sending clears the DOM draft before dismissing the native keyboard', () => {
  const source = readFileSync(join(root, 'App.tsx'), 'utf8');
  const composer = readFileSync(join(root, 'src', 'inline-composer.tsx'), 'utf8');
  const sendComposer = source.match(/const sendComposer = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/)?.[0];

  assert.ok(sendComposer);
  assert.match(sendComposer, /composerInputRef\.current\?\.submit\(\)/);
  assert.doesNotMatch(sendComposer, /\.blur\(/);
  assert.match(source, /if \(deferTimelineScrollUntilKeyboardHide\.current\) return;/);
  assert.match(sendComposer, /deferTimelineScrollUntilKeyboardHide\.current = Platform\.OS === 'ios' && Keyboard\.isVisible\(\)/);
  assert.match(source, /Keyboard\.addListener\('keyboardDidHide',[\s\S]*?deferTimelineScrollUntilKeyboardHide\.current = false;[\s\S]*?scrollTimelineToEnd\(false\)/);
  assert.match(composer, /replaceChildren\(\);[\s\S]*?publish\(\);[\s\S]*?if \(native\) input\.current!\.blur\(\);[\s\S]*?await onSubmit\(/);
  assert.match(source, /Math\.abs\(event\.deltaY\) > 2\) composerInputRef\.current\?\.blur\(\)/);
});

test('native Chat leaves bottom-following to a single scroll owner', () => {
  const source = readFileSync(join(root, 'App.tsx'), 'utf8');

  assert.match(source, /maintainVisibleContentPosition=\{Platform\.OS === 'web' \|\| nearBottom \? undefined : \{ minIndexForVisible: 0 \}\}/);
  assert.match(source, /timelineGestureActiveRef\.current = true;[\s\S]*?followLatest\.current = false;/);
  assert.match(source, /if \(!timelineGestureActiveRef\.current && latest\) followLatest\.current = true;/);
  assert.match(source, /timelineGestureActiveRef\.current && timelineGestureEndTimerRef\.current\) scheduleTimelineGestureEnd\(\)/);
  assert.match(source, /onScrollEndDrag=\{endTimelineDrag\}/);
  assert.match(source, /onMomentumScrollEnd=\{scheduleTimelineGestureEnd\}/);
});
