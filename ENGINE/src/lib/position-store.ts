import fs from 'fs';
import path from 'path';

export interface ActivePosition {
  heldAsset: string;
  entryPrice: number;
  amount: string;
  enteredAt: number;
  tpPrice?: number;
  slPrice?: number;
}

// ENGINE/data/positions.json — absolute-resolved so it works regardless of cwd
const DATA_DIR = path.resolve(__dirname, '../../data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');

function ensureStoreExists(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(POSITIONS_FILE)) {
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify({}, null, 2), 'utf-8');
    }
  } catch (err) {
    // Non-fatal — next read/write will retry
    console.warn('[position-store] Could not ensure data dir:', (err as Error).message);
  }
}

function readAllPositions(): Record<string, ActivePosition> {
  ensureStoreExists();
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
    return JSON.parse(raw) as Record<string, ActivePosition>;
  } catch (err) {
    console.warn('[position-store] Could not parse positions.json — returning empty store:', (err as Error).message);
    return {};
  }
}

function writeAllPositions(store: Record<string, ActivePosition>): void {
  ensureStoreExists();
  try {
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[position-store] Write failed — position NOT persisted:', (err as Error).message);
  }
}

export function getPosition(userRefId: string): ActivePosition | null {
  try {
    const store = readAllPositions();
    return store[userRefId] ?? null;
  } catch {
    return null;
  }
}

export function savePosition(userRefId: string, position: ActivePosition): void {
  try {
    const store = readAllPositions();
    store[userRefId] = position;
    writeAllPositions(store);
    console.log(`[position-store] ✓ Saved position for ${userRefId}: ${position.amount} ${position.heldAsset} @ ${position.entryPrice}`);
  } catch (err) {
    console.error('[position-store] savePosition failed:', (err as Error).message);
  }
}

export function clearPosition(userRefId: string): void {
  try {
    const store = readAllPositions();
    if (store[userRefId]) {
      delete store[userRefId];
      writeAllPositions(store);
      console.log(`[position-store] ✓ Cleared position for ${userRefId}`);
    }
  } catch (err) {
    console.error('[position-store] clearPosition failed:', (err as Error).message);
  }
}
