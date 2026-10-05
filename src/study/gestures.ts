/**
 * Reviewer gestures (AnkiDroid's Settings › Controls): each gesture runs a chosen action. Answer
 * actions on the question side show the answer first, as AnkiDroid's "flip or answer" commands do.
 */

export type Gesture = 'tap' | 'tapTop' | 'tapBottom' | 'tapLeft' | 'tapRight' | 'swipeUp' | 'swipeDown' | 'swipeLeft' | 'swipeRight';

export type ReviewAction =
  | 'none'
  | 'reveal'
  | 'again'
  | 'hard'
  | 'good'
  | 'easy'
  | 'undo'
  | 'edit'
  | 'info'
  | 'replay'
  | 'mark'
  | 'buryCard'
  | 'suspendCard'
  | 'flagRed'
  | 'flagOrange'
  | 'flagGreen'
  | 'flagBlue';

export const GESTURE_NAMES: Record<Gesture, string> = {
  tap: 'Tap (middle)',
  tapTop: 'Tap top',
  tapBottom: 'Tap bottom',
  tapLeft: 'Tap left',
  tapRight: 'Tap right',
  swipeUp: 'Swipe up',
  swipeDown: 'Swipe down',
  swipeLeft: 'Swipe left',
  swipeRight: 'Swipe right',
};

export const ACTION_NAMES: Record<ReviewAction, string> = {
  none: 'Nothing',
  reveal: 'Show answer',
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
  undo: 'Undo',
  edit: 'Edit note',
  info: 'Card info',
  replay: 'Replay audio',
  mark: 'Mark note',
  buryCard: 'Bury card',
  suspendCard: 'Suspend card',
  flagRed: 'Red flag',
  flagOrange: 'Orange flag',
  flagGreen: 'Green flag',
  flagBlue: 'Blue flag',
};

/** Tap or swipe up shows the answer; nothing else is bound until the user chooses. */
export const DEFAULT_GESTURES: Record<Gesture, ReviewAction> = {
  tap: 'reveal',
  tapTop: 'reveal',
  tapBottom: 'reveal',
  tapLeft: 'reveal',
  tapRight: 'reveal',
  swipeUp: 'reveal',
  swipeDown: 'none',
  swipeLeft: 'none',
  swipeRight: 'none',
};

/** Which tap gesture a tap at (x, y) in a w×h card is: the outer bands are the edge zones. */
export function tapGesture(x: number, y: number, w: number, h: number): Gesture {
  const fx = x / Math.max(1, w);
  const fy = y / Math.max(1, h);
  if (fy < 0.25) return 'tapTop';
  if (fy > 0.75) return 'tapBottom';
  if (fx < 0.3) return 'tapLeft';
  if (fx > 0.7) return 'tapRight';
  return 'tap';
}
