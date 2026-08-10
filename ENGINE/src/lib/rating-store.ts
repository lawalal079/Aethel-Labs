import fs from 'fs';
import path from 'path';

export interface RatingRecord {
  id: string;
  agentId: string;
  userAddress: string;
  rating: number; // 1 to 5
  comment?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

const DATA_DIR = path.resolve(__dirname, '../../data');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');

function ensureDataDirExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getAllRatings(): RatingRecord[] {
  ensureDataDirExists();
  if (!fs.existsSync(RATINGS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(RATINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveRating(input: { agentId: string; userAddress: string; rating: number; comment?: string }): RatingRecord {
  ensureDataDirExists();
  const ratings = getAllRatings();
  const targetUser = input.userAddress.toLowerCase();
  const existingIndex = ratings.findIndex(r => r.agentId === input.agentId && r.userAddress.toLowerCase() === targetUser);

  const now = Date.now();

  if (existingIndex >= 0) {
    const updatedRecord: RatingRecord = {
      ...ratings[existingIndex],
      rating: input.rating,
      comment: input.comment ?? ratings[existingIndex].comment,
      updatedAtMs: now,
    };
    ratings[existingIndex] = updatedRecord;
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2), 'utf-8');
    return updatedRecord;
  } else {
    const newRecord: RatingRecord = {
      id: `rate_${now}_${Math.random().toString(36).substr(2, 6)}`,
      agentId: input.agentId,
      userAddress: input.userAddress,
      rating: input.rating,
      comment: input.comment,
      createdAtMs: now,
      updatedAtMs: now,
    };
    ratings.unshift(newRecord);
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2), 'utf-8');
    return newRecord;
  }
}

export function getAgentRatingStats(agentId: string) {
  const ratings = getAllRatings().filter(r => r.agentId === agentId);
  const count = ratings.length;
  if (count === 0) {
    return {
      agentId,
      average: 0,
      count: 0,
      reviews: [],
    };
  }

  const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
  const average = parseFloat((sum / count).toFixed(1));

  return {
    agentId,
    average,
    count,
    reviews: ratings,
  };
}
