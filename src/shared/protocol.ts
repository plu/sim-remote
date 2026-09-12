export interface ScreenPoints { width: number; height: number }

export type HardwareButton = 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI';
export type Orientation =
  | 'PORTRAIT' | 'PORTRAIT_UPSIDE_DOWN' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT';
export type TouchPhase = 'down' | 'move' | 'up';

export type ClientMsg =
  | { type: 'touch'; phase: TouchPhase; x: number; y: number }
  | { type: 'button'; button: HardwareButton }
  | { type: 'key'; keycode: number }
  | { type: 'text'; text: string }
  | { type: 'orientation'; orientation: Orientation }
  | { type: 'pinch'; x: number; y: number; scale: number; duration: number; radius: number }
  | { type: 'takeControl' }
  | { type: 'setName'; name: string };

export type ConnState = 'connected' | 'reconnecting' | 'simulator-gone';

export type ServerMsg =
  | { type: 'hello'; udid: string; clientId: string; name: string; screen: ScreenPoints; density: number; orientation: Orientation }
  | { type: 'control'; controllerId: string | null; controllerName: string | null }
  | { type: 'orientation'; orientation: Orientation; screen: ScreenPoints }
  | { type: 'toast'; text: string }
  | { type: 'status'; state: ConnState };

const CLIENT_MSG_TYPES = [
  'touch', 'button', 'key', 'text', 'orientation', 'pinch', 'takeControl', 'setName',
];

export function isClientMsg(v: unknown): v is ClientMsg {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === 'string' && CLIENT_MSG_TYPES.includes(t);
}
