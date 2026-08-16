import fs from 'fs';
import path from 'path';

export interface TransactionRecord {
  id: string;
  userAddress: string;
  agentId: string;
  agentName: string;
  txType: 'Deployment' | 'Nanopayment' | 'Withdrawal' | 'Deposit' | 'Listing';
  amountUsdc: number;
  status: 'SUCCESS' | 'FAILURE';
  txHash: string;
  timestamp: string; // ISO string
  createdAtMs: number;
}

const DATA_DIR = path.resolve(__dirname, '../../data');
const TX_FILE = path.join(DATA_DIR, 'transactions.json');

function ensureDataDirExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getAllTransactions(): TransactionRecord[] {
  ensureDataDirExists();
  if (!fs.existsSync(TX_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(TX_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function recordTransaction(tx: Omit<TransactionRecord, 'id' | 'createdAtMs'>): TransactionRecord {
  ensureDataDirExists();
  const records = getAllTransactions();
  const now = new Date();
  const record: TransactionRecord = {
    ...tx,
    id: `tx_${now.getTime()}_${Math.random().toString(36).substr(2, 6)}`,
    createdAtMs: now.getTime(),
  };
  records.unshift(record); // newest first
  fs.writeFileSync(TX_FILE, JSON.stringify(records, null, 2), 'utf-8');
  return record;
}

export function getUserTransactions(userAddress: string): TransactionRecord[] {
  if (!userAddress) return [];
  const records = getAllTransactions();
  const targets = userAddress.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return records.filter(r => r.userAddress && targets.includes(r.userAddress.toLowerCase()));
}
