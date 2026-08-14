import fs from 'fs';
import path from 'path';

export interface PositionSlot {
  slotNumber: number; // 1 to 5
  heldAsset: string;
  entryPrice: number;
  amount: string;
  enteredAt: number;
  tpPrice?: number;
  slPrice?: number;
  txHash?: string;
}

export interface ActivePosition {
  heldAsset: string;
  entryPrice: number;
  amount: string;
  enteredAt: number;
  tpPrice?: number;
  slPrice?: number;
  slots?: PositionSlot[];
}

// ENGINE/data/positions.json — absolute-resolved so it works regardless of cwd
const DATA_DIR = path.resolve(__dirname, '../../data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
export const MAX_POSITION_SLOTS = 5;

function ensureStoreExists(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(POSITIONS_FILE)) {
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify({}, null, 2), 'utf-8');
    }
  } catch (err) {
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

/**
 * Normalizes positions for a user into a list of PositionSlot objects (max 5)
 */
export function getPositionSlots(userRefId: string): PositionSlot[] {
  try {
    const store = readAllPositions();
    const data = store[userRefId];
    if (!data) return [];

    if (Array.isArray(data.slots) && data.slots.length > 0) {
      return data.slots.slice(0, MAX_POSITION_SLOTS);
    }

    // Fallback if stored as legacy single position
    if (data.heldAsset && data.heldAsset !== 'USDC' && parseFloat(data.amount) > 0) {
      return [
        {
          slotNumber: 1,
          heldAsset: data.heldAsset,
          entryPrice: data.entryPrice,
          amount: data.amount,
          enteredAt: data.enteredAt,
          tpPrice: data.tpPrice,
          slPrice: data.slPrice,
        },
      ];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Returns overall position summary + individual slots for Option C display
 */
export function getPositionSummary(userRefId: string, currentPrice: number): {
  totalAmount: string;
  avgEntryPrice: number;
  pnlPct: string;
  pnlUsd: string;
  slots: PositionSlot[];
  usedSlots: number;
  availableSlots: number;
  heldAsset: string;
} {
  const slots = getPositionSlots(userRefId);
  if (slots.length === 0) {
    return {
      totalAmount: '0.00000000',
      avgEntryPrice: 0,
      pnlPct: '0.00',
      pnlUsd: '0.00',
      slots: [],
      usedSlots: 0,
      availableSlots: MAX_POSITION_SLOTS,
      heldAsset: 'USDC',
    };
  }

  let totalAmountNum = 0;
  let totalCost = 0;
  const heldAsset = slots[0].heldAsset;

  for (const s of slots) {
    const amt = parseFloat(s.amount) || 0;
    totalAmountNum += amt;
    totalCost += amt * (s.entryPrice || currentPrice);
  }

  const avgEntryPrice = totalAmountNum > 0 ? totalCost / totalAmountNum : currentPrice;
  const currentValue = totalAmountNum * currentPrice;
  const pnlUsdNum = currentValue - totalCost;
  const pnlPctNum = totalCost > 0 ? (pnlUsdNum / totalCost) * 100 : 0;

  const decimals = heldAsset === 'cirBTC' ? 8 : 6;

  return {
    totalAmount: totalAmountNum.toFixed(decimals),
    avgEntryPrice: parseFloat(avgEntryPrice.toFixed(2)),
    pnlPct: (pnlPctNum >= 0 ? '+' : '') + pnlPctNum.toFixed(2),
    pnlUsd: (pnlUsdNum >= 0 ? '+' : '') + pnlUsdNum.toFixed(2),
    slots,
    usedSlots: slots.length,
    availableSlots: Math.max(0, MAX_POSITION_SLOTS - slots.length),
    heldAsset,
  };
}

/**
 * Adds a new position slot (up to 5 max)
 */
export function addPositionSlot(userRefId: string, newSlotData: Omit<PositionSlot, 'slotNumber'>): { success: boolean; slotNumber?: number } {
  try {
    const store = readAllPositions();
    const existingSlots = getPositionSlots(userRefId);

    if (existingSlots.length >= MAX_POSITION_SLOTS) {
      console.warn(`[position-store] Cannot add slot: User ${userRefId} already has ${MAX_POSITION_SLOTS}/${MAX_POSITION_SLOTS} slots full.`);
      return { success: false };
    }

    const assignedSlotNumber = existingSlots.length + 1;
    const newSlot: PositionSlot = {
      ...newSlotData,
      slotNumber: assignedSlotNumber,
    };

    const updatedSlots = [...existingSlots, newSlot];

    // Compute weighted average for top-level summary
    let totalAmt = 0;
    let totalCost = 0;
    for (const s of updatedSlots) {
      const a = parseFloat(s.amount) || 0;
      totalAmt += a;
      totalCost += a * s.entryPrice;
    }
    const avgEntry = totalAmt > 0 ? totalCost / totalAmt : newSlot.entryPrice;
    const decimals = newSlot.heldAsset === 'cirBTC' ? 8 : 6;

    store[userRefId] = {
      heldAsset: newSlot.heldAsset,
      entryPrice: parseFloat(avgEntry.toFixed(2)),
      amount: totalAmt.toFixed(decimals),
      enteredAt: newSlot.enteredAt,
      tpPrice: newSlot.tpPrice,
      slPrice: newSlot.slPrice,
      slots: updatedSlots,
    };

    writeAllPositions(store);
    console.log(`[position-store] ✓ Added Position Slot #${assignedSlotNumber}/5 for ${userRefId}: ${newSlot.amount} ${newSlot.heldAsset} @ $${newSlot.entryPrice}`);
    return { success: true, slotNumber: assignedSlotNumber };
  } catch (err) {
    console.error('[position-store] addPositionSlot failed:', (err as Error).message);
    return { success: false };
  }
}

/**
 * Legacy compatibility: returns top-level active position
 */
export function getPosition(userRefId: string): ActivePosition | null {
  try {
    const store = readAllPositions();
    const pos = store[userRefId];
    if (!pos) return null;
    const slots = getPositionSlots(userRefId);
    return {
      ...pos,
      slots,
    };
  } catch {
    return null;
  }
}

/**
 * Legacy compatibility: saves position
 */
export function savePosition(userRefId: string, position: ActivePosition): void {
  try {
    const store = readAllPositions();
    const existingSlots = getPositionSlots(userRefId);
    
    // If position already has slots, keep them
    const slots = position.slots && position.slots.length > 0 ? position.slots : (existingSlots.length > 0 ? existingSlots : [
      {
        slotNumber: 1,
        heldAsset: position.heldAsset,
        entryPrice: position.entryPrice,
        amount: position.amount,
        enteredAt: position.enteredAt,
        tpPrice: position.tpPrice,
        slPrice: position.slPrice,
      }
    ]);

    store[userRefId] = {
      ...position,
      slots,
    };
    writeAllPositions(store);
    console.log(`[position-store] ✓ Saved position for ${userRefId}: ${position.amount} ${position.heldAsset} @ $${position.entryPrice} (${slots.length}/5 slots)`);
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
      console.log(`[position-store] ✓ Cleared all position slots (0/5) for ${userRefId}`);
    }
  } catch (err) {
    console.error('[position-store] clearPosition failed:', (err as Error).message);
  }
}
